# Unified IPD Design System & Complete 8-Tab Patient Chart Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish total visual and functional consistency across IPD by rewiring hub pages (My Patients, Wards, Bedside) into the Excel-dense hospital cockpit design system, while strictly preserving 1-tap bedside simplicity for nurses, and delivering full, production-ready views for all 8 patient chart tabs.

**Architecture:** 
- Establish shared table, card, badge, and modal design primitives adhering to 11px/12px typography, `tabular-nums`, and tight borders.
- Rewire `My Patients` from giant rounded cards into an Excel-dense clinical roster with inline status and direct actions.
- Sanitize bedside consultant names to fix the `"Dr. Dr."` duplication and maintain 1-tap plain English nurse actions (`✓ Give Medicine`, `Change Time`, `Skip Dose`, `+ Give Extra Medicine`, `+ Syringes & Items`).
- Build dedicated, high-density pages and components for all remaining patient chart tabs (`Vitals & I/O`, `Notes`, `Investigations`, `Consumables & Billing`, `Discharge`, `Orders`, and `eMAR`).

**Tech Stack:** Next.js App Router (React Server Components + Client interactive drawers), TypeScript, Tailwind CSS, Vitest, Drizzle ORM, PostgreSQL RLS.

**Spec:** [`docs/superpowers/specs/2026-10-13-ipd-unified-design-system-and-patient-chart-spec.md`](file:///d:/Projects/HospitalAutomation/docs/superpowers/specs/2026-10-13-ipd-unified-design-system-and-patient-chart-spec.md)

---

## Global Constraints

- Preserve 1-tap/1-click bedside simplicity for nurses: plain English labels only, large touch targets, no multi-step clinical jargon forms.
- Reclaim vertical screen real estate: PatientBanner + TabNavigation stack must remain ~110px.
- Use Excel-dense presentation: 11px/12px labels, `font-mono tabular-nums`, light borders (`border-ink-200/80`), subtle zebra striping.
- Fix the `"Dr. Dr."` duplicate title bug across all patient header displays.
- All database queries must enforce `tenant_isolation` via `withTenant()` / `hospital_id`.

## Review Focus

1. Nurse Bedside actions must remain instantaneous (1-tap `Give Medicine`, `Change Time`, `Skip Dose`, `+ Give Extra Medicine`) without modal complexity.
2. The `My Patients` table must handle patients without beds or diagnoses gracefully without layout breakage.
3. Vitals & Intake/Output calculations (NEWS2 score, Net fluid balance) must handle null/missing readings safely.
4. TabNavigation active state must highlight the current tab correctly for all 8 routes under `/ipd/patients/[id]/*`.
5. TypeScript compilation (`npx tsc --noEmit`) and full test suite (`npx vitest run`) must pass with 0 errors.

---

### Task 1: Bedside Simplicity Preservation & My Patients Excel-Dense Table

**Files:**
- Modify: `components/ipd/bedside/bedside-treatment-chart.tsx` (sanitize `doctorName`, preserve plain English buttons, compact bed header)
- Modify: `app/(app)/ipd/my-patients/page.tsx` (rebuild from giant cards into high-density clinical roster table)
- Test: `components/ipd/bedside/__tests__/bedside-doctor-title.test.tsx`
- Test: `app/(app)/ipd/my-patients/__tests__/my-patients-table.test.tsx`

**Interfaces:**
- Consumes: `listMyAdmittedPatients`, `setDischargeReadyAction`, `getTestChips`
- Produces: High-density `MyPatients` roster view, clean sanitized `doctorName` formatting

- [ ] **Step 1: Write failing test for `doctorName` sanitation in bedside chart**
  Verify that when `doctorName` is `"Dr. Amit Mehra"` or `"Amit Mehra"`, it renders `"Dr. Amit Mehra"` without duplicate `"Dr. Dr."`.
- [ ] **Step 2: Run test to verify it fails**
  `npx vitest run components/ipd/bedside/__tests__/bedside-doctor-title.test.tsx`
- [ ] **Step 3: Implement doctor name sanitizer in `BedsideTreatmentChart`**
  Add helper function `formatDoctorDisplay(name: string)` that strips leading `"Dr. "` / `"Dr "` before formatting.
- [ ] **Step 4: Write failing test for `My Patients` high-density table**
  Assert that `app/(app)/ipd/my-patients/page.tsx` renders a `table` with `thead` columns: Bed/Ward, Patient, Day, Diagnosis, Medication, Status, Actions, with `border-collapse`, `tabular-nums`.
- [ ] **Step 5: Run test to verify it fails**
  `npx vitest run app/(app)/ipd/my-patients/__tests__/my-patients-table.test.tsx`
- [ ] **Step 6: Rebuild `app/(app)/ipd/my-patients/page.tsx` into high-density table**
  Replace bulky `ul`/`li` cards with a clean spreadsheet-style table with compact action cluster (`Patient File →`, `Discharge ready`, `Tests`).
- [ ] **Step 7: Verify both tests pass**
  `npx vitest run components/ipd/bedside/__tests__/bedside-doctor-title.test.tsx app/(app)/ipd/my-patients/__tests__/my-patients-table.test.tsx`
- [ ] **Step 8: Commit changes**
  `git commit -m "feat(ipd): rewire My Patients into high-density clinical table and fix bedside Dr prefix bug"`

---

### Task 2: Vitals & Fluid Balance Tab (`/ipd/patients/[id]/vitals`)

**Files:**
- Create: `components/ipd/vitals/vitals-and-io-tab.tsx`
- Create: `components/ipd/vitals/record-vitals-modal.tsx`
- Create: `components/ipd/vitals/record-fluid-balance-modal.tsx`
- Create: `app/(app)/ipd/patients/[id]/vitals/page.tsx`
- Modify: `app/(app)/ipd/actions.ts` (add `recordVitalReadingAction`, `recordIntakeOutputAction`)
- Test: `app/(app)/ipd/patients/__tests__/vitals-tab.test.tsx`

**Interfaces:**
- Consumes: `vitalsReadings`, `intakeOutput` tables from `lib/db/schema.ts`
- Produces: Interactive TPR & NEWS2 flowsheet, 24h intake/output balance ledger, entry actions

- [ ] **Step 1: Write failing test for Vitals & I/O tab**
  Test that `VitalsAndIoTab` renders TPR flowsheet with columns (Time, Temp, Pulse, BP, Resp, SpO2, NEWS2) and 24h Fluid Balance section with Net ml calculation.
- [ ] **Step 2: Run test to verify it fails**
  `npx vitest run app/(app)/ipd/patients/__tests__/vitals-tab.test.tsx`
- [ ] **Step 3: Implement server actions for vitals and fluid balance in `app/(app)/ipd/actions.ts`**
  Implement `recordVitalReadingAction({ admissionId, temperatureF, pulseBpm, bpSystolic, bpDiastolic, respRate, spo2Percent, news2Score })` and `recordIntakeOutputAction({ admissionId, kind, ml, notes })`.
- [ ] **Step 4: Build `VitalsAndIoTab`, `RecordVitalsModal`, and `RecordFluidBalanceModal`**
  Build spreadsheet-dense table with abnormal highlights (fever, tachycardia, low oxygen) and quick 1-click `+ Record Vitals` / `+ Record Fluid Balance` drawers with large touch targets.
- [ ] **Step 5: Wire `app/(app)/ipd/patients/[id]/vitals/page.tsx`**
  Fetch vitals readings and intake/output records from database and render `VitalsAndIoTab`.
- [ ] **Step 6: Run tests and verify**
  `npx vitest run app/(app)/ipd/patients/__tests__/vitals-tab.test.tsx`
- [ ] **Step 7: Commit changes**
  `git commit -m "feat(ipd): implement Vitals & Fluid Balance tab with TPR flowsheet and I/O ledger"`

---

### Task 3: Clinical Progress Notes Tab (`/ipd/patients/[id]/notes`)

**Files:**
- Create: `components/ipd/notes/notes-tab.tsx`
- Create: `components/ipd/notes/add-clinical-note-modal.tsx`
- Create: `app/(app)/ipd/patients/[id]/notes/page.tsx`
- Modify: `app/(app)/ipd/actions.ts` (add `recordClinicalNoteAction`)
- Test: `app/(app)/ipd/patients/__tests__/notes-tab.test.tsx`

**Interfaces:**
- Consumes: `draftRounds`, `clinicalAuditLogs` or `chartEntries`
- Produces: Chronological SOAP progress notes list and Nurse shift handover notes

- [ ] **Step 1: Write failing test for Notes tab**
  Assert that `NotesTab` renders chronological note items with author, role badge (`Doctor`, `Staff Nurse`), SOAP sections, and `+ Add Clinical Note` trigger.
- [ ] **Step 2: Run test to verify it fails**
  `npx vitest run app/(app)/ipd/patients/__tests__/notes-tab.test.tsx`
- [ ] **Step 3: Implement `recordClinicalNoteAction` in `app/(app)/ipd/actions.ts`**
  Store note with admissionId, noteType (`SOAP`, `NURSING`, `HANDOVER`), SOAP fields (s, o, a, p) or body text, and author session.
- [ ] **Step 4: Build `NotesTab` and `AddClinicalNoteModal`**
  Render clean cards with badge indicators, collapsible SOAP details, and simple 1-click note entry modal.
- [ ] **Step 5: Wire `app/(app)/ipd/patients/[id]/notes/page.tsx`**
  Fetch notes for admission and pass to `NotesTab`.
- [ ] **Step 6: Run tests and verify**
  `npx vitest run app/(app)/ipd/patients/__tests__/notes-tab.test.tsx`
- [ ] **Step 7: Commit changes**
  `git commit -m "feat(ipd): implement Clinical Progress Notes tab with SOAP entries and shift handovers"`

---

### Task 4: Investigations & Diagnostics Tab (`/ipd/patients/[id]/investigations`)

**Files:**
- Create: `components/ipd/investigations/investigations-tab.tsx`
- Create: `components/ipd/investigations/order-investigation-modal.tsx`
- Create: `app/(app)/ipd/patients/[id]/investigations/page.tsx`
- Test: `app/(app)/ipd/patients/__tests__/investigations-tab.test.tsx`

**Interfaces:**
- Consumes: `orderTestsAction`, `getTestChips`
- Produces: Investigations tracking table with sample status and critical value alerts

- [ ] **Step 1: Write failing test for Investigations tab**
  Assert that `InvestigationsTab` renders a table with Test Name, Category, Ordered At, Status (`Ordered`, `Sample Collected`, `Reported`), and `+ Order Tests` button.
- [ ] **Step 2: Run test to verify it fails**
  `npx vitest run app/(app)/ipd/patients/__tests__/investigations-tab.test.tsx`
- [ ] **Step 3: Build `InvestigationsTab` and `OrderInvestigationModal`**
  Implement high-density investigations table with critical abnormal badge styling and quick test-chip order modal.
- [ ] **Step 4: Wire `app/(app)/ipd/patients/[id]/investigations/page.tsx`**
  Fetch active and completed investigations and available test chips, then render `InvestigationsTab`.
- [ ] **Step 5: Run tests and verify**
  `npx vitest run app/(app)/ipd/patients/__tests__/investigations-tab.test.tsx`
- [ ] **Step 6: Commit changes**
  `git commit -m "feat(ipd): implement Investigations tab with specimen tracking and critical value alerts"`

---

### Task 5: Consumables & Running Billing Tab (`/ipd/patients/[id]/billing`)

**Files:**
- Create: `components/ipd/billing/billing-and-consumables-tab.tsx`
- Create: `app/(app)/ipd/patients/[id]/billing/page.tsx`
- Test: `app/(app)/ipd/patients/__tests__/billing-tab.test.tsx`

**Interfaces:**
- Consumes: `discharge-billing.ts`, `ipd-billing.ts`, `acct_events`
- Produces: Itemized running charges ledger, financial balance overview, print interim bill

- [ ] **Step 1: Write failing test for Consumables & Billing tab**
  Assert that `BillingAndConsumablesTab` renders itemized table (Bed days, Meds, Consumables, Visits), Gross total, Advance paid, Net balance due, and `Print Interim Bill` button.
- [ ] **Step 2: Run test to verify it fails**
  `npx vitest run app/(app)/ipd/patients/__tests__/billing-tab.test.tsx`
- [ ] **Step 3: Build `BillingAndConsumablesTab`**
  Render itemized ledger with category badges, tabular amount columns, financial balance summary cards, and quick `+ Syringes & Items` bedside supply recorder.
- [ ] **Step 4: Wire `app/(app)/ipd/patients/[id]/billing/page.tsx`**
  Fetch running charges and payments for admission and render `BillingAndConsumablesTab`.
- [ ] **Step 5: Run tests and verify**
  `npx vitest run app/(app)/ipd/patients/__tests__/billing-tab.test.tsx`
- [ ] **Step 6: Commit changes**
  `git commit -m "feat(ipd): implement Consumables & Billing running ledger tab with interim invoice"`

---

### Task 6: Enhanced Discharge Clearance Cockpit (`/ipd/patients/[id]/discharge`)

**Files:**
- Modify: `components/ipd/discharge/discharge-tab.tsx` (restructure to 4-step clearance cockpit matching Excel density)
- Modify: `app/(app)/ipd/patients/[id]/discharge/page.tsx`
- Test: `app/(app)/ipd/patients/__tests__/discharge-tab-enhanced.test.tsx`

**Interfaces:**
- Consumes: `getAdmissionSummary`, `toggleDischargeReadyClientAction`
- Produces: 4-step discharge clearance workflow (Medical, Pharmacy, Billing, Discharge Summary)

- [ ] **Step 1: Write failing test for enhanced discharge cockpit**
  Assert that `DischargeTab` renders 4 steps: Medical Clearance, Pharmacy Return checklist, Final Bill Settlement, and Discharge Summary card.
- [ ] **Step 2: Run test to verify it fails**
  `npx vitest run app/(app)/ipd/patients/__tests__/discharge-tab-enhanced.test.tsx`
- [ ] **Step 3: Enhance `DischargeTab` with high-density clearance cards**
  Style steps with status badges (`Completed`, `Pending`, `Ready`), 1-tap `Ready for discharge` toggle, discharge medications summary, and `Print Discharge Card` button.
- [ ] **Step 4: Run tests and verify**
  `npx vitest run app/(app)/ipd/patients/__tests__/discharge-tab-enhanced.test.tsx`
- [ ] **Step 5: Commit changes**
  `git commit -m "feat(ipd): enhance Discharge tab with 4-step clearance workflow and discharge summary"`

---

### Task 7: Complete Suite Verification & Routing Consistency

**Files:**
- Modify: `components/ipd/shell/tab-navigation.tsx` (verify badges, links, active tab resolution across all 8 tabs)
- Create: `app/(app)/ipd/patients/[id]/emar/page.tsx` (dedicated tab view for eMAR)
- Test: `app/(app)/ipd/patients/__tests__/tab-navigation-all-tabs.test.tsx`

**Interfaces:**
- Consumes: All 8 patient chart tab routes
- Produces: Seamless tab switching with consistent ~110px sticky header

- [ ] **Step 1: Write test verifying navigation between all 8 tabs**
  Verify that `TabNavigation` renders active state for `summary`, `orders`, `emar`, `vitals`, `notes`, `investigations`, `billing`, and `discharge`.
- [ ] **Step 2: Run test and add `emar/page.tsx`**
  Implement dedicated `emar/page.tsx` linking directly to full treatment administration flowsheet.
- [ ] **Step 3: Run full TypeScript compilation**
  `npx tsc --noEmit` -> Must exit 0.
- [ ] **Step 4: Run full Vitest suite across entire repository**
  `npx vitest run` -> 100% of test files and tests must pass.
- [ ] **Step 5: Commit changes**
  `git commit -m "feat(ipd): verify complete 8-tab patient chart suite and full test suite"`
