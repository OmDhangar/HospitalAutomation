# IPD Admission Redesign, Smart Search, Consent Engine & Doctor Surveillance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform the IPD admission workflow into a unified, clinical-grade intake pipeline bridging OPD consultations and emergency walk-ins—featuring separated bed allocation vs. physical ward arrival, generic clinical alerts with automated escalation, locked financial-year document counters, hardened versioned consents with server-side hashing, Medico-Legal Case (MLC) police tracking, unidentified patient safety, payer-aware financial checklists, smart predictive search, and multi-tenant A4 printable case packs.

**Architecture:** Extend `admissions` with arrival, urgency, and MLC forensic columns; introduce `patient_contacts`, `consent_templates`, `patient_consents`, and `clinical_alerts`; unify `/ipd/new` and `/ipd/admissions/[id]/assign` into a 2-column intake form with a <60s Minimum Viable Admission (MVA); wire doctor advice into OPD consultation and priority awaiting queues; manage alert lifecycles and cron escalation in the global app shell; and render printable case sheets dynamically from hospital settings.

**Tech Stack:** Next.js 15 (App Router, Server Actions), PostgreSQL, Drizzle ORM, Row Level Security (`withTenant`, `app.clinical_access`), Tailwind CSS, Web Audio API chime.

**Spec:** [`docs/superpowers/specs/2026-10-19-ipd-admission-consent-and-doctor-surveillance-design.md`](file:///d:/Projects/HospitalAutomation/docs/superpowers/specs/2026-10-19-ipd-admission-consent-and-doctor-surveillance-design.md)

---

## Global Constraints

- Every query and mutation touching clinical records MUST execute within `withTenant(hospitalId, fn, { clinical: true })`.
- All SQL migrations MUST be idempotent (`IF NOT EXISTS`, `ON CONFLICT DO NOTHING`) and pass `lib/db/migrations/__tests__/lint.test.ts`.
- Room charges, clinical clocks, and arrival alerts MUST start strictly at physical ward arrival (`arrived_at`), NOT at bed allocation.
- Backdating `arrived_at` (> 15m) MUST be permission-gated, require a mandatory reason, and record real-time vs backdated stamps in `audit_logs`.
- In emergencies, consent or deposit absence MUST NEVER block bed allocation or physical patient care.
- Multi-tenant letterhead MUST pull hospital name, registration numbers, address, and doctor details dynamically from database settings (zero hard-coded hospital names).
- Unidentified emergency patients receive hospital-local temporary MRNs only; NO global QID is generated until verified.

---

## Review Focus

1. **Allocation vs. Arrival Billing Clock:** Assigning a bed at 2:00 PM and recording physical arrival at 3:30 PM must start room charges and the clinical clock strictly at 3:30 PM.
2. **Bed Allocation Race Condition:** If two receptionists assign the same bed concurrently, the transaction must roll back cleanly with `"Bed [Label] was taken just now"`.
3. **MLC Police Intimation Handling:** Admitting an MLC patient (RTA, assault, poisoning) must require police intimation fields before marking intake complete, without blocking emergency admission.
4. **Alert Escalation Sweep:** An unacknowledged alert must transition to `status = 'escalated'` and re-route to the nurse in-charge or owner after 20 minutes.
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
  - `admissions` new columns: `admissionNumber`, `urgency`, `advisedWardKind`, `estimatedStayDays`, `receptionNotes`, `referringDoctorName`, `arrivedAt`, `arrivalBackdateReason`, `isMlc`, `mlcNumber`, `mlcCategory`, `policeStationName`, `policeIntimatedAt`, `policeIntimationMode`, `constableName`, `constableBuckleNo`, `firstReviewedAt`, `firstReviewedByUserId`, `isIntakeComplete`.
  - `patientContacts` table for persistent family/emergency contacts.
  - `consentTemplates` table (with active partial unique index).
  - `patientConsents` table (immutable text snapshot, SHA-256 hash, doctor explanation, staff witness).
  - `clinicalAlerts` table (generic alert engine with `alertType`, `alertStatus`, escalation).
  - Document sequence kinds: `'admission'`, `'deposit_receipt'`, `'mlc'`.
  - RLS policies: `tenant_isolation` and `clinical_access`.

- [ ] **Step 1: Write migration `drizzle/0054_ipd_admission_and_consents.sql`**
  Add idempotent SQL for `admissions` columns, `patient_contacts`, `consent_templates`, `patient_consents`, `clinical_alerts`, document sequence kinds, and RLS policies.
- [ ] **Step 2: Update `lib/db/schema.ts`**
  Export `patientContacts`, `consentTemplates`, `patientConsents`, and `clinicalAlerts` Drizzle pgTable definitions.
- [ ] **Step 3: Run migration linter test**
  Run `npx vitest run lib/db/migrations/__tests__/lint.test.ts` and confirm all migration rules pass.
- [ ] **Step 4: Commit**
  `git add drizzle/0054_ipd_admission_and_consents.sql lib/db/schema.ts && git commit -m "feat(db): add 0054 migration for admission redesign, alerts, contacts, consents, and mlc"`

---

### Task 2: Smart Predictive Search & Unidentified Identity Safety

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
    activeAdmissionId: string | null; // For duplicate stay warning
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
  export async function mergeUnidentifiedPatient(args: {
    hospitalId: string;
    tempPatientId: string;
    confirmedPatientId: string;
    actorUserId: string;
  }): Promise<void>;
  ```

- [ ] **Step 1: Write unit test in `lib/services/__tests__/patient-search.test.ts`**
  Assert 10 digits triggers phone match; `QID-...` triggers QID match; alphanumeric matches MRN; text triggers fuzzy name match with `record_access_logs` entry; active IPD stay flags duplicate.
- [ ] **Step 2: Implement `searchPatientsSmart`, `registerUnidentifiedPatient`, and `mergeUnidentifiedPatient` in `lib/services/patient-search.ts`**
  Enforce tenant isolation, audit logging, and temporary MRN sequences.
- [ ] **Step 3: Verify test passes**
  Run `npx vitest run lib/services/__tests__/patient-search.test.ts`.
- [ ] **Step 4: Commit**
  `git add lib/services/patient-search.ts lib/services/__tests__/patient-search.test.ts && git commit -m "feat(patients): implement smart search, duplicate warning, and unidentified patient merge"`

---

### Task 3: OPD Admission Advice & Urgency-Ranked Awaiting Queue

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

### Task 4: Inpatient Intake Service: Allocation, Arrival, Alerts & Sequences

**Files:**
- Modify: `lib/services/admissions.ts:420-560`
- Create: `lib/services/clinical-alerts.ts`
- Modify: `app/(app)/ipd/actions.ts:180-260`
- Test: `lib/services/__tests__/intake-service.test.ts`

**Interfaces:**
- Produces:
  - `allocateBedInTx`: Reserves bed atomically.
  - `confirmWardArrival`: Sets `arrived_at`, starts room charges and clinical clock, triggers `clinical_alerts` row `'patient_arrived_ward'`. Gated backdating writes to `audit_logs`.
  - Next gapless FY document numbers for `admission` (`ADM/26-27/00042`), `deposit_receipt` (`REC/26-27/00128`), and `mlc` (`MLC/26-27/00018`).
  - `recordConsent`: Default pending, server-side SHA-256 hash, doctor explanation stamp.
  - Payer-aware financial recording: Advance deposit or pre-auth/waiver reason.
  - `acknowledgeAlert`: Acknowledges clinical alert.

- [ ] **Step 1: Write integration test in `lib/services/__tests__/intake-service.test.ts`**
  Verify allocation vs arrival split; verify arrival fires `clinical_alerts`; verify FY sequences are gapless; verify backdating requires reason and audits.
- [ ] **Step 2: Implement `allocateBedInTx`, `confirmWardArrival`, and `clinicalAlerts` services in `lib/services/`**
  Execute within `withTenant(..., { clinical: true })` with row locks.
- [ ] **Step 3: Update `executeIntakeAction` in `app/(app)/ipd/actions.ts`**
  Expose server actions with client-key idempotency.
- [ ] **Step 4: Verify test passes**
  Run `npx vitest run lib/services/__tests__/intake-service.test.ts`.
- [ ] **Step 5: Commit**
  `git add lib/services/admissions.ts lib/services/clinical-alerts.ts app/(app)/ipd/actions.ts lib/services/__tests__/intake-service.test.ts && git commit -m "feat(ipd): implement allocation vs arrival split, FY sequences, and clinical alerts service"`

---

### Task 5: 2-Column Unified Intake Form UI & Derived Completeness

**Files:**
- Create: `components/ipd/intake/unified-intake-form.tsx`
- Create: `components/ipd/intake/intake-sticky-sidebar.tsx`
- Create: `components/ipd/intake/intake-smart-search.tsx`
- Create: `components/ipd/intake/intake-success-modal.tsx`
- Modify: `app/(app)/ipd/new/page.tsx:1-186`
- Modify: `app/(app)/ipd/admissions/[id]/assign/page.tsx:1-89`
- Test: `components/ipd/__tests__/unified-intake-form.test.tsx`

**Interfaces:**
- Unifies `/ipd/new` and `/ipd/admissions/[id]/assign`.
- Implements Minimum Viable Admission (MVA): patient, consultant, bed -> **[ ADMIT PATIENT ]** in < 60s.
- Right sidebar shows intake completeness meter and missing checklist items.

- [ ] **Step 1: Write component test in `components/ipd/__tests__/unified-intake-form.test.tsx`**
  Assert pre-filled OPD patient locks identity; smart search works for walk-in; quick admit submits MVA without attendant/deposit; attendant pre-fills consent signatory.
- [ ] **Step 2: Build `intake-smart-search.tsx` and `intake-sticky-sidebar.tsx`**
  Display live intake checklist and completeness meter (e.g. 3/6 items).
- [ ] **Step 3: Build `unified-intake-form.tsx`**
  Implement 2-column layout with Cards 1–6 (Patient, Consultant & Bed, Attendant, Versioned Consent with English/Marathi declaration, Advance Deposit / Pre-auth, MLC & Referral).
- [ ] **Step 4: Update `/ipd/new` and `/ipd/admissions/[id]/assign`**
  Wire both routes to render `UnifiedIntakeForm` with mode (`direct` vs `opd_prefilled`).
- [ ] **Step 5: Verify test passes**
  Run `npx vitest run components/ipd/__tests__/unified-intake-form.test.tsx`.
- [ ] **Step 6: Commit**
  `git add components/ipd/intake/* app/(app)/ipd/new/page.tsx app/(app)/ipd/admissions/[id]/assign/page.tsx components/ipd/__tests__/unified-intake-form.test.tsx && git commit -m "feat(ipd): implement 2-column unified intake form with MVA and live completeness sidebar"`

---

### Task 6: Global Alerts Engine, Doctor Surveillance & Background Escalation

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
- Stamping `first_reviewed_at` on first clinical round/order.

- [ ] **Step 1: Write component test in `components/ipd/__tests__/surveillance-alert.test.tsx`**
  Assert alert displays distinct message for OPD-shifted patient vs emergency walk-in; acknowledge action dismisses alert.
- [ ] **Step 2: Update `lib/services/dashboard-loader.ts`**
  Query active unacknowledged alerts from `clinical_alerts` for the current user's linked doctor.
- [ ] **Step 3: Implement `components/ipd/global-surveillance-banner.tsx`**
  Render banner with audio chime unlock check and escalation warning if > 20 mins unacknowledged.
- [ ] **Step 4: Wire banner into `app/(app)/layout.tsx` and `/ipd/my-patients`**
  Ensure alert is visible globally across all routes.
- [ ] **Step 5: Verify test passes**
  Run `npx vitest run components/ipd/__tests__/surveillance-alert.test.tsx`.
- [ ] **Step 6: Commit**
  `git add components/ipd/global-surveillance-banner.tsx lib/services/dashboard-loader.ts app/(app)/layout.tsx app/(app)/dashboard/page.tsx app/(app)/ipd/my-patients/page.tsx app/(app)/ipd/my-patients/my-patients-table.tsx components/ipd/__tests__/surveillance-alert.test.tsx && git commit -m "feat(ipd): implement global clinical alerts engine, doctor surveillance, and audio notifications"`

---

### Task 7: Multi-Tenant Print Pack (Admission Form, Consent, MLC & Deposit Receipt)

**Files:**
- Create: `app/(app)/print/ipd-admission/[admissionId]/page.tsx`
- Create: `app/(app)/print/receipt/[paymentId]/page.tsx`
- Create: `components/ipd/print/dynamic-admission-sheet.tsx`
- Create: `components/ipd/print/dynamic-consent-sheet.tsx`
- Test: `components/ipd/__tests__/print-pack.test.tsx`

**Interfaces:**
- Produces: Pixel-accurate A4 printable sheets dynamically rendered with hospital letterhead from `hospitals` settings, storing an immutable payload snapshot.

- [ ] **Step 1: Write test in `components/ipd/__tests__/print-pack.test.tsx`**
  Assert letterhead renders hospital name, reg no, doctor credentials, and phone from database; verify High-Risk Consent renders signed text snapshot; verify MLC slip formats police details.
- [ ] **Step 2: Implement `dynamic-admission-sheet.tsx` and `dynamic-consent-sheet.tsx`**
  Implement authentic layout with ward transfer table, 10-box contact numbers, and bilingual consent text with pure `@media print` CSS.
- [ ] **Step 3: Implement `/print/ipd-admission/[admissionId]` and `/print/receipt/[paymentId]`**
  Fetch admission, contact, and hospital branding records under tenant isolation.
- [ ] **Step 4: Verify test passes**
  Run `npx vitest run components/ipd/__tests__/print-pack.test.tsx`.
- [ ] **Step 5: Commit**
  `git add app/(app)/print/ipd-admission/[admissionId]/page.tsx app/(app)/print/receipt/[paymentId]/page.tsx components/ipd/print/* components/ipd/__tests__/print-pack.test.tsx && git commit -m "feat(print): implement multi-tenant A4 admission sheet, consent, MLC intimation and deposit receipt"`

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
