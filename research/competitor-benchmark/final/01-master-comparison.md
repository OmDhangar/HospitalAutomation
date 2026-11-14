# Master 14-Domain Competitive Comparison

**Document Title:** Master Competitive Benchmark Across 14 Functional Domains  
**Deliverable Path:** `/research/competitor-benchmark/final/01-master-comparison.md`  
**Evaluation Date:** November 2026  
**Auditor:** Healthcare SaaS Product Analyst, Software Reverse Engineer & Product Architect  
**Scoring Key:**  
`0` — Not Available | `1` — Basic / Manual | `2` — Partially Implemented | `3` — Functional | `4` — Advanced & Integrated | `5` — Exceptionally Mature | `Unknown` — Report Pending / Insufficient Evidence | `N/A` — Outside Product Scope  

---

## 1. Architectural Scope & Product Positioning Overview

Before evaluating individual features, we establish the fundamental architectural mandates of the systems under evaluation. A specialized clinical tool is not penalized for lacking enterprise inpatient modules, but its inability to serve a hospital environment is explicitly documented:

```
┌────────────────────────────────────────────────────────────────────────────────────────────┐
│                             ARCHITECTURAL PROFILES & MARKET SCOPE                          │
│                                                                                            │
│  [Qurio / opd-queue]   ──► Mid-Sized Hospitals & Nursing Homes (20-150 beds)                │
│                            Core: Corridor Flow, Live Queue Stream, Bedside eMAR, IPD Census│
│                                                                                            │
│  [COMP-01: Insta HMS]  ──► Large Multi-Specialty Hospitals & Enterprise Chains (50-500+ beds│
│                            Core: Institutional ERP, Multi-Payer Billing, LIS, Stores, Payouts│
│                                                                                            │
│  [COMP-02: HealthPlix] ──► Solo Outpatient Clinics, Polyclinics & Specialists              │
│                            Core: Sub-30s Prescribing, 16+ Specialty Visit Pads, CDSS, H.A.L.O│
│                                                                                            │
│  [COMP-03: Eka Care]   ──► Connected Clinics, Polyclinics, Emerging IPD & 30M+ Consumers   │
│                            Core: ABDM (M1/M2/M3), FHIR R4, Paper OCR Lab Extraction, Scribe│
│                                                                                            │
│  [COMP-04 to 07]       ──► Pending Evaluation (Marked as Unknown across all domains)        │
└────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Domain-by-Domain Comprehensive Evaluation

### 2.1 Patient Management & Outpatient Department (OPD)

| Functional Capability | Qurio Baseline | COMP-01: Practo Insta | COMP-02: HealthPlix | COMP-03: Eka Care | COMP-04 to 07 | Strongest Implementation Observed |
|---|---|---|---|---|---|---|
| **Walk-in Fast Registration** | **4 / 5** | **4 / 5** | **4 / 5** | **5 / 5** | `Unknown` | **Eka Care leads.** Eka Care's ABDM Scan & Share fetches verified demographics via QR in 15 seconds. Qurio is fast (5-sec mobile/name entry), but lacks QR automation. |
| **Duplicate Patient Prevention** | **3 / 5** | **4 / 5** | **3 / 5** | **4 / 5** | `Unknown` | **Practo Insta leads.** Prompts mandatory fuzzy lookup before new record creation and provides a formal Medical Records Department (MRD) duplicate merge console. |
| **Master Patient Index (MPI) / UHID** | **4 / 5** | **5 / 5** | **4 / 5** | **5 / 5** | `Unknown` | **Eka Care & Insta tie.** Both generate permanent institutional UHIDs. Eka Care uniquely binds the UHID to the national 14-digit ABHA ID. |
| **Demographic Data Depth** | **2 / 5** | **5 / 5** | **3 / 5** | **4 / 5** | `Unknown` | **Practo Insta leads.** Captures employer sponsors, insurance policies, national IDs, photo biometrics, and Medico-Legal Case (MLC) flags. |

**Key Architectural Takeaway:**  
Qurio's ultra-minimal registration (`lib/services/queue.ts:createWalkIn`) captures only name and phone. While this optimizes receptionist typing speed, it creates severe downstream problems for billing and insurance claims, where age, gender, address, and government identification numbers are statutory prerequisites.

---

### 2.2 Doctor Consultation & Outpatient EMR

| Functional Capability | Qurio Baseline | COMP-01: Practo Insta | COMP-02: HealthPlix | COMP-03: Eka Care | COMP-04 to 07 | Strongest Implementation Observed |
|---|---|---|---|---|---|---|
| **Consultation Initiation Speed** | **4 / 5** | **3 / 5** | **5 / 5** | **4 / 5** | `Unknown` | **HealthPlix leads.** Single-page modular Visit Pad opens in exactly 1 click with pre-loaded past encounter data. |
| **Specialty-Specific Customization** | **1 / 5** | **4 / 5** | **5 / 5** | **4 / 5** | `Unknown` | **HealthPlix leads.** 16+ dynamic specialty templates (Cardiology echo parameters, Diabetology glycemic cockpits, Pediatric WHO growth curves). Qurio has 1 generic template. |
| **Prescription Authoring Speed** | **3 / 5** | **3 / 5** | **5 / 5** | **4 / 5** | `Unknown` | **HealthPlix leads.** Sub-30-second prescribing via pre-bundled "Rx-Groups" (multi-drug sets inserted in 1 click). Qurio requires searching and entering each drug individually. |
| **Vernacular Prescription Printing** | **1 / 5** | **1 / 5** | **5 / 5** | **4 / 5** | `Unknown` | **HealthPlix leads decisively.** Automatically translates dosage instructions into 14 Indian regional languages (Hindi, Marathi, Bengali, Tamil, etc.). Qurio prints English only. |
| **Drug-to-Drug Interaction (DDI) Alerts** | **0 / 5** | **3 / 5** | **4 / 5** | **4 / 5** | `Unknown` | **HealthPlix & Eka Care tie.** Real-time point-of-care alerts flagging dangerous combinations (e.g., Clopidogrel + PPI, Spironolactone + Telmisartan). Qurio has no DDI engine. |
| **Longitudinal Diagnostic Tracking** | **1 / 5** | **3 / 5** | **4 / 5** | **5 / 5** | `Unknown` | **Eka Care leads decisively.** Automatically extracts test markers from paper lab reports via vision OCR and charts longitudinal sparklines across 100+ clinical parameters. |

**Key Architectural Takeaway:**  
Qurio's consultation workspace (`app/(app)/dashboard/consultation-panel.tsx`) is clean, highly reactive, and autosaves drafts every 1.5 seconds. However, its generic, one-size-fits-all medical form and line-by-line drug entry create significant doctor fatigue compared to HealthPlix's pre-bundled Rx-Groups and Eka Care's automated lab parameter tracking.

---

### 2.3 Queue & Appointment Management

| Functional Capability | Qurio Baseline | COMP-01: Practo Insta | COMP-02: HealthPlix | COMP-03: Eka Care | COMP-04 to 07 | Strongest Implementation Observed |
|---|---|---|---|---|---|---|
| **Corridor Crowd Decongestion** | **5 / 5** | **2 / 5** | **1 / 5** | **1 / 5** | `Unknown` | **Qurio leads decisively.** Real-time mobile wait-time streaming (`/q/[token]`) allows patients to wait outside crowded corridors without installing an app. Competitors rely on static room monitors. |
| **Queue Concurrency Control** | **5 / 5** | **4 / 5** | **3 / 5** | **3 / 5** | `Unknown` | **Qurio leads.** PostgreSQL row-level locks (`SELECT ... FOR UPDATE`) on doctor chamber queues prevent double-calling and race conditions during high-volume OPD rushes. |
| **Interactive WhatsApp Booking** | **5 / 5** | **1 / 5** | **2 / 5** | **3 / 5** | `Unknown` | **Qurio leads decisively.** Fully automated, 4-step interactive booking bot via native Meta WhatsApp Cloud API (`lib/services/whatsapp.ts`). Competitors rely on one-way broadcast SMS/WhatsApp. |
| **Reserve with Google Sync** | **0 / 5** | **2 / 5** | **2 / 5** | **4 / 5** | `Unknown` | **Eka Care leads.** Deep two-way synchronization with Google Maps and Google Search *Reserve with Google* engine. |

**Key Architectural Takeaway:**  
Queue management is Qurio's undisputed signature competitive moat. Competitors approach queues as administrative appointment lists; Qurio treats the queue as a live, streaming physical corridor decongestion system.

---

### 2.4 Inpatient Department (IPD) & Admission Management

| Functional Capability | Qurio Baseline | COMP-01: Practo Insta | COMP-02: HealthPlix | COMP-03: Eka Care | COMP-04 to 07 | Strongest Implementation Observed |
|---|---|---|---|---|---|---|
| **Real-time Bed Board & Census** | **4 / 5** | **4 / 5** | **0 / 5** (N/A) | **3 / 5** | `Unknown` | **Qurio & Insta tie.** Qurio provides a modern visual grid (`components/ipd/bed-grid.tsx`); Insta supports multi-building floor layouts. HealthPlix has zero IPD capabilities. |
| **ADT Bed Transfers & Room Proration** | **4 / 5** | **4 / 5** | **0 / 5** (N/A) | **2 / 5** | `Unknown` | **Practo Insta leads.** Automatically recalculates mixed-tier room tariffs during mid-day transfers (e.g., General Ward to ICU). Qurio executes atomic transfers in single transactions. |
| **OPD-to-IPD Clinical Continuity** | **3 / 5** | **4 / 5** | **0 / 5** (N/A) | **2 / 5** | `Unknown` | **Practo Insta leads.** Automatically converts OPD consultation notes and active prescriptions into the inpatient admission chart. Qurio queues the patient but drops medication continuity. |
| **Admission Deposit & Financial Guard** | **3 / 5** | **5 / 5** | **0 / 5** (N/A) | **2 / 5** | `Unknown` | **Practo Insta leads.** Configurable financial gates blocking inpatient admission without mandatory deposit collection or explicit administrative override. |

---

### 2.5 Nursing & Treatment Workflows

| Functional Capability | Qurio Baseline | COMP-01: Practo Insta | COMP-02: HealthPlix | COMP-03: Eka Care | COMP-04 to 07 | Strongest Implementation Observed |
|---|---|---|---|---|---|---|
| **Bedside eMAR Medication Administration** | **4 / 5** | **4 / 5** | **0 / 5** (N/A) | **2 / 5** | `Unknown` | **Qurio leads in UX.** Purpose-built for low-cost Android tablets with 48px touch targets (`components/ipd/bedside/bedside-treatment-chart.tsx`). Insta connects eMAR to automated pharmacy deductions. |
| **Automated Early-Warning Deterioration (NEWS2)**| **4 / 5** | **0 / 5** | **0 / 5** (N/A) | **0 / 5** | `Unknown` | **Qurio leads decisively.** Automated **National Early Warning Score (NEWS2)** calculation engine (`lib/domain/vitals-news2.ts`). No evaluated competitor offers automated deterioration scoring. |
| **Intake / Output & Fluid Balance Charts** | **2 / 5** | **4 / 5** | **0 / 5** (N/A) | **1 / 5** | `Unknown` | **Practo Insta leads.** Dedicated multi-hour fluid balance recording covering oral, IV, drain, and urinary outputs. |

---

### 2.6 Pharmacy & Inventory Management

| Functional Capability | Qurio Baseline | COMP-01: Practo Insta | COMP-02: HealthPlix | COMP-03: Eka Care | COMP-04 to 07 | Strongest Implementation Observed |
|---|---|---|---|---|---|---|
| **Outpatient Retail Pharmacy POS** | **0 / 5** | **4 / 5** | **0 / 5** | **3 / 5** | `Unknown` | **Practo Insta leads.** Full retail pharmacy counter queue, brand/generic substitute mapping, cash/card receipting, and GST invoicing. Qurio has **zero** pharmacy POS. |
| **Ward Pharmacy Indents & Dispensing** | **0 / 5** | **4 / 5** | **0 / 5** (N/A) | **2 / 5** | `Unknown` | **Practo Insta leads.** Inpatient medication orders generate automated pharmacy indents; fulfillment auto-posts charges to the patient's interim bill. |
| **Inventory Procurement & Batch Expiry Tracking**| **0 / 5** | **5 / 5** | **0 / 5** (N/A) | **2 / 5** | `Unknown` | **Practo Insta leads.** Purchase orders, Goods Receipt Notes (GRN), store transfers, batch-level FIFO expiry tracking, and near-expiry alerts. |

**Key Commercial Takeaway:**  
The complete absence of a pharmacy POS module is Qurio's single largest commercial liability. In private Indian healthcare, 40% to 50% of hospital profitability is derived from pharmaceutical retail. Qurio's current architecture forces the hospital to leak this revenue to external chemists.

---

### 2.7 Laboratory & Diagnostic Workflows

| Functional Capability | Qurio Baseline | COMP-01: Practo Insta | COMP-02: HealthPlix | COMP-03: Eka Care | COMP-04 to 07 | Strongest Implementation Observed |
|---|---|---|---|---|---|---|
| **Numeric Lab Analyte Entry & Ranges** | **0 / 5** | **4 / 5** | **1 / 5** | **4 / 5** | `Unknown` | **Practo Insta & Eka Care tie.** Multi-parameter entry forms with age/gender reference ranges and abnormal value flagging. Qurio's test follow-up table is orphaned. |
| **Bi-Directional Analyzer Interfacing (LIS)**| **0 / 5** | **5 / 5** | **0 / 5** | **1 / 5** | `Unknown` | **Practo Insta leads decisively.** Direct HL7 and ASTM protocol machine interfacing with automated hematology and biochemistry analyzers. |
| **Vision OCR Lab Report Extraction** | **0 / 5** | **0 / 5** | **0 / 5** | **5 / 5** | `Unknown` | **Eka Care leads decisively.** Computer vision pipeline extracting parameters, units, and ranges from uploaded paper lab slips and PDFs into structured records. |

---

### 2.8 Billing & Financial Management

| Functional Capability | Qurio Baseline | COMP-01: Practo Insta | COMP-02: HealthPlix | COMP-03: Eka Care | COMP-04 to 07 | Strongest Implementation Observed |
|---|---|---|---|---|---|---|
| **Multi-Tier Rate Plans & Tariffs** | **1 / 5** | **5 / 5** | **1 / 5** | **2 / 5** | `Unknown` | **Practo Insta leads decisively.** Multi-tier base and derived tariffs across cash, corporate tie-ups, and insurance networks. Qurio only supports flat, single-price charge items. |
| **Consultant Doctor Payouts Engine** | **0 / 5** | **4 / 5** | **0 / 5** | **0 / 5** | `Unknown` | **Practo Insta leads decisively.** Rules engine automating monthly consultant revenue sharing (OPD consultation splits, surgery procedure splits, facility fee deductions). |
| **Interim Inpatient Billing Ledger** | **4 / 5** | **5 / 5** | **0 / 5** (N/A) | **3 / 5** | `Unknown` | **Practo Insta leads.** Automated midnight room rent accrual, itemized departmental additions, and deposit deduction ledger. Qurio has functional interim billing. |

---

### 2.9 Insurance & TPA Claims Management

| Functional Capability | Qurio Baseline | COMP-01: Practo Insta | COMP-02: HealthPlix | COMP-03: Eka Care | COMP-04 to 07 | Strongest Implementation Observed |
|---|---|---|---|---|---|---|
| **Cashless TPA Pre-Authorization** | **0 / 5** | **4 / 5** | **0 / 5** (N/A) | **1 / 5** | `Unknown` | **Practo Insta leads.** Tracking pre-auth requests, initial approval limits, interim enhancement requests, and final denial tracking. |
| **National Health Claims Exchange (NHCX)**| **0 / 5** | **2 / 5** | **0 / 5** (N/A) | **2 / 5** | `Unknown` | **Nascent across industry.** Early-stage integration with India's national NHCX insurance clearinghouse. |

---

### 2.10 Discharge Management

| Functional Capability | Qurio Baseline | COMP-01: Practo Insta | COMP-02: HealthPlix | COMP-03: Eka Care | COMP-04 to 07 | Strongest Implementation Observed |
|---|---|---|---|---|---|---|
| **Multi-Department Clearance Matrix** | **5 / 5** | **4 / 5** | **0 / 5** (N/A) | **2 / 5** | `Unknown` | **Qurio leads decisively.** Atomic 5-step department clearance checklist (Medical, Pharmacy returns, Nursing, Lab, Billing) with verified role sign-offs (`lib/services/ipd-clearance.ts`). |
| **Cryptographic Discharge Gate Pass** | **5 / 5** | **2 / 5** | **0 / 5** (N/A) | **1 / 5** | `Unknown` | **Qurio leads decisively.** Anti-counterfeit Gate Pass with cryptographic SHA-256 HMAC verification token preventing unauthorized patient exit. |

---

### 2.11 Notifications & Automation

| Functional Capability | Qurio Baseline | COMP-01: Practo Insta | COMP-02: HealthPlix | COMP-03: Eka Care | COMP-04 to 07 | Strongest Implementation Observed |
|---|---|---|---|---|---|---|
| **Direct WhatsApp Cloud API Delivery** | **5 / 5** | **1 / 5** | **2 / 5** | **4 / 5** | `Unknown` | **Qurio leads.** Direct integration with Meta WhatsApp Cloud API without third-party vendor markups or per-message software charges. |
| **Automated Follow-Up Scheduling** | **3 / 5** | **2 / 5** | **4 / 5** | **4 / 5** | `Unknown` | **HealthPlix & Eka Care tie.** Automatically calculates review dates based on prescription duration and dispatches WhatsApp reminders 48 hours prior. |

---

### 2.12 Administration & Reporting

| Functional Capability | Qurio Baseline | COMP-01: Practo Insta | COMP-02: HealthPlix | COMP-03: Eka Care | COMP-04 to 07 | Strongest Implementation Observed |
|---|---|---|---|---|---|---|
| **Clinical Practice Analytics** | **1 / 5** | **4 / 5** | **4 / 5** | **4 / 5** | `Unknown` | **HealthPlix & Eka Care tie.** HealthPlix's ROBIN and Eka Care's practice dashboards surface top diagnoses, prescribing trends, and patient return rates. Qurio has basic counts. |
| **Institutional MIS & Financial Reports**| **2 / 5** | **5 / 5** | **1 / 5** | **2 / 5** | `Unknown` | **Practo Insta leads decisively.** Over 3,000 pre-built enterprise reports, revenue leakage audits, and unbilled service detection. |

---

### 2.13 Security & Access Control

| Functional Capability | Qurio Baseline | COMP-01: Practo Insta | COMP-02: HealthPlix | COMP-03: Eka Care | COMP-04 to 07 | Strongest Implementation Observed |
|---|---|---|---|---|---|---|
| **Tamper-Evident Cryptographic Logging**| **5 / 5** | **2 / 5** | **2 / 5** | **2 / 5** | `Unknown` | **Qurio leads decisively.** SHA-256 HMAC chained event logs (`acct_events`) with hourly signed digests provide mathematical proof against internal database tampering. |
| **Multi-Tenant Data Isolation** | **4 / 5** | **4 / 5** | **4 / 5** | **4 / 5** | `Unknown` | **Parity.** Robust tenant isolation enforced at the database or application routing level. |

---

### 2.14 Interoperability & National Integrations

| Functional Capability | Qurio Baseline | COMP-01: Practo Insta | COMP-02: HealthPlix | COMP-03: Eka Care | COMP-04 to 07 | Strongest Implementation Observed |
|---|---|---|---|---|---|---|
| **ABDM Milestone 1 (M1) Scan & Share** | **0 / 5** | **2 / 5** | **1 / 5** | **5 / 5** | `Unknown` | **Eka Care leads decisively.** NHA benchmark for instant QR check-in and Aadhaar-based ABHA ID generation. Qurio has zero ABDM integration. |
| **ABDM M2 & M3 (HIP / HIU Integration)**| **0 / 5** | **2 / 5** | **1 / 5** | **5 / 5** | `Unknown` | **Eka Care leads decisively.** Certified HIP/HIU gateway linking care contexts and retrieving external hospital records via digital consent. |
| **FHIR R4 Schema Serialization** | **0 / 5** | **2 / 5** | **1 / 5** | **5 / 5** | `Unknown` | **Eka Care leads decisively.** Encodes all clinical encounters into standardized HL7 FHIR R4 JSON bundles compliant with NRCES India profiles. |

---

## 3. Summary Scoring Matrix Across All 14 Domains

| Functional Domain | Qurio Baseline Score | COMP-01: Practo Insta | COMP-02: HealthPlix | COMP-03: Eka Care | COMP-04 to 07 | Leading System |
|---|---|---|---|---|---|---|
| **1. Patient Management & OPD** | **3.3** / 5 | **4.5** / 5 | 3.5 / 5 | **4.5** / 5 | `Unknown` | Practo Insta & Eka Care |
| **2. Doctor Consultation & EMR** | 1.8 / 5 | 3.2 / 5 | **4.7** / 5 | 4.3 / 5 | `Unknown` | HealthPlix EMR |
| **3. Queue & Corridor Flow** | **5.0** / 5 | 2.3 / 5 | 1.8 / 5 | 2.8 / 5 | `Unknown` | **Qurio (Industry Benchmark)** |
| **4. IPD & Bed Management** | **3.8** / 5 | **4.3** / 5 | 0.0 / 5 (N/A) | 2.3 / 5 | `Unknown` | Practo Insta HMS |
| **5. Nursing & Treatment Workflows**| **3.3** / 5 | 2.7 / 5 | 0.0 / 5 (N/A) | 1.0 / 5 | `Unknown` | **Qurio (NEWS2 & Tablet UX)** |
| **6. Pharmacy & Inventory** | 0.0 / 5 | **4.3** / 5 | 0.0 / 5 (N/A) | 2.3 / 5 | `Unknown` | Practo Insta HMS |
| **7. Laboratory & Diagnostics** | 0.0 / 5 | **3.0** / 5 | 0.3 / 5 | **3.3** / 5 | `Unknown` | Eka Care & Practo Insta |
| **8. Billing & Financial Mgmt** | 2.5 / 5 | **4.7** / 5 | 0.3 / 5 | 1.7 / 5 | `Unknown` | Practo Insta HMS |
| **9. Insurance & TPA Claims** | 0.0 / 5 | **3.0** / 5 | 0.0 / 5 (N/A) | 1.5 / 5 | `Unknown` | Practo Insta HMS |
| **10. Discharge Management** | **5.0** / 5 | 3.0 / 5 | 0.0 / 5 (N/A) | 1.5 / 5 | `Unknown` | **Qurio (Clearance & Gate Pass)** |
| **11. Notifications & Automation** | **4.0** / 5 | 1.5 / 5 | 3.0 / 5 | **4.0** / 5 | `Unknown` | **Qurio & Eka Care** |
| **12. Administration & Reporting** | 1.5 / 5 | **4.5** / 5 | 2.5 / 5 | 3.0 / 5 | `Unknown` | Practo Insta HMS |
| **13. Security & Access Control** | **4.5** / 5 | 3.0 / 5 | 3.0 / 5 | 3.0 / 5 | `Unknown` | **Qurio (Cryptographic HMAC)** |
| **14. Interoperability & ABDM** | 0.0 / 5 | 2.0 / 5 | 1.0 / 5 | **5.0** / 5 | `Unknown` | Eka Care |
