# IPD Admission Redesign, 3-Way Search, Consent Engine & Doctor Surveillance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform the IPD admission workflow into a production-grade clinical intake system matching Guruved Hospital stationery—featuring 3-way patient search (Mobile, Name, UHID), attendant/emergency contact details, bilingual High-Risk Consent tracking, advance payment (deposit) capturing with printable receipts, real-time doctor surveillance alert banners with audio chimes, and 1-click A4 printable case sheets.

**Architecture:** Extend `admissions` with attendant and referral metadata; introduce `patient_consents` table supporting paper-signed toggle now and vector signatures in the future; implement unified 3-way patient lookup service; atomize admission creation with deposit ledger posting; integrate real-time doctor surveillance query in dashboard loader with chime triggers; and render standard A4 printable sheets matching physical hospital stationery.

**Tech Stack:** Next.js 15 (App Router, Server Actions), PostgreSQL, Drizzle ORM, Row Level Security (`withTenant`, `app.clinical_access`), Tailwind CSS, Web Audio API chime.

**Spec:** [`docs/superpowers/specs/2026-10-19-ipd-admission-consent-and-doctor-surveillance-design.md`](file:///d:/Projects/HospitalAutomation/docs/superpowers/specs/2026-10-19-ipd-admission-consent-and-doctor-surveillance-design.md)

---

## Global Constraints

- Every database query and mutation MUST run through `withTenant(hospitalId, fn, { clinical: true })`.
- All SQL migrations MUST be idempotent (`IF NOT EXISTS`, `ON CONFLICT DO NOTHING`) and pass `lib/db/migrations/__tests__/lint.test.ts`.
- Paper-signed consent MUST be recorded with staff witness user ID and timestamp; the schema MUST store future vector digital signature data without breaking.
- Doctor alerts MUST fail closed: only the attending doctor or hospital owner may acknowledge an alert.
- Zero external CSS frameworks or Tailwind utility drifts: use existing design tokens (`ink-*`, `brand-*`, `SELECT_CLASS`).

---

## Review Focus

1. **Unknown/Unconscious Emergency Patient:** Search by `0000000000` or blank UHID must create an emergency patient without crashing phone validation or QID linking.
2. **Bed Allocation Race Condition:** If two receptionists assign the same bed concurrently, the second transaction must abort gracefully and display `"Bed [Label] was just taken"`.
3. **High-Risk Consent Ward Gating:** Admitting to ICU, HDU, or Emergency must automatically default High-Risk Consent to checked, requiring attendant name and paper-signed confirmation.
4. **Doctor Alert Dismissal Exclusivity:** Acknowledging an alert on the OPD dashboard must instantly dismiss it from `/ipd/my-patients` without requiring a page reload.
5. **Print Layout A4 Integrity:** Printing `/print/ipd-admission/[admissionId]` must fit Page 1 (Admission Sheet) and Page 2 (High-Risk Consent) onto exact individual A4 sheets with zero margin overflow or unwanted blank trailing pages.

---

## Task Decomposition

### Task 1: Database Migration & Schema Extensions

**Files:**
- Create: `drizzle/0054_ipd_admission_and_consents.sql`
- Modify: `lib/db/schema.ts:1985-2040`
- Test: `lib/db/migrations/__tests__/lint.test.ts`

**Interfaces:**
- Produces:
  - `admissions` new columns: `admissionFormNo`, `admissionTime`, `referringDoctorName`, `broughtByName`, `broughtByRelation`, `broughtByPhone`, `broughtByAddress`, `doctorAlertedAt`, `doctorAcknowledgedAt`, `doctorAcknowledgedByUserId`.
  - `patientConsents` Drizzle table with `consentType` and `consentMethod` enums.
  - RLS policies: `tenant_isolation` and `clinical_access` on `patient_consents`.

- [ ] **Step 1: Write migration `drizzle/0054_ipd_admission_and_consents.sql`**
  Add idempotent SQL for `admissions` columns, enums `consent_type` and `consent_method`, table `patient_consents`, and RLS policies.
- [ ] **Step 2: Update `lib/db/schema.ts`**
  Export `consentType`, `consentMethod`, and `patientConsents` pgTable definitions matching Drizzle standards.
- [ ] **Step 3: Run migration linter test**
  Run `npx vitest run lib/db/migrations/__tests__/lint.test.ts` and confirm all 34+ migration checks pass.
- [ ] **Step 4: Commit**
  `git add drizzle/0054_ipd_admission_and_consents.sql lib/db/schema.ts && git commit -m "feat(db): add 0054 migration for admission details and patient consents"`

---

### Task 2: 3-Way Patient Search Service

**Files:**
- Create: `lib/services/patient-search.ts`
- Test: `lib/services/__tests__/patient-search.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type PatientSearchResult = {
    id: string;
    name: string;
    age: number | null;
    gender: string | null;
    phoneE164: string;
    address: string | null;
    qid: string | null;
  };
  export async function searchPatients(args: {
    hospitalId: string;
    query: string;
    mode: 'phone' | 'name' | 'uhid';
    limit?: number;
  }): Promise<PatientSearchResult[]>;
  ```

- [ ] **Step 1: Write unit test in `lib/services/__tests__/patient-search.test.ts`**
  Assert searching by phone normalizes phone; searching by name uses `nameKey` or ilike; searching by UHID normalizes `QID-XXXX-XXXX`.
- [ ] **Step 2: Verify test fails**
  Run `npx vitest run lib/services/__tests__/patient-search.test.ts` (fails with function not defined).
- [ ] **Step 3: Implement `searchPatients` in `lib/services/patient-search.ts`**
  Use `withTenant` with parameterized queries on `patients.phone_e164`, `patients.name_key`, and `patients.qid`.
- [ ] **Step 4: Verify test passes**
  Run `npx vitest run lib/services/__tests__/patient-search.test.ts`.
- [ ] **Step 5: Commit**
  `git add lib/services/patient-search.ts lib/services/__tests__/patient-search.test.ts && git commit -m "feat(patients): implement 3-way patient search service"`

---

### Task 3: Inpatient Admission Service & Actions Upgrade

**Files:**
- Modify: `lib/services/admissions.ts:420-515`
- Modify: `app/(app)/ipd/actions.ts:180-230`
- Test: `lib/services/__tests__/admissions-comprehensive.test.ts`

**Interfaces:**
- Consumes: `patientConsents` from Task 1, `searchPatients` from Task 2.
- Produces:
  ```ts
  export type FullAdmissionInput = {
    hospitalId: string;
    branchId: string;
    doctorId: string;
    referringDoctorName?: string | null;
    admissionFormNo?: string | null;
    admissionTime?: string | null;
    patient: {
      phoneE164: string;
      name: string;
      age?: number | null;
      gender?: string | null;
      address?: string | null;
    };
    patientId?: string | null;
    bedId?: string | null;
    reason?: string | null;
    broughtBy?: {
      name: string;
      relation: string;
      phone?: string | null;
      address?: string | null;
    };
    consent?: {
      generalConsent: boolean;
      highRiskConsent: boolean;
      signedOnPaper: boolean;
      explainedLanguage?: string;
    };
    deposit?: {
      amountRupees: number;
      method: 'cash' | 'upi' | 'card' | 'bank';
    };
    actorUserId: string;
  };
  export async function createFullAdmission(args: FullAdmissionInput): Promise<{
    admissionId: string;
    patientName: string;
    ipdNumber: number | null;
    depositId: string | null;
  }>;
  export async function acknowledgeDoctorAlert(args: {
    hospitalId: string;
    admissionId: string;
    actorUserId: string;
  }): Promise<void>;
  ```

- [ ] **Step 1: Write integration test in `lib/services/__tests__/admissions-comprehensive.test.ts`**
  Verify that calling `createFullAdmission` inserts the `admissions` row, `patient_consents` row, assigns the bed, posts advance deposit, and sets `doctor_alerted_at`.
- [ ] **Step 2: Implement `createFullAdmission` and `acknowledgeDoctorAlert` in `lib/services/admissions.ts`**
  Wrap execution in a single `withTenant(..., { clinical: true })` transaction.
- [ ] **Step 3: Update `createDirectAdmissionAction` in `app/(app)/ipd/actions.ts`**
  Extract all form fields and call `createFullAdmission`. Add `acknowledgeDoctorAlertAction`.
- [ ] **Step 4: Verify test passes**
  Run `npx vitest run lib/services/__tests__/admissions-comprehensive.test.ts`.
- [ ] **Step 5: Commit**
  `git add lib/services/admissions.ts app/(app)/ipd/actions.ts lib/services/__tests__/admissions-comprehensive.test.ts && git commit -m "feat(ipd): implement comprehensive admission creation and alert acknowledgement"`

---

### Task 4: Redesigned Admission Form UI (`/ipd/new`)

**Files:**
- Create: `components/ipd/admission-3way-search.tsx`
- Create: `components/ipd/admission-success-modal.tsx`
- Modify: `app/(app)/ipd/new/page.tsx:1-186`
- Test: `components/ipd/__tests__/new-admission-form.test.tsx`

**Interfaces:**
- Consumes: `createDirectAdmissionAction` from Task 3, `searchPatients` from Task 2.
- Produces: Complete 6-card interactive admission screen with 3-way search, live ward/bed selection, auto-populating attendant, High-Risk Consent declaration, deposit options, and post-submit print modal.

- [ ] **Step 1: Write component test for 3-way search in `components/ipd/__tests__/new-admission-form.test.tsx`**
  Assert clicking tabs switches search mode between Mobile, Name, and UHID; selecting a result autofills demographic fields.
- [ ] **Step 2: Build `components/ipd/admission-3way-search.tsx`**
  Create accessible segmented control with responsive input fields and auto-complete dropdown.
- [ ] **Step 3: Overhaul `app/(app)/ipd/new/page.tsx`**
  Implement Cards 1–6 (Patient Demographics, Clinical Referral, Ward/Bed Allocation, Attendant Details, Consent Block with English/Marathi text, Advance Deposit).
- [ ] **Step 4: Build `components/ipd/admission-success-modal.tsx`**
  Create post-admission dialog with 1-click **[ Print Admission & Consent Form ]**, **[ Print Deposit Receipt ]**, and **[ Open Chart ]**.
- [ ] **Step 5: Verify test passes**
  Run `npx vitest run components/ipd/__tests__/new-admission-form.test.tsx`.
- [ ] **Step 6: Commit**
  `git add components/ipd/admission-3way-search.tsx components/ipd/admission-success-modal.tsx app/(app)/ipd/new/page.tsx components/ipd/__tests__/new-admission-form.test.tsx && git commit -m "feat(ipd): redesign /ipd/new with 3-way search and comprehensive admission cards"`

---

### Task 5: Doctor Surveillance Alerting on OPD & IPD Dashboards

**Files:**
- Create: `components/ipd/doctor-admission-alert.tsx`
- Modify: `lib/services/dashboard-loader.ts:1-120`
- Modify: `app/(app)/dashboard/page.tsx:220-280`
- Modify: `app/(app)/ipd/my-patients/page.tsx:30-75`
- Modify: `app/(app)/ipd/my-patients/my-patients-table.tsx:1-100`
- Test: `components/ipd/__tests__/doctor-admission-alert.test.tsx`

**Interfaces:**
- Consumes: `acknowledgeDoctorAlertAction` from Task 3.
- Produces: Real-time visual alert banner, audible chime trigger, and unacknowledged patient row highlighting.

- [ ] **Step 1: Write test in `components/ipd/__tests__/doctor-admission-alert.test.tsx`**
  Assert banner renders patient name, ward/bed, time, High-Risk Consent tag; clicking Acknowledge fires action and dismisses.
- [ ] **Step 2: Update `lib/services/dashboard-loader.ts`**
  Query unacknowledged admissions (`doctor_acknowledged_at IS NULL`) for the current doctor.
- [ ] **Step 3: Implement `components/ipd/doctor-admission-alert.tsx`**
  Render alert card with audio chime trigger on mount using `/sounds/call-chime.mp3`.
- [ ] **Step 4: Integrate banner into `app/(app)/dashboard/page.tsx` and `app/(app)/ipd/my-patients/page.tsx`**
  Render banner below doctor header bar; add pulse badge to table rows in `my-patients-table.tsx`.
- [ ] **Step 5: Verify test passes**
  Run `npx vitest run components/ipd/__tests__/doctor-admission-alert.test.tsx`.
- [ ] **Step 6: Commit**
  `git add components/ipd/doctor-admission-alert.tsx lib/services/dashboard-loader.ts app/(app)/dashboard/page.tsx app/(app)/ipd/my-patients/page.tsx app/(app)/ipd/my-patients/my-patients-table.tsx components/ipd/__tests__/doctor-admission-alert.test.tsx && git commit -m "feat(ipd): implement doctor surveillance alert banners and audio notification"`

---

### Task 6: Printable Admission Form, High-Risk Consent & Deposit Receipt

**Files:**
- Create: `app/(app)/print/ipd-admission/[admissionId]/page.tsx`
- Create: `app/(app)/print/receipt/[paymentId]/page.tsx`
- Create: `components/ipd/print/guruved-admission-sheet.tsx`
- Create: `components/ipd/print/high-risk-consent-sheet.tsx`
- Test: `components/ipd/__tests__/print-admission.test.tsx`

**Interfaces:**
- Produces: Pixel-accurate A4 printable sheets matching Guruved Hospital physical stationery with automatic page break.

- [ ] **Step 1: Write test in `components/ipd/__tests__/print-admission.test.tsx`**
  Assert printable page loads admission data, renders doctor/hospital header, formats 10-box contact number, and includes High-Risk Consent page if flagged.
- [ ] **Step 2: Build `guruved-admission-sheet.tsx` and `high-risk-consent-sheet.tsx`**
  Implement A4 layout with exact hospital letterhead, admission metadata boxes, ward transfer log table, and bilingual consent declaration.
- [ ] **Step 3: Implement `/print/ipd-admission/[admissionId]/page.tsx`**
  Render admission and consent sheets with `@media print` CSS rules.
- [ ] **Step 4: Implement `/print/receipt/[paymentId]/page.tsx`**
  Render official deposit receipt with hospital letterhead and amount in words.
- [ ] **Step 5: Verify test passes**
  Run `npx vitest run components/ipd/__tests__/print-admission.test.tsx`.
- [ ] **Step 6: Commit**
  `git add app/(app)/print/ipd-admission/[admissionId]/page.tsx app/(app)/print/receipt/[paymentId]/page.tsx components/ipd/print/guruved-admission-sheet.tsx components/ipd/print/high-risk-consent-sheet.tsx components/ipd/__tests__/print-admission.test.tsx && git commit -m "feat(print): implement A4 printable admission form, high-risk consent and deposit receipt"`

---

### Task 7: Full End-to-End Verification & Audit Run

**Files:**
- Test: Full regression suite run

- [ ] **Step 1: Run migration linter**
  `npx vitest run lib/db/migrations/__tests__/lint.test.ts`
- [ ] **Step 2: Run all IPD domain & service tests**
  `npx vitest run lib/domain/__tests__/admission.test.ts lib/services/__tests__/patient-search.test.ts lib/services/__tests__/admissions-comprehensive.test.ts`
- [ ] **Step 3: Run UI unit tests**
  `npx vitest run components/ipd/__tests__/new-admission-form.test.tsx components/ipd/__tests__/doctor-admission-alert.test.tsx components/ipd/__tests__/print-admission.test.tsx`
- [ ] **Step 4: Commit any final test harness adjustments**
  `git commit -am "chore(ipd): verify complete admission, search, consent and doctor surveillance suite"`
