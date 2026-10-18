# IPD Doctor Rounding Cockpit & Inpatient Medication Administration (eMAR) Design

**Document ID:** `SPEC-IPD-EMAR-001`  
**Date:** 2026-10-12  
**Status:** In Review (Engineering Specification & Implementation Plan — Post-Consistency Audit)  
**Target Modules:** `core_ipd`, `patient_file`, `clinical_opd`  
**Target Release:** Next IPD Milestone (Migration `0047_ipd_emar_foundation.sql`)  

---

## 1. Executive Summary and Status

This document establishes the technical specification, data models, state machines, user workflows, and phased implementation plan for two core inpatient clinical capabilities:
1. **The IPD Doctor Rounding Cockpit:** A unified, single-screen rounding workspace enabling attending doctors to review patient vitals, nursing intake/output trends, allergy status, and active treatment lines, conduct explicit clinical medication reviews, and record signed daily round evaluations.
2. **The Inpatient Electronic Medication Administration Record (eMAR):** A closed-loop, time-oriented nursing interface separating prescriber authorization (`MedicationRequest`) from bedside execution (`MedicationAdministration`), eliminating guesswork, unauthorized substitutions, and silent auto-renewals.

**Current Document Status:**
- **Architecture & Domain Rules:** Finalized and aligned with HL7 FHIR R4 principles.
- **Database Schema & Constraints:** Fully audited against the existing PostgreSQL/Drizzle schema. Composite tenant foreign keys and non-destructive retention policies are explicitly specified.
- **Integration Contracts:** Downstream accounting (billing) and inventory (stock) decoupled via a dedicated transactional outbox.
- **Implementation State:** Specification and design phase. No application code, database migrations, or production data changes have been executed.

---

## 2. Problem Statement and Scope

### 2.1 Clinical & Operational Deficiencies
In hospital wards across India, morning and evening doctor rounds are rapid clinical events (15–30 beds, 1–2 minutes per bedside). The current application suffers from four critical deficiencies:
1. **Absence of Inpatient Prescribing:** Prescriptions can only be created within the OPD consultation panel (`consultation-panel.tsx`). Inpatient admissions have zero prescribing interfaces; doctors cannot order, amend, hold, or discontinue medications in IPD.
2. **Context Fragmentation:** To evaluate an admitted patient, clinicians must navigate across disjointed pages: `/ipd/my-patients` (roster), `/ipd/admissions/[id]` (summary/billing), `/ipd/admissions/[id]/tpr` (nursing vitals), and ward bed grids. There is no unified clinical rounding overview.
3. **Nursing Administration Guesswork:** In [`RecordScreen`](file:///d:/Projects/HospitalAutomation/components/ipd/record-screen.tsx), bedside nurses must search the hospital's entire raw formulary or tap arbitrary starter generics. The system has zero awareness of what the attending physician actually ordered for that patient.
4. **Order State Collapse & Safety Risks:** Treating inpatient medications as a single daily prescription that supersedes prior slips causes severe clinical hazards: multi-day courses (e.g., 5-day IV antibiotics) disappear when an unrelated medication is adjusted, or discontinued drugs get renewed accidentally. Furthermore, selecting an order chip currently equates to logging an administered dose without verifying patient identity, contraindications, or dose status.

### 2.2 System Scope
- **In Scope (MVP):**
  - Attending doctor rounding cockpit on patient file layout (`/ipd/admissions/[id]/rounds` and `/ipd/my-patients`).
  - Independent lifecycle management for inpatient medication orders (active, on-hold, discontinued, completed, superseded, voided).
  - Explicit clinical order review workflow with structured action resolution (continue, renew via successor, modify, hold, discontinue).
  - Time-bucketed bedside nursing eMAR (`Due Now`, `Overdue`, `Upcoming`, `PRN / On-Demand`, `On Hold`, `Recent History`).
  - Structured bedside administration verification and exception logging (administered, omitted, refused, held) for discrete bolus doses (oral, IV push, IV piggyback, IM, SC, nebulization, topical, sublingual, rectal).
  - Structured scheduling engine supporting standard Indian clinical frequencies (`OD`, `BD`, `TDS`, `QID`, `SOS`, `Stat`).
  - Hospital-governed, versioned clinical order set engine with mandatory prescriber review and trigger-enforced template immutability.
  - Decoupled, transactional outbox boundaries for billing and inventory deduction with distinct event dispatch (`administer`, `void`, `correction`).
  - Admission-level allergy assessment tracking with historical revision preservation (unreviewed vs. NKDA vs. documented allergen lines).
- **Out of Scope (Post-MVP Enhancements):**
  - Continuous and fixed-rate IV infusion administration lifecycle (infusion start, rate changes, pause, resume, bag changes, delivered volume tracking) — **explicitly deferred to Phase 6 (ICU & Infusion Module)**. MVP eMAR covers discrete point-in-time doses only.
  - Automated barcode medication scanning (BCMA) using camera feeds (hardware-dependent).
  - Machine-learning drug-drug interaction engines (governance rules prioritize explicit clinician validation over uncertified third-party rule sets).

---

## 3. Architecture and Domain Principles

### Principle 1: Order State vs. Daily Round Snapshots
An inpatient's active treatment is an aggregate of individual, long-running medication orders, each with distinct start times, durations, and clinical lifecycles. A doctor's daily round assessment is an episodic clinical event, but it does **not** erase, replace, or supersede ongoing medication orders unless the clinician explicitly acts upon them.

### Principle 2: Separation of Order vs. Administration (HL7 FHIR Alignment)
Following the international clinical informatics standard ([HL7 FHIR R4](https://hl7.org/fhir/R4/)):
- **`MedicationRequest` (Order):** Authorization by a licensed clinician to dispense and administer a specific drug under defined conditions.
- **`MedicationAdministration` (Execution):** The physical event of introducing a medicine into a patient (or the structured, documented clinical decision to omit, hold, or refuse it).
- Selecting an order does not equal an administration. A dose is only administered when verified, delivered, and confirmed.

### Principle 3: Explicit Clinical Review Over Silent Automation
The system must never silently renew expired or reaching-duration orders. The doctor is presented with active lines and proposed actions, requiring positive clinical resolution before signing.

### Principle 4: Clinical Governance for Order Sets
No generic, hardcoded treatment regimens will be shipped as universal software defaults. Order sets are stored in the database, versioned, authored by designated hospital clinicians, and can only be published after formal clinical approval. Applying an order set creates editable draft proposals, never pre-signed orders.

### Principle 5: Draft Isolation
Work-in-progress drafts (whether round notes or proposed medication adjustments) are completely non-actionable. Nurses at the bedside can only view and administer against signed, authorized orders.

---

## 4. Repository Audit: Verified Findings, Proposed Designs, and Unresolved Assumptions

### 4.1 Schema & Data Structures
| Component | Status | Details & Evidence |
| :--- | :--- | :--- |
| `admissions` Unique Key | **Verified** | Defined in `drizzle/0032_ipd_core.sql:175` and `lib/db/schema.ts:2006`. Has `CREATE UNIQUE INDEX admissions_tenant_encounter_key ON admissions (hospital_id, id, encounter_id, patient_id)`. Composite FKs already bind to this index in `care_entries` (`care_entries_admission_fk`). To ensure formal ANSI SQL table-constraint compliance across ORMs and tooling, migration `0047` will add: `ALTER TABLE admissions ADD CONSTRAINT admissions_tenant_encounter_uq UNIQUE USING INDEX admissions_tenant_encounter_key;` (instant execution, zero table lock rewrite). |
| `medicines` Multi-Tenancy | **Verified** | Defined in `drizzle/0028_clinical_opd.sql:71` and `lib/db/schema.ts`. Has `UNIQUE INDEX medicines_tenant_key ON medicines (hospital_id, id)`. Inpatient orders and order-set items must bind via composite FK `(hospital_id, medicine_id) REFERENCES medicines (hospital_id, id)` to prevent cross-tenant formulary leaks. |
| `doctors` Multi-Tenancy | **Verified** | Defined in `drizzle/0032_ipd_core.sql:32`. Has `UNIQUE INDEX doctors_tenant_key ON doctors (hospital_id, id)`. Orders, rounds, and order-set approval fields bind via composite FK `(hospital_id, doctor_id) REFERENCES doctors (hospital_id, id)`. |
| Retention & Deletion Policy | **Proposed** | Existing tables (`admissions`, `care_entries`) use `ON DELETE CASCADE` from `hospitals(id)`. For signed clinical records (`ipd_medication_orders`, `ipd_medication_administrations`, `ipd_clinical_rounds`, `ipd_allergy_assessments`, `ipd_medication_order_actions`), **destructive cascading deletes are strictly prohibited**. All relationships to hospitals, admissions, doctors, and medicines use `ON DELETE RESTRICT` to guarantee medico-legal retention. |
| `prescriptions` Table | **Verified** | Defined in `drizzle/0028_clinical_opd.sql`. Bound to `encounter_id`. Has unique index `prescriptions_one_current_key` where `status = 'final'`. Designed strictly for OPD: a revision marks the previous prescription `superseded`. Unsuitable for multi-day inpatient order tracking. |
| `prescription_items` Table | **Verified** | Defined in `drizzle/0028_clinical_opd.sql`. Lacks independent order states, scheduled times, administration tracking, or start/stop dates. |
| Inpatient Orders Table | **Proposed** | Dedicated `ipd_medication_orders` table with explicit lifecycle states (`draft`, `active`, `on_hold`, `discontinued`, `completed`, `superseded`, `voided`), structured schedules, and independent duration tracking. Signed instructions are protected by immutability triggers. |
| Administration Table | **Proposed** | Dedicated `ipd_medication_administrations` table tracking scheduled times, actual administration times, decision times, dose/route, outcomes (`administered`, `omitted`, `refused`, `held`), void lineage, and nurse attribution. Void-only updates enforced by trigger. |
| Allergies Table | **Verified** | **Does not exist in the database.** No table or column in `lib/db/schema.ts` tracks patient allergies. |
| Allergies Strategy | **Proposed** | Dedicated `ipd_allergy_assessments` table tracking admission-level allergy status (`unreviewed`, `nkda`, `allergies_documented`) with structured JSONB allergen lines. Initial unreviewed status permits null reviewer; updates set `is_current = false` to preserve full assessment history. |

### 4.2 Services & Clinical Logic
| Area | Status | Details & Evidence |
| :--- | :--- | :--- |
| Inpatient Prescribing | **Verified** | Zero services exist in `lib/services/` for IPD prescribing or rounding orders. |
| TPR Vitals & Trends | **Verified** | Implemented in `lib/services/tpr.ts` and `components/ipd/tpr-chart.tsx`. Exposes `getLatestVitals()` and `getTprDay()`. Chart day is defined as `08:00` to `08:00` in `lib/domain/tpr.ts`. |
| Evidence & Audit Log | **Verified** | Implemented in `drizzle/0044_evidence_log.sql` and `lib/services/evidence.ts`. Append-only tamper-evident `acct_events` table with hourly cryptographic Merkle digest sealing. |
| Bedside Record Screen | **Verified** | `components/ipd/record-screen.tsx`. Queries generic `care-entries` search. Direct inserts bypass patient orders. |
| Doctor IPD Access | **Verified** | `app/(app)/ipd/page.tsx:26` checks `can(role, 'queue.mutate')`, which blocks doctors (redirecting them to `/dashboard`). Doctor access is only partially implemented via `/ipd/my-patients`. |

### 4.3 Permissions & Authorization
| Action | Status | Details & Evidence |
| :--- | :--- | :--- |
| `clinical.write` | **Verified** | Role in `['owner', 'doctor']`. Requires account to be linked to a row in `doctors` (`doctors.user_id`). Defined in `lib/domain/permissions.ts:64`. |
| `ipd.prescribe` | **Proposed** | New permission assigned to `['doctor', 'owner']`. An owner without an active doctor linkage cannot sign prescription orders. |
| `ipd.administer` | **Proposed** | New permission assigned to `['nurse', 'owner']` allowing recording of medication administrations and exceptions. |

### 4.4 Inventory & Billing Contracts
| Integration | Status | Details & Evidence |
| :--- | :--- | :--- |
| Bedside Billing | **Verified** | In `lib/services/care-entries.ts:195` and `lib/services/ipd-billing.ts:78`, every care entry posts to `bill_items` in the same transaction. Unique partial index `bill_items_care_entry_once` guarantees single-billing per entry. Unpriced items return false and are backfilled when priced. |
| Inventory Stock Ledger | **Verified** | In `lib/services/stock.ts:43`, stock management is strictly count-first for **risk-class medicines only** (`medicine_risk_classes`, `risk_classes`). Non-risk medicines have no balance ledger. There is NO general automated FEFO bedside deduction worker for routine ward medications in the repository. |
| Outbox Worker Pattern | **Verified** | Defined in `lib/notify/worker.ts`. Uses transactional claiming: `SELECT ... FOR UPDATE SKIP LOCKED` on `notification_outbox`, with `claimed_at` and 5-minute stuck-lease recovery. There is no existing eMAR outbox. |
| eMAR Outbox Decoupling | **Proposed** | Introduce `ipd_emar_integration_outbox` replicating the `lib/notify/worker.ts` transactional pattern to decouple clinical administration writes from downstream billing and risk-stock movements. |

---

## 5. Data Model and Schema Specification

### 5.1 The Order Versioning Model: Immutable Versioned Orders & Void Semantics
To prevent clinical history overwrites while maintaining referential integrity across amendments, we adopt **Immutable Signed Order Versions linked by Replacement References**:
- **Signed Order Immutability:** Once signed (`signed_at IS NOT NULL`), clinical instructions (`medicine_id`, dose, route, schedule times, duration, instructions) are **100% frozen in the database**. Modifying an active order or renewing an expiring course **never** edits `ends_at` or dosing in place.
- **Renewal via Successor Version:** Extending or renewing an order generates a successor row in `ipd_medication_orders` inheriting the same `order_chain_id`, setting `supersedes_order_id = old.id`, and stamping the renewed start/end dates. The prior version transitions to `status = 'superseded'`.
- **Coherent Void / Entered-in-Error Model:** If an order was entered mistakenly (e.g. wrong patient, wrong drug, duplicate entry):
  - Transitions to `status = 'voided'` with mandatory `voided_at`, `voided_by_user_id`, and `void_reason`.
  - Instantly cancels all scheduled dose occurrences.
  - Requires an audit row in `ipd_medication_order_actions` with `action = 'void'`.
  - If any administrations were recorded prior to voiding, the eMAR flags those events for mandatory supervisory clinical review.

```
[Order Version 1: 500mg (Superseded)] -- (modified on Day 2) --> [Order Version 2: 650mg (Active)]
       ^                                                                ^
       |                                                                |
[Admin Record: Day 1, 08:00]                                     [Admin Record: Day 2, 14:00]
(Points to Order Version 1, Chain ID α)                          (Points to Order Version 2, Chain ID α)
```

### 5.2 Table Schemas (PostgreSQL / Drizzle)

#### A. Table: `ipd_medication_orders`
```sql
CREATE TABLE ipd_medication_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE RESTRICT,
  admission_id UUID NOT NULL,
  encounter_id UUID NOT NULL,
  patient_id UUID NOT NULL,
  order_chain_id UUID NOT NULL,                       -- Stable ID across dose amendments and renewals
  
  -- Clinical Substance Identity
  medicine_id UUID NOT NULL,
  medicine_name TEXT NOT NULL,                        -- Preserved display label at signing
  strength TEXT,                                      -- e.g. "500 mg"
  form TEXT,                                          -- e.g. "tablet", "injection"
  
  -- Structured Dosage & Route
  dose_amount NUMERIC(8, 2) NOT NULL,                 -- e.g. 1.0, 500.0
  dose_unit TEXT NOT NULL,                            -- e.g. "tablet", "mg", "ml", "vial"
  route TEXT NOT NULL CHECK (route IN (
    'oral', 'iv_push', 'iv_piggyback', 'im', 'sc', 
    'nebulization', 'topical', 'inhalation', 'sublingual', 
    'rectal', 'ophthalmic', 'otic'
  )),
  
  -- Structured Schedule & Timing
  schedule_type TEXT NOT NULL CHECK (schedule_type IN ('scheduled', 'prn', 'stat')),
  frequency_code TEXT,                                -- UI preset shortcut e.g. "OD", "BD", "TDS", "QID"
  schedule_times JSONB NOT NULL DEFAULT '[]'::jsonb,  -- Authoritative clock array e.g. ["08:00", "20:00"]
  is_prn BOOLEAN NOT NULL DEFAULT false,
  prn_indication TEXT,                                -- Required if is_prn is true
  prn_max_daily_doses SMALLINT,                       -- Ceiling count of administration events per chart day
  prn_max_daily_quantity NUMERIC(8, 2),               -- Optional ceiling cumulative substance amount per chart day
  prn_max_daily_unit TEXT,                            -- Unit for cumulative amount (e.g. "mg")
  prn_min_interval_hours SMALLINT,                    -- Minimum spacing between PRN doses
  special_instructions TEXT,                          -- e.g. "Before food", "Dilute in 100ml NS"
  
  -- Medication Origin & Reconciliation
  origin TEXT NOT NULL DEFAULT 'inpatient_order' CHECK (origin IN ('inpatient_order', 'home_medication')),
  patient_supplied BOOLEAN NOT NULL DEFAULT false,
  
  -- Course Lifespan
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ,                                -- Calculated: starts_at + (duration_days * 24 hours)
  duration_days SMALLINT CHECK (duration_days IS NULL OR duration_days BETWEEN 1 AND 365),
  
  -- Order Lifecycle State
  status TEXT NOT NULL CHECK (status IN ('draft', 'active', 'on_hold', 'discontinued', 'completed', 'superseded', 'voided')),
  
  -- Modification, Lineage & Voiding
  supersedes_order_id UUID,
  superseded_by_order_id UUID,
  order_set_id UUID,                                  -- Source order-set if generated from template
  order_set_version INTEGER,
  voided_at TIMESTAMPTZ,
  voided_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  void_reason TEXT,
  
  -- Attribution & Signing
  prescriber_doctor_id UUID NOT NULL,
  created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  signed_at TIMESTAMPTZ,                              -- NULL while in draft status
  round_note_id UUID,                                 -- Linked daily evaluation note
  
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  
  -- Retention-Aware Foreign Keys & Composite Tenant Isolation
  CONSTRAINT ipd_med_orders_tenant_key UNIQUE (hospital_id, id),
  CONSTRAINT ipd_med_orders_tenant_admission_key UNIQUE (hospital_id, admission_id, id),
  CONSTRAINT ipd_med_orders_tenant_fk FOREIGN KEY (hospital_id, admission_id, encounter_id, patient_id)
    REFERENCES admissions (hospital_id, id, encounter_id, patient_id) ON DELETE RESTRICT,
  CONSTRAINT ipd_med_orders_medicine_fk FOREIGN KEY (hospital_id, medicine_id)
    REFERENCES medicines (hospital_id, id) ON DELETE RESTRICT,
  CONSTRAINT ipd_med_orders_doctor_fk FOREIGN KEY (hospital_id, prescriber_doctor_id)
    REFERENCES doctors (hospital_id, id) ON DELETE RESTRICT,
  CONSTRAINT ipd_med_orders_round_note_fk FOREIGN KEY (hospital_id, admission_id, round_note_id)
    REFERENCES ipd_clinical_rounds (hospital_id, admission_id, id) ON DELETE RESTRICT,
  CONSTRAINT ipd_med_orders_supersedes_fk FOREIGN KEY (hospital_id, supersedes_order_id)
    REFERENCES ipd_medication_orders (hospital_id, id) ON DELETE RESTRICT,
  CONSTRAINT ipd_med_orders_superseded_by_fk FOREIGN KEY (hospital_id, superseded_by_order_id)
    REFERENCES ipd_medication_orders (hospital_id, id) ON DELETE RESTRICT,
  CONSTRAINT ipd_med_orders_signed_chk CHECK (
    (status = 'draft' AND signed_at IS NULL) OR
    (status != 'draft' AND signed_at IS NOT NULL)
  ),
  CONSTRAINT ipd_med_orders_superseded_chk CHECK (
    (status = 'superseded' AND superseded_by_order_id IS NOT NULL) OR
    (status != 'superseded' AND superseded_by_order_id IS NULL)
  ),
  CONSTRAINT ipd_med_orders_void_chk CHECK (
    (status = 'voided' AND voided_at IS NOT NULL AND void_reason IS NOT NULL) OR
    (status != 'voided' AND voided_at IS NULL AND void_reason IS NULL)
  ),
  CONSTRAINT ipd_med_orders_prn_chk CHECK (
    (is_prn = false AND prn_indication IS NULL) OR
    (is_prn = true AND prn_indication IS NOT NULL AND prn_max_daily_doses IS NOT NULL)
  ),
  CONSTRAINT ipd_med_orders_schedule_chk CHECK (
    (schedule_type = 'prn' AND is_prn = true) OR
    (schedule_type != 'prn' AND is_prn = false)
  )
);

CREATE INDEX ipd_med_orders_active_idx ON ipd_medication_orders (hospital_id, admission_id, status)
  WHERE status IN ('active', 'on_hold');
CREATE INDEX ipd_med_orders_chain_idx ON ipd_medication_orders (hospital_id, order_chain_id);

-- Trigger: Prohibit Mutation of Signed Clinical Instructions
CREATE OR REPLACE FUNCTION ipd_enforce_signed_order_immutability()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.signed_at IS NOT NULL THEN
    -- Prohibit modifying clinical instruction columns once signed
    IF NEW.medicine_id <> OLD.medicine_id OR
       NEW.dose_amount <> OLD.dose_amount OR
       NEW.dose_unit <> OLD.dose_unit OR
       NEW.route <> OLD.route OR
       NEW.schedule_type <> OLD.schedule_type OR
       NEW.schedule_times <> OLD.schedule_times OR
       NEW.is_prn <> OLD.is_prn OR
       NEW.starts_at <> OLD.starts_at OR
       NEW.ends_at <> OLD.ends_at OR
       NEW.duration_days IS DISTINCT FROM OLD.duration_days OR
       NEW.prescriber_doctor_id <> OLD.prescriber_doctor_id OR
       NEW.origin <> OLD.origin OR
       NEW.patient_supplied <> OLD.patient_supplied OR
       NEW.signed_at <> OLD.signed_at THEN
      RAISE EXCEPTION 'Signed clinical medication instructions are immutable. To modify dosage, timing, or duration, authorize a successor order version.';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_ipd_med_orders_immutable
  BEFORE UPDATE ON ipd_medication_orders
  FOR EACH ROW EXECUTE FUNCTION ipd_enforce_signed_order_immutability();
```

#### B. Table: `ipd_medication_order_actions` (Audit & State History)
Captures every meaningful state transition with strict actor attribution, mandatory rationale, and append-only enforcement:
```sql
CREATE TABLE ipd_medication_order_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE RESTRICT,
  order_id UUID NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('sign', 'hold', 'resume', 'discontinue', 'modify', 'renew', 'expire', 'void')),
  reason TEXT,                                        -- Mandatory for hold, resume, discontinue, modify, renew, void
  actor_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  doctor_id UUID,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ipd_order_actions_order_fk FOREIGN KEY (hospital_id, order_id)
    REFERENCES ipd_medication_orders (hospital_id, id) ON DELETE RESTRICT,
  CONSTRAINT ipd_order_actions_doctor_fk FOREIGN KEY (hospital_id, doctor_id)
    REFERENCES doctors (hospital_id, id) ON DELETE RESTRICT,
  CONSTRAINT ipd_order_actions_reason_chk CHECK (
    action IN ('sign', 'expire') OR (reason IS NOT NULL AND char_length(reason) >= 3)
  )
);

-- Trigger: Strictly Append-Only Enforcement
CREATE OR REPLACE FUNCTION ipd_prevent_audit_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'Clinical action audit history is strictly append-only. Modification or deletion is forbidden.';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_ipd_order_actions_append_only
  BEFORE UPDATE OR DELETE ON ipd_medication_order_actions
  FOR EACH ROW EXECUTE FUNCTION ipd_prevent_audit_mutation();
```

#### C. Table: `ipd_medication_administrations` (eMAR Event Log)
```sql
CREATE TABLE ipd_medication_administrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE RESTRICT,
  admission_id UUID NOT NULL,
  order_id UUID NOT NULL,
  order_chain_id UUID NOT NULL,                       -- Enables cross-version PRN cumulative limit calculations
  client_id UUID NOT NULL,                            -- Offline deduplication & idempotency key
  
  -- Temporal Semantics (Separated Actual vs. Decision Time vs. Entry Time)
  scheduled_time TIMESTAMPTZ,                         -- Scheduled slot (assigned order.starts_at for Stat; NULL for PRN)
  actual_time TIMESTAMPTZ,                            -- Populated ONLY when outcome = 'administered'
  decision_time TIMESTAMPTZ,                          -- Populated ONLY when outcome != 'administered'
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),     -- When row was committed
  
  -- Outcome & Clinical Findings
  outcome TEXT NOT NULL CHECK (outcome IN ('administered', 'omitted', 'refused', 'held')),
  dose_given TEXT,                                    -- Verified dose label (e.g. "500 mg")
  dose_amount_numeric NUMERIC(8, 2),                  -- Numeric dose administered for cumulative tracking
  route_given TEXT,                                   -- Verified route
  non_admin_reason TEXT,                              -- Required when outcome != 'administered'
  clinical_note TEXT,                                 -- e.g. "Site: Left deltoid, well tolerated"
  
  -- Attribution & Device Context
  nurse_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  recorded_channel TEXT CHECK (recorded_channel IN ('personal', 'ward_device')),
  recorded_device_id TEXT,
  
  -- Void & Error Correction Traceability
  voided_at TIMESTAMPTZ,
  voided_by_user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
  void_reason TEXT,
  corrects_administration_id UUID,
  corrected_by_administration_id UUID,
  
  -- Downstream Integration Traceability
  care_entry_id UUID,                                 -- Linked billing/care record if billed
  stock_ledger_id UUID,                               -- Linked inventory transaction if deducted
  
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  
  CONSTRAINT ipd_med_admin_tenant_key UNIQUE (hospital_id, id),
  CONSTRAINT ipd_med_admin_client_key UNIQUE (hospital_id, client_id),
  -- Composite Foreign Key strictly binding admission, hospital, and order together
  CONSTRAINT ipd_med_admin_order_admission_fk FOREIGN KEY (hospital_id, admission_id, order_id)
    REFERENCES ipd_medication_orders (hospital_id, admission_id, id) ON DELETE RESTRICT,
  CONSTRAINT ipd_med_admin_corrects_fk FOREIGN KEY (hospital_id, corrects_administration_id)
    REFERENCES ipd_medication_administrations (hospital_id, id) ON DELETE RESTRICT,
  CONSTRAINT ipd_med_admin_corrected_by_fk FOREIGN KEY (hospital_id, corrected_by_administration_id)
    REFERENCES ipd_medication_administrations (hospital_id, id) ON DELETE RESTRICT,
  CONSTRAINT ipd_med_admin_void_chk CHECK ((voided_at IS NULL) = (void_reason IS NULL)),
  CONSTRAINT ipd_med_admin_timing_chk CHECK (
    (outcome = 'administered' AND actual_time IS NOT NULL AND decision_time IS NULL AND non_admin_reason IS NULL) OR
    (outcome != 'administered' AND actual_time IS NULL AND decision_time IS NOT NULL AND non_admin_reason IS NOT NULL)
  )
);

-- Stable Dose Slot Uniqueness (Duplicate Occurrence Prevention)
CREATE UNIQUE INDEX ipd_med_admin_scheduled_occurrence_key 
  ON ipd_medication_administrations (hospital_id, order_id, scheduled_time) 
  WHERE voided_at IS NULL AND scheduled_time IS NOT NULL;

CREATE INDEX ipd_med_admin_admission_time_idx ON ipd_medication_administrations 
  (hospital_id, admission_id, recorded_at) WHERE voided_at IS NULL;

-- Fast Cross-Version PRN Lookups
CREATE INDEX ipd_med_admin_chain_time_idx ON ipd_medication_administrations 
  (hospital_id, order_chain_id, actual_time) 
  WHERE voided_at IS NULL AND outcome = 'administered';

-- Trigger: Prohibit Delete & Limit Updates to Void Stamping
CREATE OR REPLACE FUNCTION ipd_enforce_admin_void_only()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Administration records cannot be deleted; invoke void/strike-through workflow.';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.outcome IS NOT NULL AND (
       NEW.outcome <> OLD.outcome OR
       NEW.actual_time IS DISTINCT FROM OLD.actual_time OR
       NEW.dose_given IS DISTINCT FROM OLD.dose_given OR
       NEW.nurse_user_id <> OLD.nurse_user_id) THEN
      RAISE EXCEPTION 'Clinical administration details are immutable. Voids must preserve original execution data.';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_ipd_med_admin_void_only
  BEFORE UPDATE OR DELETE ON ipd_medication_administrations
  FOR EACH ROW EXECUTE FUNCTION ipd_enforce_admin_void_only();
```

#### D. Table: `ipd_clinical_rounds`
```sql
CREATE TABLE ipd_clinical_rounds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE RESTRICT,
  admission_id UUID NOT NULL,
  encounter_id UUID NOT NULL,
  patient_id UUID NOT NULL,
  doctor_id UUID NOT NULL,
  author_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  evaluation_notes TEXT NOT NULL,                     -- Subjective/Objective notes, assessment
  status TEXT NOT NULL CHECK (status IN ('draft', 'signed')),
  version INTEGER NOT NULL DEFAULT 1,                 -- Optimistic concurrency check
  signed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ipd_clinical_rounds_tenant_key UNIQUE (hospital_id, id),
  CONSTRAINT ipd_clinical_rounds_tenant_admission_key UNIQUE (hospital_id, admission_id, id),
  CONSTRAINT ipd_clinical_rounds_tenant_fk FOREIGN KEY (hospital_id, admission_id, encounter_id, patient_id)
    REFERENCES admissions (hospital_id, id, encounter_id, patient_id) ON DELETE RESTRICT,
  CONSTRAINT ipd_clinical_rounds_doctor_fk FOREIGN KEY (hospital_id, doctor_id)
    REFERENCES doctors (hospital_id, id) ON DELETE RESTRICT,
  CONSTRAINT ipd_clinical_rounds_signed_chk CHECK (
    (status = 'draft' AND signed_at IS NULL) OR
    (status = 'signed' AND signed_at IS NOT NULL)
  )
);

-- Trigger: Prohibit Editing Signed Clinical Round Notes
CREATE OR REPLACE FUNCTION ipd_enforce_signed_round_immutability()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status = 'signed' THEN
    IF NEW.evaluation_notes <> OLD.evaluation_notes OR NEW.signed_at <> OLD.signed_at THEN
      RAISE EXCEPTION 'Signed clinical round notes cannot be modified. Record an addendum or a new round evaluation.';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_ipd_clinical_rounds_immutable
  BEFORE UPDATE ON ipd_clinical_rounds
  FOR EACH ROW EXECUTE FUNCTION ipd_enforce_signed_round_immutability();
```

#### E. Table: `ipd_allergy_assessments`
Tracks patient allergy status with revision preservation:
```sql
CREATE TABLE ipd_allergy_assessments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE RESTRICT,
  admission_id UUID NOT NULL,
  encounter_id UUID NOT NULL,
  patient_id UUID NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('unreviewed', 'nkda', 'allergies_documented')),
  allergens JSONB NOT NULL DEFAULT '[]'::jsonb,       -- [{ substance: text, reaction: text, severity: text }]
  is_current BOOLEAN NOT NULL DEFAULT true,           -- Preserves historical assessments upon clinical re-evaluation
  reviewed_by_user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
  reviewed_at TIMESTAMPTZ,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ipd_allergy_assessments_tenant_fk FOREIGN KEY (hospital_id, admission_id, encounter_id, patient_id)
    REFERENCES admissions (hospital_id, id, encounter_id, patient_id) ON DELETE RESTRICT,
  CONSTRAINT ipd_allergy_review_chk CHECK (
    (status = 'unreviewed' AND reviewed_by_user_id IS NULL AND reviewed_at IS NULL) OR
    (status IN ('nkda', 'allergies_documented') AND reviewed_by_user_id IS NOT NULL AND reviewed_at IS NOT NULL)
  )
);

-- Guarantees exactly one current allergy assessment per admission
CREATE UNIQUE INDEX ipd_allergy_current_idx 
  ON ipd_allergy_assessments (hospital_id, admission_id) 
  WHERE is_current = true;
```

#### F. Tables: `ipd_order_sets` & `ipd_order_set_items`
```sql
CREATE TABLE ipd_order_sets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE RESTRICT,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL,                             -- e.g. "Surgical", "Medical", "ICU"
  description TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL CHECK (status IN ('draft', 'pending_review', 'approved', 'deprecated')),
  approved_by_doctor_id UUID,
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ipd_order_sets_hospital_id_key UNIQUE (hospital_id, id),
  CONSTRAINT ipd_order_sets_hospital_code_ver UNIQUE (hospital_id, code, version),
  CONSTRAINT ipd_order_sets_doctor_fk FOREIGN KEY (hospital_id, approved_by_doctor_id)
    REFERENCES doctors (hospital_id, id) ON DELETE RESTRICT,
  CONSTRAINT ipd_order_sets_approved_chk CHECK (
    (status IN ('draft', 'pending_review') AND approved_by_doctor_id IS NULL AND approved_at IS NULL) OR
    (status IN ('approved', 'deprecated') AND approved_by_doctor_id IS NOT NULL AND approved_at IS NOT NULL)
  )
);

CREATE TABLE ipd_order_set_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE RESTRICT,
  order_set_id UUID NOT NULL,
  medicine_id UUID NOT NULL,
  default_dose_amount NUMERIC(8, 2) NOT NULL,
  default_dose_unit TEXT NOT NULL,
  default_route TEXT NOT NULL CHECK (default_route IN (
    'oral', 'iv_push', 'iv_piggyback', 'im', 'sc', 
    'nebulization', 'topical', 'inhalation', 'sublingual', 
    'rectal', 'ophthalmic', 'otic'
  )),
  default_schedule_type TEXT NOT NULL CHECK (default_schedule_type IN ('scheduled', 'prn', 'stat')),
  default_frequency_code TEXT,
  default_schedule_times JSONB NOT NULL DEFAULT '[]'::jsonb,
  default_duration_days SMALLINT,
  default_instructions TEXT,
  sort_order SMALLINT NOT NULL DEFAULT 0,
  -- Composite Foreign Keys Guaranteeing Tenant Isolation
  CONSTRAINT ipd_order_set_items_set_fk FOREIGN KEY (hospital_id, order_set_id)
    REFERENCES ipd_order_sets (hospital_id, id) ON DELETE CASCADE,
  CONSTRAINT ipd_order_set_items_medicine_fk FOREIGN KEY (hospital_id, medicine_id)
    REFERENCES medicines (hospital_id, id) ON DELETE RESTRICT
);

CREATE INDEX ipd_order_set_items_set_idx ON ipd_order_set_items (hospital_id, order_set_id, sort_order);

-- Triggers: Protect Approved Order Sets and Items from Mutation
CREATE OR REPLACE FUNCTION ipd_enforce_order_set_immutability()
RETURNS TRIGGER AS $$
DECLARE
  v_status TEXT;
BEGIN
  IF TG_TABLE_NAME = 'ipd_order_sets' THEN
    IF OLD.status IN ('approved', 'deprecated') THEN
      -- Only permit transitioning approved -> deprecated
      IF TG_OP = 'DELETE' OR NEW.code <> OLD.code OR NEW.name <> OLD.name OR NEW.version <> OLD.version THEN
        RAISE EXCEPTION 'Approved order sets are immutable. Author a new version to modify.';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME = 'ipd_order_set_items' THEN
    SELECT status INTO v_status FROM ipd_order_sets WHERE id = COALESCE(NEW.order_set_id, OLD.order_set_id);
    IF v_status IN ('approved', 'deprecated') THEN
      RAISE EXCEPTION 'Items in an approved order set are immutable. Author a new template version to modify items.';
    END IF;
    RETURN COALESCE(NEW, OLD);
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_ipd_order_sets_immutable
  BEFORE UPDATE OR DELETE ON ipd_order_sets
  FOR EACH ROW EXECUTE FUNCTION ipd_enforce_order_set_immutability();

CREATE TRIGGER trg_ipd_order_set_items_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON ipd_order_set_items
  FOR EACH ROW EXECUTE FUNCTION ipd_enforce_order_set_immutability();
```

#### G. Table: `ipd_emar_integration_outbox` (Transactional Accounting Dispatch)
Replicates the verified `lib/notify/worker.ts` transactional pattern with distinct event types:
```sql
CREATE TABLE ipd_emar_integration_outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE RESTRICT,
  administration_id UUID NOT NULL,
  integration_type TEXT NOT NULL CHECK (integration_type IN ('billing', 'stock')),
  event_type TEXT NOT NULL CHECK (event_type IN ('administer', 'void', 'correction')),
  payload JSONB NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'pending_pricing', 'processing', 'processed', 'failed', 'skipped')),
  attempts INTEGER NOT NULL DEFAULT 0,
  scheduled_for TIMESTAMPTZ NOT NULL DEFAULT now(),
  claimed_at TIMESTAMPTZ,                              -- Worker lease claim timestamp
  last_error TEXT,
  processed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ipd_emar_outbox_admin_fk FOREIGN KEY (hospital_id, administration_id)
    REFERENCES ipd_medication_administrations (hospital_id, id) ON DELETE RESTRICT,
  CONSTRAINT ipd_emar_outbox_event_key UNIQUE (hospital_id, administration_id, integration_type, event_type)
);

CREATE INDEX ipd_emar_outbox_pending_idx ON ipd_emar_integration_outbox (hospital_id, status, scheduled_for)
  WHERE status = 'pending';

---

## 6. Order and Administration State-Transition Models

### 6.1 Medication Order State Transitions
```
               ┌──────────┐
               │  Draft   │
               └────┬─────┘
                    │ Sign & Authorize
                    ▼
       ┌───────► Active ◄────────────────────────┐
       │           │   ▲                         │
Resume │      Hold │   │                         │
       │           ▼   │                         │
       │        On Hold                          │
       │           │                             │
       │Discontinue│Discontinue                  │
       │           ▼                             ▼
       │      Discontinued               Voided (Entered in Error)
       │           │                             ▲
       │           ├───────────────┬─────────────┤
       │           ▼               ▼             │
       │       Completed       Superseded ───────┘
       │   (now >= ends_at)  (Modified / Renewed)
```

**Permitted Transitions & Audit Invariants:**
Every state transition requires an explicit insert into `ipd_medication_order_actions`:
1. `draft -> active` (`action = 'sign'`): Doctor with `ipd.prescribe` authorizes the order. `signed_at` is stamped; order becomes actionable on the bedside eMAR. Unsigned drafts are completely invisible to nurses.
2. `draft -> discarded`: Draft deleted prior to signing; discarded with zero clinical footprint.
3. `active -> on_hold` (`action = 'hold'`): Temporary suspension of administration (e.g., patient scheduled for OT or fasting). Requires mandatory reason (`char_length >= 3`). Pending dose tasks become non-actionable and are visually flagged "On Hold" on the eMAR.
4. `on_hold -> active` (`action = 'resume'`): Attending physician resumes the order with mandatory rationale. Dose tasks resume from the next scheduled occurrence slot.
5. `active -> discontinued` / `on_hold -> discontinued` (`action = 'discontinue'`): Permanent early cessation with mandatory reason. Outstanding dose tasks are immediately cancelled and hidden from Due Now.
6. `active -> superseded` (`action = 'modify'`): Prescriber modifies dose, strength, route, or timing. To protect clinical history, the existing order is frozen with `status = 'superseded'` and `superseded_by_order_id = new.id`. A new successor order row is created in `status = 'active'`, inheriting `order_chain_id` and setting `supersedes_order_id = old.id`.
7. `active -> superseded` (`action = 'renew'`): Prescriber renews or extends the course duration. To preserve signed order immutability, **`ends_at` is never edited in place**. A renewal creates a successor order version in `status = 'active'` inheriting `order_chain_id`, setting `supersedes_order_id = old.id`, and establishing the extended `ends_at`. The prior order transitions to `status = 'superseded'`.
8. `active -> completed` (`action = 'expire'`): Course duration reached (`now() >= ends_at`). Handled via a consistent **Dual Expiry Model**:
   - *Query-Level Invariant:* All active queries assert `status = 'active' AND (ends_at IS NULL OR ends_at > now())`. Expired orders become immediately non-actionable at runtime with zero polling lag.
   - *Physical State Update:* On doctor round load, bedside eMAR refresh, or during the periodic housekeeping sweep (`sweeps.ts`), expired rows are batch-updated to `status = 'completed'` and an audit row with `action = 'expire'` is recorded.
9. `active` / `on_hold` / `draft` -> `voided` (`action = 'void'`): Order voided due to clinical clerical error (e.g. wrong patient, wrong substance, duplicate entry). Sets `status = 'voided'`, `voided_at = now()`, `voided_by_user_id`, and mandatory `void_reason`. Pending doses are immediately cancelled. Any administrations already filed against the order prior to voiding are flagged for high-priority clinical review.

### 6.2 Administration Event State Model
```
[Scheduled Dose Task Generated]
         │
         ├──► Nurse selects task & verifies patient
         │         │
         │         ├── [Administered] ──► Verified actual dose, time, route ──► Dispatches Outbox
         │         │
         │         └── [Non-Administered]
         │                  ├── Omitted (e.g. NPO, fasting, off-ward)
         │                  ├── Refused (patient refusal documented)
         │                  └── Held (clinical hold e.g. pulse < 60)
         │
         └── [Order Modified / Discontinued / Voided] ──► Task auto-cancelled
```

**Execution & Concurrency Rules:**
1. **Rejection of Invalid Orders:** Ordinary administration actions against non-active orders are strictly rejected. The service layer verifies `status = 'active'` and `now() < ends_at` under row-lock (`FOR UPDATE`). If the order is `on_hold`, `discontinued`, `completed`, `superseded`, `voided`, or `draft`, the submission is rejected with a descriptive conflict error (e.g., *"Order was discontinued by Dr. Sharma at 14:15"*).
2. **Stable Identity for Scheduled Doses:** Each scheduled dose occurrence is uniquely identified by `(hospital_id, order_id, scheduled_time)`. The partial unique index `ipd_med_admin_scheduled_occurrence_key` enforces that multiple nurses on different tablets cannot file separate outcomes for the same dose slot, even with differing `client_id`s.
3. **Stat Order Execution Contract:** Stat orders are single immediate doses. In `ipd_medication_administrations`, a Stat event is deterministically assigned `scheduled_time = order.starts_at`. The occurrence unique index prevents duplicate administration across all devices. Upon successful administration, the order is immediately transitioned to `status = 'completed'` in the same database transaction.
4. **PRN (As-Needed) Cross-Version Concurrency & Limits:**
   - **Stable Chain Locking:** PRN doses have `scheduled_time = NULL`. Concurrent administration requests across related order versions are serialized using a PostgreSQL transactional advisory lock on the stable chain key:
     ```sql
     SELECT pg_advisory_xact_lock(hashtext('ipd_prn_chain:' || order_chain_id::text));
     ```
   - **Cross-Version Prior Administration Query:** The transaction queries all non-voided administrations across the entire order chain (`order_chain_id = $order_chain_id`):
     - Cooldown window: `now() - max(actual_time) >= prn_min_interval_hours`.
     - Daily count ceiling: `count(actual_time) + 1 <= prn_max_daily_doses` within the current **Medication Chart Day** (`08:00` to `08:00`).
     - Daily cumulative quantity ceiling: `(prn_max_daily_quantity IS NULL OR sum(coalesce(dose_amount_numeric, 0)) + proposed_dose <= prn_max_daily_quantity)`.
     If any constraint fails, the submission is rejected with `409 Conflict`.
   - **Voids and Corrections:** Administrations with `voided_at IS NOT NULL` are strictly excluded from cooldown and cumulative limits. If an administration is corrected, only the active replacement record is counted.
5. **Correction & Voiding Lineage:**
   - Completed administration records cannot be edited in place.
   - If an entry was made in error (e.g., wrong patient selected, wrong dose typed), an authorized clinician or supervisor invokes **Void / Strike Through**:
     - Sets `voided_at`, `voided_by_user_id`, and mandatory `void_reason`.
     - Dispatches a `void` event to `ipd_emar_integration_outbox` to reverse linked billing lines via `voidCareEntryLineInTx`.
     - Voids un-index the row from `ipd_med_admin_scheduled_occurrence_key`.
     - A replacement entry can then be filed referencing the original via `corrects_administration_id` and back-linked via `corrected_by_administration_id`.

---

## 7. Medication Scheduling Semantics

### 7.1 Authoritative Sources of Truth
To eliminate contradictory data, fields have strict, non-overlapping roles:
- `schedule_type`: Authoritative discriminator (`'scheduled'`, `'prn'`, `'stat'`).
- `schedule_times`: Authoritative JSONB array of clock time strings `["HH:MM"]` in 24-hour format (`00:00` to `23:59`) for `scheduled` types.
- `frequency_code`: Clinical display shorthand and template preset generator (`OD`, `BD`, `TDS`, `QID`, `SOS`, `Stat`). Selecting a frequency pre-populates default `schedule_times`, which the prescriber must review and approve. **Hospital defaults never silently substitute for signed clock instructions.**
- `is_prn`: Derived boolean constraint asserting `is_prn = (schedule_type = 'prn')`.

### 7.2 Hospital-Governed Clock Times vs Interval Semantics
In clinical practice across Indian hospital wards, medication rounds follow designated ward clock times rather than mathematical division of 24 hours:
- **TDS Semantics:** TDS does **not** mean strict 8-hour intervals (`00:00`, `08:00`, `16:00`), which would require waking sleeping patients at midnight. Instead, hospital clinical governance designates 3 waking medication rounds (e.g., `["08:00", "14:00", "20:00"]`).
- **QID Semantics:** Four times daily. In surgical wards, default times align with nursing shifts (`["06:00", "12:00", "18:00", "00:00"]`).
- **Configurable Defaults:** Default clock times are defined per hospital branch in settings, subject to hospital clinical governance:
  | Frequency Code | Clinical Meaning | Governed Default Times | Notes |
  | :--- | :--- | :--- | :--- |
  | `Stat` | Immediate, single dose | Instant execution | `scheduled_time = starts_at`; auto-completes order |
  | `OD` | Once daily | `["08:00"]` | Morning round |
  | `BD` | Twice daily (12h spacing) | `["08:00", "20:00"]` | Shift handover rounds |
  | `TDS` | Thrice daily (waking rounds) | `["08:00", "14:00", "20:00"]` | Waking ward medication rounds |
  | `QID` | Four times daily (6h spacing) | `["06:00", "12:00", "18:00", "00:00"]` | IV antibiotics spacing |
  | `SOS` / `PRN` | As needed / On Demand | Variable / NULL | Subject to minimum spacing and chart day limits |

*Midnight Boundary Representation:* Clock times strictly use 24-hour format `"HH:MM"` from `"00:00"` to `"23:59"`. A dose at midnight is represented as `"00:00"`.

### 7.3 Course Duration & Boundary Calculations
- `starts_at`: Defaults to order signing timestamp or an explicit start date/time.
- `duration_days`: Integer number of treatment calendar days.
- `ends_at`: Calculated deterministically: `starts_at + (duration_days * interval '24 hours')`.
- Timezone: Evaluated in the hospital's local timezone (`hospitals.timezone`, e.g. `Asia/Kolkata`). Indian Standard Time has no daylight saving shifts.

### 7.4 Administration Windows & Overdue Thresholds
- **Due Window:** An order appears in `Due Now` within `[scheduled_time - 60 min, scheduled_time + 60 min]`.
- **Overdue Threshold:** If `now() > scheduled_time + 60 min` and no outcome has been recorded, the task moves to `Overdue`.
- *Clinical Safety Constraint:* The `Overdue` badge is a visual clinical warning for nurses and doctors; it does not authorize administration if the safe medication window has passed.

### 7.5 PRN (As-Needed) Calculation Contract
For orders where `is_prn = true`:
1. **Clinical Indication Requirement:** Order must display mandatory `prn_indication` (e.g. *"Temperature > 101°F"*).
2. **Spacing Constraint:** `now() - last_administered_at >= prn_min_interval_hours`. Evaluated across all versions of the order chain (`order_chain_id`). If the interval has not elapsed, the administration button is disabled and displays a remaining cooldown timer.
3. **Chart Day Ceilings:** Evaluated against the hospital's **Medication Chart Day** (`08:00` to `08:00`, matching `chartDayOf` in `lib/domain/tpr.ts`), aligning with TPR vitals and nursing shift cycles:
   - **Dose Count Ceiling:** `count(actual_time) < prn_max_daily_doses`.
   - **Cumulative Quantity Ceiling:** If `prn_max_daily_quantity` is defined, `cumulative_dose_amount + proposed_dose <= prn_max_daily_quantity`.

### 7.6 Explicit Scope Deferral: Continuous & Fixed-Rate IV Infusions
Continuous and fixed-rate IV infusions are **explicitly deferred from the MVP bedside eMAR execution scope**:
- **Clinical Rationale:** Safe medication administration for infusions requires a stateful session lifecycle (infusion start, rate adjustments, pause for procedures, resume, bag change, delivered volume tally, cannula site monitoring). Treating an infusion as a single point-in-time check-off based merely on volume, rate, and duration fields is clinically unsafe and fails HL7 FHIR `MedicationAdministration` standards.
- **MVP Scope:** Prescribers may enter IV fluid regimens as narrative nursing instructions or round notes, but execution charting in the eMAR is limited to **discrete point-in-time doses** (oral, IV push, IV piggyback, IM, SC, nebulization, topical, rectal, sublingual).
- **Roadmap:** A dedicated Infusion Session model (`ipd_infusion_sessions`) with continuous telemetry, drop-rate calculators, and intake/output integration is formally scheduled for **Phase 6 (ICU & Infusion Module)**.

---

## 8. Doctor and Nurse User Workflows

### 8.1 Attending Doctor Rounding Workflow
```
[Doctor opens /ipd/my-patients or patient file]
       │
       ▼
[1. Review Clinical Context]
   • Patient identity (Name, UHID, IPD No., Bed)
   • Allergy review banner (NKDA vs documented drug allergies)
   • Live vitals freshness banner (Collection timestamp + warnings)
   • 24h nursing treatment timeline (what was given/held)
       │
       ▼
[2. Review Active Orders]
   • System lists active orders with nursing status (last given, overdue)
   • Doctor clicks "Review Current Orders"
   • For each line, selects: Continue / Renew / Modify / Hold / Discontinue
       │
       ▼
[3. Prescribe New Medications (Accelerated)]
   • Option A: Select approved hospital Order Set -> Draft lines populated
   • Option B: Click Doctor Frequent Chip (e.g. + Inj. Pantoprazole 40mg IV)
   • Option C: Formulary Search typeahead
   • Doctor specifies dose, route, schedule, and duration
       │
       ▼
[4. Clinical Round Note & Authorization]
   • Enters concise daily progress notes
   • Click "Save Draft" (private work in progress, eMAR unchanged) OR
   • Click "Sign & Authorize Orders" -> Validates, freezes version, updates live eMAR
```

### 8.2 Bedside Nurse eMAR Administration Workflow
```
[Nurse opens bed on ward tablet / phone]
       │
       ▼
[1. Positive Patient Verification]
   • Checks Bed label + Patient Name + UHID / IPD No.
   • Reviews documented Allergy banner
       │
       ▼
[2. View Work-Oriented Categories]
   • Due Now (doses within current time window)
   • Overdue (past-due doses requiring attention)
   • Upcoming (scheduled later in shift)
   • PRN / On-Demand (checks indication and limits)
   • On Hold (clearly flagged, disabled)
       │
       ▼
[3. Administer or Record Exception]
   • Choice A: Administer
       - Tap Due Task -> Modal opens
       - Confirms correct patient, medicine, dose, and route
       - Enters actual time & site note -> Confirms
       - System checks order active status -> Records administration -> Dispatches Outbox
   • Choice B: Non-Administration Exception
       - Tap Due Task -> Selects "Withhold / Omit / Refused"
       - Selects mandatory structured reason (e.g. Patient refused, NPO, Low BP)
       - Confirms -> Dose task cleared from Due Now -> Logged in History -> Doctor alerted
```

---

## 9. Security, Authorization, and Tenant Isolation

### 9.1 Permission Matrix
| Operation | Required Permission | Allowed Staff Roles | Constraints |
| :--- | :--- | :--- | :--- |
| View Inpatient Clinical Record | `ipd.view` | `doctor`, `nurse`, `owner`, `receptionist` | Tenant-isolated via `withTenant()` |
| Create/Edit Round Draft | `clinical.write` | `doctor`, `owner` | Must be linked to `doctors.user_id` |
| Sign Round & Authorize Orders | `ipd.prescribe` | `doctor`, `owner` | Mandatory `doctors.user_id` link; signs as legal prescriber |
| Hold / Resume / Discontinue Order | `ipd.prescribe` | `doctor`, `owner` | Mandatory structured reason |
| Record Medication Administration | `ipd.administer` | `nurse`, `owner` | Bedside execution |
| Record Non-Administration Exception | `ipd.administer` | `nurse`, `owner` | Mandatory structured reason |
| Void Finalized Administration | `ipd.correct` | `owner`, `doctor` | Supervisor gate; mandatory void reason |
| Author / Approve Order Sets | `clinical.configure` | `owner`, `doctor` | Clinical governance gate |
| Mark Discharge Ready | `ipd.dischargeReady`| `doctor`, `owner` | Clinical readiness sign-off |

### 9.2 Multi-Tenant Integrity, Immutability & Row-Level Security
1. **Tenant Isolation via Composite Foreign Keys:**
   Composite foreign keys enforce multi-tenant and admission boundaries at the database engine level:
   - `ipd_medication_orders` -> `admissions(hospital_id, id, encounter_id, patient_id)`
   - `ipd_medication_orders` -> `medicines(hospital_id, id)`
   - `ipd_medication_orders` -> `doctors(hospital_id, id)`
   - `ipd_medication_orders` -> `ipd_clinical_rounds(hospital_id, admission_id, id)` via `ipd_med_orders_round_note_fk`
   - `ipd_medication_administrations` -> `ipd_medication_orders(hospital_id, admission_id, id)` via `ipd_med_admin_order_admission_fk`
   - `ipd_clinical_rounds` -> `admissions(hospital_id, id, encounter_id, patient_id)`
   - `ipd_clinical_rounds` -> `doctors(hospital_id, id)`
   - `ipd_allergy_assessments` -> `admissions(hospital_id, id, encounter_id, patient_id)`
   - `ipd_order_set_items` -> `ipd_order_sets(hospital_id, id)`
   - `ipd_order_set_items` -> `medicines(hospital_id, id)`
   - `ipd_emar_integration_outbox` -> `ipd_medication_administrations(hospital_id, id)`

2. **Exhaustive Row-Level Security (RLS) Policy Specification:**
   Following the established pattern in `drizzle/0032_ipd_core.sql:420-470`:
   Every new table is configured with `ENABLE ROW LEVEL SECURITY` and `FORCE ROW LEVEL SECURITY`.
   - `FORCE ROW LEVEL SECURITY` ensures that even the table owner role is subject to RLS policies.
   - The application connection role (`app_user`) lacks `SUPERUSER` and `BYPASSRLS` privileges.
   - All queries execute through `withTenant(hospitalId, ...)` which sets `set_config('app.hospital_id', hospitalId, true)` (scoped to the transaction). When no tenant context is set, `nullif(current_setting('app.hospital_id', true), '')` evaluates to `NULL`, failing closed for all operations.

   ```sql
   DO $$
   DECLARE
     t text;
   BEGIN
     -- Apply tenant isolation and read-only session policies across all 8 tables
     FOREACH t IN ARRAY ARRAY[
       'ipd_clinical_rounds',
       'ipd_medication_orders',
       'ipd_medication_order_actions',
       'ipd_medication_administrations',
       'ipd_allergy_assessments',
       'ipd_order_sets',
       'ipd_order_set_items',
       'ipd_emar_integration_outbox'
     ]
     LOOP
       EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
       EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
       
       -- Tenant isolation (USING and WITH CHECK prevent cross-tenant reads and writes)
       EXECUTE format(
         $p$
           CREATE POLICY tenant_isolation ON %I
             USING (hospital_id = nullif(current_setting('app.hospital_id', true), '')::uuid)
             WITH CHECK (hospital_id = nullif(current_setting('app.hospital_id', true), '')::uuid)
         $p$,
         t
       );
       
       -- Read-only session write guard (0001 / 0032 pattern)
       EXECUTE format(
         $p$
           CREATE POLICY read_only_write ON %I AS RESTRICTIVE
             FOR ALL
             USING (true)
             WITH CHECK (NOT public.app_read_only())
         $p$,
         t
       );
       
       -- Read-only session delete guard
       EXECUTE format(
         $p$
           CREATE POLICY read_only_delete ON %I AS RESTRICTIVE
             FOR DELETE
             USING (NOT public.app_read_only())
         $p$,
         t
       );
     END LOOP;

     -- Clinical medical record access check (0028 / 0032 pattern)
     -- Medical records require verified clinical staff privileges (app_clinical_access)
     FOREACH t IN ARRAY ARRAY[
       'ipd_clinical_rounds',
       'ipd_medication_orders',
       'ipd_medication_order_actions',
       'ipd_medication_administrations',
       'ipd_allergy_assessments'
     ]
     LOOP
       EXECUTE format(
         $p$
           CREATE POLICY clinical_access ON %I AS RESTRICTIVE
             FOR ALL
             USING (public.app_clinical_access())
             WITH CHECK (public.app_clinical_access())
         $p$,
         t
       );
     END LOOP;
   END $$;
   ```

3. **Retention-Aware Deletion Policy (Zero Cascading Deletes on Signed Clinical History):**
   Destructive `ON DELETE CASCADE` is **strictly prohibited** on all signed clinical entities (`ipd_medication_orders`, `ipd_medication_administrations`, `ipd_clinical_rounds`, `ipd_allergy_assessments`, `ipd_medication_order_actions`, `ipd_emar_integration_outbox`).
   - If an admission, doctor, medicine, or hospital record deletion is attempted, PostgreSQL will refuse the deletion with a foreign key violation (`ON DELETE RESTRICT`).
   - Clinical entities are voided or struck through, never deleted.
   - Admissions are discharged or cancelled; medicines are deactivated (`active = false`); doctors are deactivated; hospitals are archived. Signed medico-legal clinical history is preserved permanently.

4. **Tamper-Resistant Enforcement Strategy:**
   - `ipd_medication_order_actions`: Trigger `trg_ipd_order_actions_append_only` forbids `UPDATE` or `DELETE` unconditionally.
   - `ipd_medication_administrations`: Trigger `trg_ipd_med_admin_void_only` forbids `DELETE` unconditionally. For `UPDATE`, it permits modifying only void/correction metadata (`voided_at`, `voided_by_user_id`, `void_reason`, `corrected_by_administration_id`), while raising an exception if clinical findings (`outcome`, `actual_time`, `dose_given`, `nurse_user_id`) are changed.
   - `ipd_medication_orders`: Trigger `trg_ipd_med_orders_immutable` freezes clinical instructions once `signed_at IS NOT NULL`. Only lifecycle status transitions (`on_hold`, `discontinued`, `completed`, `superseded`, `voided`) and void attribution are permitted.
   - `ipd_clinical_rounds`: Trigger `trg_ipd_clinical_rounds_immutable` locks `evaluation_notes` once `status = 'signed'`.
   - `ipd_order_sets` & `ipd_order_set_items`: Triggers `trg_ipd_order_sets_immutable` and `trg_ipd_order_set_items_immutable` reject updates or deletions once a template is `approved` or `deprecated`.

5. **Optimistic Concurrency Control:**
   - Round notes and order drafts carry an integer `version`. If two doctors open the same patient round, the second commit fails with `409 Conflict` rather than overwriting changes.
   - Administration execution checks `status = 'active'` under row-lock at commit time. If a doctor discontinued an order while a nurse had the modal open, the server rejects the administration: *"Order was discontinued by Dr. [Name] at [Time]"*.
   - PRN dose attempts acquire `pg_advisory_xact_lock(hashtext('ipd_prn_chain:' || order_chain_id::text))` to serialize cooldown and daily dose validations across all devices.

---

## 10. Inventory and Billing Integration Boundaries

```
[Bedside Administration Committed / Voided / Corrected]
       │
       ▼ (Same Database Transaction)
[ipd_emar_integration_outbox Row Inserted]
       │  (event_type: 'administer' | 'void' | 'correction')
       │
       ├──► [Billing Dispatch Worker]
       │      • If patient_supplied = true: marks 'skipped' (charge skipped)
       │      • If unpriced item: marks 'pending_pricing' (avoids repeated polling)
       │      • If priced formulary item:
       │          - 'administer': calls postCareEntryLineInTx() inside worker transaction
       │          - 'void': calls voidCareEntryLineInTx() inside worker transaction
       │          - 'correction': atomically voids old line and posts replacement line
       │      • On success: marks outbox 'processed' in SAME transaction
       │
       └──► [Stock Dispatch Worker]
              • Evaluates medicine against medicine_risk_classes (lib/services/stock.ts:43)
              • If non-risk formulary item: marks outbox 'skipped' (MVP unmanaged stock)
              • If risk-class item (Schedule H/X):
                  - 'administer': checks ward sub-store balance & posts stock_ledger movement
                  - 'void': posts compensatory stock_ledger return movement
              • On success: marks outbox 'processed' in SAME transaction
```

### 10.1 Outbox Worker Processing Contract
Replicating and extending the established `lib/notify/worker.ts` transactional pattern:

1. **Transactional Worker Polling Loop:**
   - Claims pending tasks in batches of 50 using `FOR UPDATE SKIP LOCKED`:
     ```sql
     SELECT id FROM ipd_emar_integration_outbox
     WHERE status = 'pending' AND scheduled_for <= now()
     ORDER BY scheduled_for ASC
     LIMIT 50
     FOR UPDATE SKIP LOCKED;
     ```
   - Sets `status = 'processing'` and `claimed_at = now()`.
   - Distinct worker passes run for `integration_type = 'billing'` and `integration_type = 'stock'`.

2. **Handling Unpriced Items (`pending_pricing`):**
   - In `lib/services/ipd-billing.ts:83`, `catalogueItemFor` returns `null` or `sellingPricePaise === null` for unpriced items.
   - When an unpriced medicine is encountered, the billing worker transitions the outbox row:
     ```sql
     UPDATE ipd_emar_integration_outbox
     SET status = 'pending_pricing', claimed_at = NULL, last_error = 'Medicine not priced in hospital catalogue'
     WHERE id = $id;
     ```
   - Because the polling query filters strictly for `status = 'pending'`, unpriced items are **never repeatedly claimed or spammed in a retry loop**.
   - When an administrator prices the item (via catalog save or `billUnbilledEntriesForItemsInTx`), all matching `pending_pricing` rows for that `hospital_id` and `medicine_id` are reset to `status = 'pending', scheduled_for = now()`.

3. **Retry, Exponential Backoff, and Lease Recovery:**
   - **Exponential Backoff:** On transient failure (e.g. database timeout or deadlocks), the worker calculates:
     `backoffSeconds = Math.min(3600, 30 * Math.pow(2, attempts));`
     and reschedules:
     ```sql
     UPDATE ipd_emar_integration_outbox
     SET status = 'pending',
         attempts = attempts + 1,
         scheduled_for = now() + (backoffSeconds || ' seconds')::interval,
         claimed_at = NULL,
         last_error = $error
     WHERE id = $id;
     ```
   - **Exhausted Retries (`failed`):** Maximum attempts is set to 5 (`MAX_ATTEMPTS = 5`). If `attempts >= 5`, the row transitions to `status = 'failed'`, records `last_error`, and logs a high-priority supervisor alert for manual review.
   - **Lease Expiration & Stuck Task Recovery:** Replicating `lib/notify/worker.ts:60-71`, tasks stuck in `processing` past 5 minutes (due to process crash or node restart) are reclaimed at the start of each worker pass:
     ```sql
     UPDATE ipd_emar_integration_outbox
     SET status = 'pending', claimed_at = NULL
     WHERE status = 'processing' AND claimed_at < now() - interval '5 minutes';
     ```

4. **Transactional Downstream Posting & Outbox Completion:**
   - Since `ipd_emar_integration_outbox`, `care_entries`, `bill_items`, and `stock_ledger` share the same PostgreSQL database, downstream execution and outbox status updates execute **inside the exact same database transaction**:
     ```typescript
     await db.transaction(async (tx) => {
       if (task.eventType === 'administer') {
         const billed = await postCareEntryLineInTx(tx, { entry, actorUserId: task.nurseUserId });
         await tx.update(ipdEmarIntegrationOutbox)
           .set({ status: 'processed', processedAt: new Date(), careEntryId: entry.id })
           .where(eq(ipdEmarIntegrationOutbox.id, task.id));
       } else if (task.eventType === 'void') {
         await voidCareEntryLineInTx(tx, { careEntryId: task.careEntryId, actorUserId: task.actorUserId, reason: task.voidReason });
         await tx.update(ipdEmarIntegrationOutbox)
           .set({ status: 'processed', processedAt: new Date() })
           .where(eq(ipdEmarIntegrationOutbox.id, task.id));
       }
     });
     ```
   - If the downstream post throws an error, the entire transaction rolls back, leaving the outbox row available for retry under backoff.
   - Split-brain states (e.g. bill item created without marking outbox, or outbox marked processed without bill item) are mathematically impossible.

5. **Stock Integration Contract (Verified Repository Boundaries):**
   - Verified reality: In `lib/services/stock.ts:43`, stock ledgers and balances exist **strictly for risk-class medicines** (`medicine_risk_classes`, `risk_classes`). Non-risk medicines have no balance ledger.
   - For standard ward generics: the stock worker marks `status = 'skipped'`, `processed_at = now()` with note *"Non-risk formulary item (unmanaged stock)"*.
   - For risk-class medicines (e.g. Schedule H/X narcotics):
     - `administer`: Verifies ward sub-store balance; if available, records movement in `stock_ledger` and marks `status = 'processed'`. If balance is insufficient, flags `status = 'failed'` and alerts the ward supervisor.
     - `void`: Records compensatory return movement in `stock_ledger` (returning unused ampoule/vial to ward inventory) and marks `status = 'processed'`.

6. **Periodic Outbox Reconciliation Sweeper:**
   - A background reconciliation sweeper runs every hour (`lib/services/sweeps.ts`), verifying:
     - No orphan administrations exist without corresponding outbox records.
     - Any outbox records remaining in `pending` or `pending_pricing` older than 24 hours generate a daily billing audit discrepancy digest.

---

## 11. Clinical Order-Set Governance

### 11.1 Version Lifecycle
```
[Draft Order Set] ──(Doctor Authors)──► [Pending Review]
                                                │
                                                ▼ (Designated Lead Approves)
[Deprecated] ◄──(New Version Replaces)── [Approved / Published Active Version]
```

- **Drafting (`draft`):** Clinical staff can assemble and test order sets for common ward admissions (e.g., "Acute Appendicitis Pre-Op", "Type 2 DM Sliding Scale").
- **Clinical Review (`pending_review`):** Order set is submitted to the pharmacy & therapeutics committee or clinical department head.
- **Approval Gate (`approved`):** Only users with `clinical.configure` linked to a `doctors` record can formally approve an order set. Stamped with `approved_by_doctor_id` and `approved_at`.
- **Strict Immutability Enforced by Triggers:** Once `status = 'approved'`, the parent order set and all its child `ipd_order_set_items` are **100% immutable**. Triggers `trg_ipd_order_sets_immutable` and `trg_ipd_order_set_items_immutable` reject any `INSERT`, `UPDATE`, or `DELETE` on approved templates or items. Any changes require creating a clone with `version + 1` in `draft` status.
- **Decommissioning (`deprecated`):** Obsolete templates are marked `deprecated`. They cannot be selected for new patient orders, but past orders retain full historical linkage (`order_set_id`, `order_set_version`).
- **Prescriber Legal Responsibility:** When an order set is applied, it produces editable draft lines. The attending physician must independently review dosages, verify patient weight and allergies, and explicitly sign before orders become actionable.

---

## 12. Service and API Responsibilities

### 12.1 `lib/services/ipd-medication-orders.ts`
- `listActiveOrders({ hospitalId, admissionId })`: Retrieves all active and held orders with their latest administration status, filtering out completed/superseded lines.
- `saveRoundDraft({ hospitalId, admissionId, doctorId, draft })`: Saves work-in-progress round notes and order proposals with optimistic version locking.
- `signRoundOrders({ hospitalId, admissionId, doctorId, signedRound })`: Atomically signs the round note, executes all order resolutions (continue, renew via successor version, modify via successor version, hold, discontinue), creates immutable signed order versions, and records action audit rows in a single database transaction.
- `executeOrderAction({ hospitalId, orderId, action, reason, actorUserId })`: Handles single-order ad-hoc hold, resume, or discontinue events between rounds.
- `voidOrder({ hospitalId, orderId, reason, actorUserId })`: Voids an erroneous order, cancels pending occurrences, inserts action audit row, and alerts nursing staff.

### 12.2 `lib/services/ipd-emar.ts`
- `getBedsideEmar({ hospitalId, admissionId, targetTime })`: Evaluates active orders and returns categorized dose tasks (`dueNow`, `overdue`, `upcoming`, `prn`, `onHold`, `recentHistory`).
- `recordAdministration({ hospitalId, admissionId, orderId, input, actorUserId })`: Validates order active status, acquires advisory lock on `ipd_prn_chain:<uuid>` if PRN, evaluates cross-version cooldown and chart day ceilings, creates administration event, and enqueues outbox integration tasks in the same transaction.
- `recordException({ hospitalId, admissionId, orderId, input, actorUserId })`: Records an omitted, held, or refused dose with mandatory structured reason and clears the due task.
- `voidAdministration({ hospitalId, administrationId, reason, actorUserId })`: Voids an erroneous entry with tamper-evident audit trail, un-indexes the occurrence slot, and dispatches a `void` event to the outbox for billing reversal.
- `correctAdministration({ hospitalId, administrationId, correctedInput, reason, actorUserId })`: Voids the original entry and inserts a linked replacement administration record, dispatching a `correction` outbox event.

---

## 13. Migration Strategy and Data Integrity Constraints

### 13.1 Migration Sequence (`0047_ipd_emar_foundation.sql`)
1. Add explicit ANSI SQL unique constraint to `admissions`:
   ```sql
   ALTER TABLE admissions ADD CONSTRAINT admissions_tenant_encounter_uq
     UNIQUE USING INDEX admissions_tenant_encounter_key;
   ```
2. Create table `ipd_clinical_rounds` with composite FKs referencing `admissions` and `doctors`, signed check constraint, and `ON DELETE RESTRICT`.
3. Create table `ipd_medication_orders` using:
   - `route TEXT NOT NULL CHECK (route IN ('oral', 'iv_push', 'iv_piggyback', 'im', 'sc', 'nebulization', 'topical', 'inhalation', 'sublingual', 'rectal', 'ophthalmic', 'otic'))`.
   - `schedule_type TEXT NOT NULL CHECK (schedule_type IN ('scheduled', 'prn', 'stat'))`.
   - `status TEXT NOT NULL CHECK (status IN ('draft', 'active', 'on_hold', 'discontinued', 'completed', 'superseded', 'voided'))`.
   - Composite FKs to `admissions`, `medicines`, `doctors`, and `ipd_clinical_rounds`.
   - Unique constraints `ipd_med_orders_tenant_key (hospital_id, id)` and `ipd_med_orders_tenant_admission_key (hospital_id, admission_id, id)`.
   - Check constraints for signing, superseded lineage, void reason, PRN indication/limits, and scheduling alignment.
   - `ON DELETE RESTRICT` on all clinical references.
4. Create table `ipd_medication_order_actions` for append-only state transition history (`action IN ('sign', 'hold', 'resume', 'discontinue', 'modify', 'renew', 'expire', 'void')`).
5. Create table `ipd_medication_administrations`:
   - Composite FK `(hospital_id, admission_id, order_id) REFERENCES ipd_medication_orders (hospital_id, admission_id, id) ON DELETE RESTRICT`.
   - Partial unique index on scheduled occurrences `(hospital_id, order_id, scheduled_time) WHERE voided_at IS NULL AND scheduled_time IS NOT NULL`.
   - Cross-version PRN index `(hospital_id, order_chain_id, actual_time) WHERE voided_at IS NULL AND outcome = 'administered'`.
   - Checks separating `actual_time` (administered only) from `decision_time` (non-administered only).
6. Create table `ipd_allergy_assessments`:
   - Composite FK to `admissions`.
   - Partial unique index `(hospital_id, admission_id) WHERE is_current = true`.
   - Check constraint permitting null reviewer for `status = 'unreviewed'`, and requiring reviewer and timestamp for `nkda` and `allergies_documented`.
7. Create tables `ipd_order_sets` and `ipd_order_set_items`:
   - Tenant foreign keys to `medicines` and `doctors`.
   - Route and schedule checks identical to medication orders.
8. Create table `ipd_emar_integration_outbox`:
   - `integration_type IN ('billing', 'stock')`.
   - `event_type IN ('administer', 'void', 'correction')`.
   - `status IN ('pending', 'pending_pricing', 'processing', 'processed', 'failed', 'skipped')`.
   - Composite unique constraint `(hospital_id, administration_id, integration_type, event_type)`.
9. Create PostgreSQL Triggers:
   - `trg_ipd_med_orders_immutable` on `ipd_medication_orders`: Prohibits updates to signed clinical instructions (`medicine_id`, dose, route, schedule, times, duration, prescriber).
   - `trg_ipd_clinical_rounds_immutable` on `ipd_clinical_rounds`: Prohibits updates to evaluation notes once `status = 'signed'`.
   - `trg_ipd_order_actions_append_only` on `ipd_medication_order_actions`: Forbids `UPDATE` and `DELETE`.
   - `trg_ipd_med_admin_void_only` on `ipd_medication_administrations`: Forbids `DELETE`; permits updates strictly to void/correction metadata while locking execution findings.
   - `trg_ipd_order_sets_immutable` & `trg_ipd_order_set_items_immutable`: Forbids mutating approved templates and items.
10. Apply Row-Level Security (RLS) across all 8 tables:
    - `ENABLE ROW LEVEL SECURITY` and `FORCE ROW LEVEL SECURITY`.
    - Tenant isolation: `hospital_id = nullif(current_setting('app.hospital_id', true), '')::uuid` for `USING` and `WITH CHECK`.
    - Restrictive `read_only_write` and `read_only_delete` policies using `NOT public.app_read_only()`.
    - Restrictive `clinical_access` policies using `public.app_clinical_access()` on clinical medical record tables.

---

## 14. Verification and Test Plan

### 14.1 Order Lifecycle & Immutability Tests
- `test_signed_instruction_immutability_trigger`: Direct SQL update attempting to change `dose_amount`, `route`, or `ends_at` on a signed order raises exception `Signed clinical medication instructions are immutable`.
- `test_order_amendment_creates_successor_version`: Modifying an active order creates a new successor row with `supersedes_order_id = old.id`, shared `order_chain_id`, leaves the original row untouched in `superseded` status, and records an action audit row with `action = 'modify'`.
- `test_order_renewal_preserves_immutability`: Renewing an order creates a successor version row with extended `ends_at`; the prior order is marked `superseded` without mutating its `ends_at` in place.
- `test_order_void_lineage`: Voiding an active order requires a mandatory reason (`char_length >= 3`), sets `status = 'voided'`, sets `voided_at` and `voided_by_user_id`, cancels all scheduled doses, and inserts an action audit row with `action = 'void'`.
- `test_signed_round_note_immutability`: Trigger rejects edits to `evaluation_notes` on a signed round note (`status = 'signed'`).
- `test_hold_and_resume_cycle`: Verifies that holding an order sets `status = 'on_hold'` with mandatory reason, clears due tasks on eMAR, and resuming reactivates future scheduled tasks.
- `test_isolated_discontinuation`: Discontinuing one medication does not alter start/end dates or status of other ongoing medications.
- `test_draft_isolation`: Unsigned draft orders are completely invisible to bedside eMAR queries.
- `test_dual_expiry_mechanism`: Order reaching `ends_at` is immediately omitted from eMAR active queries, and subsequent sweeper sets `status = 'completed'` with action `'expire'`.

### 14.2 Scheduling, eMAR & PRN Concurrency Tests
- `test_deterministic_schedule_occurrences`: Verifies that a `BD` order generates tasks precisely at configured hospital times (e.g., 08:00 and 20:00).
- `test_duplicate_dose_prevention_across_clients`: Two separate client requests for the same scheduled dose slot reject the second with a unique constraint violation on `ipd_med_admin_scheduled_occurrence_key`.
- `test_stat_order_single_execution`: Stat order allows exactly one administration and transitions immediately to `completed` in the same transaction.
- `test_prn_chain_advisory_lock`: Concurrent PRN dose requests across devices or order versions serialize via `pg_advisory_xact_lock(hashtext('ipd_prn_chain:' || order_chain_id::text))`.
- `test_prn_cross_version_limits`: Prior administrations on version 1 count toward the cooldown window and chart day daily dose ceiling on version 2 of the same order chain.
- `test_prn_cumulative_quantity_limit`: Reject PRN dose request if cumulative substance amount exceeds `prn_max_daily_quantity` within the chart day, even if dose count is under `prn_max_daily_doses`.
- `test_prn_void_and_correction_exclusion`: Voided administrations (`voided_at IS NOT NULL`) are excluded from PRN cooldown and cumulative limits; corrected administrations count only the active replacement record.
- `test_stale_order_administration_rejection`: If an order is discontinued concurrently while a nurse has the screen open, submitting the dose fails with an order-cancelled error.
- `test_idempotent_administration_retry`: Submitting the same `client_id` twice returns the saved administration record without duplicate entries.

### 14.3 Multi-Tenant, Retention & RLS Security Tests
- `test_cross_hospital_order_tampering`: Asserts that an actor from Hospital A cannot query or sign orders for Hospital B (RLS and service-level rejection).
- `test_app_user_cannot_bypass_rls`: Verifies that `FORCE ROW LEVEL SECURITY` blocks table-owner bypass and queries without `app.hospital_id` return zero rows.
- `test_cross_hospital_medicine_rejection`: Asserts that an order in Hospital A cannot reference a medicine catalogue row from Hospital B (composite FK rejection).
- `test_admission_order_composite_fk_integrity`: Administration with mismatched `admission_id` or `hospital_id` relative to `order_id` is rejected by the database engine.
- `test_order_round_note_composite_fk`: Medication order referencing a round note from a different admission or hospital is rejected by composite FK.
- `test_unlinked_owner_cannot_prescribe`: Asserts that an administrative owner not linked to a `doctors` record cannot sign medication orders.
- `test_nurse_cannot_modify_orders`: Asserts that a user with only `ipd.administer` cannot invoke order signing, holding, or discontinuation.
- `test_retention_policy_prevents_cascades`: Deleting a hospital, patient, admission, or doctor referenced by active or historical medication orders is refused by PostgreSQL engine (`ON DELETE RESTRICT`).
- `test_tamper_resistant_audit_and_admin_triggers`: Direct `UPDATE` or `DELETE` on `ipd_medication_order_actions` is rejected; direct `DELETE` or modification of clinical findings on `ipd_medication_administrations` is rejected.
- `test_order_set_template_immutability`: Direct `UPDATE` or `DELETE` on approved `ipd_order_sets` or child `ipd_order_set_items` is rejected by triggers.

### 14.4 Outbox & Accounting Reliability Tests
- `test_outbox_distinct_event_dispatch`:
  - `administer` event invokes `postCareEntryLineInTx`.
  - `void` event invokes `voidCareEntryLineInTx` and records inventory compensation if risk-stock was deducted.
  - `correction` event atomically reverses old line and posts replacement line.
- `test_unpriced_medicine_moves_to_pending_pricing`: An unpriced formulary medication transitions outbox row to `status = 'pending_pricing'` and is not repeatedly claimed by the worker.
- `test_priced_item_reconciliation_clears_pending_pricing`: When an item is priced in the catalogue, matching `pending_pricing` rows return to `status = 'pending'`.
- `test_outbox_exponential_backoff_and_exhaustion`: Transient errors trigger exponential backoff (`30s`, `60s`, `120s`...); after 5 attempts, transitions to `status = 'failed'` and logs alert.
- `test_outbox_stuck_lease_recovery`: Outbox row stuck in `processing` past 5 minutes is reset to `pending` by the recovery sweep.
- `test_same_tx_posting_and_outbox_completion`: Downstream billing line insertion and outbox status update to `processed` commit atomically in the same database transaction.

### 14.5 Allergy Assessment Tests
- `test_allergy_unreviewed_nullable_reviewer`: Unreviewed assessment permits null `reviewed_by_user_id` and null `reviewed_at`.
- `test_allergy_reviewed_requires_attribution`: Transitioning to `nkda` or `allergies_documented` requires valid reviewer ID and timestamp.
- `test_allergy_revision_history_retention`: Recording a new assessment updates the prior assessment to `is_current = false`, retaining full historical audit records.

---

## 15. Implementation Phases and Acceptance Criteria

| Phase | Deliverables | Verification & Release Gates |
| :--- | :--- | :--- |
| **Phase 1: Database & Domain Foundation** | Migration `0047_ipd_emar_foundation.sql`, Drizzle schema, immutability & audit triggers, RLS policies, pure domain logic for schedule calculations, PRN limits, and order state machine. | Automated tests pass: `vitest run lib/domain/__tests__/ipd-orders.test.ts`. RLS suite passes: `vitest run lib/db/__tests__/ipd-schema.integration.test.ts`. |
| **Phase 2: Service Layer & Integration Tests** | `ipd-medication-orders.ts` and `ipd-emar.ts` services. Downstream billing/stock outbox workers with lease recovery, backoff, and unpriced handling. | Integration tests pass: `vitest run lib/services/__tests__/ipd-emar.integration.test.ts`. Idempotency, cross-version PRN concurrency, and transactional posting validated. |
| **Phase 3: Doctor Rounding Cockpit** | UI components: Vitals freshness bar, allergy banner, active order review list, clinical round note editor, order signing modal. | Doctors can review and sign daily orders without page switching. Unsigned drafts do not leak to eMAR. Renewals produce successor versions. |
| **Phase 4: Bedside Nursing eMAR** | Redesigned `record-screen.tsx`: Due Now, Overdue, PRN tabs, administration verification modal, exception logging modal. Discrete bolus doses only. | Nurses can administer due doses in < 3 taps, log omissions with reasons, and view remaining PRN allowances. Advisory locks prevent duplicate doses. |
| **Phase 5: Order-Set Governance & Catalog** | Order-set approval workflow, template immutability triggers, hospital favorites configuration UI in settings. | Only authorized doctors can publish templates. Approved templates are immutable. Applied templates produce editable draft orders. |
| **Phase 6: Clinical Workflow Pilot & Audit** | In-hospital testing with selected clinical staff. | Pilot metrics evaluated: round completion time, administration discrepancy rate, audit log verification. (Phase 6 also initiates post-MVP ICU & Infusion Session development). |

---

## 16. Categorized Consistency Audit Findings

### 16.1 Verified Repository Facts
1. **Admissions Composite Key:** `admissions` has a verified unique index `admissions_tenant_encounter_key ON admissions (hospital_id, id, encounter_id, patient_id)` (`0032_ipd_core.sql:175`), which supports composite foreign keys.
2. **Missing Allergy Model:** No allergy table or column currently exists in `schema.ts`. `ipd_allergy_assessments` must be created in migration `0047`.
3. **Existing Stock Ledger Boundary:** `lib/services/stock.ts:43` restricts inventory ledgers strictly to risk-class medicines (`medicine_risk_classes`). Non-risk medicines do not have a balance ledger; bedside ward doses for standard generics must not attempt automated FEFO ledger deductions in MVP.
4. **Existing Outbox Pattern:** `lib/notify/worker.ts` establishes the repo pattern for background dispatch: `SELECT ... FOR UPDATE SKIP LOCKED` with `claimed_at` and 5-minute recovery.
5. **Chart Day Boundary:** In `lib/domain/tpr.ts`, the chart day is defined as `08:00` to `08:00`, aligning with nursing shift cycles.
6. **RLS Architecture in Repo:** In `drizzle/0032_ipd_core.sql:420-470`, multi-tenant isolation requires `ENABLE ROW LEVEL SECURITY` and `FORCE ROW LEVEL SECURITY`, checking `hospital_id = nullif(current_setting('app.hospital_id', true), '')::uuid` on `USING` and `WITH CHECK`, combined with restrictive `read_only_write`, `read_only_delete`, and `clinical_access` policies.
7. **Billing Posting Services:** In `lib/services/ipd-billing.ts`, `postCareEntryLineInTx` handles line posting and returns `false` if unpriced; `voidCareEntryLineInTx` strikes through existing lines without deletion.

### 16.2 Proposed Corrections Implemented in this Specification
1. **Signed-Order Immutability & Successor Renewals (P0-1):** Prohibited mutating signed clinical instructions in place; renewed orders explicitly author a successor row (`supersedes_order_id = old.id`, shared `order_chain_id`); protected by trigger `trg_ipd_med_orders_immutable`.
2. **Coherent Void/Entered-in-Error Model (P0-1):** Added `status = 'voided'` to order state constraints, with mandatory `voided_at`, `voided_by_user_id`, and `void_reason`. Cancels pending occurrences and records action `'void'`.
3. **Signed Round Note Immutability (P0-1):** Enforced note locking via trigger `trg_ipd_clinical_rounds_immutable` once `status = 'signed'`.
4. **Admission and Tenant Integrity (P0-2):** Bound administrations strictly to orders via composite foreign key `(hospital_id, admission_id, order_id) REFERENCES ipd_medication_orders (hospital_id, admission_id, id)`. Bound orders to round notes via composite foreign key `(hospital_id, admission_id, round_note_id) REFERENCES ipd_clinical_rounds (hospital_id, admission_id, id)`.
5. **Rigorous RLS Across All Tables (P0-2):** Defined exhaustive RLS policies with `ENABLE` + `FORCE ROW LEVEL SECURITY`, `nullif(current_setting('app.hospital_id', true), '')::uuid`, `read_only_write`, `read_only_delete`, and `clinical_access` for all 8 tables, preventing application role bypass.
6. **Cross-Version PRN Concurrency & Quantity Limits (P0-3):** Linked administrations across versions via `order_chain_id`; serialized concurrent requests via transactional advisory locks `pg_advisory_xact_lock(hashtext('ipd_prn_chain:' || order_chain_id::text))`; distinguished dose event ceiling (`prn_max_daily_doses`) from cumulative substance amount ceiling (`prn_max_daily_quantity`); excluded voided doses and included only active replacements for corrections.
7. **Outbox Reliability & Downstream Atomicity (P0-4):** Added distinct event types (`administer`, `void`, `correction`); handled unpriced items via non-polling `status = 'pending_pricing'`; specified exponential backoff, 5-minute lease recovery, and 5-attempt failure limit; committed downstream posting and outbox updates in the same database transaction.
8. **Explicit Scope Deferral for Continuous Infusions (P0-5):** Bounded MVP eMAR strictly to discrete bolus doses (oral, IV push, IV piggyback, IM, SC, etc.); explicitly deferred complex continuous/fixed-rate IV infusion administration to Phase 6 (`ipd_infusion_sessions`).
9. **Allergy Assessment Model (P1-6):** Permitted null reviewer for initial `unreviewed` state; preserved assessment revisions using `is_current = false` rather than overwriting historical findings.
10. **Schema & Migration Agreement (P1-7):** Aligned routes, schedule types, order statuses, dose fields, and PRN checks across SQL, Drizzle descriptions, and migration sequence `0047`.
11. **Order-Set Template Immutability (P1-8):** Added triggers `trg_ipd_order_sets_immutable` and `trg_ipd_order_set_items_immutable` protecting approved parent templates and items from mutation or deletion.
12. **Tamper-Resistant Audit Tables (P1-9):** Enforced append-only trigger on `ipd_medication_order_actions` and void-only trigger on `ipd_medication_administrations`.
13. **Scheduling Presets vs Clinical Authority (P1-10):** Clarified that `frequency_code` is a UI preset shorthand; signed `schedule_times JSONB` is the sole authoritative clock schedule; hospital defaults never silently substitute for signed clinical instructions.

### 16.3 Unresolved Decisions Requiring Clinical Governance or Product Input
1. **Medication Chart Day vs. Rolling 24-Hour PRN Limits:**
   - *Clinical Policy Decision:* The specification implements the hospital Medication Chart Day (`08:00` to `08:00`) for daily PRN ceilings (e.g. max 4g Paracetamol per chart day). The clinical governance committee must formally approve whether chart day limits or a rolling 24-hour sliding window should be mandated for high-risk analgesics.
2. **Handling of Unpriced Formulary Generics in eMAR Billing:**
   - *Product Decision:* In `lib/services/care-entries.ts`, an unpriced item records a care entry but skips billing until backfilled. The specification adopts `status = 'pending_pricing'` so nurses are never blocked at the bedside. Product leadership should confirm whether billing alerts should be sent to the billing desk when an unpriced medication order is signed.
3. **Home Medication Custody & Nursing Administration Policy:**
   - *Clinical Workflow Decision:* For `patient_supplied = true` orders, the system records administrations without billing. Clinical leadership must decide whether ward nurses are authorized to administer patient-supplied medications directly or if pharmacy chemical identification clearance is mandatory prior to the first dose.
4. **Two-Person Verification for Inpatient Risk-Class Administrations:**
   - *Safety Policy Decision:* `lib/services/stock.ts` requires two distinct users for risk-class adjustments. Hospital clinical governance must decide whether bedside administration of Schedule H/X narcotics requires a second nurse's PIN / credentials to co-sign the eMAR entry.

