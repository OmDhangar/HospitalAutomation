# Architectural Specification: Unified OPD Closure & Multi-Day Blackout Engine

**Date:** 2026-10-24  
**Author:** OmDhangar / Antigravity Pair  
**Status:** Approved Architectural Specification (Ready for Implementation)  
**Tracking Migration:** `0071_blackout_periods.sql` (`idx: 56`, `when: 1792250000000`)  
**Architecture Decision Record:** ADR-040  

---

## 1. Executive Summary & Review Resolutions

This specification delivers the unified closure architecture for Qurio/QueueCare:
1. **Same-day Stop OPD** (intake freeze for today's session while serving the remaining queue, per ADR-039).
2. **Multi-day Holiday & Shutdown Blackout** (calendar-range closures for hospital, branch, or doctor with automatic appointment cancellation and patient notifications, per ADR-040).
3. **Dashboard UX Fix**: Hiding the "Stop OPD" button until the OPD session has actually been started (`sessionStarted === true`).

### Resolution Matrix of Review Directives

| Code | Item | Architectural Resolution |
| :--- | :--- | :--- |
| **NB1** | Status Partition | **Today**: Cancel `CREATED, CONFIRMED, WAITING, SKIPPED, HELD`. Leave `CALLED, IN_CONSULTATION, COMPLETED`. Terminal `CANCELLED, NO_SHOW, EXPIRED`.<br>**Future**: Cancel `CREATED, CONFIRMED, WAITING`. Terminal `CANCELLED, NO_SHOW, EXPIRED`. Identical in preview and execution. |
| **NB2** | Overlap Precedence | `getActiveBlackout` queries `ORDER BY end_date DESC, created_at DESC LIMIT 1`. Picks the latest reopen date if overlapping blackouts exist. |
| **NB3** | State Machine in Tx | In `createBlackoutPeriodAndNotify` (inside `withTenant`), cancellations check `canCancel(status)` from `lib/domain/queue.ts`, update `appointments.status = 'CANCELLED'`, and write append-only `queue_events` audit rows inline within `tx`. Open draft consultation bill lines are voided (`void_reason: 'blackout'`). |
| **NB4** | Overlapping Blackouts | Prevented at creation time. `createBlackoutPeriodAndNotify` rejects with validation error if date range overlaps an existing uncancelled blackout for the same scope. |
| **NB5** | Concurrency & Locking | `createBlackoutPeriodAndNotify` locks today's target doctor(s) using `lockDoctorDay(tx, { hospitalId, doctorId, serviceDate: today })` in `lib/services/doctor-day.ts` (which does `INSERT ... ON CONFLICT DO NOTHING` then `SELECT ... FOR UPDATE`). `createWalkIn` already takes `lockDoctorDay`, ensuring strict mutual serialization. |
| **NB-NEW-1** | `branchId` Parameter | `branchId: string` is made a **required** parameter in `resolveOpdClosure()`. Callers supply `doctor.branchId` (non-null per `doctors` table schema). SQL condition `AND (blackout_periods.branch_id IS NULL OR blackout_periods.branch_id = :branchId)` is deterministic. |
| **NB-NEW-2** | Deadlock Prevention | When locking multiple doctors for a today-starting blackout, doctor IDs are deterministically sorted (`doctorIds.sort()`) before calling `lockDoctorDay`. |
| **NB-NEW-3** | Row Existence at Lock | `lockDoctorDay` executes `INSERT INTO doctor_day_states ... ON CONFLICT DO NOTHING` before `SELECT ... FOR UPDATE`, guaranteeing row existence even if no tokens have been issued today. |
| **NB-NEW-4** | Client Closure Feedback | `bookSlotWalkInDynamic` and `addWalkInDynamic` catch `OpdClosedError` and return `{ ok: false, error: err.message, closureType: err.closureType, opdClosedAt: err.stoppedAt?.toISOString(), reopenDate: err.reopenDate, publicReason: err.publicReason }`. Receptionist sees full closure context. |
| **NB-NEW-5** | `advanceQueue` on Empty | `advanceQueue` natively handles empty queues (returns `{ ok: true, called: null }`, completing the consultation and gracefully disabling "Call next"). |
| **NB6** | Canary & Circuit Breaker | `opd_appointment_cancelled` is in `CRITICAL_TEMPLATES` in `lib/notify/templates.ts`. Worker query in `lib/notify/worker.ts` is explicitly updated to exclude `milestone = 'appointment_cancelled:blackout'` from monthly canary ratio. |
| **NH1** | Interim WhatsApp Notice | Ships immediately using approved `opd_appointment_cancelled` (carries doctor and date, rebooking button). Dedicated `opd_blackout_cancellation` template registered in `templates.ts` for Meta submission. WhatsApp bot auto-replies with full public reason; `/book` displays banner. |
| **NH2** | Multiple Appointments | Accepted policy: A patient with multiple appointments receives one cancellation notice per appointment, preserving outbox idempotency. |
| **NH4** | Consultation Fees & Refunds | Consultation fees for cancelled appointments remain recorded in `patient_payments` as unconsumed credit / pending manual settlement. Consultation draft bill lines are voided (`void_reason: 'blackout'`). Automated payment refunds are owner-handled. |
| **NH5** | `sessionStarted` Source | Sourced from `doctorDayStates.session_started_at !== null` (`snapshot.sessionStartedAt` in `loadDashboardData`). Dashboard passes `sessionStarted={Boolean(snapshot?.sessionStartedAt)}`. |
| **NH6** | Primary Safety Gate Tests | Tests added: `createWalkIn` throws on blackout; `createWalkIn` with `isEmergency: true` succeeds during blackout; `createWalkIn` succeeds after revocation. |

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
  reopen_date DATE NOT NULL,                                     -- Can be > end_date + 1 (e.g. Friday closure, Monday reopen)
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

-- Strict Multi-Tenant Row Level Security (0026 pattern)
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

### 2.2 Date and Timezone Discipline
- `start_date`, `end_date`, and `reopen_date` are Postgres `DATE` types (`YYYY-MM-DD`).
- All comparisons use `DATE` vs `DATE` (via `serviceDateIn(hospital.timezone, timestamp)`). UTC timestamps are never compared directly against calendar dates.

---

## 3. Unified OPD Closure Resolver (B5, NB-NEW-1)

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
  branchId: string; // Required (NB-NEW-1)
  serviceDate: string; // YYYY-MM-DD in hospital timezone
  now?: Date;
  timezone?: string;
}): Promise<OpdClosureResolution> {
  // 1. Check active uncancelled blackouts covering serviceDate
  // SELECT * FROM blackout_periods
  // WHERE hospital_id = :hospitalId
  //   AND cancelled_at IS NULL
  //   AND start_date <= :serviceDate
  //   AND end_date >= :serviceDate
  //   AND (doctor_id IS NULL OR doctor_id = :doctorId)
  //   AND (branch_id IS NULL OR branch_id = :branchId)
  // ORDER BY end_date DESC, created_at DESC
  // LIMIT 1;
  // If found: return closureType: 'blackout', isClosed: true

  // 2. Check same-day Stop OPD (only applicable if serviceDate === serviceDateIn(timezone, now))
  // Reads doctor_day_states for today. If opd_stopped_at <= now:
  // return closureType: 'stop_today', isClosed: true

  // 3. Otherwise: return closureType: 'none', isClosed: false
}
```

### 3.1 Domain Error: `OpdClosedError` ([lib/domain/queue.ts](file:///d:/Projects/HospitalAutomation/lib/domain/queue.ts))

```typescript
export interface OpdClosureInfo {
  stoppedAt?: Date | null;
  closureType?: 'stop_today' | 'blackout';
  isMultiDay?: boolean;
  serviceDate?: string | null;
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

### 4.1 Preview Disruption (H2, NB1)
```typescript
export async function previewBlackoutDisruption(args: {
  hospitalId: string;
  branchId?: string | null;
  doctorId?: string | null;
  startDate: string;
  endDate: string;
  timezone?: string;
  now?: Date;
}): Promise<{
  totalAppointments: number;
  willCancel: number;
  inConsultationOrDone: number;
  messageCount: number;
}>
```
Partitions candidate appointments in `[startDate, endDate]`:
- **If `serviceDate === today`**:
  - Cancel: `CREATED`, `CONFIRMED`, `WAITING`, `SKIPPED`, `HELD`.
  - Leave: `CALLED`, `IN_CONSULTATION`, `COMPLETED` (counted in `inConsultationOrDone`).
  - Terminal: `CANCELLED`, `NO_SHOW`, `EXPIRED`.
- **If `serviceDate > today` (Future)**:
  - Cancel: `CREATED`, `CONFIRMED`, `WAITING`.
  - Terminal: all others.

### 4.2 Creation with State Machine Cancellations (B2, NB3, NB4, NB5, NB-NEW-2, NB-NEW-3, M4, NH4)
`createBlackoutPeriodAndNotify(args)`:
1. Validates actor has `hospital.configure`.
2. Validates `startDate <= endDate` and `reopenDate > endDate`.
3. Checks for overlapping active blackouts (NB4). If overlap exists, throws friendly validation error.
4. Opens tenant transaction:
   - If blackout includes today: gathers target doctor IDs, sorts deterministically (`doctorIds.sort()`), and acquires lock via `lockDoctorDay(tx, { hospitalId, doctorId, serviceDate: today })` (NB5, NB-NEW-2, NB-NEW-3).
   - Inserts row into `blackout_periods`.
   - Queries appointments with `FOR UPDATE`.
   - For each cancellable row per the status partition:
     - Verifies `canCancel(row.status)` from `lib/domain/queue.ts`.
     - Updates status to `CANCELLED`.
     - Inserts into `queue_events` (`action: 'cancel'`, `fromStatus: row.status`, `toStatus: 'CANCELLED'`, `actorUserId: actor.id`, metadata: `{ reason: 'blackout', blackout_id: id, public_reason }`).
     - If an open encounter exists, voids its draft consultation bill line (`void_reason: 'blackout'`) (NH4).
     - If patient has phone and opted-in: writes outbox row (`templateCode: 'opd_appointment_cancelled'`, `milestone: 'appointment_cancelled:blackout'`).
   - Writes to `audit_logs` (`action: 'blackout.created'`).

### 4.3 Cancellation / Revocation (M3, M4)
`cancelBlackoutPeriod(args)`:
- Sets `cancelled_at = now()`, `cancelled_by_user_id = actor.id`.
- Writes to `audit_logs` (`action: 'blackout.cancelled'`).
- Immediately re-enables intake and slots. Does not resurrect cancelled appointments.

---

## 5. Intake Gates & WhatsApp Bot Handling

### 5.1 The Four Gates
1. **`createWalkIn` ([lib/services/queue.ts](file:///d:/Projects/HospitalAutomation/lib/services/queue.ts))**:
   - Calls `resolveOpdClosure({ hospitalId, doctorId, serviceDate: today, branchId: doctor.branchId })`.
   - If `isClosed` and not `isEmergency`: throws `OpdClosedError`.
2. **`bookScheduledSlot` ([lib/services/web-booking.ts](file:///d:/Projects/HospitalAutomation/lib/services/web-booking.ts))**:
   - Calls `resolveOpdClosure({ hospitalId, doctorId, serviceDate: slotDate, branchId: doctor.branchId })`.
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
- Active & scheduled blackouts table (Dates, Reopen Date, Scope, Public Reason, Actions).
- **"Add Holiday / Blackout" Flow**:
  1. Input: Scope (All Doctors / Specific Doctor, Branch), Dates, Reopen Date, Internal Reason, Public Reason.
  2. Preview (H2): Calls `previewBlackoutDisruption`. Displays affected appointments count.
  3. Confirm: Calls `createBlackoutPeriodAction`.
- **"Revoke Blackout" Action**: Modal confirmation.

### 6.2 Receptionist & Doctor Error Feedback (NB-NEW-4)
- `addWalkInDynamic` and `bookSlotWalkInDynamic` in `app/(app)/dashboard/actions.ts` return:
  `{ ok: false, error: err.message, closureType: err.closureType, opdClosedAt: err.stoppedAt?.toISOString(), reopenDate: err.reopenDate, publicReason: err.publicReason }`.
  Toast / UI alert displays: *"OPD is closed until {reopenDate} ({publicReason})"*.

### 6.3 Dashboard Stop OPD Button Lifecycle (NH5)
- [app/(app)/dashboard/opd-stop-control.tsx](file:///d:/Projects/HospitalAutomation/app/(app)/dashboard/opd-stop-control.tsx):
  - Prop `sessionStarted?: boolean`.
  - When `!sessionStarted && !stoppedAt`, returns `null`.
  - If OPD is already stopped or scheduled, the status badge with Reopen / Cancel actions remains visible at all times.
- [app/(app)/dashboard/page.tsx](file:///d:/Projects/HospitalAutomation/app/(app)/dashboard/page.tsx):
  - Passes `sessionStarted={Boolean(snapshot?.sessionStartedAt)}`.

---

## 7. Testing & Quality Verification

1. **Unit Tests**:
   - `components/__tests__/opd-stop-control.test.tsx`: Stop OPD visibility states with `sessionStarted`.
   - `lib/domain/__tests__/blackout.test.ts`: `OpdClosedError` contextual messages and backward compatibility.
2. **Integration Tests**:
   - `lib/services/__tests__/blackout.integration.test.ts`:
     - Test 1: Preview disruption returns accurate partition counts.
     - Test 2: Hospital-wide blackout cancels cancellable appointments and leaves CALLED/in-consultation alone.
     - Test 3: Doctor-specific blackout isolates cancellations to target doctor.
     - Test 4: Overlapping blackout creation is rejected with validation error (NB4).
     - Test 5: Concurrency/serialization with `lockDoctorDay` and sorted IDs (NB5, NB-NEW-2).
     - Test 6: Revocation restores slot generation and intake gates.
     - Test 7: `createWalkIn` throws `OpdClosedError` on active blackout (NH6 Test X).
     - Test 8: `createWalkIn` succeeds with `isEmergency: true` during active blackout (NH6 Test Y).
     - Test 9: `createWalkIn` succeeds after blackout revocation (NH6 Test Z).
   - `lib/services/__tests__/booking.integration.test.ts`:
     - Test 10: WhatsApp reply on future blacked-out date.
     - Test 11: WhatsApp reply on today's multi-day blackout.
     - Test 12: WhatsApp reply on today's same-day stop with tomorrow's slot link.
     - Test 13: WhatsApp reply on today's same-day stop for queue-only doctor.
3. **Verification**:
   - `npm run typecheck`
   - Vitest test suite (`npm run test`) 100% green.
