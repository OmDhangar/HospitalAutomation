# IPD Doctor Rounding Cockpit & Rapid Prescription System Design

**Date:** 2026-10-12  
**Status:** Validated  
**Module:** IPD (`core_ipd`, `patient_file`)

---

## 1. Problem Statement & Motivation

During daily inpatient rounds (15–30 beds), a doctor spends 1 to 2 minutes per patient at the bedside. Currently:
1. **Zero Prescription Entry in IPD:** Prescriptions can only be entered on the OPD queue consultation panel (`consultation-panel.tsx`). There is no interface in IPD for doctors to write or adjust patient-specific medication orders.
2. **Page Fragmenting:** A doctor must jump across multiple disjointed pages:
   - `/ipd/my-patients` (list of admitted patients)
   - `/ipd/admissions/[id]` (summary & bedside entries)
   - `/ipd/admissions/[id]/tpr` (temperature/pulse/respiration chart)
   - Nursing bed screens
3. **Bedside Nursing Guesswork:** Bedside nurses recording administered medications on `RecordScreen` are presented with arbitrary open-ended search and generic starter chips with no link to what the doctor actually ordered for that patient (MAR).

---

## 2. Key Objectives & Success Criteria

1. **All-In-One Rounding Cockpit:** The doctor sees the patient's vitals (from TPR), nursing treatment history, and active medication orders on a single screen without page hopping.
2. **Ultra-Fast Prescription Entry (< 30 seconds):**
   - **1-Click "Continue Current Orders":** Automatically renews yesterday's orders so the doctor only adjusts changes.
   - **Clinical Order Sets / Protocols:** 1-click application of standard clinical regimens (e.g., Post-Op Day 1, Acute Gastroenteritis, Standard Antibiotic Cover).
   - **Doctor Quick-Add Chips:** Rapid-add buttons for the hospital's most common inpatient medications with pre-filled default dosages.
   - **Standard Shorthand Presets:** OD, BD, TDS, QID, SOS, Stat; routes IV, Oral, IM, Nebulization.
3. **Seamless Hand-off to Bedside Nursing (MAR):**
   - When orders are saved, they immediately appear at the top of the nurse's Bedside Record Screen (`record-screen.tsx`) as 1-tap administration buttons.

---

## 3. Architecture & Data Model

### A. Database Re-use (Zero New Migrations)
- Each IPD admission (`admissions` table) already contains an `encounter_id`.
- The database schema already features:
  - `prescriptions` (scoped by `hospital_id`, `encounter_id`, `patient_id`, `prescriber_doctor_id`, `status: 'final' | 'superseded'`)
  - `prescription_items` (scoped by `prescription_id`, `medicine_id`, `dose`, `frequency`, `duration_days`, `route`, `instructions`, `sort_order`)
- An IPD prescription will reuse this existing clinical schema. When a doctor updates daily orders during rounds, the new prescription is marked `status = 'final'` and supersedes the prior day's prescription (`supersedes_prescription_id`), maintaining an immutable audit trail.

### B. New Services & Domain Logic
1. **`lib/services/ipd-prescriptions.ts`**:
   - `getActiveIpdPrescription({ hospitalId, admissionId })`: Returns the active final prescription and its items for the admission.
   - `saveIpdPrescription({ hospitalId, admissionId, actorUserId, doctorId, items, advice, notes })`: Creates a new prescription version, supersedes the previous one, and logs an evidence/audit event.
   - `getIpdOrderSets()`: Returns pre-configured clinical order templates.
2. **`lib/domain/ipd-order-sets.ts`**:
   - Standard clinical regimens:
     - `post_op_day_1`: IV Antibiotic + IV PPI + IV Analgesic + IV Fluid.
     - `acute_ge`: IV Fluids + IV Antiemetic + Oral Probiotic / Racecadotril.
     - `resp_copd`: Nebulization + IV Corticosteroid + Antibiotic.
     - `fever_workup`: Antipyretic SOS + IV Fluid + Antibiotic cover.

---

## 4. User Experience & Component Design

### A. Doctor Rounding Cockpit (`components/ipd/doctor-rounding-cockpit.tsx`)
Rendered directly on `/ipd/admissions/[id]` when viewed by a doctor/owner, or accessible via a prominent "Daily Round & Orders" button on `/ipd/my-patients`:

1. **Header & Key Vitals Bar (live from `getLatestVitals` / `getTprDay`):**
   - High-contrast visual badges:
     - Temperature (with febrile warning)
     - Pulse & Blood Pressure
     - SpO2 & Respiratory Rate
     - 24h Fluid Balance (Intake vs Output)
   - "Full TPR Sheet →" link for deeper inspection.
2. **Nursing Administrations Today:**
   - Collapsible summary of medications/fluids recorded by nurses today.
3. **Active Orders & Rapid Prescription Editor:**
   - **Header Controls:**
     - `[ ↻ Continue Current Medications ]`
     - `[ 📋 Apply Clinical Order Set ▾ ]`
   - **Medication List:**
     - Each line shows Medicine, Route (IV/Oral), Frequency (BD/OD/TDS), Duration, Instructions, and [✕ Discontinue].
   - **Quick Add Bar:**
     - Frequency presets (`1-0-1`, `1-1-1`, `1-0-0`, `SOS`, `Stat`).
     - Frequent chips (`+ Inj. Pantop 40mg`, `+ Inj. Ceftriaxone 1g`, `+ IV DNS 500ml`).
     - Medicine search typeahead.
4. **Rounding Note & Actions:**
   - Compact clinical notes input (e.g., *"Patient afebrile, wound healthy, continue IV fluids"*).
   - `[ ✓ Save Daily Orders ]` button.
   - `[ Mark Discharge Ready ]` toggle.

### B. Bedside Record Screen (`components/ipd/record-screen.tsx`)
- Add a top section: **"Prescribed by Doctor"**.
- Displays the active items from the admission's latest prescription as high-priority chips.
- Tapping a prescribed medicine automatically selects the item, default dose, and route, enabling 1-tap administration by the nurse.

---

## 5. Security & Authorisation
- **Permissions:**
  - Prescribing orders requires `can(session.role, 'ipd.chart')` and role in `['owner', 'doctor']`.
  - Linked doctor check: The user account must be linked to a staff doctor record (`prescriber_doctor_id`).
  - Read access is available to clinical staff (`nurse`, `doctor`, `owner`).

---

## 6. Testing & Quality Assurance
- **Integration Tests:**
  - `lib/services/__tests__/ipd-prescriptions.integration.test.ts`: Test saving daily rounds, superseding prior day orders, and reading active prescriptions for admissions.
- **Component Tests:**
  - Verify rapid preset clicks, template applications, and quick chips.
- **TDD:** Full automated test suite verifying both the service layer and the cockpit actions.
