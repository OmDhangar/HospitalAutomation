# IPD Doctor Rounding Cockpit & Inpatient Medication Administration (eMAR) Design

**Document ID:** `SPEC-IPD-EMAR-001`  
**Date:** 2026-10-12  
**Status:** In Review (Engineering Specification & Implementation Plan)  
**Target Modules:** `core_ipd`, `patient_file`, `clinical_opd`  
**Target Release:** Next IPD Milestone (Migration 0047+)  

---

## 1. Executive Summary and Status

This document defines the architecture, data models, state machines, user workflows, and phased implementation plan for two tightly coupled inpatient clinical capabilities:
1. **The IPD Doctor Rounding Cockpit:** A single-screen daily rounding interface enabling attending doctors to review patient vitals, nursing intake/output trends, and active treatment lines, conduct explicit clinical medication reviews, and record signed round evaluations.
2. **The Inpatient Electronic Medication Administration Record (eMAR):** A closed-loop, time-oriented nursing interface that separates prescriber authorization (`MedicationRequest`) from bedside execution (`MedicationAdministration`), eliminating guesswork, unauthorized substitutions, and silent renewals.

**Current Document Status:**
- **Validated & Approved:** Core architectural principles (independent order lifecycles, HL7 FHIR order-vs-administration separation, explicit clinical review over silent auto-renewal, hospital governance for order sets).
- **In Review:** Detailed data structures, PostgreSQL schema constraints, scheduling calculations, and multi-system integration boundaries.
- **Implementation State:** Specification and design phase. No code, migrations, or database mutations have been executed.

---

## 2. Problem Statement and Scope

### 2.1 Clinical & Operational Deficiencies
In patient wards across Indian private and charitable hospitals, morning and evening doctor rounds are high-velocity events (15–30 beds, 1–2 minutes per bedside). The current system suffers from four critical deficiencies:
1. **Absence of Inpatient Prescribing:** Prescriptions can only be created within the OPD consultation panel (`consultation-panel.tsx`). Inpatient admissions have zero prescribing interfaces; doctors cannot order, amend, hold, or discontinue medications in IPD.
2. **Context Fragmentation:** To evaluate an admitted patient, clinicians must open multiple unrelated pages: `/ipd/my-patients` (roster), `/ipd/admissions/[id]` (census/billing), `/ipd/admissions/[id]/tpr` (nursing vitals), and ward bed grids. There is no unified clinical rounding overview.
3. **Nursing Administration Guesswork:** In [`RecordScreen`](file:///d:/Projects/HospitalAutomation/components/ipd/record-screen.tsx), bedside nurses must search the hospital's entire raw formulary or tap arbitrary starter generics. The system has zero awareness of what the attending physician actually ordered for that patient.
4. **Order State Collapse & Safety Risks:** Treating inpatient medications as a single daily prescription that supersedes prior slips causes severe clinical hazards: multi-day courses (e.g., 5-day IV antibiotics) disappear when an unrelated medication is adjusted, or discontinued drugs get renewed accidentally. Furthermore, tapping an order chip currently equates to logging an administered dose without verifying patient identity, contraindications, or dose status.

### 2.2 System Scope
- **In Scope (MVP):**
  - Attending doctor rounding cockpit on patient file layout (`/ipd/admissions/[id]/rounds` and `/ipd/my-patients`).
  - Independent lifecycle management for inpatient medication orders (active, held, discontinued, completed).
  - Explicit clinical order review workflow with structured action resolution (continue, renew, modify, hold, discontinue).
  - Time-bucketed bedside nursing eMAR (`Due Now`, `Overdue`, `Upcoming`, `PRN / On-Demand`, `On Hold`, `Recent History`).
  - Multi-step bedside administration verification and exception logging (refused, omitted, withheld).
  - Structured scheduling engine supporting standard Indian clinical frequencies (`OD`, `BD`, `TDS`, `QID`, `SOS`, `Stat`).
  - Hospital-governed, versioned clinical order set engine with mandatory prescriber review.
  - Decoupled, asynchronous accounting boundaries for billing and inventory deduction.
- **Out of Scope (Post-MVP Enhancements):**
  - Real-time continuous infusion drop-rate calculators and syringe-driver telemetry.
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

To anchor this specification strictly in the existing codebase, we distinguish:
- **Verified:** Confirmed by inspecting schema, migrations, and services.
- **Proposed:** Architectural recommendations designed for implementation.
- **Unresolved:** Questions requiring formal hospital policy or clinical governance decisions.

### 4.1 Schema & Data Structures
| Component | Status | Details & Evidence |
| :--- | :--- | :--- |
| `admissions` Table | **Verified** | Defined in `drizzle/0032_ipd_core.sql` and `lib/db/schema.ts:1960`. Foreign keys: `hospital_id`, `id`, `encounter_id`, `patient_id`. Carries `status: 'awaiting_bed' \| 'admitted' \| 'discharge_ready' \| 'discharged' \| 'cancelled'`, `ipd_number`. |
| `prescriptions` Table | **Verified** | Defined in `drizzle/0028_clinical_opd.sql`. Bound to `encounter_id`. Has unique index `prescriptions_one_current_key` where `status = 'final'`. Designed strictly for OPD: a revision marks the previous prescription `superseded`. |
| `prescription_items` Table | **Verified** | Defined in `drizzle/0028_clinical_opd.sql`. Columns: `medicine_id`, `medicine_name`, `strength`, `form`, `dose`, `frequency`, `duration_days`, `route`, `instructions`. Lacks order lifecycle states, scheduled times, or start/stop dates. |
| Inpatient Orders Table | **Proposed** | Dedicated `ipd_medication_orders` table with explicit lifecycle states (`draft`, `active`, `on_hold`, `discontinued`, `completed`), structured schedules, and independent duration tracking. |
| Administration Table | **Proposed** | Dedicated `ipd_medication_administrations` table tracking scheduled times, actual administration times, dose/route, outcomes (`administered`, `omitted`, `refused`, `held`), and nurse attribution. |
| Allergies Table | **Verified** | **Does not exist in the database.** No table or column in `lib/db/schema.ts` tracks patient allergies. |
| Allergies Strategy | **Proposed** | Introduce an encounter-level allergy assessment (`allergy_review_status`: `'unreviewed' \| 'no_known_allergies' \| 'has_allergies'`, with structured allergen lines). |

### 4.2 Services & Clinical Logic
| Area | Status | Details & Evidence |
| :--- | :--- | :--- |
| Inpatient Prescribing | **Verified** | Zero services exist in `lib/services/` for IPD prescribing or rounding orders. |
| TPR Vitals & Trends | **Verified** | Implemented in `lib/services/tpr.ts` and `components/ipd/tpr-chart.tsx`. Exposes `getLatestVitals()` and `getTprDay()`. Hourly readings include temperature, pulse, respiration, BP, SpO2, blood sugar, intake, and output. |
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
| Bedside Billing | **Verified** | In `lib/services/care-entries.ts:195`, every entry calls `postCareEntryLineInTx()` in `ipd-billing.ts`. Immediate row write to `bill_items`. |
| Inventory Stock Ledger | **Verified** | In `lib/services/stock.ts`, only risk-class medications participate in the strict balance ledger (`stock_balances`). General pharmacy stock is not deducted per bedside syringe. |
| Accounting Decoupling | **Proposed** | Medication administration writes a clinical record first. Billing charges and inventory deductions are processed as downstream events using the idempotent `client_id` pattern. |

---

## 5. Data Model and Schema Specification

### 5.1 The Order Versioning Model: Immutable Versioned Orders
To prevent clinical history overwrites while maintaining referential integrity across amendments, we adopt **Immutable Signed Order Versions linked by Replacement References**:
- Each clinical adjustment generates a new row in `ipd_medication_orders`.
- The stable identity of a medication across multiple dosage changes is tracked by `order_chain_id` (a UUID generated on the first version and copied to successors).
- When a doctor modifies a dose, the prior order row transitions to `status = 'superseded'` and sets `superseded_by_order_id`. The new row sets `supersedes_order_id`.
- Administration events point directly to the specific `order_id` in effect at the time of execution, preserving a perfect audit trail.

```
[Order Version 1: 500mg] -- (modified on Day 2) --> [Order Version 2: 650mg]
      ^                                                   ^
      |                                                   |
[Admin Record: Day 1, 08:00]                        [Admin Record: Day 2, 14:00]
(Points to Version 1)                              (Points to Version 2)
```

### 5.2 Table Schemas (PostgreSQL / Drizzle)

#### A. Table: `ipd_medication_orders`
```sql
CREATE TABLE ipd_medication_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  admission_id UUID NOT NULL,
  encounter_id UUID NOT NULL,
  patient_id UUID NOT NULL,
  order_chain_id UUID NOT NULL,                       -- Stable ID across dose amendments
  
  -- Clinical Substance Identity
  medicine_id UUID NOT NULL REFERENCES medicines(id),
  medicine_name TEXT NOT NULL,                        -- Preserved display label at signing
  strength TEXT,                                      -- e.g. "500 mg"
  form TEXT,                                          -- e.g. "tablet", "injection"
  
  -- Structured Dosage & Route
  dose_amount NUMERIC(8, 2) NOT NULL,                 -- e.g. 1.0, 500.0
  dose_unit TEXT NOT NULL,                            -- e.g. "tablet", "mg", "ml", "vial"
  route TEXT NOT NULL,                                -- "oral", "iv", "im", "sc", "nebulization", "topical"
  
  -- Structured Schedule & Timing
  schedule_type TEXT NOT NULL CHECK (schedule_type IN ('scheduled', 'prn', 'stat', 'continuous')),
  frequency_code TEXT,                                -- e.g. "OD", "BD", "TDS", "QID"
  schedule_times JSONB NOT NULL DEFAULT '[]'::jsonb,  -- Array of "HH:MM" e.g. ["08:00", "20:00"]
  is_prn BOOLEAN NOT NULL DEFAULT false,
  prn_indication TEXT,                                -- Required if is_prn is true
  prn_max_daily_doses SMALLINT,                       -- Ceiling per 24 hours
  prn_min_interval_hours SMALLINT,                    -- Minimum spacing between PRN doses
  special_instructions TEXT,                          -- e.g. "Before food", "Infuse in 100ml NS over 30 mins"
  
  -- Course Lifespan
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ,                                -- Calculated: starts_at + duration_days or explicit stop
  duration_days SMALLINT CHECK (duration_days IS NULL OR duration_days BETWEEN 1 AND 365),
  
  -- Order Lifecycle State
  status TEXT NOT NULL CHECK (status IN ('draft', 'active', 'on_hold', 'discontinued', 'completed', 'superseded')),
  
  -- Modification & Lineage
  supersedes_order_id UUID REFERENCES ipd_medication_orders(id),
  superseded_by_order_id UUID REFERENCES ipd_medication_orders(id),
  order_set_id UUID,                                  -- Source order-set if generated from template
  order_set_version INTEGER,
  
  -- Attribution & Signing
  prescriber_doctor_id UUID NOT NULL REFERENCES doctors(id),
  created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  signed_at TIMESTAMPTZ,                              -- NULL while in draft status
  round_note_id UUID,                                 -- Linked daily evaluation note
  
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  
  CONSTRAINT ipd_med_orders_tenant_fk FOREIGN KEY (hospital_id, admission_id, encounter_id, patient_id)
    REFERENCES admissions (hospital_id, id, encounter_id, patient_id) ON DELETE CASCADE
);

CREATE INDEX ipd_med_orders_active_idx ON ipd_medication_orders (hospital_id, admission_id, status)
  WHERE status IN ('active', 'on_hold');
CREATE INDEX ipd_med_orders_chain_idx ON ipd_medication_orders (hospital_id, order_chain_id);
```

#### B. Table: `ipd_medication_order_actions` (Audit & State History)
Captures explicit hold, resume, discontinue, and correction events:
```sql
CREATE TABLE ipd_medication_order_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  order_id UUID NOT NULL REFERENCES ipd_medication_orders(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('sign', 'hold', 'resume', 'discontinue', 'modify')),
  reason TEXT,                                        -- Mandatory for hold, discontinue, and modify
  actor_user_id UUID NOT NULL REFERENCES users(id),
  doctor_id UUID REFERENCES doctors(id),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

#### C. Table: `ipd_medication_administrations` (eMAR Event Log)
```sql
CREATE TABLE ipd_medication_administrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  admission_id UUID NOT NULL,
  order_id UUID NOT NULL REFERENCES ipd_medication_orders(id),
  client_id UUID NOT NULL,                            -- Offline deduplication & idempotency key
  
  -- Temporal Semantics
  scheduled_time TIMESTAMPTZ,                         -- Scheduled slot (NULL for PRN / Stat)
  actual_time TIMESTAMPTZ NOT NULL,                   -- When drug was administered or decision made
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),     -- When row was committed
  
  -- Outcome & Clinical Findings
  outcome TEXT NOT NULL CHECK (outcome IN ('administered', 'omitted', 'refused', 'held', 'cancelled')),
  dose_given TEXT,                                    -- Verified dose (e.g. "500 mg")
  route_given TEXT,                                   -- Verified route
  non_admin_reason TEXT,                              -- Required when outcome != 'administered'
  clinical_note TEXT,                                 -- e.g. "Site: Left forearm, cannula patent"
  
  -- Attribution & Device Context
  nurse_user_id UUID NOT NULL REFERENCES users(id),
  recorded_channel TEXT CHECK (recorded_channel IN ('personal', 'ward_device')),
  recorded_device_id TEXT,
  
  -- Void & Error Correction
  voided_at TIMESTAMPTZ,
  voided_by_user_id UUID REFERENCES users(id),
  void_reason TEXT,
  
  -- Downstream Integration Traceability
  care_entry_id UUID,                                 -- Linked billing/care record if billed
  stock_ledger_id UUID,                               -- Linked inventory transaction if deducted
  
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  
  CONSTRAINT ipd_med_admin_tenant_key UNIQUE (hospital_id, id),
  CONSTRAINT ipd_med_admin_client_key UNIQUE (hospital_id, client_id),
  CONSTRAINT ipd_med_admin_void_chk CHECK ((voided_at IS NULL) = (void_reason IS NULL)),
  CONSTRAINT ipd_med_admin_non_admin_chk CHECK (
    (outcome = 'administered' AND non_admin_reason IS NULL) OR
    (outcome != 'administered' AND non_admin_reason IS NOT NULL)
  )
);

CREATE INDEX ipd_med_admin_admission_time_idx ON ipd_medication_administrations 
  (hospital_id, admission_id, actual_time) WHERE voided_at IS NULL;
CREATE INDEX ipd_med_admin_order_scheduled_idx ON ipd_medication_administrations 
  (hospital_id, order_id, scheduled_time) WHERE voided_at IS NULL;
```

#### D. Table: `ipd_clinical_rounds`
```sql
CREATE TABLE ipd_clinical_rounds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  admission_id UUID NOT NULL,
  encounter_id UUID NOT NULL,
  doctor_id UUID NOT NULL REFERENCES doctors(id),
  author_user_id UUID NOT NULL REFERENCES users(id),
  evaluation_notes TEXT NOT NULL,                     -- Subjective/Objective notes, assessment
  status TEXT NOT NULL CHECK (status IN ('draft', 'signed')),
  signed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

#### E. Tables: `ipd_order_sets` & `ipd_order_set_items`
```sql
CREATE TABLE ipd_order_sets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL,                             -- e.g. "Surgical", "Medical", "ICU"
  description TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL CHECK (status IN ('draft', 'approved', 'deprecated')),
  approved_by_doctor_id UUID REFERENCES doctors(id),
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ipd_order_sets_hospital_code_ver UNIQUE (hospital_id, code, version)
);

CREATE TABLE ipd_order_set_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_set_id UUID NOT NULL REFERENCES ipd_order_sets(id) ON DELETE CASCADE,
  medicine_id UUID NOT NULL REFERENCES medicines(id),
  default_dose_amount NUMERIC(8, 2) NOT NULL,
  default_dose_unit TEXT NOT NULL,
  default_route TEXT NOT NULL,
  default_schedule_type TEXT NOT NULL,
  default_frequency_code TEXT,
  default_duration_days SMALLINT,
  default_instructions TEXT,
  sort_order SMALLINT NOT NULL DEFAULT 0
);
```

---

## 6. Order and Administration State-Transition Models

### 6.1 Medication Order State Transitions
```
               ┌──────────┐
               │  Draft   │
               └────┬─────┘
                    │ Sign & Authorize
                    ▼
       ┌───────► Active ◄──────┐
       │           │   ▲       │
Resume │      Hold │   │       │ Renew / Extend
       │           ▼   │       │
       │        On Hold ───────┤
       │           │           │
       │Discontinue│Discontinue│
       │           ▼           ▼
       │      Discontinued  Completed (Duration elapsed)
       │           │
       └───────────┴───► Superseded (Replaced by modified order version)
```

**Permitted Transitions:**
1. `draft -> active`: Doctor signs the round. `signed_at` is stamped; order becomes visible on eMAR.
2. `draft -> deleted`: Draft deleted prior to signing; discarded with zero clinical impact.
3. `active -> on_hold`: Temporary suspension. Requires mandatory clinical reason (e.g., "NPO for laparoscopy"). Dose tasks during hold window become non-actionable.
4. `on_hold -> active`: Clinician resumes order with mandatory rationale. Dose tasks resume from next scheduled occurrence.
5. `active -> discontinued` / `on_hold -> discontinued`: Permanent early termination. Requires mandatory reason. Outstanding dose tasks are immediately cancelled.
6. `active -> completed`: Automatically or clinically derived when `now() >= ends_at` and duration has elapsed.
7. `active -> superseded`: Order modified (e.g. dose adjustment). Old order version marked superseded; new version created with link.

### 6.2 Administration Event State Model
```
[Scheduled Dose Task Generated]
         │
         ├──► Nurse selects task & verifies patient
         │         │
         │         ├── [Administered] ──► Confirmed actual dose, time, route ──► Trigger billing/stock
         │         │
         │         └── [Non-Administered]
         │                  ├── Omitted (e.g. NPO, fasting, off-ward)
         │                  ├── Refused (patient refusal documented)
         │                  └── Held (clinical hold e.g. pulse < 60)
         │
         └── [Order Modified / Discontinued] ──► Task auto-cancelled
```

**Correction & Voiding Rules:**
- Completed administration records cannot be edited in place.
- If an entry was made in error (e.g. wrong patient selected, wrong dose typed), the authorized nurse or supervisor invokes **Void / Strike Through**:
  - Sets `voided_at`, `voided_by_user_id`, and mandatory `void_reason`.
  - Reverses any linked billing entry (`bill_items`) via the existing billing credit/void mechanism.
  - A corrected administration entry can then be filed referencing the voided record.

---

## 7. Medication Scheduling Semantics

### 7.1 Frequency Abbreviation vs. Governed Hospital Presets
Abbreviations (`OD`, `BD`, etc.) are clinical communication shorthand. The system maps them to **Hospital-Governed Schedule Presets**:
| Frequency Code | Standard Clinical Meaning | Governed Default Times | Notes |
| :--- | :--- | :--- | :--- |
| `Stat` | Immediate, single dose | Instant execution | Auto-completes upon single administration |
| `OD` | Once daily | `["08:00"]` | Morning round |
| `BD` | Twice daily (12h spacing) | `["08:00", "20:00"]` | Standard ward shift alignment |
| `TDS` | Thrice daily (8h spacing) | `["06:00", "14:00", "22:00"]` | Nursing medication round times |
| `QID` | Four times daily (6h spacing) | `["06:00", "12:00", "18:00", "24:00"]` | Antibiotic spacing |
| `SOS` / `PRN` | As needed | Variable / On Demand | Subject to minimum intervals & daily limits |

*Governance Rule:* The system shall not hardcode universal clock times in application files. Default times are loaded from hospital branch configuration, with clinician review available at prescribing time.

### 7.2 Course Duration & Boundary Calculations
- `starts_at`: Defaults to the signing timestamp, or an explicitly designated start date/hour.
- `duration_days`: Integer number of treatment days.
- `ends_at`: Calculated deterministically: `starts_at + (duration_days * 24 hours)`.
- If a conflict arises between `ends_at` and `duration_days`, `duration_days` is authoritative during prescribing; `ends_at` is computed on commit.
- Timezone: All schedules are evaluated in the hospital's local timezone (`hospitals.timezone`, e.g. `Asia/Kolkata`). Indian Standard Time has no daylight saving shifts.

### 7.3 Administration Windows & Overdue Logic
- **Due Window:** An order is classified as `Due Now` within a configurable window (hospital default: `[scheduled_time - 60 min, scheduled_time + 60 min]`).
- **Overdue Threshold:** If `now() > scheduled_time + 60 min` and no administration or non-administration outcome has been filed, the task moves to `Overdue`.
- *Clinical Safety Constraint:* The `Overdue` flag is a visual clinical warning for immediate attention. It **does not** automatically authorize administration if the safe interval has elapsed.

### 7.4 PRN (As-Needed) Calculation Contract
For orders where `is_prn = true`:
1. **Clinical Indication Check:** Order must display mandatory `prn_indication` (e.g. *"Temperature > 101°F"*).
2. **Spacing Constraint:** `now() - last_administered_at >= prn_min_interval_hours`. If the interval has not elapsed, the administration button is disabled and displays a remaining cooldown timer.
3. **Daily Ceiling Constraint:** Counts non-voided administrations within the current 24-hour chart day (08:00 to 08:00). If `count >= prn_max_daily_doses`, administration is blocked and prompts attending doctor review.

---

## 8. Doctor and Nurse User Workflows

### 8.1 Attending Doctor Rounding Workflow
```
[Doctor opens /ipd/my-patients or patient file]
       │
       ▼
[1. Review Clinical Context]
   • Patient identity (Name, UHID, IPD No., Bed)
   • Allergy review status (NKDA vs specific drug allergies)
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
   • Option A: Select approved hospital Order Set (e.g. Post-Op Protocol) -> Draft lines populated
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
       - System checks order active status -> Records administration -> Fires billing/stock
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

### 9.2 Multi-Tenant Integrity & Concurrency Control
- **Tenant Isolation:** Every query and insert executes within `withTenant(hospitalId, ...)` using PostgreSQL Row-Level Security (`app_user` cannot bypass RLS).
- **Referential Integrity Constraints:** All foreign keys assert composite tenant matching: `(hospital_id, admission_id, encounter_id, patient_id)`. Cross-hospital references are impossible.
- **Optimistic Concurrency Control:**
  - Round notes and order drafts carry an integer `version`. If two doctors open the same patient round, the second commit fails with `409 Conflict` rather than overwriting changes.
  - Administration execution checks `status = 'active'` at commit time. If a doctor discontinued an order while a nurse had the modal open, the server rejects the administration: *"Order was discontinued by Dr. [Name] at [Time]"*.

---

## 10. Inventory and Billing Integration Boundaries

```
[Clinical Administration Committed]
       │
       ▼ (Database Transaction Commit)
[Event Published: emar.dose_administered]
       │
       ├──► [Billing Service Worker]
       │      • Checks if item is billable
       │      • Generates care_entries / bill_items row with client_id idempotency
       │      • On failure: Retries via outbox; clinical record remains untouched
       │
       └──► [Stock Inventory Service Worker]
              • Checks if medicine is tracked in risk-class stock
              • If tracked: deducts batch using FEFO from ward location
              • On failure: Flags inventory variance without blocking clinical care
```

### Integration Rules:
1. **Decoupled Transactions:** A nurse must never be blocked from recording a lifesaving medication administration because the pharmacy software is calculating batch costs or an accounting balance is locked. The clinical record is saved first.
2. **Idempotency:** Downstream billing and stock deduction use the administration's `client_id` as their idempotency key. Retrying an outbox event will never bill a patient twice or deduct stock twice.
3. **Non-Administrations:** When an outcome is `omitted`, `refused`, or `held`, no bill line is generated, and zero stock is deducted.
4. **Wastage & Partial Doses:** If half a vial is administered and half is wasted (e.g. pediatric dosing), the clinical record reflects actual dose given (e.g. 250mg), while the billing/inventory rule handles the whole unit (1 vial) with an explicit wastage notation.
5. **Patient-Supplied Medications:** If a patient brought their own medication from home, the order is marked `patient_supplied = true`. Administrations are logged in the eMAR for clinical safety, but billing charge generation is skipped.

---

## 11. Clinical Order-Set Governance

### 11.1 Version Lifecycle
```
[Draft Order Set] ──(Doctor Authors)──► [Submitted for Review]
                                                │
                                                ▼ (Designated Lead Approves)
[Deprecated] ◄──(New Version Replaces)── [Published Active Version]
```
- **Drafting:** Clinical staff can propose order sets for common conditions.
- **Approval Gate:** Only designated medical directors or department heads (`clinical.configure`) can formally approve an order set.
- **Immutability:** Once published, an order set version is completely immutable. Modifying an order set creates `version + 1`.
- **Traceability:** When a doctor applies an order set, the resulting draft orders retain `order_set_id` and `order_set_version` for quality audits.
- **Prescriber Responsibility:** The application UI clearly displays: *"Order sets are clinical proposals. The attending physician must verify dosing, contraindications, and patient weight before signing."*

---

## 12. Service and API Responsibilities

### 12.1 `lib/services/ipd-medication-orders.ts`
- `listActiveOrders({ hospitalId, admissionId })`: Retrieves all active and held orders with their latest administration status.
- `saveRoundDraft({ hospitalId, admissionId, doctorId, draft })`: Saves work-in-progress round notes and order proposals.
- `signRoundOrders({ hospitalId, admissionId, doctorId, signedRound })`: Atomically signs the round note, executes all order resolutions (continue, renew, modify, hold, discontinue), and creates immutable signed order versions.
- `executeOrderAction({ hospitalId, orderId, action, reason, actorUserId })`: Handles single-order ad-hoc hold, resume, or discontinue events between rounds.

### 12.2 `lib/services/ipd-emar.ts`
- `getBedsideEmar({ hospitalId, admissionId, targetTime })`: Evaluates active orders and returns categorized dose tasks (`dueNow`, `overdue`, `upcoming`, `prn`, `onHold`, `recentHistory`).
- `recordAdministration({ hospitalId, admissionId, orderId, input, actorUserId })`: Validates order state, creates administration event, and schedules downstream billing/stock dispatch.
- `voidAdministration({ hospitalId, administrationId, reason, actorUserId })`: Voids an erroneous entry with tamper-evident audit trail and initiates financial reconciliation.

---

## 13. Migration Strategy and Data Integrity Constraints

### 13.1 Migration Sequence (`0047_ipd_emar_foundation.sql`)
1. Create enums: `ipd_order_status`, `ipd_schedule_type`, `ipd_admin_outcome`, `ipd_order_set_status`.
2. Create table `ipd_clinical_rounds`.
3. Create table `ipd_medication_orders` with foreign keys to `hospitals`, `admissions`, `doctors`, `medicines`.
4. Create table `ipd_medication_order_actions` for audit tracking.
5. Create table `ipd_medication_administrations` with foreign keys and idempotency constraints.
6. Create tables `ipd_order_sets` and `ipd_order_set_items`.
7. Add RLS policies asserting tenant isolation (`hospital_id = current_setting('app.current_hospital_id')`).
8. Add trigger ensuring `ipd_medication_administrations` cannot be deleted or updated in place (void-only).

---

## 14. Verification and Test Plan

### 14.1 Order Lifecycle & Immutability Tests
- `test_order_amendment_preserves_history`: Modifying an order creates a new row with `supersedes_order_id`, leaving the original order unchanged and marked `superseded`.
- `test_hold_and_resume_cycle`: Verifies that holding an order sets `status = 'on_hold'` with reason, clears due tasks on eMAR, and resuming reactivates future scheduled tasks.
- `test_isolated_discontinuation`: Discontinuing one medication does not alter start/end dates or status of other ongoing medications.
- `test_draft_isolation`: Unsigned draft orders are completely invisible to bedside eMAR queries.

### 14.2 Scheduling & eMAR Task Generation Tests
- `test_deterministic_schedule_occurrences`: Verifies that a `BD` order generates tasks precisely at configured hospital times (e.g., 08:00 and 20:00).
- `test_prn_frequency_and_daily_limits`: Verifies that a PRN order blocks administration if minimum interval (e.g. 4h) has not elapsed or daily ceiling is reached.
- `test_stale_order_administration_rejection`: If an order is discontinued concurrently while a nurse has the screen open, submitting the dose fails with an order-cancelled error.
- `test_idempotent_administration_retry`: Submitting the same `client_id` twice returns the saved administration record without duplicate entries.

### 14.3 Multi-Tenant & Security Tests
- `test_cross_hospital_order_tampering`: Asserts that an actor from Hospital A cannot query or sign orders for Hospital B (RLS and service-level rejection).
- `test_unlinked_owner_cannot_prescribe`: Asserts that an administrative owner not linked to a `doctors` record cannot sign medication orders.
- `test_nurse_cannot_modify_orders`: Asserts that a user with only `ipd.administer` cannot invoke order signing, holding, or discontinuation.

### 14.4 End-to-End Clinical Flow Integration Tests
- `test_full_round_to_bedside_administration_cycle`:
  1. Doctor conducts round, reviews vitals, orders IV Ceftriaxone 1g BD for 5 days, signs round.
  2. Nurse opens Bedside eMAR: Ceftriaxone appears in `Due Now`.
  3. Nurse administers dose, confirms.
  4. Administration appears in `Recent History`; Ceftriaxone scheduled for 20:00 moves to `Upcoming`.
  5. Linked billing line is verified.

---

## 15. Implementation Phases and Acceptance Criteria

| Phase | Deliverables | Verification & Release Gates |
| :--- | :--- | :--- |
| **Phase 1: Database & Domain Foundation** | Migration `0047_ipd_emar_foundation.sql`, Drizzle schema, pure domain logic for schedule calculations and order state machine. | Automated tests pass: `vitest run lib/domain/__tests__/ipd-orders.test.ts`. RLS suite passes. |
| **Phase 2: Service Layer & Integration Tests** | `ipd-medication-orders.ts` and `ipd-emar.ts` services. Downstream billing/stock hooks. | Integration tests pass: `vitest run lib/services/__tests__/ipd-emar.integration.test.ts`. Idempotency and concurrency validated. |
| **Phase 3: Doctor Rounding Cockpit** | UI components: Vitals freshness bar, active order review list, clinical round note editor, order signing modal. | Doctors can review and sign daily orders without page switching. Unsigned drafts do not leak to eMAR. |
| **Phase 4: Bedside Nursing eMAR** | Redesigned `record-screen.tsx`: Due Now, Overdue, PRN tabs, administration verification modal, exception logging modal. | Nurses can administer due doses in < 3 taps, log omissions with reasons, and view remaining PRN allowances. |
| **Phase 5: Order-Set Governance & Catalog** | Order-set approval workflow, hospital favorites configuration UI in settings. | Only authorized doctors can publish templates. Applied templates produce editable draft orders. |
| **Phase 6: Clinical Workflow Pilot & Audit** | In-hospital testing with selected clinical staff. | Pilot metrics evaluated: round completion time, administration discrepancy rate, audit log verification. |

---

## 16. Explicit Unresolved Questions and Clinical Assumptions

1. **Allergy Review Model (Clinical Decision):**
   - *Question:* Should allergy review be an admission-level checklist (e.g. NKDA vs specific drug classes: Penicillins, Cephalosporins, NSAIDs) or a fully normalized multi-substance charting module?
   - *Default Proposal for MVP:* Admission-level structured allergy capture (NKDA confirmation or documented specific drug allergy tags) with high-contrast display in the cockpit and eMAR.
2. **Medication Reconciliation on Admission:**
   - *Question:* How should chronic home medications brought in by the patient be segregated from acute hospital inpatient orders?
   - *Default Proposal for MVP:* Orders carry an optional `origin: 'home_medication' | 'inpatient_order'` tag and `patient_supplied: boolean` flag to prevent erroneous billing.
3. **Continuous IV Infusions:**
   - *Question:* Are complex continuous titrations (e.g. Dopamine, Noradrenaline mcg/kg/min) required for general ward MVP, or limited to bolus/fixed infusions (e.g. 500ml NS over 4 hours)?
   - *Default Proposal for MVP:* General ward bolus and fixed-rate IV fluids supported first; complex titration protocols deferred to an ICU expansion phase.
