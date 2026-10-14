# Specification: Qurio IPD Complete Lifecycle, Clinical Safety Gates & Operational Flow

**Specification Date:** 2026-10-14  
**Status:** Approved by Product Owner  
**Target Module:** Inpatient Department (IPD), Qurio Hospital Management SaaS  
**Author:** Senior Healthcare Software Architect & Antigravity Agent  
**Execution Order:** Workstream 1 (Outbox & Ledger) $\rightarrow$ Workstream 2 (Safety Gates & Verbal Orders) $\rightarrow$ Workstream 3 (Measurements) $\rightarrow$ Workstream 4 (Discharge & Reconciliation) $\rightarrow$ Workstream 5 (Bed Cleaning & NEWS2/Vitals Frequency)  

---

## 1. System Architecture & Canonical Identity Confirmation

### 1.1 Confirmation of `[id]` Parameter
- **Universal Rule:** Across all canonical patient chart routes (`/ipd/patients/[id]/*`) and legacy compatibility routes (`/ipd/admissions/[id]/*`), the path parameter `[id]` **strictly represents the `admissionId`** (UUID primary key of the `admissions` table).
- **Reasoning:** Inpatient hospital stays are encounter-bound episodes. A single patient (represented by `patientId` / `UHID`) may have multiple inpatient admissions over time (readmissions, historical admissions). Routing on `admissionId` isolates clinical notes, vitals, eMAR administrations, and bills strictly to that specific hospital stay without cross-admission data contamination.
- **Lookup Routing:** Any search by UHID (`/ipd/lookup?uhid=...`) or patient UUID (`/ipd/lookup?patientId=...`) queries active admissions. If an active admission exists, it issues an HTTP 307 redirect directly to `/ipd/patients/:admissionId/summary`.

---

## 2. Workstream 1: eMAR Outbox Engine, Retries, Dead-Letter Admin & Audit

### 2.1 Outbox Queue Architecture & Background Drain
- **Table:** `ipd_emar_integration_outbox`
- **Execution Target:** The outbox processor converts raw bedside administrations (`ipd_medication_administrations`) into:
  1. Billing line items (`bill_items` / `ipd_billing_lines`) with hospital tenant-configured formulary pricing.
  2. Inventory deductions in the risk-class pharmacy stock ledger (`stock_ledger` / `stock_balances`).
- **Processing Logic (`lib/services/ipd-emar-outbox.ts`):**
  - **Concurrency Leases & Advisory Locking:** Claims pending rows using PostgreSQL `SELECT ... FOR UPDATE SKIP LOCKED` bounded to `BATCH_SIZE = 50`.
  - **Lease Timeout:** 5 minutes. If a worker crashes or times out while processing, `recoverStuckOutboxClaims` resets rows in `processing` status where `claimed_at < NOW() - INTERVAL '5 minutes'` back to `pending`.
  - **Exponential Backoff & Retries:** On transient failure, `attempts` increments, `scheduled_for` is set with exponential backoff:
    $$\Delta t = \min(300, 2^{\text{attempts}} \times 5) \text{ seconds}$$
  - **Dead-Letter Threshold:** After 5 failed attempts, the event transitions to `status = 'failed'` with `last_error` recorded.

### 2.2 Scheduler & Deployment Hooks
- **Runtime Invocation:** `app/api/cron/ipd-outbox/route.ts` is invoked:
  1. Internally via `app/api/internal/tick/route.ts` (triggered by platform cron every minute).
  2. Standalone via authenticated GET/POST requests containing `Authorization: Bearer <CRON_SECRET>`.
  3. Client-assisted fallback: when an administrator views the billing ledger, a non-blocking `triggerOutboxDrain()` ensures recent events are drained.

### 2.3 Dead-Letter UI & Resolution View
- **Location:** Embedded in `/ipd/stock` and `/settings/ipd` under a dedicated tab: **"Integration Queue & Outbox Health"**.
- **Capabilities:**
  - Filter by status (`pending`, `processing`, `failed`, `pending_pricing`).
  - View error message, payload, target patient name, IPD number, and administration timestamp.
  - **1-Click Retry:** For transient errors, reset attempts to 0 and set `status = 'pending'`.
  - **Set Pricing & Drain:** If marked `pending_pricing` because a new medicine was unpriced in the hospital formulary, prompt the hospital owner to enter the unit selling price paise, update `medicines.selling_price_paise`, and immediately reprocess the batch.

### 2.4 "Given-Without-Bill" Audit Reconciliation Report
- **Endpoint / Service:** `getGivenWithoutBillReport(hospitalId)` in `lib/services/discharge-billing.ts`.
- **Clinical & Financial Purpose:** Detects medication doses administered at the bedside that have failed to produce an active, unvoided line in `bill_items`.
- **Query Logic:**
  ```sql
  SELECT 
    a.id AS administration_id,
    adm.ipd_number,
    p.name AS patient_name,
    o.medicine_name,
    a.actual_time,
    a.nurse_user_id,
    outbox.status AS outbox_status,
    outbox.last_error
  FROM ipd_medication_administrations a
  INNER JOIN admissions adm ON adm.id = a.admission_id
  INNER JOIN patients p ON p.id = adm.patient_id
  INNER JOIN ipd_medication_orders o ON o.id = a.order_id
  LEFT JOIN ipd_emar_integration_outbox outbox 
    ON outbox.administration_id = a.id AND outbox.integration_type = 'billing'
  LEFT JOIN bill_items bi ON bi.care_entry_id = a.care_entry_id AND bi.voided_at IS NULL
  WHERE a.hospital_id = :hospitalId
    AND a.outcome = 'administered'
    AND a.voided_at IS NULL
    AND bi.id IS NULL
  ORDER BY a.actual_time DESC;
  ```
- **UI Presentation:** Displayed on `/ipd/admissions/[id]/bill` and `/reports` as an alert badge: *"⚠️ N doses administered without billing lines — [Review Discrepancies]"*.

---

## 3. Workstream 2: Server-Side Clinical Safety Gates & Verbal Orders

### 3.1 Allergy Safety Gate with Ingredient Matching
- **Server Enforcement Point:** `signRoundOrdersAction` and `createTreatmentPlanAction` in `app/(app)/ipd/actions.ts` executing `signRoundOrders()` in `lib/services/ipd-medication-orders.ts`.
- **Gate 1: Unreviewed Allergy Status:**
  - If `ipd_allergy_assessments.status === 'unreviewed'`, order signing is strictly **BLOCKED**.
  - Server throws `AllergyAssessmentRequiredError`: *"Allergy assessment must be completed (NKDA or Documented Allergens) before clinical orders can be signed."*
  - UI offers 1-click modal to confirm NKDA or document known allergens without losing staged orders.
- **Gate 2: Active Allergen / Ingredient Match:**
  - System extracts known allergens from `ipd_allergy_assessments.allergens` for the admission.
  - Matches ordered drug names and active ingredients against documented allergens using case-insensitive substring and ingredient alias matching (e.g. "Penicillin" matches "Amoxicillin-Clavulanate", "Piperacillin-Tazobactam", "Ampicillin").
  - If a match is detected:
    - Order is **BLOCKED** unless an explicit `allergyOverrideReason` (minimum 8 characters) is supplied.
    - If override is provided, system logs the override to `clinical_audit_logs` (`action = 'allergy_override'`) with `userId`, `orderedMedicineName`, `matchingAllergen`, and `overrideReason`.

### 3.2 Duplicate Active Therapy Gate (Ingredient & Class Matching)
- **Server Enforcement Point:** `signRoundOrders()` in `lib/services/ipd-medication-orders.ts`.
- **Detection Algorithm:**
  - Compares all new/renewed orders against currently active orders in `ipd_medication_orders` (`status IN ('active', 'on_hold') AND id NOT IN (supersededIds)`).
  - Matches on:
    1. Exact `medicine_id` match.
    2. Normalized generic/active ingredient match (e.g. Paracetamol IV vs Paracetamol Oral; Pantoprazole IV vs Omeprazole Oral).
- **Enforcement Rules:**
  - If duplicate therapy is detected:
    - Action requires resolution:
      - **Option A (Replace):** Prior duplicate order is automatically discontinued with reason *"Superseded by new order [New Medicine Name]"*.
      - **Option B (Dual Therapy Override):** Both orders remain active, requiring a mandatory clinical rationale in `duplicateOverrideReason` (e.g. *"Dual antiplatelet therapy indicated post-PCI"* or *"Overlapping oral switch"*).
    - Failure to provide `duplicateOverrideReason` causes `signRoundOrders` to throw `DuplicateTherapyError`.

### 3.3 Explicit Verbal Order State Machine & Doctor Co-Signing Queue
- **Schema Columns on `ipd_medication_orders`:**
  - `is_verbal: boolean NOT NULL DEFAULT false`
  - `verbal_order_status: text CHECK (verbal_order_status IN ('none', 'pending_cosign', 'cosigned', 'rejected', 'modified')) DEFAULT 'none'`
  - `verbal_doctor_name: text`
  - `verbal_clinical_rationale: text`
  - `cosigned_by_doctor_id: uuid REFERENCES doctors(id)`
  - `cosigned_at: timestamp with time zone`
  - `cosign_notes: text`
- **Creation by Nurse:**
  - When nurse records urgent administration under verbal authority via `recordNurseUrgentAdministrationAction`:
    - `is_verbal = true`
    - `verbal_order_status = 'pending_cosign'`
    - `verbal_doctor_name = input.doctorName`
    - `verbal_clinical_rationale = input.clinicalRationale`
    - `status = 'completed'` (dose given at bedside).
- **Doctor Co-Signing Queue in Rounds & Orders:**
  - Displayed prominently at the top of `/ipd/patients/[id]/orders` and `/ipd/admissions/[id]/rounds`:
    **"⚠️ Pending Verbal Order Co-Sign (N orders require review)"**.
  - Doctor actions per verbal order:
    1. **Co-Sign (Approve):** Calls `cosignVerbalOrderAction({ orderId, notes })`. Updates `verbal_order_status = 'cosigned'`, `cosigned_by_doctor_id = session.doctorId`, `cosigned_at = NOW()`.
    2. **Reject (Disavow):** Calls `rejectVerbalOrderAction({ orderId, reason })`. Updates `verbal_order_status = 'rejected'`, records incident flag in `clinical_audit_logs`. Does not erase the historical administration (for medico-legal audit) but flags the order for clinical review.
    3. **Modify Therapy:** Doctor co-signs the given dose and stages an adjusted continuing order.

---

## 4. Workstream 3: Dedicated Measurements Table (Weight, Height, BMI)

### 4.1 Schema Specification: `patient_measurements`
To preserve clinical data integrity, physical body measurements are decoupled from periodic vital sign checks and stored in an append-only timeline table:

```sql
CREATE TABLE patient_measurements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  patient_id UUID NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  admission_id UUID NOT NULL REFERENCES admissions(id) ON DELETE CASCADE,
  encounter_id UUID NOT NULL,
  
  recorded_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  weight_kg NUMERIC(5, 2),
  height_cm NUMERIC(5, 1),
  bmi NUMERIC(4, 1),
  body_surface_area_m2 NUMERIC(4, 2),
  measured_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  notes TEXT,
  
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX patient_measurements_adm_idx ON patient_measurements(hospital_id, admission_id, recorded_at DESC);
```

### 4.2 Calculation Rules
- **BMI:**
  $$\text{BMI} = \frac{\text{weight\_kg}}{(\text{height\_cm} / 100)^2}$$
- **Most Recent Measurement Retrieval:**
  The `PatientBanner` and Doctor Rounding Cockpit query the latest measurement for the admission.
  - If present: renders `Wt: 62.5 kg · Ht: 172 cm (BMI 21.1)`.
  - If absent: renders amber chip `"Weight: Not recorded"` which opens the measurement drawer.

---

## 5. Workstream 4: Versioned Discharge Summary, Home Med Reconciliation & Gates

### 5.1 Admission Home Medication Capture
- **Table:** `ipd_admission_home_medications`
  - `id, hospital_id, admission_id, patient_id`
  - `medicine_name, dose, route, frequency, indication, last_taken_at`
  - `reconciliation_decision: 'undecided' | 'continued_in_ipd' | 'stopped_on_admission' | 'substituted'`
- **Workflow:** Nurse or admitting doctor documents home medications during Phase 3 assessment. When doctor creates treatment plan, home medications appear with quick "Convert to Inpatient Order" chips.

### 5.2 Versioned Discharge Summary Schema
- **Table:** `ipd_discharge_summaries`
  ```sql
  CREATE TABLE ipd_discharge_summaries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
    admission_id UUID NOT NULL REFERENCES admissions(id) ON DELETE CASCADE,
    encounter_id UUID NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL CHECK (status IN ('draft', 'finalized', 'amended')),
    
    discharge_type TEXT NOT NULL CHECK (discharge_type IN ('regular', 'lama', 'dama', 'transfer', 'death')),
    condition_at_discharge TEXT NOT NULL CHECK (condition_at_discharge IN ('cured', 'improved', 'stable', 'critical', 'deceased')),
    
    admission_diagnosis TEXT NOT NULL,
    final_diagnosis TEXT NOT NULL,
    icd10_codes JSONB DEFAULT '[]'::jsonb,
    
    hospital_course_summary TEXT NOT NULL,
    investigations_summary TEXT,
    procedures_performed TEXT,
    
    diet_instructions TEXT,
    activity_restrictions TEXT,
    warning_signs_urgency TEXT,
    follow_up_advice TEXT,
    follow_up_date DATE,
    follow_up_doctor_id UUID REFERENCES doctors(id),
    
    author_doctor_id UUID NOT NULL REFERENCES doctors(id),
    finalized_at TIMESTAMP WITH TIME ZONE,
    finalized_by_user_id UUID REFERENCES users(id),
    amendment_reason TEXT,
    
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
  );
  
  CREATE UNIQUE INDEX ipd_discharge_summary_version_idx ON ipd_discharge_summaries(hospital_id, admission_id, version);
  ```

### 5.3 Structured Take-Home Prescriptions
- **Table:** `ipd_take_home_prescriptions`
  - `id, hospital_id, discharge_summary_id, admission_id`
  - `medicine_name, dose, route, frequency_code, plain_language_timing` (e.g. *"1 tablet after breakfast and dinner"*), `duration_days, total_quantity, special_instructions`
  - `reconciliation_source: 'continued_from_inpatient' | 'new_discharge_medication' | 'resumed_home_medication'`
- **Language Formatting:** Supports plain language directions in English, Hindi, and Marathi.

### 5.4 Prescriber Registration Number Validation Gate
- When doctor clicks **"Finalize & Sign Discharge Summary"**:
  - Backend verifies `doctors.registration_no IS NOT NULL AND char_length(trim(doctors.registration_no)) >= 3`.
  - If missing, action is **BLOCKED** with `MissingPrescriberRegistrationError`: *"Doctor profile is missing a verified Medical Council Registration Number. Please update profile in Settings before finalizing medico-legal discharge summary."*

### 5.5 Discharge Finalization Gate
- In `app/(app)/ipd/admissions/[id]/bill/actions.ts` (`finalizeAction`):
  - Checking `ipd_discharge_summaries` for `status = 'finalized'`.
  - Final discharge billing settlement is **BLOCKED** until discharge summary has been signed and finalized by the primary doctor.

---

## 6. Workstream 5: Bed Cleaning State, NEWS2 Escalations & Vitals Frequency

### 6.1 Bed Cleaning State Machine
- **Table Modification on `beds`:**
  - `status TEXT NOT NULL DEFAULT 'vacant' CHECK (status IN ('vacant', 'occupied', 'cleaning', 'maintenance'))`
  - `last_cleaned_at TIMESTAMP WITH TIME ZONE`
  - `cleaned_by_user_id UUID REFERENCES users(id)`
- **Lifecycle Transition:**
  1. Bed Occupied: Patient stays in bed (`status = 'occupied'`).
  2. Patient Discharged: When reception finalizes discharge, bed assignment is closed (`to_at = NOW()`) and `beds.status` transitions automatically to `'cleaning'`.
  3. Cleaning Mode: Bed tile on Ward Grid and Overview renders in purple with a broom icon: **"Cleaning in progress"**. Bed cannot be assigned to waiting patients.
  4. Housekeeping Release: Nurse or staff taps **"✓ Mark Cleaned & Ready"**, setting `beds.status = 'vacant'` and recording `last_cleaned_at = NOW()`. Bed immediately enters free bed pool.

### 6.2 In-App NEWS2 Escalation Alerts
- When a vital sign reading is saved with calculated `news2Score >= 5` (or any single physiological parameter scoring 3):
  1. **Patient Banner Escalation:** Banner renders pulsing red badge: **"🚨 CRITICAL NEWS2: [Score] — Urgent Doctor Review Required"**.
  2. **Ward Grid Alert:** Bed tile pulses with red border and exclamation icon on ward phones/tablets.
  3. **Doctor Rounding Roster:** Patient moves to the top of `/ipd/my-patients` with high clinical priority tag.
  4. **Logged Escalation Action:** An append-only row is written to `clinical_audit_logs` documenting that the score crossed the clinical escalation threshold.

### 6.3 Structured Vitals-Frequency Doctor Orders
- **Order Model Extension:**
  - Doctors prescribe monitoring frequency: `Q1H`, `Q2H`, `Q4H` (default), `Q6H`, `Q8H`, `Q12H`, `Q24H`, or `CUSTOM`.
  - Schedule occurrence engine in `lib/domain/ipd-schedule.ts` generates scheduled vitals slots for nurses (e.g. `08:00, 12:00, 16:00, 20:00`).
  - Missed slots appear in the nurse's due board as overdue vitals checks.

---

## 7. Migration Plan (`0048_ipd_lifecycle_expansion.sql`)

A single, atomic Drizzle migration introducing:
1. `beds.status` enum extension (`cleaning`, `maintenance`).
2. `ipd_medication_orders` verbal order fields (`is_verbal`, `verbal_order_status`, `verbal_doctor_name`, `verbal_clinical_rationale`, `cosigned_by_doctor_id`, `cosigned_at`, `cosign_notes`).
3. `patient_measurements` table.
4. `ipd_admission_home_medications` table.
5. `ipd_discharge_summaries` table.
6. `ipd_take_home_prescriptions` table.
7. Constraints, foreign keys, and multi-tenant RLS policies.

---

## 8. Verification Strategy & API Bypass Tests

Every gate will have automated test coverage simulating both UI submissions and direct Server Action API calls:

| Test File | Verification Objective | Direct Bypass Scenario |
|---|---|---|
| `lib/services/__tests__/ipd-outbox-worker.test.ts` | Concurrency leases, retries, dead-lettering, outbox drain. | Simulates simultaneous competing workers; ensures zero duplicate bill lines. |
| `app/(app)/ipd/__tests__/given-without-bill.test.ts` | Reconciliation query finds all unbilled doses. | Inserts administration without bill line; verifies report picks it up immediately. |
| `app/(app)/ipd/__tests__/allergy-gate-bypass.test.ts` | Direct call to `signRoundOrdersAction` with unreviewed allergy or allergen match. | Tests direct invocation with `status = 'unreviewed'` $\rightarrow$ Expects `AllergyAssessmentRequiredError`. |
| `app/(app)/ipd/__tests__/duplicate-therapy-gate.test.ts` | Staging duplicate antibiotic/PPI without override reason. | Direct invocation without `duplicateOverrideReason` $\rightarrow$ Expects `DuplicateTherapyError`. |
| `app/(app)/ipd/__tests__/verbal-orders-cosign.test.ts` | Nurse creates verbal STAT order $\rightarrow$ Doctor co-signs / rejects. | Tests `cosignVerbalOrderAction` and `rejectVerbalOrderAction`. |
| `app/(app)/ipd/__tests__/measurements.test.ts` | Dedicated measurements timeline and BMI calculation. | Tests insertion and retrieval of height, weight, BMI over stay duration. |
| `app/(app)/ipd/__tests__/discharge-summary-gate.test.ts` | Finalizing discharge without summary or without doctor registration number. | Direct invocation of `finalizeAction` without finalized summary $\rightarrow$ Expects rejection. |
| `lib/domain/__tests__/bed-cleaning.test.ts` | Bed occupancy $\rightarrow$ cleaning $\rightarrow$ vacant state transitions. | Verifies cleaning bed is refused for assignment until cleaned. |

---

## 9. Visual Consistency & Responsive Screenshots
Visual UI verification will be performed across desktop and mobile form factors using the browser subagent:
- **1440px Desktop Viewport:** High-density Excel-style data grids, side drawers, patient banner alignment, and multi-column cockpits.
- **390px Mobile/Tablet Viewport:** Nurse 1-tap touch targets ($\ge 44\text{px}$), bedside treatment workspace, compact modal presentation, and thumb navigation.
