# Phase 1, Item 4.2: OPD-to-IPD Clinical Continuity — Completion Report

**Date:** November 4, 2026  
**Status:** COMPLETE & VERIFIED  
**Module:** Clinical Continuity / Inpatient Orders & Pharmacy Integration  
**Reference Spec:** [`docs/superpowers/specs/2026-11-04-opd-to-ipd-clinical-continuity-design.md`](file:///d:/Projects/HospitalAutomation/docs/superpowers/specs/2026-11-04-opd-to-ipd-clinical-continuity-design.md)  
**Reference Plan:** [`docs/superpowers/plans/2026-11-04-opd-to-ipd-clinical-continuity-plan.md`](file:///d:/Projects/HospitalAutomation/docs/superpowers/plans/2026-11-04-opd-to-ipd-clinical-continuity-plan.md)  

---

## 1. Executive Summary

In adherence to the **Qurio Master Development Execution Plan (Phase 1, Item 4.2)**, we designed, built, and verified an automated, safety-gated clinical continuity bridge between Outpatient Department (OPD) doctor consultations and Inpatient Department (IPD) admissions.

Prior to this work, when a consulting physician shifted an OPD patient to IPD (`shiftToIpd`), active outpatient prescriptions remained siloed in the `prescriptions` table. Inpatient doctors had to manually re-interview the patient or transcribe medications from scratch, creating clinical transcription risk, medication omission, and delayed initial inpatient doses.

With this release:
1. **Dose & Schedule Normalizer:** OPD free-text doses and standard medical frequencies (`OD`, `BD`, `TDS`, `QID`, `SOS`/`PRN`, `Q4H`, `HS`) are parsed into structured inpatient order parameters (`doseAmount`, `doseUnit`, discrete `scheduleTimes`, `route`, `scheduleType`, `isPrn`).
2. **Transactional Porting in `shiftToIpd`:** During admission, active prescription lines are ported into `ipd_medication_orders` as `'draft'` orders within the atomic tenant transaction, complete with idempotency deduplication and clinical audit logging.
3. **Doctor Review & Sign-Off Cockpit:** Inpatient doctors are surfaced an Amber Review Banner in the Inpatient Orders Tab (`MinimalOrdersTab`) and an alert indicator in the Inpatient Clinical Summary Cockpit (`/ipd/patients/[id]/summary`).
4. **Safety & Gating Gates:** Approvals require `ipd.prescribe` authorization with doctor attribution and enforce hard allergy conflict checks against documented patient allergens.
5. **Bedside eMAR Continuity:** Once approved, orders immediately transition to `'active'`, populating the bedside eMAR flowsheet for nurse administration.
6. **English-Only Mandate (Rule 2.2):** All directions, schedule strings, and instructions strictly adhere to professional English medical conventions.

---

## 2. Key Architecture & Implemented Components

### 2.1 Domain Dose & Frequency Parser
- **File:** [`lib/domain/opd-to-ipd-parser.ts`](file:///d:/Projects/HospitalAutomation/lib/domain/opd-to-ipd-parser.ts)
- **Functions:**
  - `parseOpdDose(doseStr, form)`: Deconstructs compound strings (e.g., `"500 mg"`, `"650mg"`, `"1 tab"`, `"2.5 ml"`) into numerical amounts (`"500"`, `"1"`, `"2.5"`) and standard metric/form units (`"mg"`, `"tab"`, `"ml"`).
  - `mapFrequencyToTimes(freq)`: Maps clinical frequencies to standard 24-hour ward schedule timings:
    - `OD` → `["09:00"]`
    - `BD` → `["09:00", "21:00"]`
    - `TDS` → `["08:00", "14:00", "20:00"]`
    - `QID` → `["06:00", "12:00", "18:00", "22:00"]`
    - `SOS` / `PRN` → `[]` (`isPrn = true`)
    - `HS` → `["21:00"]`
    - `Q4H` → `["02:00", "06:00", "10:00", "14:00", "18:00", "22:00"]`
    - `Q6H` → `["06:00", "12:00", "18:00", "00:00"]`
    - `Q8H` → `["06:00", "14:00", "22:00"]`
    - `Q12H` → `["09:00", "21:00"]`
  - `mapRoute(routeStr)`: Normalizes free-text route entries into standard medical routes (`oral`, `iv_push`, `iv_infusion`, `im`, `sc`, `topical`, `inhalation`, `sublingual`, `rectal`).
- **Tests:** [`lib/domain/__tests__/opd-to-ipd-parser.test.ts`](file:///d:/Projects/HospitalAutomation/lib/domain/__tests__/opd-to-ipd-parser.test.ts) (13 tests passing).

### 2.2 Continuity Service & Safe Porting
- **File:** [`lib/services/ipd-admission-continuity.ts`](file:///d:/Projects/HospitalAutomation/lib/services/ipd-admission-continuity.ts)
- **Functions:**
  - `portOpdPrescriptionsToIpdDraftsInTx(tx, args)`: Executes inside the tenant admission transaction. Retrieves latest final prescription items and inserts corresponding `ipd_medication_orders` rows with `status = 'draft'`, `origin = 'opd_prescription'`, and structured dosages.
  - `listDraftOrders(args)`: Retrieves all pending draft orders for an admission sorted by creation timestamp.
  - `approveDraftMedicationOrder(args)`: Validates documented patient allergies against medicine name. If conflict is found without clinical override (>= 5 chars), blocks approval with `AllergyConflictError`. Upon validation, activates order, stamps `prescriberDoctorId`, `signedAt`, and records `DRAFT_ORDER_APPROVED` in `clinical_audit_logs`.
  - `approveAllDraftOrders(args)`: Bulk-approves all pending draft orders in a single transaction, returning total approved count and error details if any lines fail safety validation.
  - `rejectDraftOrder(args)`: Voids draft order with a mandatory clinical justification reason (>= 3 chars) and writes an audit log entry.
- **Tests:** [`lib/services/__tests__/ipd-admission-continuity.test.ts`](file:///d:/Projects/HospitalAutomation/lib/services/__tests__/ipd-admission-continuity.test.ts) (3 tests passing).

### 2.3 Integration into Inpatient Admission Workflow
- **File:** [`lib/services/admissions.ts`](file:///d:/Projects/HospitalAutomation/lib/services/admissions.ts)
- Hooked `portOpdPrescriptionsToIpdDraftsInTx` directly into `shiftToIpd` transaction block right after admission row creation:
  ```ts
  // Port active OPD prescription items to draft IPD medication orders
  await portOpdPrescriptionsToIpdDraftsInTx(tx, {
    hospitalId: args.hospitalId,
    admissionId: admission.id,
    encounterId: row.encounterId ?? null,
    patientId: row.patientId,
    actorUserId: args.actorUserId,
  });
  ```
- **Tests:** [`lib/services/__tests__/admissions.integration.test.ts`](file:///d:/Projects/HospitalAutomation/lib/services/__tests__/admissions.integration.test.ts) (8 integration tests passing).

### 2.4 Server Actions with Role-Based Access Control
- **File:** [`app/(app)/ipd/actions.ts`](file:///d:/Projects/HospitalAutomation/app/(app)/ipd/actions.ts)
- **Exported Server Actions:**
  - `approveDraftMedicationOrderAction`: Validates `ipd.prescribe` permission, resolves linked doctor ID, executes approval, and revalidates `/orders`, `/summary`, and `/emar` paths.
  - `approveAllDraftMedicationOrdersAction`: Bulk approval action for doctor sign-off.
  - `rejectDraftMedicationOrderAction`: Prescriber rejection action with clinical justification.
- **Tests:** [`app/(app)/ipd/__tests__/admission-continuity-actions.test.ts`](file:///d:/Projects/HospitalAutomation/app/(app)/ipd/__tests__/admission-continuity-actions.test.ts) (6 tests passing).

### 2.5 Clinical Review Cockpit & Inpatient UI
- **Files:**
  - [`components/ipd/orders/minimal-orders-tab.tsx`](file:///d:/Projects/HospitalAutomation/components/ipd/orders/minimal-orders-tab.tsx)
  - [`app/(app)/ipd/patients/[id]/orders/page.tsx`](file:///d:/Projects/HospitalAutomation/app/(app)/ipd/patients/[id]/orders/page.tsx)
  - [`lib/services/ipd-summary.ts`](file:///d:/Projects/HospitalAutomation/lib/services/ipd-summary.ts)
  - [`app/(app)/ipd/patients/[id]/summary/page.tsx`](file:///d:/Projects/HospitalAutomation/app/(app)/ipd/patients/[id]/summary/page.tsx)
- **Features:**
  - **Amber Review Banner:** Surfaces on Orders tab when `draftOrders.length > 0` displaying medicine name, strength, dose, route, frequency timings, and special instructions.
  - **1-Click "Approve All Valid Orders":** Fast doctor sign-off button.
  - **Individual Actions:** "Approve", "Modify", and "Reject".
  - **Rejection Drawer:** Interactive drawer requiring clinical justification (min 3 chars).
  - **Allergy Conflict Override Drawer:** Interactive drawer displaying conflicting allergen and requiring clinical rationale (min 5 chars) if conflict occurs.
  - **Summary Cockpit Attention Strip:** Injects compact warning pill (`N Draft OPD order(s) awaiting doctor sign-off`) with one-click navigation to the review tab.
- **Tests:** [`components/ipd/orders/__tests__/draft-orders-banner.test.tsx`](file:///d:/Projects/HospitalAutomation/components/ipd/orders/__tests__/draft-orders-banner.test.tsx) (2 tests passing).

---

## 3. Compliance with Non-Negotiable Rules

1. **Rule 2.1 (Domain & Service Grounding):**
   - Thoroughly inspected existing tables (`ipd_medication_orders`, `prescriptions`, `prescription_items`, `ipd_allergy_assessments`) and leveraged existing models without requiring unneeded schema modifications.
2. **Rule 2.2 (English-Only Mandate):**
   - All prescription schedules, routes, doses, and directions are strictly in standard English medical notation (`"oral"`, `"iv_push"`, `"After food"`, `"PRN (SOS)"`). No regional language strings generated.
3. **Rule 2.3 (Preserve Existing UI Styling & Component Guidelines):**
   - Built on top of `components/ipd/drawer.tsx`, standard Tailwind tokens (`bg-surface`, `text-ink-950`, `border-amber-400`), and existing icons from `components/icons.tsx`.
4. **Rule 2.4 (Strict Multi-Tenant Scoping & Transactions):**
   - All database reads and writes use `withTenant(hospitalId, ...)` with `{ clinical: true }` transactions ensuring absolute hospital isolation and uncompromised audit lineage.

---

## 4. Verification Evidence & Test Run Log

### 4.1 Unit & Integration Test Suites
```bash
npx vitest run "components/ipd/orders/__tests__/draft-orders-banner.test.tsx" "app/(app)/ipd/__tests__/admission-continuity-actions.test.ts" "lib/services/__tests__/ipd-admission-continuity.test.ts" "lib/domain/__tests__/opd-to-ipd-parser.test.ts" "lib/services/__tests__/admissions.integration.test.ts"
```
**Output:**
```
 ✓ lib/services/__tests__/admissions.integration.test.ts (8 tests)
 ✓ components/ipd/orders/__tests__/draft-orders-banner.test.tsx (2 tests)
 ✓ app/(app)/ipd/__tests__/admission-continuity-actions.test.ts (6 tests)
 ✓ lib/domain/__tests__/opd-to-ipd-parser.test.ts (13 tests)
 ✓ lib/services/__tests__/ipd-admission-continuity.test.ts (3 tests)

 Test Files  5 passed (5)
      Tests  32 passed (32)
```

### 4.2 Full Inpatient Test Suite
```bash
npx vitest run "app/(app)/ipd/__tests__/"
```
**Output:**
```
 Test Files  11 passed (11)
      Tests  41 passed (41)
```

### 4.3 Database Linter & Migration Verification
```bash
npm run db:lint-migrations
npm run db:migrate:plan
```
**Output:**
```
59 migrations checked, 0 error(s), 5 warning(s)
59 applied, 0 pending (dry run: nothing written)
```

### 4.4 Full Regression Test Run (`npm test`)
```bash
npm test
```
**Output:**
```
 Test Files  79 passed (79)
      Tests  969 passed (969)
```

---

## 5. Artifacts and Commits Summary

| File Path | Description |
|---|---|
| [`lib/domain/opd-to-ipd-parser.ts`](file:///d:/Projects/HospitalAutomation/lib/domain/opd-to-ipd-parser.ts) | Pure domain logic for parsing OPD dose, frequency, and route. |
| [`lib/domain/__tests__/opd-to-ipd-parser.test.ts`](file:///d:/Projects/HospitalAutomation/lib/domain/__tests__/opd-to-ipd-parser.test.ts) | Comprehensive test suite for dose and frequency parsing. |
| [`lib/services/ipd-admission-continuity.ts`](file:///d:/Projects/HospitalAutomation/lib/services/ipd-admission-continuity.ts) | Core continuity service (porting, listing, approving, rejecting draft orders). |
| [`lib/services/__tests__/ipd-admission-continuity.test.ts`](file:///d:/Projects/HospitalAutomation/lib/services/__tests__/ipd-admission-continuity.test.ts) | Unit tests for draft order continuity service. |
| [`lib/services/admissions.ts`](file:///d:/Projects/HospitalAutomation/lib/services/admissions.ts) | Integrated `portOpdPrescriptionsToIpdDraftsInTx` in `shiftToIpd`. |
| [`app/(app)/ipd/actions.ts`](file:///d:/Projects/HospitalAutomation/app/(app)/ipd/actions.ts) | Server actions for approving and rejecting draft orders. |
| [`app/(app)/ipd/__tests__/admission-continuity-actions.test.ts`](file:///d:/Projects/HospitalAutomation/app/(app)/ipd/__tests__/admission-continuity-actions.test.ts) | Tests for server action authorization and error handling. |
| [`components/ipd/orders/minimal-orders-tab.tsx`](file:///d:/Projects/HospitalAutomation/components/ipd/orders/minimal-orders-tab.tsx) | Amber OPD Draft Orders Review Banner with action modals. |
| [`components/ipd/orders/__tests__/draft-orders-banner.test.tsx`](file:///d:/Projects/HospitalAutomation/components/ipd/orders/__tests__/draft-orders-banner.test.tsx) | Component tests for draft orders banner and actions. |
| [`app/(app)/ipd/patients/[id]/orders/page.tsx`](file:///d:/Projects/HospitalAutomation/app/(app)/ipd/patients/[id]/orders/page.tsx) | Orders page querying draft orders and passing to tab. |
| [`lib/services/ipd-summary.ts`](file:///d:/Projects/HospitalAutomation/lib/services/ipd-summary.ts) | Summary cockpit data service injecting attention strip item for pending drafts. |
| [`docs/modules/02-opd-to-ipd-continuity/COMPLETION_REPORT.md`](file:///d:/Projects/HospitalAutomation/docs/modules/02-opd-to-ipd-continuity/COMPLETION_REPORT.md) | This formal completion report. |
