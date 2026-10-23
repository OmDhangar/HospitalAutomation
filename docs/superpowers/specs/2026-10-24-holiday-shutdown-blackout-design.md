# Architectural Specification: Unified OPD Closure & Multi-Day Blackout Engine

**Date:** 2026-10-24  
**Author:** OmDhangar / Antigravity Pair  
**Status:** Revised Design Specification (Post Architectural Review)  
**Tracking Migration:** `0071_blackout_periods.sql`  
**Architecture Decision Record:** ADR-040  

---

## 1. Executive Summary & Review Resolutions

This specification defines the unified closure architecture for Qurio/QueueCare, combining:
1. **Same-day Stop OPD** (intake freeze for today's session while serving the remaining queue, per ADR-039).
2. **Multi-day Holiday & Shutdown Blackout** (calendar-range closures for hospital, branch, or doctor with automatic appointment cancellation and patient notifications, per ADR-040).
3. **Dashboard UX Fix**: Hiding the "Stop OPD" button until the OPD session has actually been started (`sessionStarted === true`).

### Resolution of Review Blockers & Architectural Directives
- **B1 (WhatsApp Template Approval)**: Reuses the existing, Meta-approved `opd_appointment_cancelled` template (`isCritical = true`) which takes `doctorName` and `appointmentDate` and carries a `/book?doctor={{1}}` rebooking button. A dedicated `opd_blackout_cancellation` template is added to `lib/notify/templates.ts` for future review, but runtime shipping uses the approved template without delay.
- **B2 (State Machine Integrity)**: Bulk appointment cancellations execute strictly via state machine transitions (`transitionAppointment(status, 'cancel')`) with append-only `queue_events` audit writes (`action: 'cancel'`, structured metadata). Appointments in `IN_CONSULTATION` or `COMPLETED` states are never cancelled.
- **B3 & M8 (Permissions & Roles)**: Uses existing owner permission `hospital.configure` (`STAFF_ROLES = ['owner', 'receptionist', 'doctor', 'nurse']`). Destructive multi-day blackout creation and revocation are strictly owner-only.
- **B4 (Strict RLS)**: Uses the exact `app.hospital_id` setting with `nullif(current_setting('app.hospital_id', true), '')::uuid` and copies the full `DO $outer$ ... FOREACH ...` block from `0026_billing_foundation.sql` enforcing `FORCE ROW LEVEL SECURITY`, `tenant_isolation`, `read_only_write`, and `read_only_delete`.
- **B5 (Unified Closure Resolver)**: Establishes `resolveOpdClosure()` in `lib/services/opd-hours.ts` as the single source of truth called by all four gates (`createWalkIn`, `bookScheduledSlot`, `getDoctorSlotsForDate`/`getDoctorBookingDetails`, and `handleInboundMessage`).
- **H1 (Today vs Future Date Messaging)**: `OpdClosedError` takes `targetDate` and `serviceDate`. WhatsApp messaging differentiates attempting to book *today* (which offers tomorrow's slots or tomorrow's live queue) from attempting to book a *future date* inside a blackout range (which informs that `{serviceDate}` is closed and reopens on `{reopenDate}`).
- **H2 (Preview Disruption UX)**: Adds `previewBlackoutDisruption()` and a confirmation modal showing exact counts of appointments to be cancelled, WhatsApp notices to be sent, and active consultations left alone before committing.
- **H3 (Race Conditions)**: Transactional boundary wraps blackout creation, appointment snapshot, state machine cancellation, and queue events. A final in-transaction check catches any concurrent walk-in rows before commit.
- **H4 (Message Budget Canary)**: `opd_appointment_cancelled` is in `CRITICAL_TEMPLATES`, which inherently bypasses circuit-breaker suppression in `lib/notify/worker.ts`. The monthly ratio numerator excludes automated administrative disruption messages.

---

## 2. Architecture & Data Model

### 2.1 Database Schema: `blackout_periods` (Migration `0071_blackout_periods.sql`)

```sql
CREATE TABLE blackout_periods (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  branch_id UUID REFERENCES branches(id) ON DELETE CASCADE,     -- NULL = All branches in hospital
  doctor_id UUID REFERENCES doctors(id) ON DELETE CASCADE,       -- NULL = All doctors in branch/hospital
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  reopen_date DATE NOT NULL,
  reason TEXT NOT NULL,                                          -- Internal administrative reason
  public_reason TEXT,                                            -- Patient-facing notice (defaults to "Scheduled closure")
  created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  cancelled_at TIMESTAMPTZ,                                     -- Set when revoked early
  cancelled_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT blackout_date_range_valid CHECK (end_date >= start_date),
  CONSTRAINT blackout_reopen_date_valid CHECK (reopen_date > end_date)
);

CREATE INDEX blackout_periods_lookup_idx ON blackout_periods (hospital_id, branch_id, doctor_id, start_date, end_date)
  WHERE cancelled_at IS NULL;

-- Strict Multi-Tenant Row Level Security
DO $outer$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'blackout_periods'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      $p$
        CREATE POLICY tenant_isolation ON %I
          USING (hospital_id = nullif(current_setting('app.hospital_id', true), '')::uuid)
          WITH CHECK (hospital_id = nullif(current_setting('app.hospital_id', true), '')::uuid)
      $p$,
      t
    );
    EXECUTE format(
      $p$
        CREATE POLICY read_only_write ON %I AS RESTRICTIVE
          FOR ALL
          USING (true)
          WITH CHECK (NOT public.app_read_only())
      $p$,
      t
    );
    EXECUTE format(
      $p$
        CREATE POLICY read_only_delete ON %I AS RESTRICTIVE
          FOR DELETE
          USING (NOT public.app_read_only())
      $p$,
      t
    );
  END LOOP;
END
$outer$;
```

### 2.2 Date and Timezone Discipline (M10)
- `start_date`, `end_date`, and `reopen_date` are Postgres `DATE` types (stored as `YYYY-MM-DD` strings).
- All comparisons use `DATE` vs `DATE` (via `serviceDateIn(hospital.timezone, timestamp)`). Never compare UTC timestamps directly against local calendar dates.

---

## 3. Unified OPD Closure Resolver (B5)

Located in `lib/services/opd-hours.ts`:

```typescript
export interface OpdClosureResolution {
  isClosed: boolean;
  closureType: 'none' | 'stop_today' | 'blackout';
  stoppedAt?: Date | null;
  startDate?: string | null;
  endDate?: string | null;
  reopenDate?: string | null;
  reason?: string | null;
  publicReason?: string | null;
  isMultiDay: boolean;
}

export async function resolveOpdClosure(args: {
  hospitalId: string;
  doctorId: string;
  serviceDate: string; // YYYY-MM-DD in hospital timezone
  branchId?: string | null;
  now?: Date;
  timezone?: string;
}): Promise<OpdClosureResolution> {
  // 1. Check active uncancelled blackouts covering serviceDate
  // Queries blackout_periods WHERE cancelled_at IS NULL
  //   AND start_date <= serviceDate AND end_date >= serviceDate
  //   AND (doctor_id IS NULL OR doctor_id = args.doctorId)
  //   AND (branch_id IS NULL OR branch_id = args.branchId)
  // ORDER BY created_at DESC LIMIT 1 (precedence: M5)
  // If found: return closureType: 'blackout'

  // 2. Check same-day Stop OPD (only applicable if serviceDate === today)
  // Reads doctor_day_states for today. If opd_stopped_at <= now:
  // return closureType: 'stop_today'

  // 3. Neither: return closureType: 'none', isClosed: false
}
```

### 3.1 Domain Error: `OpdClosedError` ([lib/domain/queue.ts](file:///d:/Projects/HospitalAutomation/lib/domain/queue.ts))
Fully backwards-compatible constructor:

```typescript
export interface OpdClosureInfo {
  stoppedAt?: Date | null;
  closureType?: 'stop_today' | 'blackout';
  isMultiDay?: boolean;
  serviceDate?: string | null; // Date patient attempted to book
  reopenDate?: string | null;
  endDate?: string | null;
  reason?: string | null;
  publicReason?: string | null;
}

export class OpdClosedError extends Error {
  readonly stoppedAt: Date | null;
  readonly closureType: 'stop_today' | 'blackout';
  readonly isMultiDay: boolean;
  readonly serviceDate: string | null;
  readonly reopenDate: string | null;
  readonly reason: string | null;
  readonly publicReason: string | null;

  constructor(arg: OpdClosureInfo | Date) {
    if (arg instanceof Date) {
      super('OPD is closed for today');
      this.stoppedAt = arg;
      this.closureType = 'stop_today';
      this.isMultiDay = false;
      this.serviceDate = null;
      this.reopenDate = null;
      this.reason = null;
      this.publicReason = null;
    } else {
      const msg = arg.closureType === 'blackout'
        ? `OPD is closed on ${arg.serviceDate ?? 'the requested date'}`
        : 'OPD is closed for today';
      super(msg);
      this.stoppedAt = arg.stoppedAt ?? null;
      this.closureType = arg.closureType ?? 'stop_today';
      this.isMultiDay = Boolean(arg.isMultiDay);
      this.serviceDate = arg.serviceDate ?? null;
      this.reopenDate = arg.reopenDate ?? null;
      this.reason = arg.reason ?? null;
      this.publicReason = arg.publicReason ?? arg.reason ?? null;
    }
    this.name = 'OpdClosedError';
  }
}
```

---

## 4. Blackout Service & Execution Engine

Located in `lib/services/blackout.ts`:

### 4.1 Preview Disruption (H2)
```typescript
export async function previewBlackoutDisruption(args: {
  hospitalId: string;
  branchId?: string | null;
  doctorId?: string | null;
  startDate: string;
  endDate: string;
}): Promise<{
  totalAppointments: number;
  willCancel: number;
  inConsultationOrDone: number;
  patientCountWithWhatsApp: number;
}>
```
Queries all appointments in `[startDate, endDate]` for the given doctor/branch/hospital. Partitions by status:
- Cancellable: `CREATED`, `CONFIRMED`, `WAITING`, `PARKED`, `HELD` -> `willCancel`.
- Non-cancellable: `IN_CONSULTATION`, `COMPLETED`, `CANCELLED` -> `inConsultationOrDone` (left alone).

### 4.2 Creation with State Machine Cancellations (B2, H3, M4)
`createBlackoutPeriodAndNotify(args)`:
1. Validates inputs (`hospital.configure` verified, `endDate >= startDate`, `reopenDate > endDate`).
2. Opens tenant transaction:
   - Inserts row into `blackout_periods`.
   - Fetches candidate appointments in `[startDate, endDate]` with `FOR UPDATE`.
   - For each cancellable row:
     - Applies state machine transition to `CANCELLED`.
     - Appends to `queue_events` (`action: 'cancel'`, metadata: `{ reason: 'blackout', blackout_id: id, public_reason }`).
     - If patient has phone & WhatsApp opt-in: enqueues notification in `notification_outbox` with `templateCode: 'opd_appointment_cancelled'`, `appointmentDate`, `doctorName`.
   - Concurrency sweep: verifies no unhandled `WAITING` rows slipped in; cancels them before transaction commit.
   - Logs destructive action to `audit_logs` (`action: 'blackout.created'`).

### 4.3 Cancellation / Revocation (M3, M4)
`cancelBlackoutPeriod(args)`:
- Sets `cancelled_at = now()`, `cancelled_by_user_id = actor.id`.
- Writes to `audit_logs` (`action: 'blackout.cancelled'`).
- Semantics: Reopens slot booking and walk-in intake immediately. Does not attempt to revive previously cancelled appointments (patients received notice and made other plans).

---

## 5. Intake Gates & WhatsApp Bot Handling

### 5.1 The Four Gates
1. **`createWalkIn` ([lib/services/queue.ts](file:///d:/Projects/HospitalAutomation/lib/services/queue.ts))**:
   - Calls `resolveOpdClosure({ hospitalId, doctorId, serviceDate: today })`.
   - If `isClosed`: throws `OpdClosedError`.
2. **`bookScheduledSlot` ([lib/services/web-booking.ts](file:///d:/Projects/HospitalAutomation/lib/services/web-booking.ts))**:
   - Calls `resolveOpdClosure({ hospitalId, doctorId, serviceDate: slotDate })`.
   - If `isClosed`: throws `OpdClosedError`.
3. **`getDoctorSlotsForDate` & `getDoctorBookingDetails`**:
   - Calls `resolveOpdClosure`.
   - If `isClosed`: returns `slots: []`, `isClosed: true`, `closureType`, `reopenDate`, `closureReason`.
4. **`handleInboundMessage` ([lib/services/booking.ts](file:///d:/Projects/HospitalAutomation/lib/services/booking.ts))**:
   - Catches `OpdClosedError`.

### 5.2 Contextual WhatsApp Responses (H1)
- **Scenario 1: Attempting to book a future date that is blacked out**:
  > *"OPD for Dr. {doctorName} is closed on {serviceDate} and will reopen on {reopenDate}{reason ? ` due to ${reason}` : ''}. Please select a date after reopening."*
- **Scenario 2: Attempting to book today during a multi-day blackout**:
  > *"Today's OPD is closed and will remain closed until {reopenDate}{reason ? ` due to ${reason}` : ''}. Please visit us after reopening."*
- **Scenario 3: Attempting to book today during a same-day Stop OPD**:
  - If doctor accepts slots (`scheduleMode === 'slot' || scheduleMode === 'both'`):
    Generates tomorrow's booking URL:
    `${baseUrl}/book?doctor=${doctor.id}&phone=${encodeURIComponent(phoneE164)}&hospital=${hospitalId}&locale=${locale}&date=${tomorrow}`
    Sends:
    > *"Today's OPD is closed. You can book a slot for tomorrow using this link: {bookUrl} or return tomorrow for the live queue."*
  - If queue-only:
    Sends:
    > *"Today's OPD is closed. Please return tomorrow for the live queue."*

---

## 6. User Interface & Controls

### 6.1 Admin Scheduling UI ([app/(app)/settings/scheduling](file:///d:/Projects/HospitalAutomation/app/(app)/settings/scheduling))
Owner-only section: `<HolidaysAndBlackoutsManager />`:
- Table of active and scheduled blackouts (Dates, Reopen Date, Scope, Public Reason, Actions).
- **"Add Holiday / Blackout" Flow**:
  1. Input Step: Select Scope (All Doctors / Specific Doctor, Branch), Dates, Reopen Date, Internal Reason, and Public Reason.
  2. Preview Step (H2): Calls `previewBlackoutDisruption`. Shows summary of affected appointments and notifications.
  3. Confirm Step: Calls Server Action `createBlackoutPeriodAction`.
- **"Revoke Blackout" Action**: Modal confirmation to reopen dates early.

### 6.2 Discoverability on Same-Day + Multi-Day Closures (M7)
- If a hospital decides at 3:00 PM to close today and remain closed tomorrow:
  - Admin schedules a Blackout with `start_date = today` and `end_date = tomorrow`.
  - Because `resolveOpdClosure` checks blackouts first, this single action closes both today's intake and tomorrow's intake automatically. No need to click "Stop OPD" first.

### 6.3 Dashboard Stop OPD Button Lifecycle
- [app/(app)/dashboard/opd-stop-control.tsx](file:///d:/Projects/HospitalAutomation/app/(app)/dashboard/opd-stop-control.tsx):
  - Prop `sessionStarted?: boolean`.
  - When `!sessionStarted && !stoppedAt`, returns `null`. The button is invisible until staff clicks "Start OPD".
  - If OPD is already stopped or scheduled, the status badge with Reopen / Cancel actions remains visible at all times.
- [app/(app)/dashboard/page.tsx](file:///d:/Projects/HospitalAutomation/app/(app)/dashboard/page.tsx):
  - Passes `sessionStarted={sessionStarted}` at lines 319 (doctor view) and 700 (receptionist view).

---

## 7. Testing & Quality Verification

1. **Unit Tests**:
   - `components/__tests__/opd-stop-control.test.tsx`: Stop OPD visibility states with `sessionStarted`.
   - `lib/domain/__tests__/blackout.test.ts`: `OpdClosedError` contextual messages and backward compatibility.
2. **Integration Tests**:
   - `lib/services/__tests__/blackout.integration.test.ts`:
     - Test 1: Preview disruption returns accurate cancellation and left-alone counts.
     - Test 2: Hospital-wide blackout creation cancels appointments via state machine and enqueues `opd_appointment_cancelled` messages.
     - Test 3: Doctor-specific blackout isolates cancellations to target doctor.
     - Test 4: Concurrency and race conditions (H3) between walk-in creation and blackout.
     - Test 5: Revocation restores slot generation and intake gates.
     - Test 6: Precedence on overlapping blackouts (M5).
   - `lib/services/__tests__/booking.integration.test.ts`:
     - Test 7: WhatsApp reply on future blacked-out date.
     - Test 8: WhatsApp reply on today's multi-day blackout.
     - Test 9: WhatsApp reply on today's same-day stop with tomorrow's slot link.
     - Test 10: WhatsApp reply on today's same-day stop for queue-only doctor.
3. **Verification**:
   - `npm run typecheck`
   - Vitest test suite (`npm run test`) 100% green.
