# IPD eMAR Phase 4: Bedside Nursing eMAR & Administration Interface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Bedside Nursing Electronic Medication Administration Record (eMAR) interface enabling nurses to review time-bucketed orders (`Due Now`, `Overdue`, `Upcoming`, `PRN / SOS`, `On Hold`, `Recent History`), execute rapid bedside dose administration verification (< 3 taps), and record non-administration exceptions with mandatory clinical reasons.

**Architecture:** Client orchestrator (`BedsideEmar`) consuming `getBedsideEmar` data, organizing tasks into work-oriented buckets, and dispatching atomic `recordAdministrationAction`, `recordExceptionAction`, and `voidAdministrationAction` Server Actions. Discrete point-in-time bolus doses only (no continuous infusions).

**Tech Stack:** Next.js (App Router, Server Actions), React 19, TypeScript, Tailwind CSS, PostgreSQL / Drizzle ORM, Vitest.

**Spec:** [`docs/superpowers/specs/2026-10-12-ipd-doctor-rounding-prescriptions-design.md`](file:///d:/Projects/HospitalAutomation/docs/superpowers/specs/2026-10-12-ipd-doctor-rounding-prescriptions-design.md) (SPEC-IPD-EMAR-001).

## Global Constraints

- **Discrete Bolus Doses Only:** MVP eMAR execution charts discrete point-in-time doses only (oral, IV push, IV piggyback, IM, SC, nebulization, topical, rectal, sublingual). Continuous IV infusions are explicitly deferred to Phase 6.
- **Signed Order Invariant:** Unsigned or draft orders are completely invisible and non-actionable on the nursing eMAR.
- **Occurrence Deduplication:** Scheduled dose occurrences use `(hospital_id, order_id, scheduled_time)` partial uniqueness to prevent multiple nurses from double-administering the same dose slot.
- **PRN Safety & Advisory Locks:** PRN doses strictly evaluate cross-version cooldown windows (`prn_min_interval_hours`) and chart day ceilings (`prn_max_daily_doses`, `prn_max_daily_quantity`) with transaction-level advisory locks.
- **Zero Migrations:** Do not run `npm run db:migrate`. The schema is already fully defined.
- **Dual Access Surface:** Accessible both as a first-class sheet tab on the patient file (`/ipd/admissions/[id]/(file)/emar`) and at the bedside on ward tablets (`/ipd/ward/[wardId]/bed/[bedId]`).

## Review Focus

1. **Concurrent Duplicate Administration:** Two nurses tapping the same scheduled dose simultaneously across ward tablets — database unique index on occurrence rejects the second submission with clear user feedback.
2. **Concurrent Order Modification/Hold/Discontinuation:** Doctor modifies or holds an order while the nurse's screen is open — attempting administration rejects with a descriptive order-inactive error.
3. **PRN Dose Interval Violation:** Nurse attempts to administer PRN analgesics before cooldown has elapsed — button is disabled with remaining minutes/hours countdown, and service rejects if bypassed.
4. **Non-Administration Exception Traceability:** Omitted, refused, or held doses require mandatory structured reasons (e.g. NPO, patient refusal, low vitals) and clear from Due Now while remaining visible in Recent History.
5. **Accidental Administration Voiding:** Erroneously filed administration can be voided with mandatory reason by authorized staff, un-indexing the scheduled slot and reversing billing via outbox.

---

### Task 1: eMAR Server Actions & File Tab Navigation

**Files:**
- Modify: `app/(app)/ipd/actions.ts`
- Modify: `lib/modules/registry.ts`
- Test: Unit/integration tests in `lib/services/__tests__/ipd-emar.integration.test.ts`

**Interfaces:**
- `recordAdministrationAction(args: { admissionId: string; orderId: string; input: RecordAdministrationInput })`: Authorized for `ipd.administer`. Revalidates admission, emar, and ward routes.
- `recordExceptionAction(args: { admissionId: string; orderId: string; input: RecordExceptionInput })`: Authorized for `ipd.administer`. Revalidates admission, emar, and ward routes.
- `voidAdministrationAction(args: { admissionId: string; administrationId: string; reason: string })`: Authorized for `ipd.administer` / `ipd.prescribe`. Revalidates routes.
- `registry.ts`: Register `emar` fileTab under `core_ipd` with `slug: 'emar'`, `label: 'eMAR'`, `permission: 'ipd.view'`, `order: 8`.

- [ ] **Step 1: Write integration tests for eMAR Server Actions**
- [ ] **Step 2: Run test to verify it fails (RED)**
- [ ] **Step 3: Implement Server Actions in `app/(app)/ipd/actions.ts` and update `lib/modules/registry.ts`**
- [ ] **Step 4: Run test to verify it passes (GREEN)**
- [ ] **Step 5: Commit Task 1**

---

### Task 2: Bedside eMAR Task Bucket Timeline & Cards

**Files:**
- Create: `components/ipd/emar/emar-bucket-tabs.tsx`
- Create: `components/ipd/emar/emar-task-card.tsx`
- Create: `components/ipd/emar/emar-recent-history.tsx`
- Test: Unit tests in `components/ipd/emar/__tests__/emar-components.test.tsx`

**Interfaces:**
- `EmarBucketTabs`: Segmented tab bar with counts: `Due Now (N)`, `Overdue (M)`, `Upcoming (U)`, `PRN / SOS (P)`, `On Hold (H)`, `Recent History (R)`.
- `EmarTaskCard`: Card for scheduled/PRN tasks displaying drug name, dose, unit, route, scheduled time, special instructions, PRN indication/cooldown, and action buttons (`Administer`, `Exception`).
- `EmarRecentHistory`: Timeline of past 24-hour administration events and logged exceptions with timestamp, nurse name, dose given, and status badge.

- [ ] **Step 1: Implement `components/ipd/emar/emar-bucket-tabs.tsx`**
- [ ] **Step 2: Implement `components/ipd/emar/emar-task-card.tsx`**
- [ ] **Step 3: Implement `components/ipd/emar/emar-recent-history.tsx`**
- [ ] **Step 4: Write component unit tests in `components/ipd/emar/__tests__/emar-components.test.tsx`**
- [ ] **Step 5: Run tests and verify they pass**
- [ ] **Step 6: Commit Task 2**

---

### Task 3: Administration Verification, Exception, and PRN Modals

**Files:**
- Create: `components/ipd/emar/administer-modal.tsx`
- Create: `components/ipd/emar/exception-modal.tsx`
- Create: `components/ipd/emar/prn-admin-modal.tsx`
- Test: Unit tests in `components/ipd/emar/__tests__/emar-components.test.tsx`

**Interfaces:**
- `AdministerModal`: Rapid bedside verification (< 3 taps). Verifies patient identity and allergy warning, pre-fills dose and route, allows custom actual time and injection/administration site notes, and invokes `recordAdministrationAction`.
- `ExceptionModal`: Records non-administration (`omitted`, `refused`, `held`) with mandatory structured reason selector (`NPO for surgery`, `Patient refused`, `Low BP / vitals`, `Vomiting`, `Off-ward`, `Drug unavailable`) and optional clinical note.
- `PrnAdminModal`: PRN dose verification with real-time remaining doses today, remaining cumulative quantity, cooldown countdown timer, and administration submission.

- [ ] **Step 1: Implement `components/ipd/emar/administer-modal.tsx`**
- [ ] **Step 2: Implement `components/ipd/emar/exception-modal.tsx`**
- [ ] **Step 3: Implement `components/ipd/emar/prn-admin-modal.tsx`**
- [ ] **Step 4: Add modal tests in `components/ipd/emar/__tests__/emar-components.test.tsx`**
- [ ] **Step 5: Run tests and verify they pass**
- [ ] **Step 6: Commit Task 3**

---

### Task 4: Bedside eMAR Orchestrator & Patient File Tab Integration

**Files:**
- Create: `components/ipd/emar/bedside-emar.tsx`
- Create: `app/(app)/ipd/admissions/[id]/(file)/emar/page.tsx`
- Modify: `components/ipd/record-screen.tsx` (add direct switch / banner to eMAR tasks)
- Test: Page integration test in `components/ipd/emar/__tests__/bedside-emar-e2e.test.tsx`

**Interfaces:**
- `BedsideEmar`: Top-level client orchestrator managing active bucket tab, selected dose task, modal states, real-time optimistic updates, and server action revalidation.
- `EmarPage`: Patient file sheet page under `/ipd/admissions/[id]/(file)/emar` loading data via `getBedsideEmar` and rendering `BedsideEmar`.
- `RecordScreen`: Bedside record screen displays summary banner with pending due medications for the bed's occupant, linking directly to the eMAR tab.

- [ ] **Step 1: Implement `components/ipd/emar/bedside-emar.tsx`**
- [ ] **Step 2: Implement `app/(app)/ipd/admissions/[id]/(file)/emar/page.tsx`**
- [ ] **Step 3: Enhance `components/ipd/record-screen.tsx` with eMAR pending doses banner**
- [ ] **Step 4: Write end-to-end integration test in `components/ipd/emar/__tests__/bedside-emar-e2e.test.tsx`**
- [ ] **Step 5: Run integration test to verify it passes**
- [ ] **Step 6: Commit Task 4**

---

### Task 5: End-to-End Verification & System Regression Suite

**Files:**
- Test: Full integration test suite & `npm run typecheck`.

- [ ] **Step 1: Run complete eMAR and cockpit test suites**
- [ ] **Step 2: Run `npm run typecheck` across entire workspace**
- [ ] **Step 3: Verify 0 type errors, 0 test failures, and 0 database migration executions**
- [ ] **Step 4: Commit Task 5**
