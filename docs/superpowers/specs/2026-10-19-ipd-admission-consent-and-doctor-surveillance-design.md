# Design Spec: Comprehensive IPD Admission, Consent Engine, Doctor Surveillance & Intake Workflow

**Date:** 2026-10-19  
**Status:** Approved for Implementation (Revision 2 — Fully Grounded in Clinical Practice & OPD-to-IPD Continuity)  
**Target Modules:** OPD Consultation (`/dashboard`), IPD Intake (`/ipd/new`, `/ipd/admissions/[id]/assign`), Patient Chart (`/ipd/admissions/[id]`), Global App Shell, Print System (`/print`)  
**Multi-Tenant Design:** Fully dynamic letterhead & configuration driven by `hospitals` settings (zero hard-coded hospital names)

---

## 1. Executive Summary & Clinical Architecture

Inpatient admission is not a standalone desk form; it is a clinical transition with **two distinct entry points into one unified intake engine**:

```
[ ENTRY POINT A: OPD Consultation ]          [ ENTRY POINT B: Walk-In / Emergency ]
Doctor clicks "Admit to IPD"                   Desk opens /ipd/new
Captures Doctor's Admission Advice:            Single Smart Search (detects Phone/Name/QID)
- Advised ward category & urgency              Or "Register Unidentified Emergency Patient"
- Provisional diagnosis & stay estimate        
               │                                                 │
               ▼                                                 │
Reception: "To Admit" Queue (/ipd?tab=awaiting)                  │
Ordered by urgency (Emergency > Same-Day > Planned)              │
Shows doctor note, wait time, advised ward                       │
               │                                                 │
               └───────────────────────┬─────────────────────────┘
                                       ▼
                       ONE UNIFIED ADMISSION FORM
        ┌──────────────────────────────────────────────────────────────┐
        │  Left Column: Form Sections      │ Right Column: Sticky Live │
        │  1. Patient Identity (locked     │ Summary & Intake Progress │
        │     if from OPD; search if direct│                           │
        │  2. Consultant In-charge         │ • Patient Card & Identifiers
        │  3. Bed & Ward Allocation        │ • Advised vs Assigned Bed │
        │  ------------------------------- │ • Intake Checklist (MVA)  │
        │  [ QUICK ADMIT BUTTON (< 60s) ]  │ • Deposit Ledger Summary  │
        │  ------------------------------- │                           │
        │  4. Related Persons (Attendant)  │                           │
        │  5. Versioned Consent Engine     │                           │
        │  6. Advance Deposit Ledger       │                           │
        │  7. Clinical Referral Source     │                           │
        └──────────────────────────────┬───────────────────────────────┘
                                       │
                      Atomic DB Transaction Commit
                                       │
         ┌─────────────────────────────┴─────────────────────────────┐
         ▼                                                           ▼
┌─────────────────────────────────┐         ┌─────────────────────────────────┐
│     GLOBAL DOCTOR SURVEILLANCE  │         │       MULTI-TENANT PRINT PACK   │
│                                 │         │                                 │
│ 1. App-Shell Banner & Toast     │         │ 1. Admission Sheet A4           │
│    "Patient in Ward, Bed X"     │         │    (dynamic hospital letterhead)│
│    (or "New Inpatient Under     │         │ 2. Bilingual Consent Sheet      │
│     Your Surveillance")         │         │    (exact snapshot of wording)  │
│ 2. Configurable Audio Chime     │         │ 3. Gapless Deposit Receipt      │
│ 3. Escalation if unacknowledged │         │ 4. Historical Snapshot stored   │
│ 4. "First Clinical Review" metric│        └─────────────────────────────────┘
└─────────────────────────────────┘
```

---

## 2. The Admission Pipeline: Two Entry Points, One Form

### 2.1 Entry Point A: OPD Consultation Admission Advice
When an OPD doctor decides an outpatient needs admission (via the consultation action panel on `/dashboard`):
1. The modal captures the **Doctor's Admission Advice**:
   - `advised_ward_kind`: `'general' | 'special' | 'hdu' | 'icu'`
   - `urgency`: `'emergency' | 'same_day' | 'planned'`
   - `provisional_diagnosis`: text (pre-filled from active consultation notes)
   - `estimated_stay_days`: integer (e.g., 3 days)
   - `reception_notes`: text (e.g., *"Requires immediate oxygen support, cardiac monitor on standby"*)
2. The encounter transitions to stage `'ipd'`, creating an `admissions` row in status `'awaiting_bed'`.

### 2.2 Reception "To Admit" Queue (`/ipd?tab=awaiting`)
The awaiting queue displays:
- **Urgency Indicator:** `EMERGENCY` (red pill, animated pulse) | `SAME DAY` (amber) | `PLANNED` (blue).
- **Waiting Clock:** Time elapsed since doctor ordered admission (e.g., *"Waiting 14 min"*).
- **Doctor's Advice Ribbon:** Advised ward category, provisional diagnosis, and reception notes.
- **Sorting:** Strict priority queue: `emergency` first, then `same_day`, then `planned`; sub-sorted by longest wait time.
- Clicking **"Assign Bed & Intake"** opens the unified admission form with patient, doctor, diagnosis, and advised ward **pre-filled and locked**.

### 2.3 Entry Point B: Walk-In / Direct Emergency (`/ipd/new`)
For direct emergencies arriving straight to the casualty/desk:
- Staff uses the **Single Smart Search Box** or clicks **"Register Unidentified Patient"**.
- Fills consultant, selects bed, and executes intake immediately.

---

## 3. Data Model & Database Architecture

### 3.1 Extensions to `admissions` Table ([`lib/db/schema.ts`](file:///d:/Projects/HospitalAutomation/lib/db/schema.ts#L1985))

```sql
-- Admission Sequence & Timing
ALTER TABLE admissions ADD COLUMN IF NOT EXISTS admission_number text; -- Gapless per-hospital document sequence (e.g. ADM-2026-0042)
ALTER TABLE admissions ADD COLUMN IF NOT EXISTS urgency text DEFAULT 'same_day'; -- 'emergency' | 'same_day' | 'planned'
ALTER TABLE admissions ADD COLUMN IF NOT EXISTS advised_ward_kind text; -- 'general' | 'special' | 'hdu' | 'icu'
ALTER TABLE admissions ADD COLUMN IF NOT EXISTS estimated_stay_days smallint;
ALTER TABLE admissions ADD COLUMN IF NOT EXISTS reception_notes text;
ALTER TABLE admissions ADD COLUMN IF NOT EXISTS referring_doctor_name text;

-- Doctor Surveillance Lifecycle
ALTER TABLE admissions ADD COLUMN IF NOT EXISTS doctor_alerted_at timestamptz;
ALTER TABLE admissions ADD COLUMN IF NOT EXISTS doctor_acknowledged_at timestamptz;
ALTER TABLE admissions ADD COLUMN IF NOT EXISTS doctor_acknowledged_by_user_id uuid REFERENCES users(id);
ALTER TABLE admissions ADD COLUMN IF NOT EXISTS first_reviewed_at timestamptz; -- Clinical quality metric
ALTER TABLE admissions ADD COLUMN IF NOT EXISTS first_reviewed_by_user_id uuid REFERENCES users(id);

-- Intake Completeness Flags
ALTER TABLE admissions ADD COLUMN IF NOT EXISTS is_intake_complete boolean NOT NULL DEFAULT false;
ALTER TABLE admissions ADD COLUMN IF NOT EXISTS intake_completed_at timestamptz;
ALTER TABLE admissions ADD COLUMN IF NOT EXISTS intake_completed_by_user_id uuid REFERENCES users(id);
```

---

### 3.2 Persistent Related Persons (`patient_contacts`) Table
Family contacts outlive a single admission. A dedicated table preserves emergency contacts across hospital visits:

```ts
export const patientContacts = pgTable('patient_contacts', {
  id: id(),
  hospitalId: hospitalFk(),
  patientId: uuid('patient_id').notNull().references(() => patients.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  relation: text('relation').notNull(), // 'father' | 'mother' | 'spouse' | 'son' | 'daughter' | 'brother' | 'sister' | 'guardian' | 'other'
  phoneE164: text('phone_e164'),
  address: text('address'),
  isEmergencyContact: boolean('is_emergency_contact').notNull().default(true),
  isDecisionMaker: boolean('is_decision_maker').notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  uniqueIndex('patient_contacts_tenant_key').on(t.hospitalId, t.id),
  index('patient_contacts_patient_idx').on(t.hospitalId, t.patientId),
]);
```

---

### 3.3 Versioned Consent Engine (`consent_templates` & `patient_consents`)

To prevent hard-coded liability text and guarantee legal reproducibility:

```ts
/** Hospital-configurable versioned consent templates */
export const consentTemplates = pgTable('consent_templates', {
  id: id(),
  hospitalId: hospitalFk(),
  code: text('code').notNull(), // 'general_admission' | 'high_risk' | 'surgery' | 'anaesthesia'
  version: smallint('version').notNull().default(1),
  titleEn: text('title_en').notNull(),
  titleMr: text('title_mr'),
  titleHi: text('title_hi'),
  bodyEn: text('body_en').notNull(),
  bodyMr: text('body_mr'),
  bodyHi: text('body_hi'),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex('consent_templates_code_ver').on(t.hospitalId, t.code, t.version),
]);

/** Immutable record of patient/relative consent */
export const patientConsents = pgTable('patient_consents', {
  id: id(),
  hospitalId: hospitalFk(),
  admissionId: uuid('admission_id').notNull().references(() => admissions.id, { onDelete: 'cascade' }),
  patientId: uuid('patient_id').notNull().references(() => patients.id, { onDelete: 'cascade' }),
  templateId: uuid('template_id').references(() => consentTemplates.id),
  templateVersion: smallint('template_version').notNull(),
  
  // Immutable snapshot of exact wording signed
  textSnapshot: text('text_snapshot').notNull(),
  textHashSha256: text('text_hash_sha256').notNull(),
  language: text('language').$type<'en' | 'mr' | 'hi'>().notNull().default('mr'),
  
  // Status & Emergency non-blocking
  status: text('status').$type<'obtained' | 'pending' | 'refused' | 'revoked'>().notNull().default('obtained'),
  pendingReason: text('pending_reason'), // e.g. "Unconscious patient, relative arriving"
  
  // Signatory capacity
  signatoryCapacity: text('signatory_capacity').$type<'patient' | 'relative' | 'guardian' | 'legal_rep'>().notNull(),
  inabilityReason: text('inability_reason'), // 'unconscious' | 'minor' | 'altered_sensorium' | 'emergency_incapacitated'
  signatoryContactId: uuid('signatory_contact_id').references(() => patientContacts.id),
  signatoryNameSnapshot: text('signatory_name_snapshot').notNull(),
  signatoryRelationSnapshot: text('signatory_relation_snapshot').notNull(),
  signatoryPhoneSnapshot: text('signatory_phone_snapshot'),
  
  // Attestation & Signatures
  method: text('method').$type<'paper' | 'digital'>().notNull().default('paper'),
  paperOnFile: boolean('paper_on_file').notNull().default(true),
  paperDocumentScanUrl: text('paper_document_scan_url'),
  digitalSignatureVector: text('digital_signature_vector'),
  
  // Clinical explanation (doctor accountability)
  explainedByDoctorId: uuid('explained_by_doctor_id').references(() => doctors.id),
  witnessStaffUserId: uuid('witness_staff_user_id').references(() => users.id),
  signedAt: timestamp('signed_at', { withTimezone: true }).notNull().defaultNow(),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex('patient_consents_tenant_key').on(t.hospitalId, t.id),
  index('patient_consents_admission_idx').on(t.hospitalId, t.admissionId),
]);
```

---

### 3.4 Unidentified / Emergency Patient Identity Safety
To stop dirty `0000000000` records:
- When an unknown/unconscious patient arrives, the desk clicks **"Unidentified Emergency Patient"**.
- System generates a structured temporary identity:
  - Name: `"Unknown Male (~40y), Trauma 02/10"`
  - Flag: `is_unidentified: true`
  - Emergency MRN / QID generated.
- A permanent **"Resolve Unidentified Patient"** banner remains on the chart, allowing one-click merge into an existing or newly verified record via [`patients.merge`](file:///d:/Projects/HospitalAutomation/lib/domain/permissions.ts#L207) when family arrives.

---

## 4. Front-End Architecture & User Experience

### 4.1 Single Smart Search Box
Instead of a slow 3-way toggle, a single predictive search field automatically categorizes user input:
- **10 digits:** Treated as Indian Mobile number (normalizes to E.164). Lists all family members sharing that phone.
- **Matches `QID-[0-9A-Z]{4}-[0-9A-Z]{4}` or Crockford 32:** Queries platform QID.
- **Alphanumeric string without dashes:** Matches hospital-local MRN / UHID.
- **Text:** Triggers prefix/fuzzy name match.
- **Audit Logging:** Every patient search logs to `record_access_logs` for DPDP compliance.
- **Safety Confirmation:** Search results display Name, Age, Sex, Locality, and Last Visit. Desk must confirm 2 identifiers before locking.

---

### 4.2 Fast 2-Column Intake Form Layout

Designed to ensure **Minimum Viable Admission (MVA) is completed in under 60 seconds**:

```
┌──────────────────────────────────────────────────┬─────────────────────────────┐
│  FORM COLUMN (Left, 65%)                         │ STICKY SIDEBAR (Right, 35%) │
├──────────────────────────────────────────────────┼─────────────────────────────┤
│  1. PATIENT IDENTIFICATION                       │ INTAKE CHECKLIST & SUMMARY  │
│  [ Smart Search: Phone, Name, MRN, QID       ]   │                             │
│  Selected: Bhayaram Kalya Pawara (25y / Male)    │ Patient: Bhayaram Pawara    │
│  Locality: Mogrikheda · MRN: H-1042 · QID: 8K4M  │ UHID: QID-8K4M-2P7R         │
│  ----------------------------------------------  │ Status: Direct Emergency    │
│  2. CONSULTANT & BED (Minimum Viable Set)        │ ─────────────────────────── │
│  Consultant: Dr. Vinod Rajesh Pawara (MD)     ▼  │ Assigned Bed: HDU - Bed 02  │
│  Ward: HDU / Emergency ▼   Bed: [ Bed 02 (Free)] │ Room Charge: ₹ 2,500 / day  │
│  Provisional Diagnosis: Acute Gastroenteritis    │ ─────────────────────────── │
│  Admitted At: [ 02/10/2026, 03:30 PM ] (now)     │ Completeness: 3 / 6         │
│                                                  │ ☑ Patient Identifiers       │
│  ┌────────────────────────────────────────────┐  │ ☑ Consultant Assigned       │
│  │  ⚡ ADMIT PATIENT NOW (Hold Bed & Open File)│  │ ☑ Bed Allocated             │
│  └────────────────────────────────────────────┘  │ ☒ Attendant Contact (Draft) │
│  ----------------------------------------------  │ ☒ Consent (Pending)         │
│  3. ATTENDANT / RELATED PERSON                   │ ☒ Advance Deposit (₹0)      │
│  Name: Dilip Dudwe    Relation: Brother ▼        │ ─────────────────────────── │
│  Phone: 7806042541    [x] Decision Maker         │ Doctor's Advice (if OPD):   │
│  ----------------------------------------------  │ "Oxygen support needed"     │
│  4. CONSENT CAPTURING                            │                             │
│  [x] General Admission Consent                   │ [ 🖨️ Print Admission Pack ]│
│  [!] High-Risk Consent Suggested for HDU:        │ [ 🧾 Print Deposit Receipt ]│
│      [x] High-Risk Consent Obtained              │                             │
│      Explained By: Dr. Vinod Pawara              │                             │
│      Mode: [x] Signed on Paper on File           │                             │
│  ----------------------------------------------  │                             │
│  5. ADVANCE DEPOSIT (Optional, Non-blocking)     │                             │
│  Amount: ₹ 5,000      Mode: UPI ▼                │                             │
│  Receipt No: REC-2026-0842 (Auto-generated)      │                             │
│  ----------------------------------------------  │                             │
│  6. REFERRAL SOURCE: Dr. R. K. Patil (GP)        │                             │
└──────────────────────────────────────────────────┴─────────────────────────────┘
```

#### The MVA Rule (Minimum Viable Admission):
In critical trauma or shock, clicking **"ADMIT PATIENT NOW"** immediately:
1. Reserves the bed atomically (handling bed races).
2. Generates the gapless Admission Number.
3. Opens the inpatient encounter and alerts the doctor.
4. If Attendant, Consent, or Deposit are skipped, the admission status is set to `is_intake_complete = false`. A prominent **"⚠️ Incomplete Intake"** banner persists on the patient chart with 1-click links to finish paperwork as soon as the patient is stabilized.

---

## 5. Doctor Surveillance Alerting Architecture

### 5.1 Dual-Context Alert Messaging
The alert adapts based on clinical origin:
- **Case 1 (OPD-Shifted Patient):** Doctor already knows the patient.  
  Alert Message: *"Your patient [Name] has reached the ward and is in Bed [X]."*
- **Case 2 (Emergency / Direct Intake):** Doctor did not see them in OPD.  
  Alert Message: *"🚨 New Inpatient under your surveillance: [Name] (25y/M) in Bed [X]."*

### 5.2 Global App-Shell Visibility
Doctors are not always looking at `/dashboard` or `/ipd/my-patients`. The alert sits in the **Global App Header Shell** ([`app/(app)/layout.tsx`](file:///d:/Projects/HospitalAutomation/app/(app)/layout.tsx)):
- **App-Wide Notification Toast / Banner:** Visible across OPD queue, consultation panels, settings, and rounding views.
- **Configurable Sound:** Chime triggers only after user interaction has unlocked the browser Web Audio context; accompanied by a persistent pulsing visual indicator.
- **Escalation Protocol:** If `doctor_acknowledged_at` is null for > 20 minutes, a high-priority flag notifies the Nursing In-Charge and Hospital Owner.
- **Clinical Review Metric:**
  - `doctor_acknowledged_at`: When the doctor clicks "Acknowledge" (operational acknowledgement).
  - `first_reviewed_at`: When the doctor signs the first clinical round note or inpatient prescription on [`/ipd/admissions/[id]/rounds`](file:///d:/Projects/HospitalAutomation/app/(app)/ipd/admissions/[id]/(file)/rounds/page.tsx) (clinical quality & NABH metric).

---

## 6. Multi-Tenant Print System

### 6.1 Dynamic Letterhead & Branding
Zero hard-coded hospital names. The print engine extracts letterhead parameters dynamically from `hospitals` and `hospital_settings`:
- Hospital Name (e.g. *Guruved Hospital & Criticare Center*).
- Tagline (e.g. *Devotion to Healing*).
- Attending Doctor Name & Qualifications (from `doctors` table).
- Registration Numbers (Hospital Establishment Reg No., Doctor MMC/NMC Reg No.).
- Physical Address, Telephone, Emergency Helpline.
- Hospital Logo (if uploaded in settings).

### 6.2 Printable Pack Routes
1. **`/print/ipd-admission/[admissionId]`**:
   - **Page 1 (Admission Sheet):** Exactly replicates the physical layout from the reference stationery: Admission No., IPD No., UHID, Patient Demographics, Consultant, Referral, Ward Movement Table, Deposit details, and Attendant signature block with 10-box contact numbers.
   - **Page 2 (High-Risk Consent):** Included if High-Risk Consent was flagged. Renders exact legal text in the relative's selected language with witness and physician signature lines.
   - **Historical Immutability:** Stores a SHA-256 hash and JSON snapshot of the print payload at generation time, guaranteeing reprints years later are historically identical.
2. **`/print/receipt/[paymentId]`**:
   - Gapless sequential receipt for advance deposits with amount in figures and words (*"Rupees Five Thousand Only"*).

---

## 7. Edge Cases & Safety Hardening

| Failure Mode / Edge Case | Mitigation & System Behavior |
|---|---|
| **Bed taken concurrently by another user** | Atomic transaction detects `bed_assignments_bed_occupied` constraint; rolls back gracefully with user-friendly alert: *"Bed [Label] was taken just now. Please choose another bed."* |
| **Emergency patient with no relatives** | Intake permits checking *"Emergency: Consent Pending (Patient Incapacitated)"*; logs reason, allocates bed, and raises a visible task on ward due board. |
| **Unidentified unconscious patient** | One-tap creates `"Unknown Male (~40y)"` with temporary identifier; unlocks full emergency medical care without fake phone numbers; merges cleanly later. |
| **Double submission / network retry** | Client generates unique `client_id` (UUIDv4) passed in form; database enforces idempotency index, preventing duplicate admissions or double deposit receipts. |
| **Deposit transaction failure** | Deposit payment errors do NOT roll back emergency admission; admission completes and marks deposit as failed/uncollected for desk follow-up. |
| **Consultant reassignment** | If the patient is clinically transferred to another doctor, alert status resets and re-routes to the new consultant. |
| **Existing admissions backward compatibility** | Old admissions render cleanly with fallback defaults (`admission_number` displays IPD number, missing attendant displays *"Not recorded"*). |

---

## 8. Implementation Stages

1. **Stage 1: Database Migration (0054):**
   - Add columns to `admissions`.
   - Create `patient_contacts`, `consent_templates`, `patient_consents`, and document sequence for `admission_number`.
   - Apply tenant isolation and `clinical_access` RLS policies.
2. **Stage 2: Core Domain Services & Smart Search:**
   - Single smart search (`searchPatientsSmart`).
   - Doctor OPD Admission Advice service (`requestIpdAdmissionFromOpd`).
   - Unified intake service (`executePatientIntake`).
   - Doctor surveillance alert query & acknowledgement service.
3. **Stage 3: OPD "To Admit" & Reception Queue Upgrades:**
   - Update OPD "Shift to IPD" modal on `/dashboard` to capture advice.
   - Update `/ipd?tab=awaiting` queue with urgency sorting and advice ribbons.
4. **Stage 4: Unified Intake Form UI:**
   - Refactor `/ipd/new` and `/ipd/admissions/[id]/assign` into one shared component.
   - Implement 2-column MVA layout with sticky progress sidebar.
5. **Stage 5: Global Doctor Surveillance Alerting:**
   - Integrate alert banner in global layout shell and doctor dashboard.
   - Implement audio chime with user interaction gate.
6. **Stage 6: Multi-Tenant Print Engine:**
   - Build `/print/ipd-admission/[admissionId]` and `/print/receipt/[paymentId]` with dynamic letterhead.
7. **Stage 7: End-to-End Verification:**
   - Run migration linter, RLS tests, bed-race tests, and complete admission lifecycle suite.
