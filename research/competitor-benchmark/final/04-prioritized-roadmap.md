# Prioritized Engineering Roadmap (30-60-90 Days)

**Document Title:** Product Action Plan & Engineering Implementation Specifications  
**Deliverable Path:** `/research/competitor-benchmark/final/04-prioritized-roadmap.md`  
**Evaluation Date:** November 2026  
**Auditor:** Healthcare SaaS Product Analyst, Software Reverse Engineer & Product Architect  

---

## 1. Prioritization Framework & Methodology

To ensure that development effort translates directly into measurable hospital revenue, clinical safety, and system reliability, all recommendations are classified using a strict 4-tier rubric:

- **P0 (Critical Reliability, Security, Correctness, or Essential Revenue Workflows):** Must be fixed immediately. Blocks production stability, loses critical hospital revenue, or causes data corruption.
- **P1 (High-Impact Operational Improvements):** High-ROI capabilities that mid-sized hospitals actively require to sign commercial contracts.
- **P2 (Usability, Automation, Reporting & Prescribing Speed):** Features that dramatically reduce doctor/staff cognitive load and elevate product delight.
- **P3 (Future Opportunities & Advanced Capabilities):** Strategic differentiators and national ecosystem integrations.

```
┌───────────────────────────────────────────────────────────────────────────┐
│                      ROADMAP PHASE DISTRIBUTION                           │
│                                                                           │
│   PHASE 1: NEXT 30 DAYS (Foundational Integrity & Core Revenue Capture)   │
│   ► P0.1: Clean Database Migrations & Resolve Journal Syntax Corruption   │
│   ► P0.2: Implement Outpatient Retail Pharmacy POS Module                │
│   ► P0.3: Fix OPD-to-IPD Medication Order Porting & Continuity           │
│   ► P1.1: Pre-Bundled "Rx-Groups" for Sub-30-Second Prescribing           │
│                                                                           │
│   PHASE 2: NEXT 60 DAYS (Clinical Depth, Payer Tariffs & Interop M1)      │
│   ► P1.2: Parameter-Wise Laboratory Result Entry & Normal Ranges         │
│   ► P1.3: ABDM Milestone 1 (M1) Scan & Share QR Counter Check-In         │
│   ► P1.4: Multi-Tier Tariff Rate Plans (Cash vs TPA vs Corporate)        │
│   ► P2.1: Vernacular Prescription Printing (Hindi & Marathi Directions)  │
│                                                                           │
│   PHASE 3: NEXT 90 DAYS (Practice Intelligence, DDI & Payouts Engine)     │
│   ► P1.5: Consultant Doctor Revenue-Share & Procedure Split Engine       │
│   ► P2.2: Specialty Consultation Presets (Pediatrics & Diabetology)       │
│   ► P2.3: Offline Curated Drug-to-Drug Interaction (DDI) Safety Engine   │
│   ► P2.4: FHIR R4 Serialization & NRCES Conformance Gateway              │
│   ► P3.1: Browser Web Speech API Hands-Free Dictation Prototype          │
└───────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Detailed Technical Specifications for Roadmap Items

### Item P0.1: Fix Migration Journal Syntax Error & Resolve Orphaned Migrations
- **Problem:** [`drizzle/meta/_journal.json`](file:///d:/Projects/HospitalAutomation/drizzle/meta/_journal.json) has invalid trailing characters after line 405, breaking automated migrations and CI test suites. Tables from migrations `0047`–`0053` (`test_orders`, `treatment_orders`, `ipd_notes`) are orphaned, and `ipd_discharge_clearances` exists in the DB without a migration.
- **Proposed Solution:** Sanitize `_journal.json`, generate a clean migration for `ipd_discharge_clearances`, and formally reconcile or deprecate orphaned Track B migrations.
- **Competitor Reference:** Internal baseline architectural integrity.
- **Why Worth Implementing:** Restores CI/CD automation, prevents runtime database crashes, and ensures repeatable staging/production deployments.
- **Frontend Changes:** None.
- **Backend Changes:** Re-run `npm run db:generate` and ensure `drizzle-kit migrate` executes cleanly.
- **Database Implications:** Zero data loss; aligns schema files with PostgreSQL catalog.
- **Integrations & Dependencies:** Drizzle ORM, Node test runner.
- **Implementation Complexity:** **Low** (1–2 days).
- **Acceptance Criteria:** `npm test` passes `lint.test.ts` and `plan.test.ts` with 0 migration errors.
- **Success Metric:** 100% automated CI build pass rate.

---

### Item P0.2: Outpatient Retail Pharmacy POS Module
- **Problem:** Qurio doctors write digital prescriptions, but the hospital cannot dispense or bill them at the pharmacy counter. 100% of retail pharmaceutical revenue (40–50% of hospital profit) leaks to outside chemists.
- **Proposed Solution:** Build a dedicated `/pharmacy` dispensing queue where pharmacists can lookup doctor prescriptions by token or phone, select batch numbers, substitute generic equivalents, collect cash/UPI, and print retail GST pharmacy receipts.
- **Competitor Reference:** **Practo Insta HMS** ([`EVD-INSTA-013`](file:///d:/Projects/HospitalAutomation/research/competitor-benchmark/evidence-register.csv)).
- **Why Worth Implementing:** Eliminates the #1 reason hospital owners reject Qurio. Directly unlocks massive high-margin revenue for the hospital.
- **Frontend Changes:**
  - Create `app/(app)/pharmacy/page.tsx` (Queue of unfulfilled prescriptions).
  - Create `components/pharmacy/dispense-modal.tsx` (Medicine picker, batch selector, quantity, unit price, GST rate).
  - Add `app/print/pharmacy-bill/[id]/page.tsx` (Compliant thermal/A4 pharmacy receipt).
- **Backend Changes:**
  - Add `pharmacist` to `STAFF_ROLES` in [`lib/domain/permissions.ts`](file:///d:/Projects/HospitalAutomation/lib/domain/permissions.ts).
  - Create `lib/services/pharmacy.ts` (`fulfillPrescription`, `createDirectPharmacySale`).
- **Database Implications:**
  - Add `pharmacy_orders` and `pharmacy_order_items` tables to [`lib/db/schema.ts`](file:///d:/Projects/HospitalAutomation/lib/db/schema.ts).
  - Link fulfilled orders to central interim billing ledger.
- **Integrations & Dependencies:** Receipt thermal printing, central billing ledger.
- **Implementation Complexity:** **Medium** (5–7 days).
- **Acceptance Criteria:** Pharmacist can search patient token, view prescribed drugs, click "Dispense All", collect payment, and issue printed bill.
- **Success Metric:** Hospital captures >80% of outpatient prescription-to-pharmacy dispensing.

---

### Item P0.3: OPD-to-IPD Medication Order Porting & Clinical Continuity
- **Problem:** Shifting an OPD patient to the IPD ward queues the patient, but completely drops all outpatient prescriptions. Admitting nurses must re-type all medications manually.
- **Proposed Solution:** When `shiftToIpdAction` executes, automatically convert active OPD `prescription_items` into draft `treatment_orders` for the ward, requiring only 1 click by the admitting doctor to confirm.
- **Competitor Reference:** **Practo Insta HMS** ([`EVD-INSTA-006`](file:///d:/Projects/HospitalAutomation/research/competitor-benchmark/evidence-register.csv)).
- **Why Worth Implementing:** Eliminates medical transcription errors during admission and saves doctors 5–10 minutes per admission.
- **Frontend Changes:**
  - Update `components/ipd/bedside/bedside-treatment-chart.tsx` to display an "Imported from OPD Consultation" banner over unconfirmed medication orders.
- **Backend Changes:**
  - Enhance `lib/services/ipd-admissions.ts:admitPatient` to query active `prescription_items` from the latest consultation and insert corresponding rows into `treatment_orders`.
- **Database Implications:** Ensure foreign key linkages between OPD `consultations` and `ipd_admissions`.
- **Integrations & Dependencies:** Inpatient eMAR treatment chart.
- **Implementation Complexity:** **Low** (2–3 days).
- **Acceptance Criteria:** Admitting a patient with 3 OPD drugs automatically creates 3 draft orders on their bedside treatment chart.
- **Success Metric:** Zero medication omissions during inpatient ward intake.

---

### Item P1.1: Pre-Bundled "Rx-Groups" for Sub-30-Second Prescribing
- **Problem:** Searching and configuring each medication individually slows down consultations and causes doctor fatigue.
- **Proposed Solution:** Enable doctors to create personal or institutional "Rx-Groups" (multi-drug bundles). Selecting an Rx-Group immediately populates all included medications with preset doses, frequencies, and durations.
- **Competitor Reference:** **HealthPlix EMR** ([`EVD-HPLX-005`](file:///d:/Projects/HospitalAutomation/research/competitor-benchmark/evidence-register.csv)).
- **Why Worth Implementing:** Cuts prescription drafting time from 90 seconds to under 20 seconds.
- **Frontend Changes:**
  - Add an "Rx-Groups" dropdown in [`app/(app)/dashboard/consultation-panel.tsx`](file:///d:/Projects/HospitalAutomation/app/(app)/dashboard/consultation-panel.tsx).
  - Add an "Rx-Group Management" modal allowing doctors to save the current prescription grid as a reusable template.
- **Backend Changes:**
  - Create `lib/services/rx-groups.ts` (`createRxGroup`, `getRxGroupsByDoctor`).
- **Database Implications:**
  - Create `rx_groups` and `rx_group_items` tables in `lib/db/schema.ts`.
- **Integrations & Dependencies:** Consultation panel draft state machine.
- **Implementation Complexity:** **Low** (3 days).
- **Acceptance Criteria:** Doctor clicks "URTI Adult Pack"; 4 medications appear populated in the prescription grid in <1 second.
- **Success Metric:** Average prescription creation time drops below 30 seconds.

---

### Item P1.2: Parameter-Wise Laboratory Result Entry & Reference Ranges
- **Problem:** Doctors write test orders, but laboratory staff cannot record numeric values, flag abnormal ranges, or print official lab reports.
- **Proposed Solution:** Build a `/laboratory` dashboard displaying ordered diagnostic tests. Lab technicians select a test, enter numeric results into pre-defined parameter fields (with normal reference ranges), and digitally sign the report.
- **Competitor Reference:** **Practo Insta HMS & Eka Care** ([`EVD-INSTA-018`](file:///d:/Projects/HospitalAutomation/research/competitor-benchmark/evidence-register.csv), [`EVD-EKA-003`](file:///d:/Projects/HospitalAutomation/research/competitor-benchmark/evidence-register.csv)).
- **Why Worth Implementing:** Closes the diagnostic care loop, eliminates manual paper lab slips, and enables longitudinal graphing.
- **Frontend Changes:**
  - Create `app/(app)/laboratory/page.tsx` (Test worklist).
  - Create `components/laboratory/result-entry-form.tsx` (Dynamic parameter inputs with red highlight for abnormal values).
  - Create `app/print/lab-report/[id]/page.tsx` (Official branded pathology PDF report).
- **Backend Changes:**
  - Add `lab_technician` role to `lib/domain/permissions.ts`.
  - Create `lib/services/laboratory.ts` (`recordTestResults`, `approveReport`).
- **Database Implications:**
  - Create `lab_orders`, `lab_test_templates`, and `lab_results` tables in `lib/db/schema.ts`.
- **Integrations & Dependencies:** Patient consultation panel (results appear in History drawer), WhatsApp notification.
- **Implementation Complexity:** **Medium** (6–8 days).
- **Acceptance Criteria:** Tech enters Fasting Glucose `160 mg/dL`; system flags value in red, marks test `completed`, and updates doctor's EMR.
- **Success Metric:** Diagnostic turnaround time (TAT) reduced by 40%.

---

### Item P1.3: ABDM Milestone 1 (M1) Scan & Share QR Counter Check-In
- **Problem:** Manual typing of patient demographics at reception causes spelling mistakes and counter queues. Hospitals miss out on government cash incentives.
- **Proposed Solution:** Implement NHA-certified ABDM M1 Scan & Share. Display a dynamic or static QR code at reception. When patients scan via ABHA or Aarogya Setu apps, their verified profile automatically populates the walk-in registration form.
- **Competitor Reference:** **Eka Care** ([`EVD-EKA-015`](file:///d:/Projects/HospitalAutomation/research/competitor-benchmark/evidence-register.csv)).
- **Why Worth Implementing:** Cuts walk-in registration time to 15 seconds, guarantees 100% demographic accuracy, and earns the hospital government subsidies under the Digital Health Incentive Scheme (DHIS).
- **Frontend Changes:**
  - Add "Scan & Share Incoming Queue" card to `app/(app)/queue/page.tsx`.
  - Add "Create ABHA via Aadhaar OTP" modal in patient registration.
- **Backend Changes:**
  - Create `lib/services/abdm-m1.ts` (Handles ABDM gateway token exchange, webhook callbacks, and profile retrieval).
- **Database Implications:**
  - Add `abha_number`, `abha_address`, and `abdm_link_status` columns to `patients` table.
- **Integrations & Dependencies:** National Health Authority (NHA) ABDM Sandbox / Production APIs.
- **Implementation Complexity:** **Medium** (7–10 days).
- **Acceptance Criteria:** Scanning counter QR immediately surfaces patient profile on receptionist screen with 1-click token issuance.
- **Success Metric:** 50%+ of walk-in patients checked in via ABDM Scan & Share within 60 days of launch.

---

### Item P1.4: Multi-Tier Tariff Rate Plans (Cash vs. TPA Insurance vs. Corporate)
- **Problem:** Qurio only supports a single flat price per charge item, making it impossible to bill cash, insurance, and corporate patients at different contracted rates.
- **Proposed Solution:** Introduce `rate_plans` (e.g., "General Cash", "Star Health TPA", "CGHS Govt"). Each charge item can define tier-specific pricing or a percentage modifier against base rates.
- **Competitor Reference:** **Practo Insta HMS** ([`EVD-INSTA-009`](file:///d:/Projects/HospitalAutomation/research/competitor-benchmark/evidence-register.csv)).
- **Why Worth Implementing:** Prerequisite for any mid-sized hospital dealing with corporate tie-ups or cashless insurance.
- **Frontend Changes:**
  - Add "Payer / Rate Plan" selector to patient registration and admission forms.
  - Add "Rate Plan Management" tab in Settings.
- **Backend Changes:**
  - Update `lib/services/ipd-billing.ts` to evaluate the patient's assigned `rate_plan_id` when calculating charges.
- **Database Implications:**
  - Create `rate_plans` and `charge_item_tariffs` tables in `lib/db/schema.ts`.
- **Integrations & Dependencies:** Inpatient interim billing, Outpatient registration.
- **Implementation Complexity:** **Medium** (5 days).
- **Acceptance Criteria:** Assigning "Star Health" to a patient automatically applies insurance-negotiated room and consultation rates.
- **Success Metric:** Zero manual price overriding by billing clerks.

---

### Item P1.5: Consultant Doctor Revenue-Share & Procedure Splits Engine
- **Problem:** Hospital accountants manually calculate monthly doctor payouts on Excel sheets, leading to disputes and delays.
- **Proposed Solution:** Build a rules engine allowing administrators to configure doctor payout splits (e.g., 70% of OPD consultation fee, 60% of surgery fee minus OT consumable costs). Automatically generate a monthly payout summary.
- **Competitor Reference:** **Practo Insta HMS** ([`EVD-INSTA-012`](file:///d:/Projects/HospitalAutomation/research/competitor-benchmark/evidence-register.csv)).
- **Why Worth Implementing:** Hospital owners and medical directors view transparent doctor payouts as a top-3 software buying criterion.
- **Frontend Changes:**
  - Add "Payout Rules" tab to Doctor Profile settings.
  - Create `app/(app)/reports/doctor-payouts/page.tsx` (Monthly realization and payout statements).
- **Backend Changes:**
  - Create `lib/services/payouts.ts` (`computeDoctorPayoutsForPeriod`).
- **Database Implications:**
  - Create `doctor_payout_rules` and `doctor_payout_settlements` tables.
- **Integrations & Dependencies:** Central billing transactions.
- **Implementation Complexity:** **Medium** (5–6 days).
- **Acceptance Criteria:** End-of-month report generates exact net payout owed to Dr. Sharma with full itemized procedure breakdown.
- **Success Metric:** Reduces monthly doctor payout calculation time from 3 days to 5 minutes.

---

### Item P2.1: Vernacular Prescription Printing (Hindi & Marathi Directions)
- **Problem:** English-only prescription directions cause dosing errors among tier-2/3 Indian patients.
- **Proposed Solution:** In `app/print/prescription/[id]/page.tsx`, implement a translation mapping dictionary for standard dosage instructions (`1-0-1` $\to$ `"सकाळी १, रात्री १"`, `After Food` $\to$ `"जेवणानंतर"`). Add a language toggle checkbox to the consultation workspace.
- **Competitor Reference:** **HealthPlix EMR** ([`EVD-HPLX-007`](file:///d:/Projects/HospitalAutomation/research/competitor-benchmark/evidence-register.csv)).
- **Why Worth Implementing:** Major patient safety improvement and strong sales differentiator in regional Indian markets.
- **Frontend Changes:**
  - Add language selector toggle (`English`, `Hindi`, `Marathi`) in [`app/(app)/dashboard/consultation-panel.tsx`](file:///d:/Projects/HospitalAutomation/app/(app)/dashboard/consultation-panel.tsx).
  - Update prescription print component to render translated instruction strings.
- **Backend Changes:**
  - Add `print_language` string column to `prescriptions` table.
  - Create static translation map utility `lib/domain/vernacular-rx.ts`.
- **Database Implications:** Low; 1 new column.
- **Integrations & Dependencies:** Print view, WhatsApp PDF generator.
- **Implementation Complexity:** **Low** (2 days).
- **Acceptance Criteria:** Toggling "Marathi" prints dosage instructions cleanly in Devanagari script while retaining drug brand names in English.
- **Success Metric:** 100% patient readability score in regional post-visit surveys.

---

### Item P2.2: Specialty Consultation Presets (Pediatrics & Diabetology)
- **Problem:** Generic consultation forms cannot capture pediatric growth percentiles or chronic diabetic glycemic trajectories.
- **Proposed Solution:** Create dynamic specialty sub-cards for Pediatrics (WHO height/weight percentile curves) and Diabetology (glycemic sparkline trends).
- **Competitor Reference:** **HealthPlix EMR & Eka Care** ([`EVD-HPLX-003`](file:///d:/Projects/HospitalAutomation/research/competitor-benchmark/evidence-register.csv), [`EVD-EKA-004`](file:///d:/Projects/HospitalAutomation/research/competitor-benchmark/evidence-register.csv)).
- **Why Worth Implementing:** Attracts pediatric and diabetic specialists who refuse to use generic hospital software.
- **Frontend Changes:**
  - Create `components/consultation/specialty/pediatric-card.tsx` (Interactive WHO growth curves via Recharts).
  - Create `components/consultation/specialty/diabetic-card.tsx` (Fasting/PP blood sugar and HbA1c trend lines).
- **Backend Changes:**
  - Update `lib/services/consultation.ts` to persist specialty-specific JSON metadata.
- **Database Implications:** Add `specialty_data` JSONB column to `consultations` table.
- **Implementation Complexity:** **Medium** (5 days).
- **Acceptance Criteria:** Entering child weight plots exact percentile against WHO growth curves inside consultation workspace.
- **Success Metric:** Specialist adoption rate increases by 60%.

---

### Item P2.3: Offline Curated Drug-to-Drug Interaction (DDI) Safety Engine
- **Problem:** Accidental prescribing of contraindicated drug combinations creates patient safety and malpractice risks.
- **Proposed Solution:** Embed a curated, open-source offline interaction table covering the top 300 Indian pharmaceutical molecules. Evaluate concurrent drugs in real time and display non-intrusive amber warning banners.
- **Competitor Reference:** **HealthPlix EMR & Eka Care** ([`EVD-HPLX-008`](file:///d:/Projects/HospitalAutomation/research/competitor-benchmark/evidence-register.csv)).
- **Why Worth Implementing:** Transforms Qurio into a clinically intelligent system that actively protects patients from harm.
- **Frontend Changes:**
  - Add inline warning alerts to `components/consultation/medicine-picker.tsx`.
- **Backend / Client Changes:**
  - Implement client-side rule evaluation utility `lib/domain/ddi-rules.ts`.
- **Database Implications:** Static rules JSON or lookup table.
- **Implementation Complexity:** **Low** (3 days).
- **Acceptance Criteria:** Adding Clopidogrel and Omeprazole immediately triggers an amber warning explaining antiplatelet inhibition risk.
- **Success Metric:** 100% of high-severity drug interaction errors caught prior to prescription print.

---

### Item P2.4: FHIR R4 Schema Serialization & NRCES Conformance
- **Problem:** Inability to export clinical records into international interoperability formats.
- **Proposed Solution:** Build a TypeScript serialization utility converting Qurio consultation, prescription, and vitals records into standardized HL7 FHIR R4 JSON bundles compliant with NRCES India specifications.
- **Competitor Reference:** **Eka Care** ([`EVD-EKA-018`](file:///d:/Projects/HospitalAutomation/research/competitor-benchmark/evidence-register.csv)).
- **Why Worth Implementing:** Architectural prerequisite for ABDM Milestone 2 (HIP) certification.
- **Frontend Changes:** None.
- **Backend Changes:** Create `lib/services/fhir.ts` (`serializeEncounterToFhirBundle`).
- **Database Implications:** None.
- **Implementation Complexity:** **Low** (3 days).
- **Acceptance Criteria:** Export endpoint outputs valid FHIR R4 JSON that validates against official NRCES JSON schema checkers.
- **Success Metric:** 100% NRCES conformance test pass rate.

---

## 3. Phased 30-60-90 Day Execution Roadmap

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│                             ENGINEERING ROADMAP TIMELINE                         │
├──────────────────────────┬───────────────────────────┬───────────────────────────┤
│    DAYS 1 - 30           │    DAYS 31 - 60           │    DAYS 61 - 90           │
│    (Foundation & Cash)   │    (Clinical & Tariffs)   │    (Intelligence & Growth)│
├──────────────────────────┼───────────────────────────┼───────────────────────────┤
│ • P0.1: Fix _journal.json│ • P1.2: Laboratory (LIMS) │ • P1.5: Consultant Doctor │
│   and orphaned DB schema │   numeric result entry    │   payouts rules engine    │
│                          │                           │                           │
│ • P0.2: Outpatient retail│ • P1.3: ABDM Milestone 1  │ • P2.2: Pediatric &       │
│   pharmacy POS queue     │   (M1) Scan & Share QR    │   diabetic clinical cards │
│                          │                           │                           │
│ • P0.3: OPD-to-IPD order │ • P1.4: Multi-tier rate   │ • P2.3: Offline drug-to-  │
│   continuity bridge      │   plans (Cash/TPA/Corp)   │   drug interaction engine │
│                          │                           │                           │
│ • P1.1: Pre-bundled      │ • P2.1: Vernacular Rx     │ • P2.4: FHIR R4 bundle    │
│   Rx-Groups authoring    │   printing in Hindi/Mar   │   serialization utility   │
└──────────────────────────┴───────────────────────────┴───────────────────────────┘
```
