# Qurio — Pre-Implementation Codebase Analysis

## 1. Existing Relevant Files

### Schema & DB
- [`lib/db/schema.ts`](file:///d:/Projects/HospitalAutomation/lib/db/schema.ts) — All tables, enums, indexes
- [`lib/db/index.ts`](file:///d:/Projects/HospitalAutomation/lib/db/index.ts) — Tenant-scoped `withTenant()` + `getDb()`
- [`lib/db/admin.ts`](file:///d:/Projects/HospitalAutomation/lib/db/admin.ts) — Cross-tenant admin DB (bypasses RLS)

### Domain Layer (Pure Logic)
- [`lib/domain/types.ts`](file:///d:/Projects/HospitalAutomation/lib/domain/types.ts) — `APPOINTMENT_STATUSES`, `QUEUE_ACTIONS`, `QueueEntry`
- [`lib/domain/queue.ts`](file:///d:/Projects/HospitalAutomation/lib/domain/queue.ts) — State machine, `isTerminal`, `isActive`, `orderQueue`, `callNext`
- [`lib/domain/booking.ts`](file:///d:/Projects/HospitalAutomation/lib/domain/booking.ts) — WhatsApp conversation FSM
- [`lib/domain/disruption.ts`](file:///d:/Projects/HospitalAutomation/lib/domain/disruption.ts) — `isCancellableByPatient`, disruption action logic
- [`lib/domain/entitlements.ts`](file:///d:/Projects/HospitalAutomation/lib/domain/entitlements.ts) — `checkLimit`, `limitFor`, `LimitKind` (branches/doctors/staff)
- [`lib/domain/eta.ts`](file:///d:/Projects/HospitalAutomation/lib/domain/eta.ts) — ETA estimation model

### Services Layer
- [`lib/services/auth.ts`](file:///d:/Projects/HospitalAutomation/lib/services/auth.ts) — `createStaffUser`, `login`, `resolveSession`, `canMutateQueue`
- [`lib/services/queue.ts`](file:///d:/Projects/HospitalAutomation/lib/services/queue.ts) — `createWalkIn`, `advanceQueue`, `applyQueueAction`, `getQueueSnapshot`, `getPublicQueueView`, `cancelByPublicToken`
- [`lib/services/booking.ts`](file:///d:/Projects/HospitalAutomation/lib/services/booking.ts) — WhatsApp booking conversation handler
- [`lib/services/web-booking.ts`](file:///d:/Projects/HospitalAutomation/lib/services/web-booking.ts) — Web slot booking, `bookScheduledSlot`
- [`lib/services/scheduling.ts`](file:///d:/Projects/HospitalAutomation/lib/services/scheduling.ts) — `getDoctorSlotsForDate` (slot availability)
- [`lib/services/hospital.ts`](file:///d:/Projects/HospitalAutomation/lib/services/hospital.ts) — `listDoctors`, `createDoctor`, `createBranch`
- [`lib/services/entitlements.ts`](file:///d:/Projects/HospitalAutomation/lib/services/entitlements.ts) — `assertCanAdd`, `checkCanAdd`, `getEntitlements`
- [`lib/services/subscriptions.ts`](file:///d:/Projects/HospitalAutomation/lib/services/subscriptions.ts) — `getCurrentSubscription`, `listActiveTiers`
- [`lib/services/platform.ts`](file:///d:/Projects/HospitalAutomation/lib/services/platform.ts) — `getPortfolioHealth`, cross-tenant admin queries
- [`lib/services/whatsapp-integration.ts`](file:///d:/Projects/HospitalAutomation/lib/services/whatsapp-integration.ts) — Full WhatsApp integration management, `assignNumberToHospital`, `validateConnection`, credential handling
- [`lib/services/whatsapp-numbers.ts`](file:///d:/Projects/HospitalAutomation/lib/services/whatsapp-numbers.ts) — Number inventory management
- [`lib/services/audit.ts`](file:///d:/Projects/HospitalAutomation/lib/services/audit.ts) — `listQueueEvents`, `listAuditLogs`
- [`lib/services/sweeps.ts`](file:///d:/Projects/HospitalAutomation/lib/services/sweeps.ts) — `expireStaleAppointments`, `runSweeps`

### Notification Layer
- [`lib/notify/provider.ts`](file:///d:/Projects/HospitalAutomation/lib/notify/provider.ts) — `MetaCloudProvider`, `ConsoleProvider`, `getProvider()` (currently singleton from env token)
- [`lib/notify/worker.ts`](file:///d:/Projects/HospitalAutomation/lib/notify/worker.ts) — `drainOutbox` (outbox-pattern worker)
- [`lib/notify/webhook.ts`](file:///d:/Projects/HospitalAutomation/lib/notify/webhook.ts) — Inbound webhook handler

### Security
- [`lib/security/credentials.ts`](file:///d:/Projects/HospitalAutomation/lib/security/credentials.ts) — AES-256-GCM `sealCredential`/`openCredential` with key versioning
- [`lib/security/password.ts`](file:///d:/Projects/HospitalAutomation/lib/security/password.ts) — scrypt password hashing
- [`lib/security/tokens.ts`](file:///d:/Projects/HospitalAutomation/lib/security/tokens.ts) — `generatePublicToken`, `hashToken`

### App Routes
- [`app/(app)/dashboard/`](file:///d:/Projects/HospitalAutomation/app/(app)/dashboard) — Main reception/doctor dashboard
- [`app/(app)/admin/`](file:///d:/Projects/HospitalAutomation/app/(app)/admin) — Platform admin page
- [`app/(app)/settings/`](file:///d:/Projects/HospitalAutomation/app/(app)/settings) — Hospital settings
- [`app/display/[branchId]/`](file:///d:/Projects/HospitalAutomation/app/display/[branchId]) — Waiting room TV display
- [`app/q/[token]/`](file:///d:/Projects/HospitalAutomation/app/q/[token]) — Patient public queue page

---

## 2. Existing Relevant Services

| Service | Key Functions |
|---------|--------------|
| `auth` | `createStaffUser`, `login`, `resolveSession`, `canMutateQueue`, `canConfigureHospital` |
| `queue` | `createWalkIn`, `advanceQueue`, `applyQueueAction`, `getQueueSnapshot`, `getPublicQueueView`, `cancelByPublicToken`, `setDoctorPaused` |
| `hospital` | `listDoctors`, `createDoctor`, `createBranch`, `getHospital`, `setDoctorActive` |
| `entitlements` | `assertCanAdd`, `checkCanAdd`, `getEntitlements` — already checks `maxDoctors`, `maxStaffLogins` |
| `platform` | `getPortfolioHealth`, `getRecentFailures` — cross-tenant via admin DB |
| `whatsapp-integration` | `assignNumberToHospital`, `validateConnection`, `getIntegrationView` — already complete with credential encryption |
| `scheduling` | `getDoctorSlotsForDate` — slot availability query |
| `sweeps` | `expireStaleAppointments`, `runSweeps` |
| `audit` | `listQueueEvents`, `listAuditLogs` |

---

## 3. Existing Queue State Machine

```
CREATED → confirm → CONFIRMED | cancel → CANCELLED | expire → EXPIRED
CONFIRMED → arrive → ARRIVED | enqueue → WAITING | cancel → CANCELLED | mark_no_show → NO_SHOW | expire → EXPIRED
ARRIVED → enqueue → WAITING | cancel → CANCELLED | mark_no_show → NO_SHOW | expire → EXPIRED
WAITING → call → CALLED | hold → HELD | skip → SKIPPED | cancel → CANCELLED | mark_no_show → NO_SHOW | expire → EXPIRED
CALLED → start_consultation → IN_CONSULTATION | complete → COMPLETED | skip → SKIPPED | hold → HELD | cancel → CANCELLED | expire → EXPIRED
IN_CONSULTATION → complete → COMPLETED | hold → HELD
SKIPPED → recall → WAITING | mark_no_show → NO_SHOW | cancel → CANCELLED | expire → EXPIRED
HELD → resume → WAITING | cancel → CANCELLED | mark_no_show → NO_SHOW | expire → EXPIRED
COMPLETED → (terminal)
CANCELLED → (terminal)
NO_SHOW → (terminal)
EXPIRED → (terminal)
```

> [!IMPORTANT]
> **`HELD` already means "temporarily removed from queue and can resume later".**
> `HELD → resume → WAITING` is already in the state machine.
> `hold` action is available from: WAITING, CALLED, IN_CONSULTATION.
> This is exactly the "pause patient" semantics needed for Feature 3.

**Active statuses** (occupy queue position): `WAITING`, `CALLED`, `IN_CONSULTATION`
**Terminal statuses**: `COMPLETED`, `CANCELLED`, `NO_SHOW`, `EXPIRED`
**Parked statuses** (shown separately): `SKIPPED`, `HELD`

---

## 4. Existing Appointment Lifecycle

```
createWalkIn()  →  WAITING (directly, with enqueued_at and token)
bookScheduledSlot()  →  WAITING (with scheduled_slot_at)
advanceQueue()  →  complete current + call next (WAITING → CALLED)
applyQueueAction()  →  any valid transition via the state machine
writeTransition()  →  updates appointment row + inserts queue_event
```

Key timestamps on `appointments`:
- `enqueued_at` — when entered queue (reset on recall/resume)
- `called_at` — when called by doctor
- `consult_started_at` — when consultation began
- `completed_at` — when completed
- `scheduled_slot_at` — booked slot time (null for walk-ins)

> [!NOTE]
> **No `paused_at` or `resume_at` columns exist yet.** These need to be added for Feature 3.

---

## 5. Existing Token Allocation Logic

**Canonical mechanism**: `doctor_day_states.last_token_number`

In `createWalkIn()`, a CTE atomically:
1. Upserts `doctor_day_states` with `last_token_number + 1` (or inserts `1` for first token)
2. Uses `FOR UPDATE` row lock for concurrency
3. Assigns the token to the appointment

Comment in schema: *"tokens are allocated monotonically and never reused, even after cancellations"*

Unique constraint: `appointments_token_key` on `(doctor_id, service_date, token_number)`

The domain also has `nextTokenNumber()` in `lib/domain/queue.ts` but `doctor_day_states` is the authoritative source.

---

## 6. Existing Cancellation Logic

### Cancel paths:
1. **Patient cancel** via `cancelByPublicToken()` — validates public token, checks `isCancellableByPatient()`, locks doctor day, re-reads under lock, transitions to `CANCELLED`
2. **Staff cancel** via `applyQueueAction({ action: 'cancel' })` — validates via state machine, locks doctor day, writes transition

### `isCancellableByPatient()` allows: CREATED, CONFIRMED, ARRIVED, WAITING, HELD, SKIPPED, CALLED
### `isCancellableByPatient()` blocks: IN_CONSULTATION, COMPLETED, CANCELLED, NO_SHOW, EXPIRED

### Slot release on cancel:
In `getDoctorSlotsForDate()` line 431:
```sql
status not in ('CANCELLED', 'NO_SHOW')
```
**This correctly excludes CANCELLED from slot occupancy.** The comment in `cancelByPublicToken()` confirms: *"`getDoctorSlotsForDate` already excludes CANCELLED, so the time becomes bookable again the moment this commits"*

### Active appointment uniqueness:
The partial unique index `appointments_one_active_per_patient_key` excludes: `COMPLETED`, `CANCELLED`, `NO_SHOW`, `EXPIRED`

> [!TIP]
> **Cancellation slot release is already correct** in `getDoctorSlotsForDate`. The queue domain's `isActive()` correctly excludes CANCELLED (only WAITING, CALLED, IN_CONSULTATION are active). The "invariant audit" in Feature 5 may require only verifying consistency across all paths rather than fixing a broken query.

---

## 7. Existing User/Role Model

- `users` table with `is_platform_admin` boolean, `email`, `password_hash`, `name`
- `staff_memberships` with roles: `owner`, `receptionist`, `doctor`
- `sessions` scoped to one `hospital_id`
- Auth: `createStaffUser()` creates user + membership in transaction
- Login: resolves hospital via `resolve_user_hospital()` SQL function
- Authorization: `canMutateQueue()` (owner/receptionist/doctor), `canConfigureHospital()` (owner only)

> [!NOTE]
> `doctors` table has optional `user_id` FK — a doctor can optionally be linked to a user account.

---

## 8. Existing Subscription-Limit Logic

**Already fully implemented:**
- `plan_tiers` has `max_branches`, `max_doctors`, `max_staff_logins` (null = unlimited)
- `subscriptions` snapshots these entitlements at signing time
- `lib/domain/entitlements.ts` — pure `checkLimit()` function
- `lib/services/entitlements.ts` — `assertCanAdd()` throws `PlanLimitError` with upgrade message
- Counts: `doctors` where `active=true`, `staff_memberships` where `active=true`

**Enforcement is service-level, not yet wired into all creation paths.**

---

## 9. Existing WhatsApp Credential Handling

**Already fully implemented:**
- `whatsapp_integrations` table with AES-256-GCM encrypted credentials
- `whatsapp_numbers` table for phone numbers (platform-owned model)
- `lib/security/credentials.ts` — `sealCredential()`, `openCredential()`, key versioning
- `lib/services/whatsapp-integration.ts` — complete service with auth, validation, credential masking, disconnect
- `lib/notify/provider.ts` — `getProvider()` currently singleton from env `WHATSAPP_ACCESS_TOKEN`
- Provider comment: *"When a hospital-owned integration arrives... Constructing a MetaCloudProvider from it per hospital is the whole change"*
- `resolveCredential()` already exists in whatsapp-integration.ts

> [!IMPORTANT]
> The WhatsApp integration infrastructure is **already built**. Feature 1 needs UI, hospital onboarding flow, and wiring the provider to resolve per-hospital credentials — not building the encryption/integration from scratch.

---

## 10. Existing Waiting-Room Display Implementation

[`app/display/[branchId]/page.tsx`](file:///d:/Projects/HospitalAutomation/app/display/[branchId]/page.tsx):
- Requires staff session (TV is hospital device)
- Shows per-doctor cards with: current token (number only, no name), waiting count, seen today count
- Uses `getBranchSnapshots()` → `getQueueSnapshot()` for each doctor
- Auto-refreshes every 15 seconds via `<AutoRefresh seconds={15} />`
- **No patient names shown currently** (privacy choice)
- **No next patient shown**
- **No language toggle** (English only)
- **No Marathi support** for display labels

---

## 11. Existing Job Worker Implementation

- `jobs` table with: `kind`, `payload`, `status`, `run_after`, `attempts`, `max_attempts`, `locked_at`
- [`scripts/tick.ts`](file:///d:/Projects/HospitalAutomation/scripts/tick.ts) runs: `drainOutbox()` then `runSweeps()`
- **No generic job runner exists yet** — the `jobs` table schema is defined but no `claimAndRunJobs()` function processes arbitrary job kinds
- Sweeps are hardcoded functions, not job-kind dispatchers
- Need to build: job claim loop + `resume_paused_appointment` handler

---

## 12. Exact Files That Will Change

### Feature 1 — Platform Admin + Hospital Onboarding
| File | Change |
|------|--------|
| `app/(app)/admin/page.tsx` | Add hospital creation UI, integrate WhatsApp config panel |
| `app/(app)/admin/actions.ts` | Add `createHospitalAction` server action |
| `lib/services/platform.ts` | Add `createHospital()` transactional service |
| `lib/services/auth.ts` | May need to ensure `createStaffUser` supports owner creation by platform admin |

### Feature 2 — Hospital User Management
| File | Change |
|------|--------|
| `app/(app)/settings/` | Add doctor/staff creation UI with limit display |
| `lib/services/hospital.ts` | Ensure `createDoctor` calls `assertCanAdd` |

### Feature 3 — Doctor Dashboard + Pause/Resume
| File | Change |
|------|--------|
| `lib/db/schema.ts` | Add `paused_at`, `resume_at` to appointments |
| `lib/domain/queue.ts` | Add `occupiesBookingSlot()`, `canPause()` helpers |
| `lib/services/queue.ts` | Add `pauseAppointment()`, `resumeAppointment()` services |
| `lib/services/sweeps.ts` | Add `processResumeJobs()` to sweep cycle |
| `app/(app)/dashboard/` | Add pause/resume UI for doctor view |
| `app/q/[token]/page.tsx` | Show paused state + resume button |
| `app/q/[token]/actions.ts` | Add `resumeByPatient` action |
| `lib/i18n/patient.ts` | Add paused/resume strings |

### Feature 4 — Waiting Room Display
| File | Change |
|------|--------|
| `app/display/[branchId]/page.tsx` | Add patient names, next patient, language toggle, Marathi translations |
| `lib/services/queue.ts` | Ensure `QueueSnapshot` includes next patient info |

### Feature 5 — Cancellation Root-Cause Fix
| File | Change |
|------|--------|
| `lib/domain/queue.ts` | Add canonical `occupiesBookingSlot()`, `canCancel()` helpers |
| `lib/services/scheduling.ts` | Audit slot query uses status helpers |
| `lib/services/queue.ts` | Audit cancel paths use domain helpers consistently |

---

## 13. Exact Migrations Required

### Migration: `0022_pause_resume.sql`
```
ALTER TABLE appointments ADD COLUMN paused_at TIMESTAMPTZ;
ALTER TABLE appointments ADD COLUMN resume_at TIMESTAMPTZ;
```

### Migration: `0023_resume_jobs.sql` (if needed)
The `jobs` table already exists and has a generic `kind`/`payload` structure. No schema change needed — just need a job processor for `resume_paused_appointment` kind.

> [!NOTE]
> **No new enums needed.** `HELD` already exists as an appointment status. `hold` and `resume` already exist as queue actions. No new roles needed — `owner`, `receptionist`, `doctor` cover all Feature 2 requirements.

---

## Key Architectural Findings

1. **HELD status is exactly the pause semantic** — no new status needed
2. **WhatsApp integration infrastructure is already built** — needs UI wiring, not crypto implementation
3. **Entitlement limits already exist** in both domain and service layers — need to wire into creation flows
4. **Cancellation slot release is correct** in `getDoctorSlotsForDate` — audit should verify consistency across all booking paths
5. **Jobs table exists but no generic runner** — need to build a simple kind-based dispatcher in tick.ts
6. **Display page is token-only** — adding names is a product decision change, not a bug fix
7. **i18n system exists** for patient-facing pages — needs display-board translation dict
