# IPD Admission Redesign, Smart Search, Consent Engine & Doctor Surveillance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform the IPD admission workflow into a unified clinical intake system bridging OPD consultations and emergency walk-ins—featuring OPD admission advice, urgency-ranked awaiting queue, single smart search, persistent family contacts (`patient_contacts`), versioned legal consents (`patient_consents`), non-blocking advance deposits with gapless receipts, global doctor surveillance alerts with audio chimes, and multi-tenant A4 printable case packs matching Guruved Hospital stationery.

**Architecture:** Extend `admissions` with urgency, advised ward, and sequence columns; introduce `patient_contacts`, `consent_templates`, and `patient_consents`; unify `/ipd/new` and `/ipd/admissions/[id]/assign` into a single 2-column intake form with a <60s Minimum Viable Admission (MVA); wire doctor advice into the OPD consultation panel and the awaiting queue; broadcast arrival alerts to the global app shell; and render printable case sheets dynamically from hospital settings.

**Tech Stack:** Next.js 15 (App Router, Server Actions), PostgreSQL, Drizzle ORM, Row Level Security (`withTenant`, `app.clinical_access`), Tailwind CSS, Web Audio API chime.

**Spec:** [`docs/superpowers/specs/2026-10-19-ipd-admission-consent-and-doctor-surveillance-design.md`](file:///d:/Projects/HospitalAutomation/docs/superpowers/specs/2026-10-19-ipd-admission-consent-and-doctor-surveillance-design.md)

---

## Global Constraints

- Every query and mutation touching clinical records MUST execute within `withTenant(hospitalId, fn, { clinical: true })`.
- All SQL migrations MUST be idempotent (`IF NOT EXISTS`, `ON CONFLICT DO NOTHING`) and pass `lib/db/migrations/__tests__/lint.test.ts`.
- In emergencies, consent or deposit absence MUST NEVER block bed allocation or patient care.
- Multi-tenant letterhead MUST pull hospital name, registration numbers, address, and doctor details dynamically from database settings (zero hard-coded hospital names).
- Intake form MUST be dual-entry: pre-fills and locks patient if arriving from OPD consultation; provides smart search if direct walk-in/emergency.

---

## Review Focus

1. **OPD-to-IPD Pre-population:** Admitting an OPD-shifted patient must lock patient demographics, pre-fill doctor advice, and require only bed assignment to complete intake.
2. **Bed Allocation Race Condition:** If two receptionists assign the same bed concurrently, the transaction must roll back cleanly with `"Bed [Label] was taken just now"`.
3. **Unidentified Emergency Intake:** Creating an unidentified patient must generate a valid temporary identity without fake `0000000000` numbers and permit later merging.
4. **Doctor Alert Delivery Across Views:** An alert for an arriving inpatient must display as a banner/toast in the global header regardless of whether the doctor is in OPD queue, consultation, or settings.
5. **Print Layout A4 Integrity:** Printing `/print/ipd-admission/[admissionId]` must fit Page 1 (Admission Sheet) and Page 2 (High-Risk Consent) onto exact individual A4 sheets with zero margin overflow.

---

## Task Decomposition

### Task 1: Database Migration & Schema Extensions (Migration 0054)

**Files:**
- Create: `drizzle/0054_ipd_admission_and_consents.sql`
- Modify: `lib/db/schema.ts:1985-2040`
- Test: `lib/db/migrations/__tests__/lint.test.ts`

**Interfaces:**
- Produces:
  - `admissions` new columns: `admissionNumber`, `urgency`, `advisedWardKind`, `estimatedStayDays`, `receptionNotes`, `referringDoctorName`, `doctorAlertedAt`, `doctorAcknowledgedAt`, `doctorAcknowledgedByUserId`, `firstReviewedAt`, `firstReviewedByUserId`, `isIntakeComplete`, `intakeCompletedAt`, `intakeCompletedByUserId`.
  - `patientContacts` table for persistent family/emergency contacts.
  - `consentTemplates` table for versioned legal wording.
  - `patientConsents` table with immutable text snapshots and signature fields.
  - RLS policies: `tenant_isolation` and `clinical_access`.

- [ ] **Step 1: Write migration `drizzle/0054_ipd_admission_and_consents.sql`**
  Add idempotent SQL for `admissions` columns, `patient_contacts`, `consent_templates`, `patient_consents`, document sequence kinds (`admission_number`, `deposit_receipt`), and RLS policies.
- [ ] **Step 2: Update `lib/db/schema.ts`**
  Export `patientContacts`, `consentTemplates`, and `patientConsents` Drizzle pgTable definitions.
- [ ] **Step 3: Run migration linter test**
  Run `npx vitest run lib/db/migrations/__tests__/lint.test.ts` and confirm all migration rules pass.
- [ ] **Step 4: Commit**
  `git add drizzle/0054_ipd_admission_and_consents.sql lib/db/schema.ts && git commit -m "feat(db): add 0054 migration for admission redesign, contacts, and versioned consents"`

---

### Task 2: Smart Predictive Patient Search & Unidentified Intake Service

**Files:**
- Create: `lib/services/patient-search.ts`
- Modify: `lib/services/patients.ts:260-320`
- Test: `lib/services/__tests__/patient-search.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type SmartSearchResult = {
    id: string;
    name: string;
    age: number | null;
    gender: string | null;
    phoneE164: string;
    address: string | null;
    mrn: string | null;
    qid: string | null;
    lastVisitAt: Date | null;
    matchType: 'phone' | 'qid' | 'mrn' | 'name';
  };
  export async function searchPatientsSmart(args: {
    hospitalId: string;
    query: string;
    actorUserId: string;
    limit?: number;
  }): Promise<SmartSearchResult[]>;
  export async function registerUnidentifiedPatient(args: {
    hospitalId: string;
    branchId: string;
    gender?: string | null;
    approxAge?: number | null;
    descriptiveNote?: string | null;
    actorUserId: string;
  }): Promise<{ patientId: string; tempName: string; mrn: string }>;
  ```

- [ ] **Step 1: Write unit test in `lib/services/__tests__/patient-search.test.ts`**
  Assert 10 digits triggers phone match; `QID-...` triggers QID match; alphanumeric matches MRN; text triggers fuzzy name match with `record_access_logs` entry.
- [ ] **Step 2: Implement `searchPatientsSmart` and `registerUnidentifiedPatient` in `lib/services/patient-search.ts`**
  Enforce tenant isolation and audit logging.
- [ ] **Step 3: Verify test passes**
  Run `npx vitest run lib/services/__tests__/patient-search.test.ts`.
- [ ] **Step 4: Commit**
  `git add lib/services/patient-search.ts lib/services/__tests__/patient-search.test.ts && git commit -m "feat(patients): implement smart single-box search and unidentified registration"`

---

### Task 3: OPD Admission Advice Capture & Awaiting Queue Upgrades

**Files:**
- Modify: `lib/services/admissions.ts:114-180`
- Modify: `app/(app)/dashboard/shift-to-ipd-button.tsx:1-80`
- Modify: `app/(app)/dashboard/ipd-actions.ts:20-60`
- Modify: `lib/services/ipd-census.ts:150-220`
- Modify: `app/(app)/ipd/page.tsx:80-140`
- Test: `lib/services/__tests__/opd-admission-advice.test.ts`

**Interfaces:**
- Produces:
  - Doctor's admission advice modal on OPD consultation dashboard capturing advised ward, urgency, diagnosis, expected stay, and reception note.
  - Urgency-sorted Awaiting Bed queue on `/ipd?tab=awaiting` with wait timer and advice ribbons.

- [ ] **Step 1: Write integration test in `lib/services/__tests__/opd-admission-advice.test.ts`**
  Assert `shiftToIpd` stores doctor advice and sets urgency; verify `getIpdCensus` returns patients sorted by urgency (Emergency > Same-Day > Planned).
- [ ] **Step 2: Update `shiftToIpd` in `lib/services/admissions.ts` and `ipd-actions.ts`**
  Add advice parameters to `shiftToIpd` signature.
- [ ] **Step 3: Update `ShiftToIpdButton` in `app/(app)/dashboard/shift-to-ipd-button.tsx`**
  Open quick advice dialog before dispatching shift action.
- [ ] **Step 4: Update Awaiting Bed queue in `app/(app)/ipd/page.tsx`**
  Render urgency badge, wait timer, and doctor advice preview with 1-click **"Assign Bed & Intake"** link.
- [ ] **Step 5: Verify test passes**
  Run `npx vitest run lib/services/__tests__/opd-admission-advice.test.ts`.
- [ ] **Step 6: Commit**
  `git add lib/services/admissions.ts app/(app)/dashboard/shift-to-ipd-button.tsx app/(app)/dashboard/ipd-actions.ts lib/services/ipd-census.ts app/(app)/ipd/page.tsx lib/services/__tests__/opd-admission-advice.test.ts && git commit -m "feat(ipd): implement OPD admission advice and urgency-ranked awaiting queue"`

---

### Task 4: Unified Inpatient Intake Service & Alert Actions

**Files:**
- Modify: `lib/services/admissions.ts:420-560`
- Modify: `app/(app)/ipd/actions.ts:180-260`
- Test: `lib/services/__tests__/intake-service.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type ExecuteIntakeInput = {
    hospitalId: string;
    branchId: string;
    admissionId?: string | null; // provided if completing an OPD-shifted admission
    patientId?: string | null;   // provided if existing patient
    newPatient?: { phoneE164: string; name: string; age?: number | null; gender?: string | null; address?: string | null };
    doctorId: string;
    bedId: string;
    referringDoctorName?: string | null;
    provisionalDiagnosis?: string | null;
    admittedAt?: Date;
    attendant?: { name: string; relation: string; phone?: string | null; address?: string | null; isDecisionMaker?: boolean };
    consent?: {
      highRiskAccepted: boolean;
      status: 'obtained' | 'pending' | 'refused';
      pendingReason?: string | null;
      signatoryCapacity: 'patient' | 'relative' | 'guardian' | 'legal_rep';
      inabilityReason?: string | null;
      paperOnFile: boolean;
      explainedByDoctorId?: string | null;
      language?: 'en' | 'mr' | 'hi';
    };
    deposit?: { amountRupees: number; method: 'cash' | 'upi' | 'card' | 'bank' };
    clientId: string; // Idempotency key
    actorUserId: string;
  };
  export async function executePatientIntake(args: ExecuteIntakeInput): Promise<{
    admissionId: string;
    admissionNumber: string;
    patientName: string;
    ipdNumber: number | null;
    depositId: string | null;
  }>;
  export async function acknowledgeDoctorSurveillanceAlert(args: {
    hospitalId: string;
    admissionId: string;
    actorUserId: string;
  }): Promise<void>;
  ```

- [ ] **Step 1: Write integration test in `lib/services/__tests__/intake-service.test.ts`**
  Verify single transaction creates/updates admission, records bed occupancy, saves persistent contact, creates versioned consent with text snapshot, posts deposit, and marks doctor alerted.
- [ ] **Step 2: Implement `executePatientIntake` and `acknowledgeDoctorSurveillanceAlert` in `lib/services/admissions.ts`**
  Handle both OPD-prefilled (`admissionId`) and direct emergency intake paths idempotently.
- [ ] **Step 3: Update `executeIntakeAction` in `app/(app)/ipd/actions.ts`**
  Expose server action with parameter parsing and client-key idempotency.
- [ ] **Step 4: Verify test passes**
  Run `npx vitest run lib/services/__tests__/intake-service.test.ts`.
- [ ] **Step 5: Commit**
  `git add lib/services/admissions.ts app/(app)/ipd/actions.ts lib/services/__tests__/intake-service.test.ts && git commit -m "feat(ipd): implement unified executePatientIntake service and alert actions"`

---

### Task 5: 2-Column Unified Intake Form UI

**Files:**
- Create: `components/ipd/intake/unified-intake-form.tsx`
- Create: `components/ipd/intake/intake-sticky-sidebar.tsx`
- Create: `components/ipd/intake/intake-smart-search.tsx`
- Create: `components/ipd/intake/intake-success-modal.tsx`
- Modify: `app/(app)/ipd/new/page.tsx:1-186`
- Modify: `app/(app)/ipd/admissions/[id]/assign/page.tsx:1-89`
- Test: `components/ipd/__tests__/unified-intake-form.test.tsx`

**Interfaces:**
- Replaces disparate pages with one cohesive, responsive 2-column component.
- Implements Minimum Viable Admission (MVA): patient, consultant, bed -> **[ ADMIT PATIENT ]** in < 60s.

- [ ] **Step 1: Write component test in `components/ipd/__tests__/unified-intake-form.test.tsx`**
  Assert pre-filled OPD patient locks identity; smart search works for walk-in; quick admit submits MVA without attendant/deposit; attendant pre-fills consent signatory.
- [ ] **Step 2: Build `intake-smart-search.tsx` and `intake-sticky-sidebar.tsx`**
  Display live intake checklist and completeness meter (e.g. 3/6 items).
- [ ] **Step 3: Build `unified-intake-form.tsx`**
  Implement 2-column layout with Cards 1–6 (Patient, Consultant & Bed, Attendant, Versioned Consent with English/Marathi declaration, Advance Deposit, Referral).
- [ ] **Step 4: Update `/ipd/new` and `/ipd/admissions/[id]/assign`**
  Wire both routes to render `UnifiedIntakeForm` with mode (`direct` vs `opd_prefilled`).
- [ ] **Step 5: Verify test passes**
  Run `npx vitest run components/ipd/__tests__/unified-intake-form.test.tsx`.
- [ ] **Step 6: Commit**
  `git add components/ipd/intake/* app/(app)/ipd/new/page.tsx app/(app)/ipd/admissions/[id]/assign/page.tsx components/ipd/__tests__/unified-intake-form.test.tsx && git commit -m "feat(ipd): implement 2-column unified intake form with MVA and live sidebar"`

---

### Task 6: Global Doctor Surveillance Alerting System

**Files:**
- Create: `components/ipd/global-surveillance-banner.tsx`
- Modify: `lib/services/dashboard-loader.ts:1-140`
- Modify: `app/(app)/layout.tsx:1-100`
- Modify: `app/(app)/dashboard/page.tsx:220-270`
- Modify: `app/(app)/ipd/my-patients/page.tsx:30-80`
- Modify: `app/(app)/ipd/my-patients/my-patients-table.tsx:60-120`
- Test: `components/ipd/__tests__/surveillance-alert.test.tsx`

**Interfaces:**
- Produces: Global app-shell banner & toast, audio chime trigger, escalation tracking, and `/ipd/my-patients` table pulse highlighting.

- [ ] **Step 1: Write component test in `components/ipd/__tests__/surveillance-alert.test.tsx`**
  Assert alert displays distinct message for OPD-shifted patient vs emergency walk-in; acknowledge action dismisses alert.
- [ ] **Step 2: Update `lib/services/dashboard-loader.ts`**
  Query active unacknowledged admissions (`doctor_acknowledged_at IS NULL`) for the current user's linked doctor.
- [ ] **Step 3: Implement `components/ipd/global-surveillance-banner.tsx`**
  Render banner with audio chime unlock check and escalation warning if > 20 mins unacknowledged.
- [ ] **Step 4: Wire banner into `app/(app)/layout.tsx` and `/ipd/my-patients`**
  Ensure alert is visible globally across all routes.
- [ ] **Step 5: Verify test passes**
  Run `npx vitest run components/ipd/__tests__/surveillance-alert.test.tsx`.
- [ ] **Step 6: Commit**
  `git add components/ipd/global-surveillance-banner.tsx lib/services/dashboard-loader.ts app/(app)/layout.tsx app/(app)/dashboard/page.tsx app/(app)/ipd/my-patients/page.tsx app/(app)/ipd/my-patients/my-patients-table.tsx components/ipd/__tests__/surveillance-alert.test.tsx && git commit -m "feat(ipd): implement global doctor surveillance alerts and audio chime"`

---

### Task 7: Multi-Tenant Print Pack (Admission Form, Consent & Deposit Receipt)

**Files:**
- Create: `app/(app)/print/ipd-admission/[admissionId]/page.tsx`
- Create: `app/(app)/print/receipt/[paymentId]/page.tsx`
- Create: `components/ipd/print/dynamic-admission-sheet.tsx`
- Create: `components/ipd/print/dynamic-consent-sheet.tsx`
- Test: `components/ipd/__tests__/print-pack.test.tsx`

**Interfaces:**
- Produces: Pixel-accurate A4 printable sheets dynamically rendered with hospital letterhead from `hospitals` settings, storing an immutable payload snapshot.

- [ ] **Step 1: Write test in `components/ipd/__tests__/print-pack.test.tsx`**
  Assert letterhead renders hospital name, reg no, doctor credentials, and phone from database; verify High-Risk Consent renders signed text snapshot.
- [ ] **Step 2: Implement `dynamic-admission-sheet.tsx` and `dynamic-consent-sheet.tsx`**
  Implement authentic layout with ward transfer table, 10-box contact numbers, and bilingual consent text with pure `@media print` CSS.
- [ ] **Step 3: Implement `/print/ipd-admission/[admissionId]` and `/print/receipt/[paymentId]`**
  Fetch admission, contact, and hospital branding records under tenant isolation.
- [ ] **Step 4: Verify test passes**
  Run `npx vitest run components/ipd/__tests__/print-pack.test.tsx`.
- [ ] **Step 5: Commit**
  `git add app/(app)/print/ipd-admission/[admissionId]/page.tsx app/(app)/print/receipt/[paymentId]/page.tsx components/ipd/print/* components/ipd/__tests__/print-pack.test.tsx && git commit -m "feat(print): implement multi-tenant A4 admission sheet, consent and deposit receipt"`

---

### Task 8: End-to-End Verification & Regression Suite

**Files:**
- Test: Full regression test suite run

- [ ] **Step 1: Run migration linter**
  `npx vitest run lib/db/migrations/__tests__/lint.test.ts`
- [ ] **Step 2: Run all patient search & admission domain tests**
  `npx vitest run lib/services/__tests__/patient-search.test.ts lib/services/__tests__/opd-admission-advice.test.ts lib/services/__tests__/intake-service.test.ts`
- [ ] **Step 3: Run UI & print component tests**
  `npx vitest run components/ipd/__tests__/unified-intake-form.test.tsx components/ipd/__tests__/surveillance-alert.test.tsx components/ipd/__tests__/print-pack.test.tsx`
- [ ] **Step 4: Commit any final test harness adjustments**
  `git commit -am "chore(ipd): verify complete unified intake, search, consent and surveillance suite"`
