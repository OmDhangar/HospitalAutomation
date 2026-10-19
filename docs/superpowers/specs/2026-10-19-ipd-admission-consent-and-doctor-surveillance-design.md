# Design Spec: IPD Admission Redesign, 3-Way Search, Consent Engine & Doctor Surveillance Alerting

**Date:** 2026-10-19  
**Status:** Approved for Implementation Planning  
**Target Module:** Inpatient Department (`/ipd`, `/ipd/new`, `/ipd/my-patients`, `/dashboard`, `/print`)  
**Reference Hospital Stationery:** Guruved Hospital & Criticare Center (Dr. Vinod Rajesh Pawara, MD Medicine)

---

## 1. Executive Summary & Problem Statement

The current `/ipd/new` admission page in the Qurio Hospital Automation platform was built as a minimal 3-step proof-of-concept. It collects only basic demographic fields (Name, Phone, Age, Gender) and collapses billing into an optional `<details>` tag. 

In clinical hospital reality—demonstrated by the physical stationery used by Guruved Hospital & Criticare Center—admitting an inpatient requires:
1. **Emergency Contact / Attendant Details ("Brought By"):** Legally binding relative name, relation to patient, contact number, and signature.
2. **Clinical Referral Context:** Attending consultant (Consultant In-Charge), referring doctor, specific admission time, and provisional diagnosis.
3. **Formal Consent Tracking:** General admission consent and mandatory **High-Risk Consent** for critical, emergency, and ICU/HDU admissions with legally sound bilingual wording (English / Marathi).
4. **Advance Payment (Deposit) Capturing:** Prominent advance billing at the desk with immediate printable deposit receipts crediting the running patient ledger.
5. **3-Way Patient Search:** In emergencies, desk staff cannot always ask for a phone number; they need instant search by **Mobile Number**, **Patient Name**, or **UHID / QID** (the unique global identifier issued in OPD).
6. **Doctor Surveillance Alerting:** Attending physicians consulting in OPD or rounding in the ward must be alerted immediately via visual banners and audio chimes when a new patient is admitted under their clinical surveillance.
7. **Printable Stationery Matching Physical Case Files:** Immediate 1-click A4 printout matching the hospital's official admission form and high-risk consent sheet for physical case folder filing.

---

## 2. System Architecture & Workflows

```
┌────────────────────────────────────────────────────────────────────────┐
│                        DESK ADMISSION WORKFLOW                         │
│                                                                        │
│   1. 3-Way Patient Search (Mobile / Name / UHID)                       │
│      ├── Found: Auto-populate demographics & medical history           │
│      └── Not Found: Fast new patient registration                      │
│                                                                        │
│   2. Clinical & Attendant Information                                  │
│      ├── Consultant In-charge + Referring Doctor + Reason              │
│      ├── Admission Date & Time (defaults to now, editable)             │
│      ├── Ward & Bed Allocation (ICU, HDU, General, Special)           │
│      └── Attendant ("Brought By"): Name, Relation, Phone, Address      │
│                                                                        │
│   3. Consent Engine                                                    │
│      ├── General Admission Consent                                     │
│      ├── High-Risk Consent (auto-prompted for ICU / HDU / Emergency)  │
│      └── Signing Mode: "Signed on Paper" toggle (future digital canvas)│
│                                                                        │
│   4. Advance Billing (Deposit)                                         │
│      ├── Amount (₹) + Payment Mode (Cash, UPI, Card, Bank)            │
│      └── Posts to Ledger + triggers Receipt sequence                   │
└──────────────────────────────────┬─────────────────────────────────────┘
                                   │
                   Atomic DB Transaction Commit
                                   │
         ┌─────────────────────────┴─────────────────────────┐
         ▼                                                   ▼
┌──────────────────────────────────┐        ┌──────────────────────────────────┐
│      PRINT & FILE ENGINE         │        │    DOCTOR SURVEILLANCE ENGINE    │
│                                  │        │                                  │
│ 1. Printable Admission Sheet     │        │ 1. Real-time Doctor Banner       │
│    (matches Guruved A4 format)   │        │    (/dashboard & /ipd/my-patients)
│ 2. Printable High-Risk Consent   │        │ 2. Audio Chime Notification      │
│ 3. Printable Deposit Receipt     │        │ 3. Status: "Awaiting Review"     │
│                                  │        │ 4. 1-Click Acknowledge / Round   │
└──────────────────────────────────┘        └──────────────────────────────────┘
```

---

## 3. Data Model & Database Schema

### 3.1 Extensions to `admissions` Table ([`lib/db/schema.ts`](file:///d:/Projects/HospitalAutomation/lib/db/schema.ts#L1985))

We add the following fields to the `admissions` table:

```ts
// In lib/db/schema.ts inside admissions pgTable:
admissionFormNo: text('admission_form_no'),
admissionTime: text('admission_time'), // e.g. "03:30 PM"
referringDoctorName: text('referring_doctor_name'),

// Attendant / Brought By details (Emergency Contact)
broughtByName: text('brought_by_name'),
broughtByRelation: text('brought_by_relation'), // 'father' | 'mother' | 'spouse' | 'son' | 'daughter' | 'brother' | 'sister' | 'relative' | 'friend' | 'other'
broughtByPhone: text('brought_by_phone'),
broughtByAddress: text('brought_by_address'),

// Doctor surveillance & alert lifecycle
doctorAlertedAt: timestamp('doctor_alerted_at', { withTimezone: true }),
doctorAcknowledgedAt: timestamp('doctor_acknowledged_at', { withTimezone: true }),
doctorAcknowledgedByUserId: uuid('doctor_acknowledged_by_user_id').references(() => users.id, { onDelete: 'set null' }),
```

**Indexes:**
```sql
CREATE INDEX admissions_doctor_alert_idx ON admissions (hospital_id, admitting_doctor_id, status)
  WHERE doctor_acknowledged_at IS NULL AND status = 'admitted';
```

---

### 3.2 New `patient_consents` Table

Stores patient and relative consents with complete separation of concerns and future-proofing for tablet digital signature capture:

```ts
export const consentType = pgEnum('consent_type', [
  'general_admission',
  'high_risk',
  'surgical',
  'anaesthesia',
  'blood_transfusion',
]);

export const consentMethod = pgEnum('consent_method', [
  'paper',    // Signed on physical printed sheet, witnessed by staff
  'digital',  // Future tablet touch signature
]);

export const patientConsents = pgTable('patient_consents', {
  id: id(),
  hospitalId: uuid('hospital_id').notNull().references(() => hospitals.id, { onDelete: 'cascade' }),
  encounterId: uuid('encounter_id').notNull(),
  admissionId: uuid('admission_id').notNull().references(() => admissions.id, { onDelete: 'cascade' }),
  patientId: uuid('patient_id').notNull().references(() => patients.id, { onDelete: 'cascade' }),
  type: consentType('type').notNull().default('general_admission'),
  method: consentMethod('method').notNull().default('paper'),
  
  // Attendant / Signatory Details
  signatoryName: text('signatory_name').notNull(),
  signatoryRelation: text('signatory_relation').notNull(),
  signatoryPhone: text('signatory_phone'),
  
  // Paper signature verification
  signedOnPaper: boolean('signed_on_paper').notNull().default(true),
  paperDocumentRef: text('paper_document_ref'), // optional scan/photo attachment reference
  
  // Future digital signature payload (strokes / vector JSON / base64 image data)
  digitalSignatureData: text('digital_signature_data'),
  
  // Clinical explanation & witness
  explainedInLanguage: text('explained_in_language').default('mr'), // 'mr' (Marathi), 'hi' (Hindi), 'en' (English)
  witnessStaffUserId: uuid('witness_staff_user_id').references(() => users.id, { onDelete: 'set null' }),
  attendingDoctorId: uuid('attending_doctor_id').references(() => doctors.id, { onDelete: 'set null' }),
  signedAt: timestamp('signed_at', { withTimezone: true }).notNull().defaultNow(),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex('patient_consents_tenant_key').on(t.hospitalId, t.id),
  index('patient_consents_admission_idx').on(t.hospitalId, t.admissionId),
]);
```

**Row-Level Security & Policies:**
`patient_consents` receives standard tenant isolation policies plus the `clinical_access` restrictive policy:
```sql
CREATE POLICY tenant_isolation ON patient_consents
  USING (hospital_id = nullif(current_setting('app.hospital_id', true), '')::uuid)
  WITH CHECK (hospital_id = nullif(current_setting('app.hospital_id', true), '')::uuid);

CREATE POLICY clinical_access ON patient_consents AS RESTRICTIVE
  USING (public.app_clinical_access()) WITH CHECK (public.app_clinical_access());
```

---

## 4. Feature Specifications

### 4.1 3-Way Patient Search

Located at Section 1 of `/ipd/new`:
- **Segmented Control:**
  1. `[ 📱 Mobile Number ]`: Accepts 10 digits. Validates format. Supports `0000000000` for unknown/unconscious emergencies.
  2. `[ 👤 Patient Name ]`: Text search running fuzzy prefix matching across `patients.name` and `patients.name_key`. Shows name, age, gender, mobile, and town/village for disambiguation.
  3. `[ 🆔 UHID / QID ]`: Formatted input for `QID-XXXX-XXXX` (using `normalizeQid()`). Supports scanning standard barcode or QR code from physical OPD slips.
- **Selection Behavior:** Selecting any match autofills patient demographics (Name, Age, Gender, Address, Mobile, QID/UHID) and locks the patient ID. Staff can edit address/age if updated.
- **Registration Fallback:** If search yields no results, a 1-click button *"Register New Patient with this [Phone/Name/QID]"* unlocks the demographic input fields.

---

### 4.2 Comprehensive Admission Sheet (`/ipd/new`)

The page layout consists of six distinct, high-clarity cards:

1. **Card 1: Patient Identity & Demographics**
   - 3-Way Search bar + matched candidate list.
   - Patient Name, Age, Sex (Male / Female / Other), Phone Number, Full Address.
2. **Card 2: Consultant & Clinical Referral**
   - **Consultant In-Charge:** Dropdown of hospital doctors (required).
   - **Referring Doctor:** Free text input (e.g. "Dr. R. K. Patil, Dhule" or "Self / Walk-in").
   - **Admission Date & Time:** Defaults to `now()`, with standard date picker and time input.
   - **Provisional Diagnosis / Reason:** Free-text input with quick-pick chips (e.g. *Fever with Dehydration*, *Acute Gastroenteritis*, *COPD Exacerbation*, *RTA / Trauma*, *Snake Bite*).
3. **Card 3: Ward & Bed Allocation**
   - **Ward Selector:** Groups beds by ward classification (General Ward, Special Room, HDU / Emergency, ICU).
   - **Bed Picker:** Displays live free beds with bed label, ward name, and per-day room charge.
4. **Card 4: Attendant Details ("Brought By")**
   - **Attendant Name:** Full name of relative or accompanying person.
   - **Relationship:** Select box (`Father`, `Mother`, `Spouse`, `Son`, `Daughter`, `Brother`, `Sister`, `Relative`, `Friend`, `Other`).
   - **Contact Number:** 10-digit mobile number with a quick checkbox: `[ ] Same as patient phone`.
   - **Attendant Address:** Optional text field.
5. **Card 5: Consent Engine**
   - **General Admission Consent:** Default checked.
   - **High-Risk Consent:** Auto-checks when ward category is ICU, HDU, or Emergency. Can also be manually toggled for critical ward cases.
   - **Consent Text Card:** Full legal text displayed in English and Marathi:
     > *"WE THE RELATIVES OF THE PATIENT HAVE BEEN EXPLAINED ABOUT THE CRITICAL CONDITION AND POOR PROGNOSIS OF MY PATIENT IN THE LANGUAGE WE UNDERSTAND THE BEST. WE KNOW THAT OUR PATIENT IS VERY CRITICAL AND NEEDS CRITICAL CARE MONITORING... WE WILL NOT HOLD DOCTORS AND HOSPITAL STAFF RESPONSIBLE... GIVING VALID CONSENT IN FULL SOUND STATE OF MIND WITHOUT ANY EXTERNAL FORCES ON US."*
   - **Signatory Confirmation:** Autofilled from Attendant details.
   - **Paper Signature Toggle:** `[x] Consent Form Signed on Physical Paper (On File)`.
6. **Card 6: Advance Billing (Deposit)**
   - **Deposit Amount (₹):** Numeric currency field (e.g., ₹5,000).
   - **Payment Method:** `Cash` | `UPI` | `Card` | `Bank transfer`.
   - **Transaction Ref:** Optional UPI/UTR/Card reference number.
   - Creates a linked `patient_payments` record tagged `is_deposit: true`.

---

### 4.3 Doctor Surveillance Alerting System

#### Visual & Audio Alerts
- **OPD Consultation Dashboard ([`/dashboard`](file:///d:/Projects/HospitalAutomation/app/(app)/dashboard/page.tsx)):**
  - Rendered at the top of the doctor view below the doctor header bar.
  - Alert Card Style: Amber/brand border, subtle pulse animation, stethoscope/bed icon.
  - Text:  
    **"🚨 New Inpatient Admission Under Your Surveillance"**  
    `Bhayaram Kalya Pawara (25y M) · IPD #1042 · HDU Bed 02 · Today at 03:30 PM`  
    `Provisional Diagnosis: Fever with moderate dehydration`  
    `Badges: [⚠️ High-Risk Consent On File] [₹5,000 Advance Paid]`
  - Action 1: **`[ ✓ Acknowledge ]`** — Marks alert acknowledged, dismisses banner.
  - Action 2: **`[ 📋 Open Rounding Cockpit ]`** — Deep-links directly to `/ipd/admissions/[id]/rounds`.
- **IPD Doctor Roster ([`/ipd/my-patients`](file:///d:/Projects/HospitalAutomation/app/(app)/ipd/my-patients/page.tsx)):**
  - Identical alert banner at the top.
  - The patient's row in the table is highlighted with a pulse badge: `🚨 New Admission · Awaiting Round`.
- **Audible Notification:**
  - Auto-refresh (every 10s on dashboard, 15s on IPD) detects `doctor_acknowledged_at IS NULL`.
  - Triggers the existing web audio call chime (`/sounds/call-chime.mp3`) once per new admission event.

---

### 4.4 Printable Forms & Receipts Engine

#### Printable Admission Form (`/print/ipd-admission/[admissionId]`)
- Formatted specifically for standard A4 portrait printing with zero overflow.
- **Page 1: Admission Sheet**
  - Hospital Letterhead: Guruved Hospital & Criticare Center, Dr. Vinod Rajesh Pawara, Reg No., Address, Phone numbers.
  - Grid Table: Admission Form No, Date, IPD No., UHID.
  - Patient demographics (Name, Age, Sex, Address).
  - Consultant In-charge, Referring Doctor, Admission Date & Time.
  - Ward Transfer Log (General Ward, Special Room, HDU/Emergency, ICU) with Date & Time entries.
  - Deposit amount and payment mode.
  - Attendant ("Brought By") block with 10-box contact number styling and signature lines for Relative and Doctor.
- **Page 2: High-Risk Consent Sheet** (Included when High-Risk Consent is flagged)
  - Hospital letterhead.
  - Patient demographics header.
  - Complete verbatim High-Risk Consent declaration text in English and Marathi.
  - Relative signature block with Name, Relationship, and Attending Doctor signature line.

#### Printable Deposit Receipt (`/print/receipt/[paymentId]`)
- Clean A5 / 80mm thermal receipt format.
- Receipt Number, Date & Time, Patient Name, IPD No., UHID.
- Amount in numbers (₹5,000.00) and words (*"Rupees Five Thousand Only"*).
- Payment Mode & Reference, Received By staff name, Hospital authorization stamp.

---

## 5. Security, Permissions & Compliance

1. **Role-Based Access Control ([`lib/domain/permissions.ts`](file:///d:/Projects/HospitalAutomation/lib/domain/permissions.ts)):**
   - Creating Admissions: `can(role, 'ipd.admit')` (`owner`, `receptionist`).
   - Taking Advance Deposits: `can(role, 'billing.collect')` (`owner`, `receptionist`).
   - Acknowledging Doctor Alerts: Clinicians linked to the attending doctor (`doctors.user_id`) or `owner`.
2. **Clinical Privacy Key & Tenant Isolation:**
   - All admission queries and consent mutations run within `withTenant(hospitalId, fn, { clinical: true })`.
   - Restrictive RLS on `admissions` and `patient_consents` ensures records fail closed and are never leaked to non-clinical or support sessions.
3. **Indian Healthcare Regulations:**
   - **Clinical Establishments Act:** Preserves permanent record of admitting consultant, referring medical practitioner, and physical signature logs.
   - **NABH Patient Rights & Education (PRE):** Verifiable consent records with documented patient/relative explanation in local language.

---

## 6. Implementation Stages & Verification Plan

### Stage 1: Database Migration
- Add `admission_form_no`, `admission_time`, `referring_doctor_name`, `brought_by_*`, `doctor_*` columns to `admissions`.
- Create `patient_consents` table, enums (`consent_type`, `consent_method`), and RLS policies.
- Run migration linter: `npx vitest run lib/db/migrations/__tests__/lint.test.ts`.

### Stage 2: Backend Domain & Services
- Update `lib/services/admissions.ts` to support 3-way patient resolution, attendant details, consent generation, and deposit processing.
- Add `searchPatients({ hospitalId, query, mode })` supporting phone, name, and QID/UHID.
- Add `acknowledgeDoctorAdmissionAlert({ hospitalId, admissionId, actorUserId })`.
- Write unit & integration tests in `lib/services/__tests__/admissions.integration.test.ts`.

### Stage 3: UI Redesign of `/ipd/new`
- Implement 3-Way Search tab component with live results.
- Implement Cards 1 through 6 with clean typography and auto-population.
- Implement post-admission dialog with instant 1-click Print actions.

### Stage 4: Doctor Surveillance Alerting
- Update [`loadDashboardData`](file:///d:/Projects/HospitalAutomation/lib/services/dashboard-loader.ts) to query unacknowledged inpatient admissions.
- Render alert banner and audio chime on [`app/(app)/dashboard/page.tsx`](file:///d:/Projects/HospitalAutomation/app/(app)/dashboard/page.tsx).
- Add alert strip and highlight styling on [`app/(app)/ipd/my-patients/page.tsx`](file:///d:/Projects/HospitalAutomation/app/(app)/ipd/my-patients/page.tsx).

### Stage 5: A4 Print Pages
- Create `/print/ipd-admission/[admissionId]` matching Guruved Hospital stationery.
- Create `/print/receipt/[paymentId]` for deposit receipts.
- Verify print layouts using browser test runner.
