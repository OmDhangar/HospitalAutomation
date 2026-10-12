# IPD Doctor Rounding Cockpit & Inpatient Medication Administration (eMAR) Design

**Date:** 2026-10-12  
**Status:** In Review (Updated with Clinical Governance & eMAR Feedback)  
**Module:** IPD (`core_ipd`, `patient_file`)

---

## 1. Problem Statement & Motivation

During daily inpatient rounds (15–30 beds), a doctor spends 1 to 2 minutes per patient at the bedside. Currently:
1. **Zero Prescription/Order Entry in IPD:** Medication prescribing is only available in the OPD consultation queue. IPD has no mechanism for doctors to order, adjust, hold, or discontinue patient medications.
2. **Page Fragmentation:** Doctors must jump across multiple disconnected pages (`/ipd/my-patients`, `/ipd/admissions/[id]`, `/ipd/admissions/[id]/tpr`, ward grids).
3. **Bedside Nursing Guesswork:** Bedside nurses on `RecordScreen` have no structured Medication Administration Record (MAR). They must manually search an open-ended database or choose generic starter chips.
4. **Safety & Order State Risks:** Prescriptions cannot be treated as a single daily snapshot where the latest version supersedes everything; medications have independent lifecycles (multi-day courses, PRN orders, holds, dose adjustments). Tapping an order must not be confused with administering a dose.

---

## 2. Core Architectural Principles & Scope

### Principle 1: Order State vs. Round Snapshots
- An IPD patient's medication plan is **not** a single daily prescription snapshot where "latest wins".
- Individual medication orders have their own **lifecycle** (`draft`, `active`, `on_hold`, `discontinued`, `completed`).
- Round notes and daily review sessions capture the clinician's daily evaluation, but individual medication orders persist across days until their specific duration ends, or until they are deliberately held or discontinued.

### Principle 2: Separation of Order vs. Administration (HL7 FHIR Alignment)
- Following the HL7 FHIR `MedicationRequest` vs. `MedicationAdministration` standard:
  - **Medication Order (`MedicationRequest`):** What the doctor authorized (dose, route, schedule, indications, limits).
  - **Medication Administration (`MedicationAdministration`):** What was actually given to (or withheld from) the patient, when, by whom, and with what verification.

### Principle 3: Clinical Governance & Review Over Automation
- **No silent renewals:** The doctor explicitly reviews active orders rather than the system blindly extending validity.
- **No hardcoded clinical regimens:** Order sets are hospital-configured, versioned, clinician-approved templates. Prescribers must explicitly review all generated draft orders.
- **Separate Draft from Signing:** Unsigned work-in-progress is never actionable for nursing staff.

---

## 3. Data Model & Migrations

To support individual order lifecycles and structured administration records without forcing inadequate OPD models, we define dedicated IPD tables:

### A. `ipd_medication_orders`
Tracks the prescriber's authorized medication plan with individual lifecycles:
```typescript
{
  id: uuid,
  hospitalId: uuid,
  admissionId: uuid,
  encounterId: uuid,
  patientId: uuid,
  medicineId: uuid,
  medicineName: text,          // Snapshot of brand/generic name
  strength: text,              // e.g. "40 mg"
  form: text,                  // e.g. "injection", "tablet"
  dose: text,                  // e.g. "1 vial", "1 tab", "500 ml"
  route: text,                 // "IV", "Oral", "IM", "SC", "Nebulization", "Topical"
  frequencyCode: text,         // "OD", "BD", "TDS", "QID", "SOS", "Stat"
  scheduleTimes: jsonb,        // e.g. ["08:00", "20:00"] for BD
  isPrn: boolean,              // true for SOS / as-needed
  prnIndication: text,         // e.g. "Temp > 100°F or severe headache"
  prnMaxDailyDoses: integer,   // e.g. 3
  prnMinIntervalHours: integer,// e.g. 4
  instructions: text,          // e.g. "Before food", "Infuse over 60 mins"
  startsAt: timestamp with tz,
  endsAt: timestamp with tz,   // Derived from duration or explicit stop
  durationDays: smallint,      // Intended duration
  status: 'draft' | 'active' | 'on_hold' | 'discontinued' | 'completed',
  holdReason: text,
  heldAt: timestamp with tz,
  heldByUserId: uuid,
  discontinueReason: text,
  discontinuedAt: timestamp with tz,
  discontinuedByUserId: uuid,
  prescriberDoctorId: uuid,    // Doctor legally signing the order
  prescriberUserId: uuid,
  signedAt: timestamp with tz,
  roundNoteId: uuid,           // Links to the clinical round where signed
  createdAt: timestamp with tz,
  updatedAt: timestamp with tz,
}
```

### B. `ipd_medication_administrations`
Tracks every bedside nurse interaction with a medication order:
```typescript
{
  id: uuid,
  hospitalId: uuid,
  admissionId: uuid,
  orderId: uuid,               // References ipd_medication_orders.id
  status: 'administered' | 'omitted' | 'refused' | 'held',
  scheduledTime: timestamp with tz, // When dose was due (null for PRN)
  administeredAt: timestamp with tz,// When dose was given or withheld
  doseGiven: text,
  routeGiven: text,
  nonAdminReason: text,        // e.g. "Patient refused", "Vitals out of range (pulse < 60)", "NPO for OR"
  note: text,
  recordedByUserId: uuid,
  recordedChannel: 'personal' | 'ward_device',
  recordedDeviceId: text,
  careEntryId: uuid,           // Associated billing/inventory line if administered
  createdAt: timestamp with tz,
}
```

### C. `ipd_round_notes`
Captures daily clinical evaluations and signs off order revisions:
```typescript
{
  id: uuid,
  hospitalId: uuid,
  admissionId: uuid,
  encounterId: uuid,
  doctorId: uuid,
  userId: uuid,
  clinicalNote: text,          // Assessment & plan for today
  status: 'draft' | 'signed',
  signedAt: timestamp with tz,
  createdAt: timestamp with tz,
}
```

### D. `ipd_order_sets` & `ipd_order_set_items`
Hospital-governed, versioned clinical protocols:
- `id`, `hospital_id`, `name`, `code`, `category`, `version`, `approved_by_doctor_id`, `approved_at`, `active`.
- Items: `medicine_id`, `default_dose`, `default_route`, `default_frequency`, `default_duration_days`, `default_instructions`.

---

## 4. Doctor Rounding Cockpit (`components/ipd/doctor-rounding-cockpit.tsx`)

Rendered on the patient file ([`/ipd/admissions/[id]`](file:///d:/Projects/HospitalAutomation/app/(app)/ipd/admissions/[id]/(file)/page.tsx)) and directly reachable from [**My Patients**](file:///d:/Projects/HospitalAutomation/app/(app)/ipd/my-patients/page.tsx).

### 1. Clinical Context First (Vitals Freshness & Nursing Timeline)
- **Vitals Freshness Banner:**
  - Shows latest Temperature, Pulse, BP, SpO2, Resp Rate, and 24h Fluid Balance.
  - **Explicit observation timestamps:** e.g., *"Observed at 08:15 AM (45 mins ago)"*.
  - Visual staleness warning if vitals are older than 4 hours.
  - Visual flag for abnormal vitals (e.g. Febrile 101.4°F, Tachycardia 112 bpm).
  - Link to "View Full TPR Chart →".
- **Recent Nursing Administration Timeline:**
  - Summary of doses given, omitted, or held in the past 24 hours with reasons and recording nurse names.

### 2. Active Orders & Explicit Review Workflow
- Displays all currently active, held, and completed orders for this stay.
- **Nursing Status Beside Each Order:**
  - Order status badge (`Active`, `On Hold`, `Expiring Today`).
  - Administration tracking: e.g., *"Dose 3 of 6 given today at 08:00 AM"*, *"Dose 2 overdue"*, *"Last dose held: low BP"*.
- **Review Current Orders Action Bar:**
  - Not an automatic renewal. The doctor reviews each line:
    - `[ Continue Unchanged ]` (maintains active schedule)
    - `[ Renew / Extend ]` (sets new duration)
    - `[ Modify ]` (dose/frequency/route adjustment)
    - `[ Hold ]` (opens hold reason dialog; e.g. NPO for surgery)
    - `[ Discontinue ]` (deliberate stop with reason)

### 3. Rapid Prescription Entry (Safe & Governed)
- **Approved Order Sets Picker:** Dropdown of hospital-approved clinical protocols (e.g., Post-Op Day 1, Acute GE).
  - Applying a template inserts **draft orders** that the doctor must visually inspect, tailor to the patient, and approve.
- **Doctor Favorites:** Pre-configured hospital medicine shortcuts (e.g. `+ Inj. Pantoprazole 40mg IV`).
- **Structured Schedule Selectors:**
  - Abbreviations (`OD`, `BD`, `TDS`, `QID`, `SOS`, `Stat`) map to structured schedule times (`["08:00", "20:00"]`).
  - PRN orders require an explicit clinical indication and max daily dose limit.

### 4. Separate Draft from Signing
- `[ Save Work in Progress ]` (keeps round draft private without updating nurse eMAR).
- `[ Sign & Authorize Orders ]` (commits active orders to the live eMAR with doctor signature and timestamp).

### 5. Independent Discharge Workflow
- Discharge Readiness is decoupled from daily medication signing and sits in its own dedicated card with clinical readiness checklist and criteria.

---

## 5. Nursing Bedside eMAR Redesign (`components/ipd/record-screen.tsx`)

Replaces unstructured bedside searches with a structured, time-based Electronic Medication Administration Record (eMAR).

### Work Sections (Action-Oriented):
1. **Due Now:** Scheduled doses due in the current administration window (e.g. within ±60 minutes of now).
2. **Overdue:** Past-due doses requiring immediate administration or omission documentation.
3. **Upcoming:** Doses scheduled later in the shift.
4. **PRN / On-Demand:** Orders authorized for as-needed use, displaying clear indication (e.g. "For fever > 100°F") and remaining allowed doses for today.
5. **On Hold:** Suspended orders with reason clearly marked; non-actionable for administration.
6. **Recent History:** Complete log of doses administered, omitted, or refused during the last 24 hours.

### Controlled Administration Sequences:
- **Administration Sequence:**
  1. Nurse selects due dose.
  2. Verifies patient identity (Bed & Name confirmation), medicine, dose, and route.
  3. Records actual administration time (and optional cannula/site note).
  4. Confirms → Dose saved to `ipd_medication_administrations` and automatically reflected on billing/stock.
- **Exception / Non-Administration Sequence:**
  1. Nurse selects dose.
  2. Selects non-administration status: `Refused`, `Omitted`, or `Held`.
  3. Selects mandatory reason (Patient asleep/refused, NPO, Vitals contraindicated, Drug unavailable).
  4. Confirms → Record updated without billing the patient; flag raised on Doctor Rounding Cockpit.

---

## 6. Implementation Phasing & Tasks

1. **Phase 1: Database Migration & Domain Logic**
   - Create migration for `ipd_medication_orders`, `ipd_medication_administrations`, `ipd_round_notes`, and `ipd_order_sets`.
   - Domain logic: structured schedule calculations (OD/BD/TDS to clock times), PRN limit checks, order lifecycle state machine.
2. **Phase 2: Service Layer & Unit Tests**
   - `lib/services/ipd-medication-orders.ts`: draft, sign, hold, discontinue, renew operations.
   - `lib/services/ipd-emar.ts`: query due, overdue, PRN, and history for bedside nursing; record administration and omissions.
3. **Phase 3: Doctor Rounding Cockpit UI**
   - Vitals freshness display, order review list with individual actions, approved order set loader, draft/sign workflow.
4. **Phase 4: Bedside eMAR Nursing Screen Update**
   - Categorized eMAR view (Due Now, Overdue, PRN, On Hold), controlled verification modal, exception logging.
