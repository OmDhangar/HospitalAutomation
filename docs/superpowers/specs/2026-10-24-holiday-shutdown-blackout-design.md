# Architectural Specification: Multi-Day Holiday & Shutdown Blackout

**Date:** 2026-10-24  
**Author:** OmDhangar / Antigravity Pair  
**Status:** Approved for Implementation  
**Tracking Migration:** `0071_blackout_periods.sql`  

---

## 1. Executive Summary

This feature delivers an engine-level multi-day holiday and shutdown blackout system for Qurio/QueueCare, allowing administrators to schedule temporary closures for the entire hospital or individual doctors. 

When a blackout is scheduled:
1. All existing booked appointments within the date range are automatically cancelled, and affected patients receive a WhatsApp cancellation notice with the closure reason and reopen date.
2. Web slot booking and walk-in intake gates immediately block new bookings across that date range.
3. When patients attempt to book via WhatsApp:
   - **Multi-day closure:** The bot informs them that today's OPD is closed and will remain closed until the specified reopen date.
   - **Single-day closure:** The bot informs them that today's OPD is closed and provides a direct link to book tomorrow's slot (if the doctor accepts slots) or directs them to return tomorrow for the live queue.
4. On the staff/doctor dashboard, the **"Stop OPD"** button is made visible only after staff have started the OPD session (`sessionStarted === true`), avoiding confusion before intake has even commenced.

---

## 2. Architecture & Data Model

### 2.1 Database Schema: `blackout_periods`

The table is defined in `lib/db/schema.ts` and managed under multi-tenant Row Level Security (RLS).

```sql
CREATE TABLE blackout_periods (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  doctor_id UUID REFERENCES doctors(id) ON DELETE CASCADE, -- NULL = Hospital-wide (all doctors), set = Doctor-specific
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  reopen_date DATE NOT NULL,
  reason TEXT NOT NULL,
  created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  cancelled_at TIMESTAMPTZ, -- Set if admin revokes/cancels the blackout early
  cancelled_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT blackout_date_range_valid CHECK (end_date >= start_date),
  CONSTRAINT blackout_reopen_date_valid CHECK (reopen_date > end_date)
);

CREATE INDEX blackout_periods_lookup_idx ON blackout_periods (hospital_id, doctor_id, start_date, end_date)
  WHERE cancelled_at IS NULL;
```

### 2.2 Permissions & Security
- Managed by `owner` and `admin` roles via permission `scheduling.manage`.
- Multi-tenant isolation enforced via `hospital_id = current_setting('app.current_hospital_id', true)::uuid`.
- All writes run inside `withTenant(hospitalId, tx)` ensuring complete tenant safety.

---

## 3. Domain Model & Errors

### 3.1 `OpdClosedError` Refinement ([lib/domain/queue.ts](file:///d:/Projects/HospitalAutomation/lib/domain/queue.ts))
`OpdClosedError` is expanded to carry blackout context:

```typescript
export interface OpdClosureInfo {
  stoppedAt?: Date | null;
  isMultiDay?: boolean;
  reopenDate?: string | null; // e.g. "2026-10-29"
  endDate?: string | null;    // e.g. "2026-10-28"
  reason?: string | null;
}

export class OpdClosedError extends Error {
  readonly stoppedAt: Date | null;
  readonly isMultiDay: boolean;
  readonly reopenDate: string | null;
  readonly reason: string | null;

  constructor(closure: OpdClosureInfo | Date) {
    super('OPD is closed');
    this.name = 'OpdClosedError';
    if (closure instanceof Date) {
      this.stoppedAt = closure;
      this.isMultiDay = false;
      this.reopenDate = null;
      this.reason = null;
    } else {
      this.stoppedAt = closure.stoppedAt ?? null;
      this.isMultiDay = Boolean(closure.isMultiDay);
      this.reopenDate = closure.reopenDate ?? null;
      this.reason = closure.reason ?? null;
    }
  }
}
```

---

## 4. Services & Business Logic

### 4.1 Blackout Service ([lib/services/blackout.ts](file:///d:/Projects/HospitalAutomation/lib/services/blackout.ts))
1. **`createBlackoutPeriodAndNotify`**:
   - Validates `startDate <= endDate` and `reopenDate > endDate`.
   - Inserts row into `blackout_periods`.
   - Identifies all appointments where `status IN ('CREATED', 'CONFIRMED', 'WAITING')` scheduled between `startDate` and `endDate`.
   - Cancels these appointments (`status = 'CANCELLED'`).
   - Inserts WhatsApp notifications into `notification_outbox` for each affected patient.
2. **`cancelBlackoutPeriod`**:
   - Sets `cancelled_at = now()` and `cancelled_by_user_id = actor.id`.
3. **`getActiveBlackout`**:
   - Queries if a given `serviceDate` falls within `start_date <= serviceDate AND end_date >= serviceDate` where `cancelled_at IS NULL` and `(doctor_id IS NULL OR doctor_id = :doctorId)`.
4. **`listBlackoutPeriods`**:
   - Lists active/upcoming blackouts for the admin interface.

### 4.2 Intake Gates & Scheduling Integration
- **Slot Discovery (`getDoctorSlotsForDate` in `lib/services/scheduling.ts` & `getDoctorBookingDetails` in `lib/services/web-booking.ts`)**:
  - Checks `getActiveBlackout`. If active, returns `slots: []`, `isClosed: true`, `isMultiDay: true`, and `reopenDate`.
- **Intake Gates (`createWalkIn` and `bookScheduledSlot`)**:
  - Checks `getActiveBlackout`. If active, throws `OpdClosedError({ isMultiDay: true, reopenDate, reason })`.

### 4.3 WhatsApp Conversational Booking (`lib/services/booking.ts`)
When `OpdClosedError` is caught at inbound messaging:
- **Multi-day closure** (`error.isMultiDay || error.reopenDate`):
  - Sends: `"Today's OPD is closed and will remain closed until ${error.reopenDate}${error.reason ? ` due to ${error.reason}` : ''}. Please visit us after reopening."`
- **Single-day closure**:
  - Checks if doctor accepts slots (`scheduleMode === 'slot' || scheduleMode === 'both'`).
  - If yes, builds tomorrow's booking link:
    `${baseUrl}/book?doctor=${doctor.id}&phone=${encodeURIComponent(phoneE164)}&hospital=${hospitalId}&locale=${locale}&date=${tomorrow}`
    Sends: `"Today's OPD is closed. You can book a slot for tomorrow using this link: ${bookUrl} or return tomorrow for the live queue."`
  - If queue-only, sends: `"Today's OPD is closed. Please return tomorrow for the live queue."`

---

## 5. User Interface & Controls

### 5.1 Admin Scheduling UI ([app/(app)/settings/scheduling](file:///d:/Projects/HospitalAutomation/app/(app)/settings/scheduling))
- New card component `<HolidaysAndBlackoutsManager />`:
  - List of active & upcoming blackout periods with revoke/cancel actions.
  - "Add Holiday / Blackout" modal with scope selection (Hospital-wide vs Doctor-specific), date pickers, reason presets, and clear warning about automatic cancellation of existing appointments.

### 5.2 Dashboard Stop OPD Button Visibility ([app/(app)/dashboard/opd-stop-control.tsx](file:///d:/Projects/HospitalAutomation/app/(app)/dashboard/opd-stop-control.tsx))
- `OpdStopControl` accepts `sessionStarted?: boolean`.
- When `!sessionStarted && !stoppedAt`, returns `null` (hiding the "Stop OPD today" button until OPD is started).
- If OPD is already stopped or scheduled, the status badge with Reopen / Cancel actions remains visible at all times.

---

## 6. Testing & Verification

1. **Unit Tests**:
   - `components/__tests__/opd-stop-control.test.tsx`: Verifies button is hidden when `sessionStarted` is false, shown when true, and badge stays visible when stopped.
   - `lib/domain/__tests__/blackout.test.ts`: Verifies `OpdClosedError` behavior.
2. **Integration Tests**:
   - `lib/services/__tests__/blackout.integration.test.ts`:
     - Test hospital-wide blackout: cancels appointments, enqueues WhatsApp notices.
     - Test doctor-specific blackout: isolates cancellations to the target doctor.
     - Test slot generation and intake gates block appointments during blackouts.
     - Test revocation restores intake.
   - `lib/services/__tests__/booking.integration.test.ts`:
     - Test WhatsApp bot replies with multi-day reopen date on multi-day closure.
     - Test WhatsApp bot replies with tomorrow's slot link on single-day closure when doctor accepts slots.
     - Test WhatsApp bot replies with live queue instructions when doctor is queue-only.
3. **Verification**:
   - `npm run typecheck`
   - Vitest test suite run.
