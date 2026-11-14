# Comprehensive Product, Workflow & Technical Gap Analysis

**Document Title:** Critical Gaps, Vulnerabilities, and Architectural Deficiencies in Qurio  
**Deliverable Path:** `/research/competitor-benchmark/final/03-product-gap-analysis.md`  
**Evaluation Date:** November 2026  
**Auditor:** Healthcare SaaS Product Analyst, Software Reverse Engineer & Product Architect  

---

## 1. Executive Summary of Product Gaps

While Qurio excels in corridor queue decongestion and bedside nursing ergonomics, the benchmark against **Practo Insta HMS**, **HealthPlix EMR**, and **Eka Care** reveals severe functional and architectural gaps that currently prevent Qurio from competing as a full-service commercial Hospital Management System (HMS).

```
┌───────────────────────────────────────────────────────────────────────────┐
│                        SUMMARY OF CRITICAL GAPS IN QURIO                  │
│                                                                           │
│  [PRODUCT & USABILITY GAPS]                                               │
│  • Slow line-by-line prescribing (lacks pre-bundled Rx-Groups)            │
│  • Generic one-size-fits-all consultation template (no specialty presets) │
│  • English-only prescription printing (no regional language translations) │
│                                                                           │
│  [WORKFLOW & AUTOMATION GAPS]                                             │
│  • OPD-to-IPD medication order discontinuity (orders dropped on shift)    │
│  • Inability to record numeric lab results (orphaned test module)         │
│  • Lack of point-of-care Drug-to-Drug Interaction (DDI) safety checks     │
│                                                                           │
│  [TECHNICAL & CODEBASE VULNERABILITIES]                                   │
│  • Syntax corruption in drizzle/meta/_journal.json breaks test suites      │
│  • Orphaned migrations (0047 to 0053) create severe database drift       │
│  • Untracked DB table: ipd_discharge_clearances missing from migration log│
│                                                                           │
│  [COMMERCIAL & REVENUE BLINDSPOTS]                                        │
│  • Zero Outpatient Pharmacy POS (100% retail drug revenue leaked)         │
│  • Single flat price list (cannot bill Cash vs TPA Insurance differently) │
│  • No consultant doctor revenue-sharing or procedure split calculations   │
│  • Zero ABDM / ABHA integration (ineligible for government DHIS subsidies)│
└───────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Category-by-Category Gap Analysis

### 2.1 Product & Usability Gaps

#### Gap 1.1: Slow Line-by-Line Medication Authoring (High Doctor Cognitive Load)
- **Problem Description:** In Qurio's consultation workspace ([`app/(app)/dashboard/consultation-panel.tsx`](file:///d:/Projects/HospitalAutomation/app/(app)/dashboard/consultation-panel.tsx)), prescribing a standard treatment regimen (e.g., an antibiotic, an antacid, and an anti-inflammatory) requires searching and adding each drug as an individual line item. Busy Indian doctors seeing 40–80 patients per shift find this tedious and slow.
- **Source-Code Evidence:** [`app/(app)/dashboard/consultation-panel.tsx:addMedication`](file:///d:/Projects/HospitalAutomation/app/(app)/dashboard/consultation-panel.tsx). Only supports adding one drug at a time from the medicine picker.
- **Strongest Competitor Approach:** **HealthPlix EMR** ([`EVD-HPLX-005`](file:///d:/Projects/HospitalAutomation/research/competitor-benchmark/evidence-register.csv)). Doctors configure **"Rx-Groups"**—pre-bundled clinical packages (e.g., *"Acute Bronchitis Adult Standard"*, *"Stage-1 Hypertension Kit"*). A single click inserts all 3 to 5 drugs with appropriate dosages, frequencies, food instructions, and durations in under **2 seconds**.

---

#### Gap 1.2: Static One-Size-Fits-All Consultation Template (Zero Specialty Customization)
- **Problem Description:** Qurio provides an identical consultation form for all clinical users. A pediatrician, a cardiologist, an orthopedist, and a general physician all see the exact same fields (Chief Complaints, Vitals, Diagnosis, Medications, Advice). Specialized clinical parameters cannot be captured cleanly.
- **Source-Code Evidence:** [`app/(app)/dashboard/consultation-panel.tsx`](file:///d:/Projects/HospitalAutomation/app/(app)/dashboard/consultation-panel.tsx). Rigid layout with static inputs for BP, pulse, temp, SpO2, and weight.
- **Strongest Competitor Approach:** **HealthPlix EMR & Eka Care** ([`EVD-HPLX-003`](file:///d:/Projects/HospitalAutomation/research/competitor-benchmark/evidence-register.csv), [`EVD-EKA-007`](file:///d:/Projects/HospitalAutomation/research/competitor-benchmark/evidence-register.csv)). HealthPlix dynamically swaps clinical examination sheets and diagnostic criteria across 16+ specialties (e.g., WHO growth percentile curves and immunization trackers for Pediatrics; echocardiogram parameters and LVEF for Cardiology; glycemic sparklines for Diabetology).

---

#### Gap 1.3: English-Only Prescription Printing (Poor Tier-2/3 Patient Compliance)
- **Problem Description:** Qurio prints prescriptions exclusively in English ([`app/print/prescription/[id]/page.tsx`](file:///d:/Projects/HospitalAutomation/app/print/prescription/[id]/page.tsx)). In semi-urban and rural Indian hospitals, elderly patients and regional language speakers frequently misinterpret instructions like `1-0-1 PC`, leading to dosing errors and adverse drug events.
- **Source-Code Evidence:** [`app/print/prescription/[id]/page.tsx:PrescriptionPrintView`](file:///d:/Projects/HospitalAutomation/app/print/prescription/[id]/page.tsx). Renders raw Latin/English frequency codes directly into the printed output.
- **Strongest Competitor Approach:** **HealthPlix EMR** ([`EVD-HPLX-007`](file:///d:/Projects/HospitalAutomation/research/competitor-benchmark/evidence-register.csv)). Automatically translates dosage directions (e.g., `1 Tab After Food x 5 Days`) into **14 Indian regional languages** (Hindi, Marathi, Bengali, Tamil, Telugu, Gujarati, Kannada, etc.) while preserving generic chemical names in English.

---

### 2.2 Workflow & Automation Gaps

#### Gap 2.1: OPD-to-IPD Medication Order Discontinuity
- **Problem Description:** When a doctor advises hospital admission for an outpatient, Qurio provides an action to shift the patient to the inpatient ward ([`app/(app)/dashboard/consultation-panel.tsx:shiftToIpdAction`](file:///d:/Projects/HospitalAutomation/app/(app)/dashboard/consultation-panel.tsx)). However, the medications prescribed during the OPD consultation **do not carry over** into the inpatient ward treatment chart. Inpatient nurses and admitting doctors must re-enter all medications manually from scratch.
- **Source-Code Evidence:** [`lib/services/ipd-admissions.ts`](file:///d:/Projects/HospitalAutomation/lib/services/ipd-admissions.ts) creates an `ipd_admissions` record and marks the bed occupied, but does not read from `prescription_items` or create corresponding draft rows in `treatment_orders` or `ipd_notes`.
- **Strongest Competitor Approach:** **Practo Insta HMS** ([`EVD-INSTA-006`](file:///d:/Projects/HospitalAutomation/research/competitor-benchmark/evidence-register.csv)). Consultation notes, primary diagnosis, and outpatient prescriptions automatically populate the Inpatient Admission Case Sheet as "Pending Doctor Confirmation," allowing admitting doctors to approve or modify orders with one click.

---

#### Gap 2.2: Absence of Numeric Laboratory (LIMS) Result Entry
- **Problem Description:** Qurio doctors can write test names in an investigation box, but there is no screen or database capability for laboratory technicians to enter numeric test values (e.g., Hemoglobin: `11.2 g/dL`, Fasting Glucose: `145 mg/dL`), flag abnormal values against reference ranges, or print an official diagnostic report.
- **Source-Code Evidence:** The migration `drizzle/0047_test_follow_up.sql` created a basic `test_orders` table designed only to track whether a patient returned to the hospital for a test follow-up. Worse, this migration was orphaned and never applied to the active database.
- **Strongest Competitor Approach:** **Practo Insta HMS & Eka Care** ([`EVD-INSTA-018`](file:///d:/Projects/HospitalAutomation/research/competitor-benchmark/evidence-register.csv), [`EVD-EKA-003`](file:///d:/Projects/HospitalAutomation/research/competitor-benchmark/evidence-register.csv)). Insta supports parameter-wise result entry with age/gender reference ranges and bi-directional analyzer interfacing. Eka Care uses computer vision OCR to extract structured lab parameters directly from paper slips.

---

#### Gap 2.3: Zero Drug-to-Drug Interaction (DDI) Safety Checks
- **Problem Description:** Qurio checks basic patient drug allergies, but possesses no molecule-to-molecule interaction engine. A doctor can accidentally prescribe contraindicated or lethal drug combinations (e.g., *Sildenafil + Nitrates*, *Warfarin + High-Dose Aspirin*, *Clopidogrel + Omeprazole*) without triggering a warning.
- **Source-Code Evidence:** [`components/consultation/medicine-picker.tsx`](file:///d:/Projects/HospitalAutomation/components/consultation/medicine-picker.tsx). Validates only dosage string format; no interaction checking exists.
- **Strongest Competitor Approach:** **HealthPlix EMR & Eka Care** ([`EVD-HPLX-008`](file:///d:/Projects/HospitalAutomation/research/competitor-benchmark/evidence-register.csv), [`EVD-EKA-008`](file:///d:/Projects/HospitalAutomation/research/competitor-benchmark/evidence-register.csv)). Real-time background rules engines analyze concurrent prescriptions and surface non-intrusive amber alerts explaining the clinical risk and suggesting safer therapeutic alternatives.

---

### 2.3 Technical & Codebase Weaknesses

#### Gap 3.1: Drizzle Migration Journal Syntax Corruption
- **Problem Description:** Line 405+ of [`drizzle/meta/_journal.json`](file:///d:/Projects/HospitalAutomation/drizzle/meta/_journal.json) contains invalid trailing non-whitespace characters following the closing JSON array bracket. This breaks automated schema tooling, prevents running `drizzle-kit migrate`, and causes test failures in `lint.test.ts` and `plan.test.ts`.
- **Source-Code Evidence:** [`drizzle/meta/_journal.json`](file:///d:/Projects/HospitalAutomation/drizzle/meta/_journal.json#L400-L415). Uncommitted manual edits corrupted the JSON structure.
- **Impact:** Critical database reliability risk. Prevents deploying automated schema updates in CI/CD pipelines.

---

#### Gap 3.2: Orphaned Database Migrations (0047–0053 Track B Split)
- **Problem Description:** Migrations `0047` through `0053` (`test_orders`, `treatment_orders`, `ipd_notes`, `time_critical_signoffs`) exist as SQL files in `drizzle/`, but are recorded with negative indices or omitted entirely from `_journal.json`. These tables **do not exist in the active PostgreSQL database**, leaving several service files referencing phantom tables.
- **Source-Code Evidence:** Documented in [`00-existing-product-audit.md`](file:///d:/Projects/HospitalAutomation/research/competitor-benchmark/00-existing-product-audit.md#L450-L500).
- **Impact:** Severe architectural drift. Any runtime code attempting to query these tables will fail with PostgreSQL `relation does not exist` errors.

---

#### Gap 3.3: Database Schema Drift on `ipd_discharge_clearances`
- **Problem Description:** The table `ipd_discharge_clearances` exists in the local development database and powers the discharge clearance cockpit, but **has no corresponding SQL migration file in `drizzle/`**. 
- **Source-Code Evidence:** [`lib/db/schema.ts`](file:///d:/Projects/HospitalAutomation/lib/db/schema.ts) defines the Drizzle table model, but `drizzle/` lacks the schema generation migration.
- **Impact:** Any fresh deployment of Qurio to staging or production will crash when opening the discharge cockpit because the table will not be created.

---

### 2.4 Missing Integrations

#### Gap 4.1: Complete Isolation from Ayushman Bharat Digital Mission (ABDM)
- **Problem Description:** Qurio has zero integration with India's national ABDM digital health stack. It cannot generate or verify Ayushman Bharat Health Accounts (ABHA IDs), cannot support national QR **Scan & Share** check-in at reception, cannot act as a Health Information Provider (HIP), and cannot serialize clinical encounters into FHIR R4 bundles.
- **Source-Code Evidence:** Absence of any ABDM endpoints in `app/api/` or FHIR serialization services in `lib/services/`.
- **Strongest Competitor Approach:** **Eka Care** ([`EVD-EKA-015`](file:///d:/Projects/HospitalAutomation/research/competitor-benchmark/evidence-register.csv), [`EVD-EKA-018`](file:///d:/Projects/HospitalAutomation/research/competitor-benchmark/evidence-register.csv)). National benchmark for ABDM M1, M2, and M3; handles millions of ABHA transactions and serializes records into NRCES-compliant FHIR R4 bundles.

---

#### Gap 4.2: Absence of Laboratory Analyzer Equipment Interfacing (LIS Drivers)
- **Problem Description:** Qurio cannot connect to automated laboratory diagnostic equipment (hematology, biochemistry, immunoassay machines).
- **Source-Code Evidence:** No serial RS-232, TCP/IP, or ASTM/HL7 driver adapters in the codebase.
- **Strongest Competitor Approach:** **Practo Insta HMS** ([`EVD-INSTA-017`](file:///d:/Projects/HospitalAutomation/research/competitor-benchmark/evidence-register.csv)). Bi-directional interfacing reads barcode tubes, instructs analyzers, and ingests raw numerical test results automatically without human intervention.

---

### 2.5 Reporting & Operational Visibility Gaps

#### Gap 5.1: Zero Consultant Doctor Revenue-Share Payout Engine
- **Problem Description:** In private Indian hospitals, 70% of senior specialists and surgeons work on visiting or fee-sharing arrangements (e.g., 70% of OPD fees, 60% of OT surgical fees minus consumable costs). Qurio provides no mechanism to track or calculate consultant payouts. Hospital accountants must spend days calculating doctor commissions manually on spreadsheets.
- **Source-Code Evidence:** [`app/(app)/reports/page.tsx`](file:///d:/Projects/HospitalAutomation/app/(app)/reports/page.tsx). Reports page only aggregates total consultation counts and gross revenue.
- **Strongest Competitor Approach:** **Practo Insta HMS** ([`EVD-INSTA-012`](file:///d:/Projects/HospitalAutomation/research/competitor-benchmark/evidence-register.csv)). Highly configurable consultant rules engine automating monthly fee sharing, procedure splits, tax deductions at source (TDS), and realized cash collections.

---

#### Gap 5.2: Lack of Clinical Practice Analytics (ROBIN Equivalent)
- **Problem Description:** Qurio's reporting is limited to basic operational queue counts and revenue totals. Doctors have no insight into top presenting complaints, diagnostic distributions, antibiotic prescribing habits, or chronic disease compliance.
- **Source-Code Evidence:** [`app/(app)/reports/page.tsx`](file:///d:/Projects/HospitalAutomation/app/(app)/reports/page.tsx). Minimal high-level dashboard.
- **Strongest Competitor Approach:** **HealthPlix EMR (ROBIN) & Eka Care** ([`EVD-HPLX-014`](file:///d:/Projects/HospitalAutomation/research/competitor-benchmark/evidence-register.csv), [`EVD-EKA-012`](file:///d:/Projects/HospitalAutomation/research/competitor-benchmark/evidence-register.csv)). Real-time practice dashboards displaying diagnosis Pareto charts, therapeutic class heatmaps, and patient follow-up retention curves.

---

### 2.6 Commercial & Customer-Value Gaps

#### Gap 6.1: Zero Outpatient Retail Pharmacy POS (100% Drug Margin Leaked)
- **Problem Description:** Qurio allows doctors to author prescriptions, but provides no counter dispensing interface, batch inventory tracking, retail billing, or pharmacy receipt printing. Patients leave the hospital building to purchase medications at outside retail pharmacies.
- **Commercial Impact:** Hospital owners lose their most profitable revenue center (retail pharmaceutical margins typically range from 20% to 45%). A hospital system that cannot manage the internal pharmacy counter is commercially unacceptable to most private hospital owners.
- **Strongest Competitor Approach:** **Practo Insta HMS** ([`EVD-INSTA-013`](file:///d:/Projects/HospitalAutomation/research/competitor-benchmark/evidence-register.csv)). Complete outpatient retail pharmacy POS queue with automatic prescription fetching, brand substitution, inventory deduction, and GST receipting.

---

#### Gap 6.2: Inability to Support Multi-Tier Rate Plans (Cash vs. TPA vs. Corporate)
- **Problem Description:** Qurio configures prices on a flat, single-price model per `charge_item` ([`lib/services/ipd-config.ts`](file:///d:/Projects/HospitalAutomation/lib/services/ipd-config.ts)). However, private hospitals maintain 10 to 50 distinct rate sheets: Cash Rates, Star Health TPA, Medi Assist TPA, CGHS / Government Rates, and Corporate Panels. Charging the same flat fee across all payers makes the system unusable for hospitals with insurance tie-ups.
- **Source-Code Evidence:** [`lib/services/ipd-config.ts:createChargeItem`](file:///d:/Projects/HospitalAutomation/lib/services/ipd-config.ts). Only accepts a single `unit_price_cents` integer.
- **Strongest Competitor Approach:** **Practo Insta HMS** ([`EVD-INSTA-009`](file:///d:/Projects/HospitalAutomation/research/competitor-benchmark/evidence-register.csv)). Advanced rate-plan engine supporting base price lists and percentage-derived tariff tiers linked to patient payer profiles.
