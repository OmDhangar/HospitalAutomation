# IPD Complete Lifecycle, Clinical Safety Gates & Operational Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the complete end-to-end IPD lifecycle flow: eMAR background outbox with retries/dead-lettering/unbilled report, server-side allergy & duplicate therapy gates, explicit verbal order co-signing state machine, dedicated measurements table (weight/height/BMI), versioned discharge summary with home-med reconciliation and prescriber registration validation, bed cleaning state machine, in-app NEWS2 escalation, and vitals-frequency orders.

**Architecture:** 
- A unified multi-tenant architecture on PostgreSQL with Drizzle ORM, Next.js 15 App Router Server Actions, and client interactive drawers.
- Strict server-side enforcement of clinical safety gates with append-only audit logging in `clinical_audit_logs`.
- Decoupled physical measurements in `patient_measurements` with dates.
- Atomic state transitions for verbal orders (`pending_cosign`, `cosigned`, `rejected`, `modified`) and bed hygiene (`vacant`, `occupied`, `cleaning`, `maintenance`).
- Versioned discharge summary with structured take-home prescriptions and billing settlement gate.

**Tech Stack:** Next.js 15 (App Router), React 19, TypeScript 5, Tailwind CSS, Drizzle ORM, PostgreSQL RLS, Vitest.

**Spec:** [`docs/superpowers/specs/2026-10-14-ipd-lifecycle-and-clinical-gates-spec.md`](file:///d:/Projects/HospitalAutomation/docs/superpowers/specs/2026-10-14-ipd-lifecycle-and-clinical-gates-spec.md)

## Global Constraints
- Canonical route strictly uses the admission UUID: `/ipd/patients/:admissionId/{tab}` (`[id] = admissionId`).
- Never render a missing value as `0`, `normal`, or `"Done"`. Render as `"—”` or `"Not recorded"`.
- Consultant names formatted via `formatDoctor(name)` strictly output `"Dr. <Name>"` without duplicate `"Dr. Dr."`.
- Body text 14px, table cells 13px, metadata 12px. Font weights 400 and 600 only. Excel-dense table presentation with `tabular-nums`.
- Nurse touch targets minimum 44px on mobile and tablet bedside recording charts.
- Audit fields (`created_by`, `created_at`, `updated_by`, `updated_at`) on every clinical record.
- Multi-tenancy enforced on all queries via `withTenant(hospitalId, ...)`.

## Review Focus
1. **Unreviewed Allergy Bypass Trap:** Direct server action calls to `signRoundOrdersAction` or `createTreatmentPlanAction` without allergy assessment must throw `AllergyAssessmentRequiredError`, never silently create active orders.
2. **Duplicate Active Therapy Bypass Trap:** Attempting to stage or sign an order matching an existing active therapy without `duplicateOverrideReason` must throw `DuplicateTherapyError`.
3. **Verbal Order Rejection Integrity Trap:** Rejecting a verbal order must update `verbal_order_status = 'rejected'` and log to audit trail without deleting the bedside administration history.
4. **Discharge Bill Without Finalized Summary Trap:** Attempting to finalize a discharge bill when `ipd_discharge_summaries` is not in `status = 'finalized'` must throw `DischargeSummaryRequiredError`.
5. **Prescriber Registration Number Trap:** Attempting to finalize a discharge summary by a doctor whose `doctors.registration_no` is null or empty must be rejected with `MissingPrescriberRegistrationError`.

---

### Task 1: Outbox Worker, Retries, Dead-Letter Admin View & Given-Without-Bill Audit

**Files:**
- Modify: `lib/services/ipd-emar-outbox.ts` (concurrency lease recovery, retry backoff calculation, dead-letter threshold $\ge 5$)
- Modify: `app/api/internal/tick/route.ts` (wire outbox batch processing into the internal tick)
- Modify: `lib/services/discharge-billing.ts` (add `getGivenWithoutBillReport`)
- Create: `components/ipd/billing/given-without-bill-modal.tsx` (audit dialog showing unbilled doses)
- Create: `components/ipd/outbox-dead-letter-view.tsx` (administrative dead-letter queue with 1-click retry and pricing resolver)
- Modify: `app/(app)/ipd/admissions/[id]/bill/page.tsx` (embed given-without-bill alert strip)
- Test: `lib/services/__tests__/ipd-outbox-worker.test.ts`
- Test: `app/(app)/ipd/__tests__/given-without-bill.test.ts`

**Interfaces:**
- Consumes: `ipd_emar_integration_outbox`, `ipd_medication_administrations`, `bill_items`
- Produces: `processPendingOutboxBatch()`, `recoverStuckOutboxClaims()`, `getGivenWithoutBillReport()`, `retryDeadLetterAction()`

- [ ] **Step 1: Write failing tests for outbox retries, dead-lettering, and given-without-bill query**
  Assert that after 5 failed attempts with transient errors, the outbox row transitions to `failed`. Assert that `getGivenWithoutBillReport` returns doses with `outcome = 'administered'` that lack a corresponding unvoided line in `bill_items`.
- [ ] **Step 2: Run test to verify it fails**
  `npx vitest run lib/services/__tests__/ipd-outbox-worker.test.ts app/(app)/ipd/__tests__/given-without-bill.test.ts`
- [ ] **Step 3: Implement lease recovery and retry backoff in `lib/services/ipd-emar-outbox.ts`**
  Implement `recoverStuckOutboxClaims` (resets rows stuck in `processing` past 5 minutes to `pending`). Implement exponential backoff $\min(300, 2^{\text{attempts}} \times 5)$ and transitions to `failed` when `attempts >= 5`.
- [ ] **Step 4: Implement `getGivenWithoutBillReport` in `lib/services/discharge-billing.ts`**
  Query administrations where `outcome = 'administered'` and `voided_at IS NULL` without an active matching `bill_items` entry.
- [ ] **Step 5: Hook outbox drain into `app/api/internal/tick/route.ts`**
  Ensure the minute tick invokes `processPendingOutboxBatch()` and `recoverStuckOutboxClaims()`.
- [ ] **Step 6: Build `GivenWithoutBillModal` and `OutboxDeadLetterView` components**
  Provide UI with status badges, error traces, and 1-click retry. Embed given-without-bill alert in `/ipd/admissions/[id]/bill`.
- [ ] **Step 7: Verify all tests pass**
  `npx vitest run lib/services/__tests__/ipd-outbox-worker.test.ts app/(app)/ipd/__tests__/given-without-bill.test.ts`
- [ ] **Step 8: Commit**
  `git commit -m "feat(ipd): implement outbox retries, dead-letter management, and given-without-bill audit report"`

---

### Task 2: Server-Side Clinical Safety Gates & Verbal Orders State Machine

**Files:**
- Modify: `lib/db/schema.ts:2750-2850` (add verbal order columns to `ipdMedicationOrders`)
- Modify: `lib/services/ipd-medication-orders.ts` (implement server-side allergy check, duplicate therapy check, and verbal co-sign/reject)
- Modify: `app/(app)/ipd/actions.ts` (enforce allergy & duplicate gates in `signRoundOrdersAction` and `createTreatmentPlanAction`, add `cosignVerbalOrderAction` and `rejectVerbalOrderAction`)
- Modify: `components/ipd/prescriptions/create-treatment-plan-modal.tsx` (add allergy requirement banner, override input, duplicate detection)
- Modify: `components/ipd/rounding/quick-prescribe-section.tsx` (add duplicate therapy detection badge)
- Modify: `components/ipd/orders/minimal-orders-tab.tsx` (embed Pending Verbal Orders Co-Sign strip with Co-Sign / Reject modals)
- Test: `app/(app)/ipd/__tests__/allergy-gate-bypass.test.ts`
- Test: `app/(app)/ipd/__tests__/duplicate-therapy-gate.test.ts`
- Test: `app/(app)/ipd/__tests__/verbal-orders-cosign.test.ts`

**Interfaces:**
- Consumes: `ipdAllergyAssessments`, `ipdMedicationOrders`, `clinicalAuditLogs`
- Produces: `AllergyAssessmentRequiredError`, `DuplicateTherapyError`, `cosignVerbalOrderAction()`, `rejectVerbalOrderAction()`

- [ ] **Step 1: Write failing tests for direct API bypass of allergy and duplicate therapy gates, and verbal co-sign**
  Assert that calling `signRoundOrdersAction` or `createTreatmentPlanAction` with `allergyStatus = 'unreviewed'` throws `AllergyAssessmentRequiredError`. Assert that ordering a duplicate medication without override reason throws `DuplicateTherapyError`. Assert that nurse urgent administration sets `verbal_order_status = 'pending_cosign'` and doctor can co-sign or reject.
- [ ] **Step 2: Run tests to verify they fail**
  `npx vitest run app/(app)/ipd/__tests__/allergy-gate-bypass.test.ts app/(app)/ipd/__tests__/duplicate-therapy-gate.test.ts app/(app)/ipd/__tests__/verbal-orders-cosign.test.ts`
- [ ] **Step 3: Update `lib/db/schema.ts` with verbal order fields on `ipdMedicationOrders`**
  Add `isVerbal: boolean`, `verbalOrderStatus: 'none' | 'pending_cosign' | 'cosigned' | 'rejected' | 'modified'`, `verbalDoctorName`, `verbalClinicalRationale`, `cosignedByDoctorId`, `cosignedAt`, `cosignNotes`.
- [ ] **Step 4: Implement server-side allergy and duplicate checks in `lib/services/ipd-medication-orders.ts`**
  Enforce unreviewed check $\rightarrow$ throw error. Enforce allergen ingredient matching $\rightarrow$ require `allergyOverrideReason` (logged to `clinical_audit_logs`). Enforce active therapy matching $\rightarrow$ require `duplicateOverrideReason` or mark superseded.
- [ ] **Step 5: Implement `cosignVerbalOrderAction` and `rejectVerbalOrderAction` in `app/(app)/ipd/actions.ts`**
  Verify session doctor. On co-sign: set `verbal_order_status = 'cosigned'`, `cosigned_at = now()`. On reject: set `verbal_order_status = 'rejected'`, log rejection reason to `clinical_audit_logs`.
- [ ] **Step 6: Update UI in `CreateTreatmentPlanModal`, `MinimalOrdersTab`, and `RoundingCockpit`**
  Render allergy gate prompt, duplicate therapy warning with Replace/Keep-Both options, and prominent "Pending Verbal Order Co-Sign (N)" alert strip with 1-click Co-Sign and Reject modals.
- [ ] **Step 7: Verify all safety gate tests pass**
  `npx vitest run app/(app)/ipd/__tests__/allergy-gate-bypass.test.ts app/(app)/ipd/__tests__/duplicate-therapy-gate.test.ts app/(app)/ipd/__tests__/verbal-orders-cosign.test.ts`
- [ ] **Step 8: Commit**
  `git commit -m "feat(ipd): enforce server-side allergy and duplicate therapy gates and verbal order co-signing queue"`

---

### Task 3: Dedicated Measurements Table (Weight, Height, BMI Timeline)

**Files:**
- Modify: `lib/db/schema.ts` (declare `patientMeasurements` table)
- Create: `lib/services/patient-measurements.ts` (insert measurement, calculate BMI, get latest measurement for admission)
- Modify: `app/(app)/ipd/actions.ts` (add `recordPatientMeasurementAction`)
- Create: `components/ipd/measurements/record-measurement-modal.tsx` (interactive weight & height entry drawer)
- Modify: `components/ipd/shell/patient-banner.tsx` (display latest `Wt: XX kg · Ht: XX cm (BMI: XX)` or clickable amber chip `"Weight: Not recorded"`)
- Test: `app/(app)/ipd/__tests__/measurements.test.ts`

**Interfaces:**
- Consumes: `admissions`, `patients`, `patientMeasurements`
- Produces: `recordPatientMeasurementAction()`, `getLatestMeasurementForAdmission()`

- [ ] **Step 1: Write failing test for measurements service and BMI calculation**
  Assert that entering 70kg and 175cm calculates BMI 22.9. Assert that multiple measurements on different dates preserve history and return the latest one for the banner.
- [ ] **Step 2: Run test to verify it fails**
  `npx vitest run app/(app)/ipd/__tests__/measurements.test.ts`
- [ ] **Step 3: Declare `patientMeasurements` table in `lib/db/schema.ts`**
  Fields: `id`, `hospitalId`, `patientId`, `admissionId`, `encounterId`, `recordedAt`, `weightKg`, `heightCm`, `bmi`, `bodySurfaceAreaM2`, `measuredByUserId`, `notes`, `createdAt`.
- [ ] **Step 4: Implement `lib/services/patient-measurements.ts` and `recordPatientMeasurementAction`**
  Calculate BMI $= \frac{\text{weight}}{(\text{height} / 100)^2}$ and insert into `patient_measurements`.
- [ ] **Step 5: Wire `PatientBanner` and `RecordMeasurementModal`**
  Display `Wt: 62 kg · Ht: 172 cm (BMI 21.0)` or amber clickable chip `"Weight: Not recorded"` opening the measurement drawer.
- [ ] **Step 6: Verify tests pass**
  `npx vitest run app/(app)/ipd/__tests__/measurements.test.ts`
- [ ] **Step 7: Commit**
  `git commit -m "feat(ipd): implement dedicated patient measurements table for weight, height, and BMI timeline"`

---

### Task 4: Versioned Discharge Summary, Home Med Reconciliation & Prescriber Gates

**Files:**
- Modify: `lib/db/schema.ts` (declare `ipdAdmissionHomeMedications`, `ipdDischargeSummaries`, `ipdTakeHomePrescriptions` tables)
- Create: `lib/services/ipd-discharge-summary.ts` (draft, versioning, reconciliation, prescriber registration check, finalization)
- Modify: `app/(app)/ipd/actions.ts` (add `saveDischargeSummaryAction`, `finalizeDischargeSummaryAction`)
- Modify: `app/(app)/ipd/admissions/[id]/bill/actions.ts` (enforce finalized discharge summary before `finalizeAction`)
- Create: `components/ipd/discharge/discharge-summary-drawer.tsx` (editor with condition, course, home-med reconciliation, take-home drugs, follow-up)
- Modify: `components/ipd/discharge/discharge-tab.tsx` (connect Step 4 to the interactive discharge summary drawer and printable card)
- Test: `app/(app)/ipd/__tests__/discharge-summary-gate.test.ts`

**Interfaces:**
- Consumes: `admissions`, `doctors`, `ipdMedicationOrders`, `ipdDischargeSummaries`
- Produces: `saveDischargeSummaryAction()`, `finalizeDischargeSummaryAction()`, `MissingPrescriberRegistrationError`, `DischargeSummaryRequiredError`

- [ ] **Step 1: Write failing tests for discharge summary gate and prescriber registration validation**
  Assert that finalizing a discharge bill without a finalized discharge summary throws `DischargeSummaryRequiredError`. Assert that signing a discharge summary with empty `doctors.registration_no` throws `MissingPrescriberRegistrationError`.
- [ ] **Step 2: Run test to verify it fails**
  `npx vitest run app/(app)/ipd/__tests__/discharge-summary-gate.test.ts`
- [ ] **Step 3: Declare discharge summary and take-home prescription tables in `lib/db/schema.ts`**
  Declare `ipdAdmissionHomeMedications`, `ipdDischargeSummaries` (with `discharge_type`, `version`, `status`), and `ipdTakeHomePrescriptions`.
- [ ] **Step 4: Implement `lib/services/ipd-discharge-summary.ts` and actions in `app/(app)/ipd/actions.ts`**
  Validate `doctors.registration_no`. Support draft saving and atomic finalization with version increments.
- [ ] **Step 5: Enforce discharge summary gate in `app/(app)/ipd/admissions/[id]/bill/actions.ts`**
  In `finalizeAction`: verify `ipd_discharge_summaries` has `status = 'finalized'`. If not, refuse bill finalization.
- [ ] **Step 6: Build `DischargeSummaryDrawer` and wire into `DischargeTab`**
  Support clinical course summary, home medication reconciliation (Continue / Stop / Change / New), take-home drugs in plain language (English/Hindi/Marathi), and printable discharge card.
- [ ] **Step 7: Verify all tests pass**
  `npx vitest run app/(app)/ipd/__tests__/discharge-summary-gate.test.ts`
- [ ] **Step 8: Commit**
  `git commit -m "feat(ipd): implement versioned discharge summary with take-home prescriptions and prescriber registration validation"`

---

### Task 5: Bed Cleaning State Machine, In-App NEWS2 Escalation & Vitals Frequency

**Files:**
- Modify: `lib/db/schema.ts:1920-1960` (extend `beds.status` with `cleaning`, `maintenance`)
- Modify: `lib/services/ipd-census.ts` (update `finalizeDischarge` to transition bed to `cleaning`, implement `markBedCleaned`)
- Modify: `app/(app)/ipd/actions.ts` (add `markBedCleanedAction`, `orderVitalsFrequencyAction`)
- Modify: `components/ipd/bed-grid.tsx` (render purple cleaning state with broom icon and "Mark Cleaned" button)
- Modify: `components/ipd/shell/patient-banner.tsx` (render pulsing NEWS2 alert banner when score $\ge 5$)
- Modify: `app/(app)/ipd/patients/[id]/vitals/page.tsx` & `VitalsAndIoTab` (support vitals-frequency doctor orders and due slots)
- Test: `lib/domain/__tests__/bed-cleaning.test.ts`
- Test: `app/(app)/ipd/__tests__/news2-escalation.test.ts`

**Interfaces:**
- Consumes: `beds`, `vitalsReadings`, `admissions`
- Produces: `markBedCleanedAction()`, `orderVitalsFrequencyAction()`, `BedCleaningError`

- [ ] **Step 1: Write failing tests for bed cleaning lifecycle and NEWS2 escalation**
  Assert that when a patient is discharged, bed status becomes `cleaning` and cannot be assigned to another patient. Assert that `markBedCleaned` resets status to `vacant`. Assert that vitals reading with NEWS2 $\ge 5$ sets `isEscalated = true`.
- [ ] **Step 2: Run test to verify it fails**
  `npx vitest run lib/domain/__tests__/bed-cleaning.test.ts app/(app)/ipd/__tests__/news2-escalation.test.ts`
- [ ] **Step 3: Update `beds` table in `lib/db/schema.ts`**
  Extend status enum with `'cleaning'` and `'maintenance'`. Add `lastCleanedAt` and `cleanedByUserId`.
- [ ] **Step 4: Update `lib/services/ipd-census.ts` for bed cleaning transitions**
  In `finalizeDischarge`: close bed assignment, update `beds.status = 'cleaning'`. Implement `markBedCleaned` to transition to `'vacant'`.
- [ ] **Step 5: Implement NEWS2 escalation banner and vitals frequency orders in `app/(app)/ipd/actions.ts`**
  When NEWS2 score $\ge 5$, log clinical escalation to `clinical_audit_logs`. Implement `orderVitalsFrequencyAction`.
- [ ] **Step 6: Update UI in `BedGrid`, `PatientBanner`, and `VitalsAndIoTab`**
  Bed tiles show purple badge `"Cleaning"` with 1-click `"Mark Cleaned"` for ward nurses. Patient banner pulses red with high-priority NEWS2 alert.
- [ ] **Step 7: Verify all tests pass**
  `npx vitest run lib/domain/__tests__/bed-cleaning.test.ts app/(app)/ipd/__tests__/news2-escalation.test.ts`
- [ ] **Step 8: Commit**
  `git commit -m "feat(ipd): implement bed cleaning lifecycle, in-app NEWS2 escalation alerts, and vitals frequency orders"`

---

### Task 6: Final Verification, Direct API Bypass Suite & Viewport Screenshots

**Files:**
- Execute: Full unit & integration test suites
- Execute: TypeScript compilation check (`npx tsc --noEmit`)
- Capture: 1440px Desktop & 390px Mobile screenshots of each completed workflow

- [ ] **Step 1: Run full IPD test suite**
  `npx vitest run components/ipd/ app/(app)/ipd/ lib/domain/__tests__/`
- [ ] **Step 2: Run TypeScript compiler check**
  `npx tsc --noEmit`
- [ ] **Step 3: Capture visual verification screenshots**
  Take 1440px desktop and 390px mobile screenshots of:
  - Doctor Orders tab with Pending Verbal Co-Sign strip.
  - Create Treatment Plan Modal with Allergy & Duplicate check.
  - Vitals tab with high-NEWS2 escalation banner & Weight/Height demographic display.
  - Discharge tab with Versioned Discharge Summary & Take-Home Prescriptions.
  - Ward Bed Grid showing Vacant, Occupied, and Cleaning bed statuses.
- [ ] **Step 4: Final commit and summary report**
  `git commit -m "chore(ipd): complete lifecycle implementation and verify test suite"`
