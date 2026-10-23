# Design Spec: Comprehensive IPD Admission, Consent Engine, Doctor Surveillance & Intake Workflow

**Date:** 2026-10-19  
**Status:** Approved for Implementation (Revision 3 — Production-Grade Clinical, Forensic & Legal Hardening)  
**Target Modules:** OPD Consultation (`/dashboard`), IPD Intake (`/ipd/new`, `/ipd/admissions/[id]/assign`), Patient Chart (`/ipd/admissions/[id]`), Global App Shell, Alerts Engine, Multi-Tenant Print System (`/print`)  
**Compliance Standards:** Indian Clinical Establishments Act, Medico-Legal Guidelines (CrPC/BNS), DPDP Act 2023, NABH Patient Safety & Consent Protocols

---

## 1. Executive Summary & Clinical Architecture

Inpatient admission is a coordinated clinical and administrative pipeline. This design solidifies every stage from OPD consultation through ward arrival, forensic documentation, consent custody, and multi-channel alerting:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       TWO ENTRY POINTS, ONE ADMISSION PIPELINE              │
│                                                                             │
│  [ ENTRY POINT A: OPD Consultation ]       [ ENTRY POINT B: Walk-In / Emer ]│
│  Doctor clicks "Admit to IPD"              Desk opens /ipd/new              │
│  Captures Admission Advice:                Smart Predictive Search          │
│  - Advised ward, Urgency, Diagnosis        - Phone / QID / MRN / Name       │
│  - Est. stay & Reception notes             - Or "Unidentified Emergency"    │
│                 │                                         │                 │
│                 ▼                                         │                 │
│  Reception "To Admit" Queue (/ipd?tab=awaiting)           │                 │
│  Ranked: Emergency > Same-Day > Planned                   │                 │
│  Shows wait timers, advice, advised ward                  │                 │
│                 │                                         │                 │
│                 └────────────────────┬────────────────────┘                 │
│                                      ▼                                      │
│                          1. BED ALLOCATION (Reserved)                       │
│                             Atomically holds bed                            │
│                             Generates gapless FY sequence                   │
│                                      │                                      │
│                                      ▼                                      │
│                          2. PATIENT PHYSICAL ARRIVAL                        │
│                             (Split from allocation!)                        │
│                             Starts room charges & clinical clock            │
│                             Triggers doctor "Patient in Ward" alert         │
│                             Backdating: Gated, Reasoned, Audited            │
│                                      │                                      │
│                                      ▼                                      │
│             3. POST-ARRIVAL INTAKE CHECKLIST (Derived Status)               │
│             ┌───────────────────────────────────────────────┐               │
│             │ • Related Persons (Persistent family contact) │               │
│             │ • Versioned Consent (Template snapshot, hash) │               │
│             │ • Payer-Aware Coverage (Deposit vs Pre-Auth)  │               │
│             │ • Medico-Legal Case (MLC & Police Intimation) │               │
│             └───────────────────────────────────────────────┘               │
│                                      │                                      │
│                 ┌────────────────────┴────────────────────┐                 │
│                 ▼                                         ▼                 │
│    GENERIC CLINICAL ALERTS ENGINE          MULTI-TENANT DYNAMIC PRINT PACK  │
│    - Global App Shell banner & toast       - A4 Case Sheet (Guruved style)  │
│    - Audio chime (user-interaction gated)  - Bilingual Consent Sheet        │
│    - Escalation to Nurse/Owner at 20 min   - Gapless FY Deposit Receipt     │
│    - Separates operational Acknowledged    - MLC Police Intimation Form     │
│      from "First Clinical Review Time"     - Immutable rendered snapshot    │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Core Architectural Pillars

### 2.1 Pillar 1: Separation of Bed Allocation vs. Physical Arrival
- **Bed Allocation (`bed_assignments.from_at`):** Reserves the bed so no other staff can assign it.
- **Physical Ward Arrival (`admissions.arrived_at`):**
  - Room charges and day-count billing commence strictly at `arrived_at`.
  - Clinical observation clocks (vitals due, initial assessment) begin at `arrived_at`.
  - The doctor alert *"Your patient [Name] has reached the ward, Bed [X]"* fires strictly when arrival is confirmed.
- **Permission-Gated Backdating:**
  - In emergencies, the patient physically reaches the ICU/bed before staff updates the terminal.
  - Setting `arrived_at` in the past (> 15 minutes) requires permission `ipd.admit` or `ipd.correct`.
  - Mandatory `arrival_backdate_reason` input (e.g., *"Direct emergency resuscitation in casualty before system entry"*).
  - Every backdated arrival writes an immutable record to `audit_logs` capturing real-time submission vs backdated timestamp.

---

### 2.2 Pillar 2: Generic Clinical Alerts Table (`clinical_alerts`)
Replaces ad-hoc alert columns on tables with an enterprise notification subsystem:

```ts
export const alertType = pgEnum('alert_type', [
  'patient_arrived_ward',       // Doctor alerted when patient physically reaches bed
  'new_emergency_admission',   // On-call doctor alerted of direct casualty admission
  'intake_incomplete_warn',     // Nurse/desk alerted of missing MLC/Consent
  'consent_pending_escalated',  // Escalation when consent pending > 30m in ICU
  'alert_unacknowledged_esc',   // Escalated to Nurse In-Charge / Owner
  'critical_lab_value'          // Future LIS integration
]);

export const alertStatus = pgEnum('alert_status', [
  'pending',
  'acknowledged',
  'escalated',
  'resolved',
  'dismissed'
]);

export const clinicalAlerts = pgTable('clinical_alerts', {
  id: id(),
  hospitalId: hospitalFk(),
  branchId: uuid('branch_id').notNull(),
  type: alertType('type').notNull(),
  subjectType: text('subject_type').notNull(), // 'admission' | 'patient' | 'lab_order'
  subjectId: uuid('subject_id').notNull(),
  
  // Recipient routing
  recipientUserId: uuid('recipient_user_id').references(() => users.id, { onDelete: 'set null' }),
  recipientRole: staffRole('recipient_role'), // fallback if user unassigned
  
  // Content & Metadata
  title: text('title').notNull(),
  message: text('message').notNull(),
  metadata: jsonb('metadata').$type<{
    admissionId: string;
    patientName: string;
    ipdNumber: number | null;
    bedLabel: string;
    wardName: string;
    urgency: string;
    isMlc: boolean;
  }>().notNull(),
  
  // Lifecycle & Escalation
  status: alertStatus('status').notNull().default('pending'),
  acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
  acknowledgedByUserId: uuid('acknowledged_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  escalateAfterMinutes: smallint('escalate_after_minutes').notNull().default(20),
  escalatedAt: timestamp('escalated_at', { withTimezone: true }),
  escalatedToUserId: uuid('escalated_to_user_id').references(() => users.id, { onDelete: 'set null' }),
  escalatedToRole: staffRole('escalated_to_role').default('nurse'),
  
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex('clinical_alerts_tenant_key').on(t.hospitalId, t.id),
  index('clinical_alerts_recipient_idx').on(t.hospitalId, t.recipientUserId, t.status)
    .where(sql`status in ('pending', 'escalated')`),
  index('clinical_alerts_sweep_idx').on(t.hospitalId, t.status, t.createdAt)
    .where(sql`status = 'pending'`),
]);
```

- **Scheduler / Cron Sweep:**
  Runs every 60 seconds (via the background cron schedule tool or serverless sweep) executing `sweepPendingAlerts(hospitalId)`:
  If `status = 'pending'` and `now() >= created_at + escalate_after_minutes`, updates `status = 'escalated'`, stamps `escalated_at`, and notifies the Nursing Superintendent or Hospital Owner.
- **Operational Acknowledgment vs. Clinical Review Quality Metric:**
  - `acknowledged_at`: When the physician acknowledges the notification ("I saw they reached the ward").
  - `first_reviewed_at`: Captured on `admissions` when the physician signs the first clinical progress note or inpatient medication order on [`/ipd/admissions/[id]/rounds`](file:///d:/Projects/HospitalAutomation/app/(app)/ipd/admissions/[id]/(file)/rounds/page.tsx).

---

### 2.3 Pillar 3: Gapless Per-Hospital Financial-Year Document Sequences
In Indian healthcare accounting and medico-legal standards, admission numbers and deposit receipts must be sequential and gapless per financial year (April 1 to March 31):

- Extends [`document_sequences`](file:///d:/Projects/HospitalAutomation/lib/db/schema.ts) with kinds `'admission'` and `'deposit_receipt'`.
- Format:
  - Admission Number: `ADM/{FY}/{00000}` (e.g. `ADM/26-27/00042`)
  - Receipt Number: `REC/{FY}/{00000}` (e.g. `REC/26-27/00128`)
- Concurrency Control: Uses row-locked PostgreSQL transactions with `SELECT ... FOR UPDATE` via `nextDocumentNumberInTx` so concurrent admissions or receipts never skip or collide.

---

### 2.4 Pillar 4: Hardened Versioned Consent Engine
- **Default State:** Always `'pending'`. Consent is never assumed or pre-checked.
- **Explicit Staff Attestation:** Staff member must check *"I attest the physical consent form was signed by the relative and is placed in the case folder"*, stamping `witness_staff_user_id` and timestamp.
- **Append-Only & Immutable:** Consent records cannot be edited. Corrections supersede the previous row with `supersedes_id` and audit reasons.
- **Server-Side Normalization & SHA-256 Hash:**
  The server normalizes template text, replaces placeholders with patient/signatory details, and computes a SHA-256 hash stored in `text_hash_sha256`. Even if template wording changes later, the exact text signed is mathematically preserved.
- **Doctor Explanation Separation:**
  The doctor who explained the prognosis/risks (`explained_by_doctor_id`) is tracked separately from the desk/nurse staff who entered the record (`entered_by_user_id`).
- **Template Constraint:** Exactly one active template version per code enforced via partial unique index:
  ```sql
  CREATE UNIQUE INDEX consent_templates_active_key ON consent_templates (hospital_id, code) WHERE is_active = true;
  ```
- **High-Risk Consent Suggestion:** Suggested when ward is ICU or HDU, but requires physician confirmation—never forced on routine post-op monitoring.

---

### 2.5 Pillar 5: Medico-Legal Case (MLC) & Police Intimation Tracking
In Indian medical practice, injuries from accidents, assaults, poisoning, burns, and snake bites are legally Medico-Legal Cases.

```sql
ALTER TABLE admissions ADD COLUMN IF NOT EXISTS is_mlc boolean NOT NULL DEFAULT false;
ALTER TABLE admissions ADD COLUMN IF NOT EXISTS mlc_number text; -- Gapless MLC/26-27/00018
ALTER TABLE admissions ADD COLUMN IF NOT EXISTS mlc_category text; -- 'rta' | 'assault' | 'poisoning' | 'snake_bite' | 'burns' | 'industrial' | 'hanging' | 'unnatural' | 'other'
ALTER TABLE admissions ADD COLUMN IF NOT EXISTS mlc_narrative text;
ALTER TABLE admissions ADD COLUMN IF NOT EXISTS police_station_name text;
ALTER TABLE admissions ADD COLUMN IF NOT EXISTS police_intimated_at timestamptz;
ALTER TABLE admissions ADD COLUMN IF NOT EXISTS police_intimation_mode text; -- 'written_slip' | 'phone_call' | 'in_person_constable'
ALTER TABLE admissions ADD COLUMN IF NOT EXISTS constable_name text;
ALTER TABLE admissions ADD COLUMN IF NOT EXISTS constable_buckle_no text;
ALTER TABLE admissions ADD COLUMN IF NOT EXISTS mlc_intimation_copy_url text;
```
- **Intake Flow:** Flagging `is_mlc: true` prompts the police intimation fields.
- **Non-Blocking Emergency:** If police intimation is pending, admission proceeds immediately while flagging an active task: *"⚠️ Police Intimation Pending for MLC #..."*.

---

### 2.6 Pillar 6: Unidentified Emergency Patients (Identity Safety)
To prevent polluted `0000000000` numbers or phantom global identities:
1. **Hospital-Local Temporary Identity Only:**
   - Unidentified patients receive a hospital-local temporary MRN (`TEMP-2627-0012`) and flag `is_unidentified: true`.
   - **No global QID is generated** while the identity is unverified.
   - Name format: `"Unidentified Male (~40y), Casualty 02/10"`.
2. **Deterministic Re-Pointing & Merge Engine:**
   - When relatives arrive and provide valid Aadhaar / Phone / Identity:
   - A dedicated merge service executes within a transaction:
     - Re-points `admissions.patient_id`, `encounters.patient_id`, `bed_assignments.patient_id`, `bill_items.patient_id`, and `clinical_notes.patient_id` to the confirmed `patients.id`.
     - Logs the merge event in `patient_merges` with staff user ID and audit trail.
     - Retains the temporary MRN in `patient_aliases` so physical lab labels or triage tags printed with the temporary ID remain traceable.

---

### 2.7 Pillar 7: Payer-Aware Intake Checklist & Deposit Controls
Intake financial requirements depend on how care is funded:

| Payer Kind | Financial Requirement at Intake | Non-Blocking Waiver Option |
|---|---|---|
| **Self-Pay (`self`)** | Advance Deposit recommended (e.g. ₹5,000) | Deposit Waived with mandatory reason: *"Emergency stabilization"*, *"Owner approved"*, *"Relative bringing cash"* |
| **Insurance / TPA (`insurance`)** | Pre-Authorization details required (TPA name, Policy No, Claim No, Pre-auth Status, Approved Amount ₹) | Deposit NOT required unless co-pay/excess applies |
| **Govt Scheme (`scheme`)** | Scheme Card / Ration Card / Ayushman Bharat PM-JAY registration | Deposit prohibited by scheme rules |
| **Corporate (`corporate`)** | Corporate credit letter reference | Direct corporate ledger debit |

- **Emergency Rule:** Advance deposit failures or absence **never abort or roll back an emergency admission**.
- **Accounting Reversals:** Deposit refunds or corrections are recorded as dedicated negative debit/credit ledger lines, never mutating historical receipt lines.

---

### 2.8 Pillar 8: Search Security, Rate-Limiting & Duplicate Guard

```
┌─────────────────────────────────────────────────────────────┐
│ 🔍 Smart Predictive Search: [ 9689308335                  ] │
├─────────────────────────────────────────────────────────────┤
│ ⚠️ DUPLICATE ADMISSION WARNING                              │
│ Patient "Bhayaram Pawara" is ALREADY ADMITTED!              │
│ Status: Inpatient · IPD #1042 · Ward: HDU Bed 02           │
│ Admitted: Today at 03:30 PM under Dr. Vinod Pawara          │
│ [ 📂 View Active Inpatient File ]   [ Cancel ]              │
└─────────────────────────────────────────────────────────────┘
```

1. **Pattern Detection:**
   - 10 digits -> Indian phone number E.164.
   - `QID-...` -> Verified Crockford base32 patient identifier.
   - `ADM-...` or `H-...` -> Hospital local admission or MRN.
   - Text -> Prefix & fuzzy name search.
2. **Security & Privacy:**
   - Enforced tenant isolation (`hospitalId` filter on all queries).
   - Rate-limited to max 60 searches/minute per session to block scraping.
   - Selecting a search candidate writes a record to `record_access_logs` (`reason: 'ipd_admission_search_select'`).
3. **Duplicate Prevention:**
   - If a patient has an active admission (`status IN ('awaiting_bed', 'admitted', 'discharge_ready')`), the search results immediately flag:  
     **"Already Admitted in Bed [X]"** and disable the "New Admission" button, preventing split clinical records.

---

## 3. Derived Intake Completeness Engine

Rather than a static boolean, `admissions.is_intake_complete` is derived from clinical and legal requirements:

```ts
export type IntakeRequirements = {
  hasBedAssigned: boolean;
  hasArrivedWard: boolean;
  hasAttendantRecorded: boolean;
  hasConsentSettled: boolean;    // obtained OR (pending AND emergency_override_reason present)
  hasFinancialCoverage: boolean; // deposit paid OR pre-auth active OR waiver_reason recorded
  hasMlcCompleted: boolean;      // if is_mlc is true, police_intimated_at must be set
};

export function evaluateIntakeCompleteness(admission: AdmissionWithRelations): {
  isComplete: boolean;
  missingItems: string[];
} {
  const missing: string[] = [];
  if (!admission.bedId) missing.push('Bed not assigned');
  if (!admission.arrivedAt) missing.push('Patient not arrived in ward');
  if (!admission.attendantId) missing.push('Attendant/Family contact missing');
  if (!admission.consentSettled) missing.push('Consent neither obtained nor emergency-waived');
  if (!admission.financialSettled) missing.push('Deposit / Pre-Auth / Waiver missing');
  if (admission.isMlc && !admission.policeIntimatedAt) missing.push('MLC Police intimation pending');
  
  return {
    isComplete: missing.length === 0,
    missingItems: missing,
  };
}
```

If incomplete, the patient chart displays an actionable **"⚠️ Incomplete Intake Checklist (3/6 Missing)"** banner with direct shortcuts for the desk/nurse to complete items.

---

## 4. Multi-Tenant Print System

Zero hard-coded hospital details. Printable documents pull dynamically from `hospitals` settings:

1. **Letterhead Fields:**
   - `hospitals.name` (e.g. *Guruved Hospital & Criticare Center*)
   - `hospitals.tagline` (e.g. *Devotion to Healing*)
   - `hospitals.address`, `hospitals.phone_numbers`
   - `doctors.name`, `doctors.qualifications`, `doctors.registration_number`
2. **Page 1: Admission Sheet A4 (`/print/ipd-admission/[admissionId]`):**
   - Renders exact boxes matching the reference physical stationery.
   - Displays Admission No, Date, IPD No, UHID, Patient Demographics, Consultant, Referring Doctor, Ward Transfer Log with dates and times, Attendant details with 10-digit contact boxes, and signature blocks.
   - If MLC: includes MLC number, Police Station, and Constable intimation details.
3. **Page 2: High-Risk Consent Sheet A4:**
   - Prints the exact snapshot of the text hash agreed upon in the patient's language.
   - Attendant name, relationship, and physician explanation signature.
4. **Historical Reproduction:**
   - When generating print documents, a snapshot payload is cached in `admission_print_snapshots`. Reprints years later render from the historical snapshot.

---

## 5. Security & Permission Matrix

| Action | Allowed Roles | System & DB Enforcements |
|---|---|---|
| Request OPD Admission Advice | `owner`, `doctor` | Must be attending doctor of active consultation encounter |
| Assign Bed (Intake) | `owner`, `receptionist` | Tenant isolation, atomic bed occupancy locks |
| Confirm Ward Arrival | `owner`, `nurse`, `receptionist` | Starts room charge clock; triggers doctor alert |
| Backdate Ward Arrival (> 15m) | `owner`, `receptionist` | Requires `arrival_backdate_reason`; writes to `audit_logs` |
| Record Persistent Contact | `owner`, `receptionist`, `nurse` | Preserved in `patient_contacts` |
| Attest Paper Consent | `owner`, `receptionist`, `nurse` | Requires staff witness stamp; cannot mutate existing rows |
| Confirm Consent Explanation | `owner`, `doctor` | Records `explained_by_doctor_id` |
| Record Medico-Legal Intimation | `owner`, `receptionist`, `doctor` | Required for MLC before intake marked complete |
| Acknowledge Arrival Alert | `owner`, attending `doctor` | Updates `clinical_alerts.status = 'acknowledged'` |
| First Clinical Review Time | `owner`, `doctor` | Automatically stamped when doctor signs first round/Rx |
