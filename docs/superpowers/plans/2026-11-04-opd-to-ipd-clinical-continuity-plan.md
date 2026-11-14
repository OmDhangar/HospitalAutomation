# OPD-to-IPD Clinical Continuity Implementation Plan

> **Goal:** Connect OPD doctor prescribing to inpatient admission by automatically porting active OPD prescription items into draft inpatient medication orders upon "Shift to IPD", providing a 1-click review and approval cockpit for admitting doctors, and immediately unlocking bedside eMAR administration.

**Architecture:** A domain service (`lib/services/ipd-admission-continuity.ts`) parses OPD doses and frequencies, inserts `draft` rows into `ipd_medication_orders` during admission transitions, and evaluates allergy and duplicate safety gates upon approval. Server actions in `app/(app)/ipd/actions.ts` provide RBAC-guarded mutation endpoints. The UI in `components/ipd/orders/minimal-orders-tab.tsx` and `app/(app)/ipd/patients/[id]/summary/page.tsx` renders reactive review controls.

**Tech Stack:** Next.js 16 (App Router, Server Actions), React 19, TypeScript, Drizzle ORM, PostgreSQL with RLS, Vitest.

**Spec:** [`docs/superpowers/specs/2026-11-04-opd-to-ipd-clinical-continuity-design.md`](file:///d:/Projects/HospitalAutomation/docs/superpowers/specs/2026-11-04-opd-to-ipd-clinical-continuity-design.md)

---

## Task Breakdown

### Task 1: Domain Logic for OPD Dose Parsing & Frequency Mapping
**Files:**
- Create: `lib/domain/opd-to-ipd-parser.ts`
- Test: `lib/domain/__tests__/opd-to-ipd-parser.test.ts`

- [ ] **Step 1: Write unit tests for `parseOpdDose` and `mapFrequencyToTimes`**
  - Test parsing numeric amounts and units from various formats (`"500 mg"`, `"650mg"`, `"1 tab"`, `"2 puffs"`, `"10 ml"`).
  - Test mapping clinical frequencies (`OD`, `BD`, `TDS`, `QID`, `SOS`, `STAT`, `HS`) to schedule times and PRN flags.
  - Test fallback handling for non-standard inputs.
- [ ] **Step 2: Run test to verify failure**
  - Run: `npx vitest run lib/domain/__tests__/opd-to-ipd-parser.test.ts`
- [ ] **Step 3: Implement `lib/domain/opd-to-ipd-parser.ts`**
  - Export `parseOpdDose(dose: string, fallbackUnit?: string | null): { doseAmount: string; doseUnit: string }`
  - Export `mapFrequencyToTimes(frequency: string): { frequencyCode: string; scheduleTimes: string[]; scheduleType: 'scheduled' | 'prn' | 'stat'; isPrn: boolean }`
  - Export `mapRoute(route?: string | null): IpdRoute`
- [ ] **Step 4: Run test to verify pass**
  - Run: `npx vitest run lib/domain/__tests__/opd-to-ipd-parser.test.ts`

---

### Task 2: Inpatient Admission Continuity Service
**Files:**
- Create: `lib/services/ipd-admission-continuity.ts`
- Test: `lib/services/__tests__/ipd-admission-continuity.test.ts`

- [ ] **Step 1: Write integration tests for `portOpdPrescriptionsToIpdDraftsInTx`, `approveDraftOrder`, and `rejectDraftOrder`**
  - Test porting: verify active OPD prescription items are converted to `ipd_medication_orders` with status `'draft'` and special instructions referencing OPD prescription.
  - Test approval: verify status transitions from `'draft'` to `'active'` with timestamp `signedAt`.
  - Test rejection: verify status transitions to `'voided'` with `voidReason`.
  - Test bulk approval: verify all valid drafts transition to `'active'`.
- [ ] **Step 2: Run test to verify failure**
  - Run: `npx vitest run lib/services/__tests__/ipd-admission-continuity.test.ts`
- [ ] **Step 3: Implement `lib/services/ipd-admission-continuity.ts`**
  - Implement `portOpdPrescriptionsToIpdDraftsInTx(tx, args)`: queries active `prescriptions` and `prescription_items` by encounter/patient, transforms them with parser, and inserts draft `ipdMedicationOrders`.
  - Implement `listDraftOrders(args)`: retrieves pending draft orders for an admission.
  - Implement `approveDraftMedicationOrder(args)`: verifies allergy and duplicate gates, updates to `'active'`.
  - Implement `approveAllDraftOrders(args)`: batch approval in transaction.
  - Implement `rejectDraftOrder(args)`: updates to `'voided'`.
- [ ] **Step 4: Run test to verify pass**
  - Run: `npx vitest run lib/services/__tests__/ipd-admission-continuity.test.ts`

---

### Task 3: Hooking into Admission Workflows
**Files:**
- Modify: `lib/services/admissions.ts`
- Test: `lib/services/__tests__/admissions.integration.test.ts`

- [ ] **Step 1: Update `shiftToIpd` in `lib/services/admissions.ts`**
  - Inside the tenant transaction of `shiftToIpd`, call `portOpdPrescriptionsToIpdDraftsInTx` when the admission is created.
- [ ] **Step 2: Update `executePatientIntake` in `lib/services/admissions.ts`**
  - When direct intake occurs for a patient with an existing OPD encounter, ensure draft orders are ported if not already present.
- [ ] **Step 3: Run admission integration tests**
  - Run: `npx vitest run lib/services/__tests__/admissions.integration.test.ts`

---

### Task 4: Server Actions for Draft Order Approval & Rejection
**Files:**
- Modify: `app/(app)/ipd/actions.ts`
- Test: `app/(app)/ipd/__tests__/admission-continuity-actions.test.ts`

- [ ] **Step 1: Write action tests for role authorization and error handling**
  - Verify doctor role can approve/reject drafts.
  - Verify unauthorized roles (nurse, receptionist) are rejected.
- [ ] **Step 2: Run test to verify failure**
  - Run: `npx vitest run app/(app)/ipd/__tests__/admission-continuity-actions.test.ts`
- [ ] **Step 3: Implement server actions in `app/(app)/ipd/actions.ts`**
  - `approveDraftMedicationOrderAction`
  - `approveAllDraftMedicationOrdersAction`
  - `rejectDraftMedicationOrderAction`
  - Revalidate `/ipd/patients/[id]/orders`, `/ipd/patients/[id]/summary`, and `/ipd/patients/[id]/emar`.
- [ ] **Step 4: Run test to verify pass**
  - Run: `npx vitest run app/(app)/ipd/__tests__/admission-continuity-actions.test.ts`

---

### Task 5: Orders Tab & Patient Summary UI Enhancements
**Files:**
- Modify: `components/ipd/orders/minimal-orders-tab.tsx`
- Modify: `app/(app)/ipd/patients/[id]/orders/page.tsx`
- Modify: `app/(app)/ipd/patients/[id]/summary/page.tsx`
- Test: `components/ipd/orders/__tests__/draft-orders-banner.test.tsx`

- [ ] **Step 1: Write component tests for `MinimalOrdersTab` with draft orders**
  - Renders draft banner with correct count.
  - Displays "Approve All Valid Orders" button.
  - Shows line-item "Approve", "Modify", and "Reject" actions.
- [ ] **Step 2: Update `MinimalOrdersTab` component**
  - Add `draftOrders` prop.
  - Render dedicated draft orders review banner with responsive card list and action handlers.
- [ ] **Step 3: Update `app/(app)/ipd/patients/[id]/orders/page.tsx`**
  - Query both active and draft orders and pass to `MinimalOrdersTab`.
- [ ] **Step 4: Update `app/(app)/ipd/patients/[id]/summary/page.tsx`**
  - Inject attention strip pill when draft orders are pending.
- [ ] **Step 5: Run UI component test suite**
  - Run: `npx vitest run components/ipd/orders/__tests__/draft-orders-banner.test.tsx`

---

### Task 6: Full Verification Suite
- [ ] Run `npm run db:lint-migrations` (ensure 0 errors).
- [ ] Run `npm run db:migrate:plan` (ensure 0 warnings).
- [ ] Run `npm test` (ensure 100% test pass rate across all suites).
- [ ] Verify eMAR reflects approved orders.
