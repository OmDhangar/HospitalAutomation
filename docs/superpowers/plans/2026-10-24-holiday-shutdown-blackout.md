# Multi-Day Holiday & Shutdown Blackout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the unified OPD closure resolver, calendar-range holiday and shutdown blackout engine with automated state-machine cancellations, WhatsApp patient notices, and the dashboard Stop OPD visibility lifecycle.

**Architecture:** A single unified resolver (`resolveOpdClosure`) serves as the single source of truth for all four platform intake gates (walk-in, slot booking, discovery, and WhatsApp inbound bot). A new `blackout_periods` table backed by strict tenant RLS records calendar closures. Scheduling a blackout takes deterministic row locks (`lockDoctorDay`), cancels cancellable appointments through state machine transitions with `queue_events` audit writes, voids draft consultation bill items, and enqueues Meta-approved cancellation notices.

**Tech Stack:** Next.js 16 (App Router), Drizzle ORM, PostgreSQL (RLS), TypeScript, Vitest, Meta WhatsApp Cloud API.

**Spec:** `docs/superpowers/specs/2026-10-24-holiday-shutdown-blackout-design.md`

---

## Global Constraints

- Never compare UTC timestamps directly against calendar dates; compare `DATE` (`YYYY-MM-DD`) strings using `serviceDateIn(hospital.timezone, timestamp)`.
- Multi-tenant isolation enforced via `hospital_id = nullif(current_setting('app.hospital_id', true), '')::uuid` and `withTenant(hospitalId, tx)`.
- Blackout mutations are strictly owner-only under permission `hospital.configure`.
- Cancellations must never execute via raw `UPDATE status = 'CANCELLED'`; they must check `canCancel(status)` from `lib/domain/queue.ts`, update `appointments.status = 'CANCELLED'`, and append to `queue_events`.
- Appointments in `CALLED` (if starting today), `IN_CONSULTATION`, and `COMPLETED` must never be cancelled.

---

## Review Focus

1. **Concurrent walk-in during blackout creation**: Verified serialized by `lockDoctorDay` on `doctor_day_states` with deterministic `doctorIds.sort()` ordering.
2. **Missing or null `branchId` in closure resolver**: Prevented by requiring `branchId: string` on `resolveOpdClosure`, passed directly from `doctor.branchId`.
3. **Overlapping blackouts**: Prevented at creation time with friendly validation error rejecting overlapping ranges for the same scope.
4. **WhatsApp monthly canary ratio spike**: Prevented by explicitly excluding `milestone = 'appointment_cancelled:blackout'` from `hospitalMessageRatio` numerator in `lib/notify/worker.ts`.
5. **Null dereference in dashboard error handling**: Prevented by safely extracting `err.stoppedAt?.toISOString()` and propagating `reopenDate` and `publicReason`.

---

### Task 1: Stop OPD Button Visibility Lifecycle on Dashboard

**Files:**
- Modify: `app/(app)/dashboard/opd-stop-control.tsx`
- Modify: `app/(app)/dashboard/page.tsx`
- Test: `components/__tests__/opd-stop-control.test.tsx`

**Interfaces:**
- Consumes: `OpdStopControl({ doctorId, status, timezone, sessionStarted }: { doctorId: string; status?: OpdStopControlStatus | null; timezone?: string; sessionStarted?: boolean })`
- Produces: Hides "Stop OPD today" button when `!sessionStarted && !stoppedAt`. Retains status badges when `isStopped` or `scheduled`.

- [ ] **Step 1: Update unit test to verify button visibility lifecycle**
  Add tests in `components/__tests__/opd-stop-control.test.tsx`:
  - `sessionStarted = false` and `stoppedAt = null` renders empty string (`null`).
  - `sessionStarted = true` and `stoppedAt = null` renders `"Stop OPD today"`.
  - `isStopped = true` renders `"OPD closed at..."` badge even when `sessionStarted = false`.

- [ ] **Step 2: Run test to verify failure**
  Run: `npx vitest run components/__tests__/opd-stop-control.test.tsx`
  Expected: FAIL (button currently rendered regardless of `sessionStarted`).

- [ ] **Step 3: Implement `sessionStarted` prop in `OpdStopControl`**
  In `app/(app)/dashboard/opd-stop-control.tsx`, accept `sessionStarted: boolean = false`. In State 1 (`!stoppedAt`), `if (!sessionStarted) return null;`.

- [ ] **Step 4: Pass `sessionStarted` in `app/(app)/dashboard/page.tsx`**
  Pass `sessionStarted={Boolean(snapshot?.sessionStartedAt)}` into `<OpdStopControl />` at doctor view and receptionist view.

- [ ] **Step 5: Run test to verify it passes**
  Run: `npx vitest run components/__tests__/opd-stop-control.test.tsx`
  Expected: PASS.

- [ ] **Step 6: Commit**
  ```bash
  git add components/__tests__/opd-stop-control.test.tsx app/\(app\)/dashboard/opd-stop-control.tsx app/\(app\)/dashboard/page.tsx
  git commit -m "feat(dashboard): show Stop OPD button only after session is started"
  ```

---

### Task 2: Database Migration & Schema for `blackout_periods`

**Files:**
- Create: `drizzle/0071_blackout_periods.sql`
- Modify: `drizzle/meta/_journal.json`
- Modify: `lib/db/schema.ts`
- Modify: `scripts/migrate.ts`

**Interfaces:**
- Produces: `blackoutPeriods` table in `lib/db/schema.ts` with columns `id`, `hospitalId`, `branchId`, `doctorId`, `startDate`, `endDate`, `reopenDate`, `reason`, `publicReason`, `createdByUserId`, `cancelledAt`, `cancelledByUserId`, `createdAt`, `updatedAt`. Strict RLS applied.

- [ ] **Step 1: Write migration SQL file `drizzle/0071_blackout_periods.sql`**
  Add DDL with `CREATE TABLE blackout_periods`, indexes, check constraints (`end_date >= start_date`, `reopen_date > end_date`), and full `DO $outer$ ... FOREACH ...` RLS block from `0026_billing_foundation.sql`.

- [ ] **Step 2: Register migration in `drizzle/meta/_journal.json`**
  Append entry: `{"idx": 56, "version": "7", "when": 1792250000000, "tag": "0071_blackout_periods", "breakpoints": true}`.

- [ ] **Step 3: Declare `blackoutPeriods` in `lib/db/schema.ts`**
  Define `blackoutPeriods = pgTable('blackout_periods', ...)` matching the SQL schema.

- [ ] **Step 4: Update `scripts/migrate.ts` for safe idempotent DDL**
  Add table existence check and DDL if needed in `scripts/migrate.ts`.

- [ ] **Step 5: Run typecheck to verify schema declaration**
  Run: `npm run typecheck`
  Expected: PASS.

- [ ] **Step 6: Commit**
  ```bash
  git add drizzle/0071_blackout_periods.sql drizzle/meta/_journal.json lib/db/schema.ts scripts/migrate.ts
  git commit -m "feat(db): add blackout_periods table with strict RLS (migration 0071)"
  ```

---

### Task 3: Domain Error & Closure Context Refinement

**Files:**
- Modify: `lib/domain/queue.ts`
- Create: `lib/domain/__tests__/blackout.test.ts`

**Interfaces:**
- Produces: `OpdClosureInfo` interface and enhanced `OpdClosedError` with properties `stoppedAt`, `closureType`, `isMultiDay`, `serviceDate`, `reopenDate`, `reason`, `publicReason`. Fully backwards-compatible with `new OpdClosedError(date)`.

- [ ] **Step 1: Write failing unit test in `lib/domain/__tests__/blackout.test.ts`**
  Verify:
  - `new OpdClosedError(new Date())` sets `closureType: 'stop_today'`, message `'OPD is closed for today'`.
  - `new OpdClosedError({ closureType: 'blackout', serviceDate: '2026-10-25', reopenDate: '2026-10-28', reason: 'Diwali' })` sets properties and message `'OPD is closed on 2026-10-25'`.

- [ ] **Step 2: Run test to verify failure**
  Run: `npx vitest run lib/domain/__tests__/blackout.test.ts`
  Expected: FAIL (`closureType`, `reopenDate` undefined).

- [ ] **Step 3: Implement enhanced `OpdClosedError` in `lib/domain/queue.ts`**
  Update constructor to accept `OpdClosureInfo | Date`.

- [ ] **Step 4: Run test to verify it passes**
  Run: `npx vitest run lib/domain/__tests__/blackout.test.ts`
  Expected: PASS.

- [ ] **Step 5: Commit**
  ```bash
  git add lib/domain/queue.ts lib/domain/__tests__/blackout.test.ts
  git commit -m "feat(domain): enhance OpdClosedError with blackout closure metadata"
  ```

---

### Task 4: Unified OPD Closure Resolver

**Files:**
- Modify: `lib/services/opd-hours.ts`
- Test: `lib/services/__tests__/opd-hours.integration.test.ts`

**Interfaces:**
- Consumes: `blackout_periods`, `doctor_day_states`
- Produces: `resolveOpdClosure(args: { hospitalId: string; doctorId: string; branchId: string; serviceDate: string; now?: Date; timezone?: string }): Promise<OpdClosureResolution>`

- [ ] **Step 1: Write integration tests for `resolveOpdClosure`**
  Add tests in `lib/services/__tests__/opd-hours.integration.test.ts`:
  - Returns `closureType: 'none'` when open.
  - Returns `closureType: 'blackout'` when `serviceDate` falls within active blackout.
  - Correctly selects blackout with latest `end_date` when overlapping (NB2).
  - Matches hospital-wide (`branch_id IS NULL`) or branch-specific (`branch_id = :branchId`).
  - Returns `closureType: 'stop_today'` when today is stopped via `opd_stopped_at`.

- [ ] **Step 2: Run test to verify failure**
  Run: `npx vitest run lib/services/__tests__/opd-hours.integration.test.ts`
  Expected: FAIL (`resolveOpdClosure is not defined`).

- [ ] **Step 3: Implement `resolveOpdClosure` in `lib/services/opd-hours.ts`**
  Implement logic checking `blackout_periods` first (`ORDER BY end_date DESC, created_at DESC LIMIT 1`), then `doctor_day_states` for today.

- [ ] **Step 4: Run test to verify it passes**
  Run: `npx vitest run lib/services/__tests__/opd-hours.integration.test.ts`
  Expected: PASS.

- [ ] **Step 5: Commit**
  ```bash
  git add lib/services/opd-hours.ts lib/services/__tests__/opd-hours.integration.test.ts
  git commit -m "feat(services): implement unified resolveOpdClosure resolver"
  ```

---

### Task 5: Blackout Management Core Service

**Files:**
- Create: `lib/services/blackout.ts`
- Create: `lib/services/__tests__/blackout.integration.test.ts`

**Interfaces:**
- Consumes: `withTenant`, `lockDoctorDay`, `canCancel`, `queueEvents`, `appointments`, `notificationOutbox`
- Produces:
  - `previewBlackoutDisruption(args): Promise<{ totalAppointments, willCancel, inConsultationOrDone, messageCount }>`
  - `createBlackoutPeriodAndNotify(args): Promise<{ blackoutId, cancelledCount, notifiedCount }>`
  - `cancelBlackoutPeriod(args): Promise<void>`
  - `listBlackoutPeriods(args): Promise<BlackoutPeriodItem[]>`

- [ ] **Step 1: Write integration tests for blackout service in `lib/services/__tests__/blackout.integration.test.ts`**
  - Test 1: `previewBlackoutDisruption` partitions statuses correctly: leaves `CALLED`, `IN_CONSULTATION`, `COMPLETED` alone; cancels `WAITING`, `CREATED`, `CONFIRMED`.
  - Test 2: `createBlackoutPeriodAndNotify` cancels appointments with state machine transition, records `queue_events`, and queues `opd_appointment_cancelled` outbox notices.
  - Test 3: Doctor-specific blackout isolates cancellations to target doctor.
  - Test 4: Overlapping active blackout creation is rejected with validation error (NB4).
  - Test 5: Multi-doctor today lock serializes deterministically (`doctorIds.sort()`, NB-NEW-2).
  - Test 6: `cancelBlackoutPeriod` un-blackouts and updates `cancelled_at`.

- [ ] **Step 2: Run test to verify failure**
  Run: `npx vitest run lib/services/__tests__/blackout.integration.test.ts`
  Expected: FAIL (`lib/services/blackout.ts not found`).

- [ ] **Step 3: Implement `lib/services/blackout.ts`**
  Implement preview, creation with deterministic doctor locks and state machine cancellations, voiding of open draft bill lines, and revocation.

- [ ] **Step 4: Run test to verify it passes**
  Run: `npx vitest run lib/services/__tests__/blackout.integration.test.ts`
  Expected: PASS.

- [ ] **Step 5: Commit**
  ```bash
  git add lib/services/blackout.ts lib/services/__tests__/blackout.integration.test.ts
  git commit -m "feat(services): implement blackout management core service"
  ```

---

### Task 6: Intake Gates Integration & Dashboard Actions

**Files:**
- Modify: `lib/services/queue.ts` (`createWalkIn`)
- Modify: `lib/services/web-booking.ts` (`bookScheduledSlot`, `getDoctorBookingDetails`)
- Modify: `lib/services/scheduling.ts` (`getDoctorSlotsForDate`)
- Modify: `app/(app)/dashboard/actions.ts` (`addWalkInDynamic`, `bookSlotWalkInDynamic`)
- Modify: `lib/services/__tests__/queue.integration.test.ts`
- Modify: `lib/services/__tests__/booking.integration.test.ts`

**Interfaces:**
- Consumes: `resolveOpdClosure`
- Produces: All intake gates reject closed dates with `OpdClosedError`. Dashboard actions return `{ ok: false, error, closureType, reopenDate, publicReason }`. Emergency walk-ins bypass.

- [ ] **Step 1: Write safety gate integration tests**
  In `lib/services/__tests__/queue.integration.test.ts` and `lib/services/__tests__/booking.integration.test.ts`:
  - `createWalkIn` throws `OpdClosedError` on active blackout (NH6 Test X).
  - `createWalkIn` with `isEmergency: true` succeeds during blackout (NH6 Test Y).
  - `createWalkIn` succeeds after blackout revocation (NH6 Test Z).
  - `bookScheduledSlot` throws `OpdClosedError` on blackout date.
  - `getDoctorSlotsForDate` returns `slots: []` and `isClosed: true` on blackout date.

- [ ] **Step 2: Run tests to verify failures**
  Run: `npx vitest run lib/services/__tests__/queue.integration.test.ts lib/services/__tests__/booking.integration.test.ts`
  Expected: FAIL.

- [ ] **Step 3: Integrate `resolveOpdClosure` into the 4 intake gates**
  - In `createWalkIn`: call `resolveOpdClosure({ hospitalId, doctorId, branchId: doctor.branchId, serviceDate: today })`.
  - In `bookScheduledSlot`: call `resolveOpdClosure({ hospitalId, doctorId, branchId: doctor.branchId, serviceDate: slotDate })`.
  - In `getDoctorSlotsForDate` & `getDoctorBookingDetails`: call `resolveOpdClosure`.
  - In `app/(app)/dashboard/actions.ts`: catch `OpdClosedError` in `addWalkInDynamic` and `bookSlotWalkInDynamic`, returning `reopenDate` and `publicReason`.

- [ ] **Step 4: Run tests to verify they pass**
  Run: `npx vitest run lib/services/__tests__/queue.integration.test.ts lib/services/__tests__/booking.integration.test.ts`
  Expected: PASS.

- [ ] **Step 5: Commit**
  ```bash
  git add lib/services/queue.ts lib/services/web-booking.ts lib/services/scheduling.ts app/\(app\)/dashboard/actions.ts lib/services/__tests__/queue.integration.test.ts lib/services/__tests__/booking.integration.test.ts
  git commit -m "feat(gates): wire resolveOpdClosure into walk-in, slots, and booking gates"
  ```

---

### Task 7: WhatsApp Conversational Bot Messaging & Canary Exclusion

**Files:**
- Modify: `lib/notify/templates.ts`
- Modify: `lib/notify/worker.ts`
- Modify: `lib/services/booking.ts`
- Test: `lib/services/__tests__/booking.integration.test.ts`

**Interfaces:**
- Produces: Contextual WhatsApp replies:
  - Future blacked-out date: informs closed until `{reopenDate}`.
  - Today multi-day blackout: informs closed until `{reopenDate}`.
  - Today same-day stop: sends tomorrow's slot booking link (if doctor accepts slots) or directs to tomorrow's live queue.
- Excludes `milestone = 'appointment_cancelled:blackout'` from monthly message canary in `worker.ts`.

- [ ] **Step 1: Write WhatsApp inbound bot integration tests in `lib/services/__tests__/booking.integration.test.ts`**
  - Test 1: Inbound message attempting to book future blacked-out date replies with reopen date and reason.
  - Test 2: Inbound message on today's multi-day blackout replies with reopen date and reason.
  - Test 3: Inbound message on same-day stop for slot-accepting doctor includes tomorrow's `/book` link.
  - Test 4: Inbound message on same-day stop for queue-only doctor directs to tomorrow's live queue without link.

- [ ] **Step 2: Run tests to verify failure**
  Run: `npx vitest run lib/services/__tests__/booking.integration.test.ts`
  Expected: FAIL.

- [ ] **Step 3: Register `opd_blackout_cancellation` in `lib/notify/templates.ts` & update `worker.ts`**
  - Add template definition to `lib/notify/templates.ts`.
  - In `lib/notify/worker.ts`, update `hospitalMessageRatio` to exclude `appointment_cancelled:blackout`.

- [ ] **Step 4: Implement contextual WhatsApp responses in `lib/services/booking.ts`**
  In `handleInboundMessage`, catch `OpdClosedError` on live-queue join and slot-booking, branching on `error.closureType` and `error.serviceDate`.

- [ ] **Step 5: Run tests to verify they pass**
  Run: `npx vitest run lib/services/__tests__/booking.integration.test.ts`
  Expected: PASS.

- [ ] **Step 6: Commit**
  ```bash
  git add lib/notify/templates.ts lib/notify/worker.ts lib/services/booking.ts lib/services/__tests__/booking.integration.test.ts
  git commit -m "feat(whatsapp): contextual bot closure replies and canary ratio exclusion"
  ```

---

### Task 8: Admin UI: Holidays & Blackouts Manager in Scheduling Settings

**Files:**
- Create: `app/(app)/settings/scheduling/holidays-manager.tsx`
- Create: `app/(app)/settings/scheduling/blackout-actions.ts`
- Modify: `app/(app)/settings/scheduling/doctor-schedule-manager.tsx`
- Modify: `app/(app)/settings/scheduling/page.tsx` (or parent loader)

**Interfaces:**
- Consumes: `previewBlackoutDisruption`, `createBlackoutPeriodAndNotify`, `cancelBlackoutPeriod`, `listBlackoutPeriods`
- Produces: Owner-only `<HolidaysAndBlackoutsManager />` with:
  - Table of active and scheduled blackouts.
  - "Add Holiday / Blackout" modal with scope selector (All Doctors vs Specific Doctor, Branch), date pickers, reason inputs, disruption preview step, and confirmation.
  - "Revoke Blackout" action modal.

- [ ] **Step 1: Create Server Actions in `app/(app)/settings/scheduling/blackout-actions.ts`**
  Actions for `previewBlackoutAction`, `createBlackoutAction`, `revokeBlackoutAction`, checking `can(session.role, 'hospital.configure')`.

- [ ] **Step 2: Build `<HolidaysAndBlackoutsManager />` component in `holidays-manager.tsx`**
  Clean, accessible UI using `@/components/ui` (`Card`, `Button`, `Field`, `Input`, `Alert`, `Table`).

- [ ] **Step 3: Integrate into `app/(app)/settings/scheduling/doctor-schedule-manager.tsx`**
  Mount component for owners.

- [ ] **Step 4: Run typecheck and component test**
  Run: `npm run typecheck`
  Expected: PASS.

- [ ] **Step 5: Commit**
  ```bash
  git add app/\(app\)/settings/scheduling/holidays-manager.tsx app/\(app\)/settings/scheduling/blackout-actions.ts app/\(app\)/settings/scheduling/doctor-schedule-manager.tsx
  git commit -m "feat(ui): add Holidays and Blackouts management interface in scheduling settings"
  ```

---

### Task 9: Full End-to-End Verification & Documentation Update

**Files:**
- Modify: `docs/architecture/migrations.md`
- Modify: `docs/architecture/progress.md`

- [ ] **Step 1: Document migration in `docs/architecture/migrations.md`**
  Document `0071_blackout_periods.sql` under §5.

- [ ] **Step 2: Update `docs/architecture/progress.md`**
  Record completed unified OPD closure and multi-day blackout milestone.

- [ ] **Step 3: Run full typecheck and test suite**
  Run:
  `npm run typecheck`
  `npm run test`
  Expected: All checks pass, 0 errors.

- [ ] **Step 4: Commit**
  ```bash
  git add docs/architecture/migrations.md docs/architecture/progress.md
  git commit -m "docs: record migration 0071 and blackout engine completion in progress docs"
  ```
