# Competitor Benchmark Research Ledger

## 1. Research Overview & Index
This ledger maintains longitudinal continuity across all competitive investigations conducted against the baseline of Qurio (internal: `opd-queue` / `QueueCare`). It tracks completed audits, active investigations, evidence registers, scoring normalization, and open architectural questions.

---

## 2. Investigation Registry

| Investigation ID | Target Competitor | Product Type | Target Market | Status | Lead Report Path | Date Completed |
|---|---|---|---|---|---|---|
| **AUDIT-00** | Qurio (Baseline) | Cloud OPD/IPD Queue & Hospital SaaS | Indian Small/Mid Hospitals (50–200 beds) | **Completed** | `/research/competitor-benchmark/00-existing-product-audit.md` | 2026-11-02 |
| **COMP-01** | **Practo Insta HMS** | Enterprise Hospital Management ERP / Cloud HIS | Mid-to-Large Hospitals, Multi-center Chains (India, Middle East, SEA) | **Completed** | `/research/competitor-benchmark/individual-reports/practo-insta-hms-report.md` | 2026-11-02 |
| **COMP-02** | **HealthPlix EMR** | Doctor-First AI EMR & Digital Prescription Platform | Independent Clinics, Polyclinics, OPD Specialists (India) | **Completed** | `/research/competitor-benchmark/individual-reports/healthplix-emr-report.md` | 2026-11-02 |
| **COMP-03** | **Eka Care** | AI Health OS, Practice Management & ABDM Interoperability Platform | Clinics, Polyclinics, Mid-sized Hospitals & Patients (India) | **Completed** | `/research/competitor-benchmark/individual-reports/eka-care-report.md` | 2026-11-02 |

---

## 3. Normalized Scoring Framework

To prevent score inflation and subjective bias, all competitor comparisons follow a strict 6-tier rubric grounded in verifiable functional evidence:

| Score | Rating | Definition | Verification Criteria |
|---|---|---|---|
| **0** | **Not Available** | No capability exists in the software. | Completely absent from UI, API, database, and documentation. |
| **1** | **Basic / Manual** | Feature exists only as static fields or manual entries without automated logic. | Simple text input/toggle; no downstream automation, validation, or ledger impacts. |
| **2** | **Partially Implemented** | Feature exists with domain logic, but suffers from severe workflow disconnects or partial implementation. | UI exists but fails at runtime; or worker/billing disconnect; or unlinked cross-department handoffs. |
| **3** | **Functional** | Feature works end-to-end for standard use cases with reliable business logic and database persistence. | Full UI $\to$ API $\to$ DB flow verified; covers standard operational workflows without crashing. |
| **4** | **Advanced & Integrated** | Feature is deeply integrated across multiple departments, automated background jobs, and robust error handling. | Automatic charge posting, bidirectional data sync, automated outbox workers, role-based controls. |
| **5** | **Exceptionally Mature** | Market-defining implementation with deep external interoperability, hardware interfacing, and rigorous compliance. | Bi-directional machine interfaces (HL7/ASTM), automated rate-plan engines, government clearinghouse (ABDM/NPHIES). |
| **Unknown** | **Insufficient Evidence** | Capability cannot be confirmed through accessible documentation, trials, or demonstrations. | Unverified marketing claim without concrete operational documentation. |
| **N/A** | **Not Applicable** | Capability is deliberately outside the product's architectural mandate or target sector. | Out of scope. |

---

## 4. Evidence Classification Standards

Every piece of competitive intelligence is tagged with one of five evidence standards:
1. **Directly observed in the application:** Verified through live system access, trial environments, or sandboxes.
2. **Confirmed through official documentation:** Verified via official vendor user manuals, technical knowledge bases, API docs, or published release notes.
3. **Observed in an official demonstration:** Verified through official vendor product walkthroughs, webinars, or recorded training sessions.
4. **Inferred from available evidence:** Synthesized from third-party audits, customer case studies, implementation reviews, and architecture teardowns.
5. **Unverified:** Marketing claims without technical corroboration (explicitly flagged to prevent unwarranted scoring).

---

## 5. Investigation Log: COMP-01 — Practo Insta HMS

- **Target URL:** `https://www.practo.com/providers/insta` / `https://www.instahms.com/`
- **Key Artifacts Generated:**
  - Individual Report: `/research/competitor-benchmark/individual-reports/practo-insta-hms-report.md`
  - Evidence Register: `/research/competitor-benchmark/evidence-register.csv`
  - Feature Comparison Matrix: `/research/competitor-benchmark/feature-comparison.csv`
- **Key Discoveries:**
  - **Backend Similarity:** Built on Core Java/Spring enterprise backend with PostgreSQL database—confirming relational Postgres is fully capable of driving an enterprise hospital ERP.
  - **Strengths Observed:** Deep LIS bi-directional equipment integration (HL7/ASTM), comprehensive pharmacy indents/returns with auto-posting to interim IPD bills, multi-tier corporate/insurance tariff rate plans, automated doctor consultant payout rules engine, and cross-department discharge clearance.
  - **Weaknesses Observed:** High onboarding friction (weeks/months), complex multi-window desktop interface with high cognitive load for nursing staff, complete dependence on persistent internet (cloud-only halts billing when offline), slow post-implementation customer support, and lack of WhatsApp-first asynchronous patient queue streaming.
- **Unresolved Questions:**
  - Exact database schema topology for Insta's doctor payout rules (split formula vs net realization).
  - Exact offline caching mechanism for local client terminals during cloud WAN link drops.

---

## 6. Investigation Log: COMP-02 — HealthPlix EMR

- **Target URL:** `https://www.healthplix.com/`
- **Key Artifacts Generated:**
  - Individual Report: `/research/competitor-benchmark/individual-reports/healthplix-emr-report.md`
  - Evidence Register: `/research/competitor-benchmark/evidence-register.csv` (Appended EVD-HPLX-001 through EVD-HPLX-020)
  - Feature Comparison Matrix: `/research/competitor-benchmark/feature-comparison.csv` (Appended HealthPlix comparative rows)
- **Key Discoveries:**
  - **Doctor-First Optimization:** Designed exclusively around the doctor's consultation experience. 1-click consultation initiation, sub-30-second prescription authoring via "Rx-Groups", and modular "Visit Pads" configured for 16+ medical specialties (Cardiology, Diabetology, Pediatrics, Oncology, etc.).
  - **Multilingual Prescription Generation:** Translates and prints digital prescriptions in up to 14 regional Indian languages, dramatically improving patient compliance in tier-2/3 towns.
  - **AI & Speech Documentation:** Embedded "H.A.L.O." (HealthPlix Ambient Listening Operations) voice scribe for ambient doctor-patient transcription and structured note drafting.
  - **Clinical Decision Support (CDSS) & DDI:** Interactive real-time drug-to-drug interaction alerts (e.g., Clopidogrel + Rabeprazole, Spironolactone + Telmisartan) at the exact moment of prescribing.
  - **Weaknesses Observed:** Almost zero Inpatient Department (IPD) functionality (no bed board, no ward census, no midnight-to-midnight bed-day billing, no eMAR, no discharge clearance). Lacks outpatient pharmacy POS, procurement, and comprehensive LIS equipment interfacing. Dual-sided business model relies on monetizing anonymized clinical prescription insights and sponsored engagement to pharmaceutical companies ("Robin" & RWE analytics).
- **Unresolved Questions:**
  - Real-world latency of H.A.L.O. ambient AI transcription on low-bandwidth rural connections.
  - Doctor opt-out rates regarding pharma-sponsored point-of-care educational cards.

---

## 7. Investigation Log: COMP-03 — Eka Care

- **Target URL:** `https://www.eka.care/`
- **Key Artifacts Generated:**
  - Individual Report: `/research/competitor-benchmark/individual-reports/eka-care-report.md`
  - Evidence Register: `/research/competitor-benchmark/evidence-register.csv` (Appended EVD-EKA-001 through EVD-EKA-022)
  - Feature Comparison Matrix: `/research/competitor-benchmark/feature-comparison.csv` (Appended Eka Care comparative rows)
- **Key Discoveries:**
  - **ABDM Pioneer & Infrastructure Stack:** Eka Care is India's leading private ABDM infrastructure provider, certified for Milestone 1 (M1 - ABHA creation & Scan & Share), Milestone 2 (M2 - Health Information Provider / care context linking), and Milestone 3 (M3 - Health Information User / consent-based record retrieval). Native FHIR R4 clinical data serialization and NRCES compliance.
  - **AI-Powered Document Intelligence:** Proprietary Vision OCR extracts structured medical parameters, units, and reference ranges from warped paper lab slips and PDFs into "Smart Reports", auto-generating longitudinal trend sparklines across 100+ clinical markers (HbA1c, lipids, TSH, creatinine).
  - **Ambient Voice AI & Clinical LLM:** "Eka Scribe" ambient voice scribe captures multilingual doctor-patient dialogue in 15+ regional languages, outputting structured SOAP notes; "DocAssist" generative AI copilot allows natural-language Q&A across longitudinal patient history.
  - **Dual OPD & Emerging IPD Scope:** Eka Care started as an OPD practice management OS and consumer PHR app (30M+ users), but has expanded into basic HMIS/IPD modules (bed allocation, eMAR, nursing checklists, discharge summaries).
  - **Weaknesses Observed:** IPD functionality is newer and lacks Qurio's automated NEWS2 deterioration scoring, tablet-optimized 48px touch ergonomic grids, and strict 5-department discharge clearance matrix with cryptographic SHA-256 HMAC gate pass tokens. Patient corridor flow lacks Qurio's live mobile wait-time stream (`/q/[token]`), relying instead on static SMS/WhatsApp blasts. Post-sales customer support responsiveness is a frequent complaint in public user reviews.
- **Unresolved Questions:**
  - Real-world accuracy of vision OCR on crumpled carbon-copy handwritten lab receipts.
  - Penetration of Eka Care's HMIS IPD module in 100+ bed hospitals vs small 10-20 bed nursing homes.

---

## 8. Final Decision Suite: Synthesis & Verification Audit

- **Verification Date:** November 2026
- **Audit Requirement:** Verify all 7 competitor reports exist before presenting final comparison.
- **Verification Status:**
  - **Present:** 3 of 7 Competitor Reports (Practo Insta HMS, HealthPlix EMR, Eka Care).
  - **Missing:** 4 of 7 Competitor Reports (COMP-04 to COMP-07: e.g., MocDoc, KareXpert, Attune/Halemind, MediXcel).
  - **Declaration:** In strict accordance with prompt instructions, the overall comparison is **NOT presented as complete**, but rather as an evidence-backed **Interim Strategic Decision Report** grounded in the 3 completed primary market archetypes (Enterprise ERP, Prescription EMR, and AI/ABDM Health OS).
- **Final Deliverables Created:**
  - Executive Summary: [`/research/competitor-benchmark/final/00-executive-summary.md`](file:///d:/Projects/HospitalAutomation/research/competitor-benchmark/final/00-executive-summary.md)
  - Master 14-Domain Comparison: [`/research/competitor-benchmark/final/01-master-comparison.md`](file:///d:/Projects/HospitalAutomation/research/competitor-benchmark/final/01-master-comparison.md)
  - Competitive Advantages: [`/research/competitor-benchmark/final/02-competitive-advantages.md`](file:///d:/Projects/HospitalAutomation/research/competitor-benchmark/final/02-competitive-advantages.md)
  - Product Gap Analysis: [`/research/competitor-benchmark/final/03-product-gap-analysis.md`](file:///d:/Projects/HospitalAutomation/research/competitor-benchmark/final/03-product-gap-analysis.md)
  - Prioritized Roadmap (30-60-90 Days): [`/research/competitor-benchmark/final/04-prioritized-roadmap.md`](file:///d:/Projects/HospitalAutomation/research/competitor-benchmark/final/04-prioritized-roadmap.md)
  - Product Strategy: [`/research/competitor-benchmark/final/05-product-strategy.md`](file:///d:/Projects/HospitalAutomation/research/competitor-benchmark/final/05-product-strategy.md)
  - Unified Master Matrix: [`/research/competitor-benchmark/final/final-feature-matrix.csv`](file:///d:/Projects/HospitalAutomation/research/competitor-benchmark/final/final-feature-matrix.csv)
