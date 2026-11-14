# Qurio HMS — Module Status & Feature Classification

**Document Title:** Feature Classification & Architectural Disposition Matrix  
**Audit Path:** `docs/audit/MODULE_STATUS.md`  
**Audit Date:** November 2026  
**Status:** Read-Only Baseline Architectural Audit  

---

## 1. Classification Categories & Evaluation Standards

Every module, submodule, and operational screen in the Qurio repository has been inspected across code, database relations, and user workflows, and assigned one of six definitive dispositions:

- **KEEP:** Implemented cleanly, technically robust, tested, and aligned with target hospital workflows. Preserve without unnecessary modification.
- **FIX:** Implemented with domain logic, but suffers from severe functional, data integrity, or technical bugs that must be corrected.
- **EXTEND:** Functional foundation exists, but requires essential clinical, operational, or financial capabilities to become market-ready.
- **BUILD:** Required hospital operational capability is completely absent from the codebase and must be built from the ground up.
- **DEFER:** Advanced or non-essential capability that should be postponed beyond the initial market-ready release.
- **REMOVE:** Redundant, dead, orphaned, or unmaintained code that clutters the repository.

---

## 2. Comprehensive Module Classification Matrix

### 2.1 Outpatient Department (OPD) & Registration

| Submodule / Feature | Current Code Reference | Status | Disposition | Detailed Technical & Workflow Rationale |
|---|---|---|---|---|
| **Live Mobile Queue Tracker (`/q/[token]`)** | `app/q/[token]/page.tsx`, `lib/services/queue.ts` | Fully implemented | **KEEP** | Industry-leading SSE real-time wait-time stream. Completely eliminates corridor congestion; highly stable. |
| **Chamber Queue Row-Level Locking** | `lib/services/queue.ts:callNextPatient` | Fully implemented | **KEEP** | PostgreSQL `SELECT ... FOR UPDATE` prevents concurrent chamber race conditions during peak OPD rushes. |
| **Walk-in Fast Registration** | `lib/services/queue.ts:createWalkIn` | Basic implementation | **EXTEND** | Currently captures only name and phone. Must be extended to capture age, gender, address, and insurance sponsor. |
| **ABDM M1 Scan & Share Check-In** | None in codebase | Not available | **BUILD** | Critical national workflow to scan reception QR, auto-populate demographics via ABHA, and earn DHIS subsidies. |
| **Duplicate Patient Prevention** | `lib/services/patient-identity.ts` | Partially implemented | **FIX** | Only matches phone post-facto; must warn receptionists *before* token issuance and prevent accidental duplicate UHIDs. |
| **Corridor Waiting Room TV Display** | `app/display/[branchId]/page.tsx` | Fully implemented | **KEEP** | Reliable SSE token calling screen for wall-mounted corridor televisions. |
| **Online Appointment Booking** | `app/book/page.tsx`, `lib/services/booking.ts` | Fully implemented | **KEEP** | Functional public booking engine with doctor schedule checks and slot capacity controls. |

---

### 2.2 Doctor Consultation & Clinical EMR

| Submodule / Feature | Current Code Reference | Status | Disposition | Detailed Technical & Workflow Rationale |
|---|---|---|---|---|
| **Single-Page Consultation Panel** | `app/(app)/dashboard/consultation-panel.tsx` | Fully implemented | **KEEP** | Reactive workspace with 1.5s draft autosaving, ICD-10 search, and dosage presets. |
| **Pre-Bundled "Rx-Groups"** | None in codebase | Not available | **BUILD** | High-priority productivity capability to insert multi-drug clinical treatment packs in 1 click (sub-30s prescribing). |
| **OPD-to-IPD Clinical Order Continuity**| `consultation-panel.tsx:shiftToIpdAction` | Partially implemented | **FIX** | Shifting a patient to the ward drops all active prescriptions. Must convert OPD medications into draft IPD orders. |
| **Specialty Consultation Presets** | `consultation-panel.tsx` | Basic implementation | **EXTEND** | Currently a static generic card. Extend with dynamic sub-cards for Pediatrics (growth curves) and Diabetology. |
| **English Prescription Printing** | `app/print/prescription/[id]/page.tsx` | Fully implemented | **KEEP** | Clean A4/thermal clinical letterhead print view. *Non-negotiable rule: Keep prescription text strictly in English.* |
| **Drug-to-Drug Interaction (DDI) Checks**| None in codebase | Not available | **BUILD** | Real-time safety engine to warn doctors against dangerous polypharmacy combinations (e.g., Clopidogrel + PPI). |
| **Multilingual Prescription Translation** | None in codebase | Not available | **REMOVE** | *Explicit user instruction: Remove Marathi/Hindi prescription directions from roadmap; all directions must remain English.* |

---

### 2.3 Inpatient Department (IPD) & Bed Management

| Submodule / Feature | Current Code Reference | Status | Disposition | Detailed Technical & Workflow Rationale |
|---|---|---|---|---|
| **Visual Bed Board & Census Grid** | `components/ipd/bed-grid.tsx`, `app/(app)/ipd/page.tsx` | Fully implemented | **KEEP** | Modern tablet-optimized grid showing ward occupancy, bed status (Occupied, Cleaning, Vacant), and patient details. |
| **ADT Bed Transfers** | `lib/services/ipd-census.ts:transferBed` | Fully implemented | **KEEP** | Atomic transfer transaction closing previous bed occupancy and opening new occupancy cleanly. |
| **Automated Room Rent Proration** | `lib/services/bed-days.ts` | Basic implementation | **EXTEND** | Prorate room charges when patients transfer across different ward tiers (e.g., General Ward to ICU) mid-day. |
| **Inpatient Face-Sheet Overview** | `app/(app)/ipd/admissions/[id]/page.tsx` | Fully implemented | **KEEP** | Clear display of primary diagnosis, admitting consultant, assigned bed, and active clinical care team. |
| **Inpatient Admission Consents** | `lib/services/consents.ts` | Functional | **KEEP** | Captures digital signature and photo proofs for admission consent forms. |

---

### 2.4 Nursing & Bedside Treatment

| Submodule / Feature | Current Code Reference | Status | Disposition | Detailed Technical & Workflow Rationale |
|---|---|---|---|---|
| **Bedside eMAR Medication Administration**| `components/ipd/bedside/bedside-treatment-chart.tsx`| Fully implemented | **KEEP** | 48px touch targets purpose-built for budget Android tablets. Excellent nurse ergonomics. |
| **Automated NEWS2 Deterioration Alerts** | `lib/domain/vitals-news2.ts` | Fully implemented | **KEEP** | Unique clinical safety moat; automatically calculates early-warning scores and flags physiological decompensation. |
| **Bedside Mistake Undo Window** | `lib/services/ipd-undo.ts`, `/api/ipd/care-entries/undo`| Fully implemented | **KEEP** | 120-second safety window allowing nurses to retract accidental taps before charges lock to the bill. |
| **Fluid Balance (Intake / Output) Charts** | `lib/services/tpr.ts`, `lib/db/schema.ts:intakeOutput` | Basic implementation | **EXTEND** | Enhance unstructured notes with structured tracking across IV fluids, oral intake, urinary, and drain outputs. |
| **Ward Pharmacy Indents & eMAR Deduction**| None in codebase | Not available | **BUILD** | Connect bedside medication administration events to ward stock deductions and automated pharmacy replenishment. |

---

### 2.5 Pharmacy & Inventory Management

| Submodule / Feature | Current Code Reference | Status | Disposition | Detailed Technical & Workflow Rationale |
|---|---|---|---|---|
| **Outpatient Retail Pharmacy POS** | None in codebase | Not available | **BUILD** | **Critical P0.** Build `/pharmacy` dispensing queue, batch selection, generic substitution, and retail GST billing. |
| **Medicine Master Catalogue** | `lib/services/medicines.ts`, `lib/db/schema.ts:medicines`| Functional | **EXTEND** | Currently flat medicine list. Extend with batch numbers, expiry dates, GST rates, and manufacturer details. |
| **Ward Stock Management & Indents** | `lib/db/schema.ts:stockLocations`, `stockLedger` | Schema only / Untracked | **BUILD** | Tables exist in schema but lack UI workflows. Connect ward nurses to pharmacy store replenishment indents. |
| **Procurement & Purchase Orders (PO)** | `lib/db/schema.ts:purchaseReceipts` | Schema scaffold | **DEFER** | Enterprise supply-chain procurement; defer to Phase 3 after retail dispensing and ward indents are stabilized. |

---

### 2.6 Laboratory & Diagnostic Workflows

| Submodule / Feature | Current Code Reference | Status | Disposition | Detailed Technical & Workflow Rationale |
|---|---|---|---|---|
| **Numeric Lab Result Entry & Reference Ranges**| None in codebase | Not available | **BUILD** | **Critical P1.** Build `/laboratory` worklist for technicians to record analyte values against age/gender ranges. |
| **Pathology PDF Report Generation** | None in codebase | Not available | **BUILD** | Official branded laboratory report with technician entry, pathologist digital approval, and reference intervals. |
| **Test Follow-Up Tracker (Track B Split)** | `drizzle/0047_test_follow_up.sql` | Orphaned migration | **REMOVE** | Legacy table tracking physical follow-up calls rather than diagnostic results. Deprecate and replace with true LIS. |
| **Bi-Directional Analyzer Interfacing** | None in codebase | Not available | **DEFER** | Direct RS-232/ASTM serial machine drivers are cost-prohibitive for MVP. Defer to third-party LIS middleware integration. |

---

### 2.7 Billing, Tariffs & Revenue Cycle

| Submodule / Feature | Current Code Reference | Status | Disposition | Detailed Technical & Workflow Rationale |
|---|---|---|---|---|
| **Interim Inpatient Billing Ledger** | `lib/services/ipd-billing.ts` | Fully implemented | **KEEP** | Real-time bill calculation combining daily bed rent, care entries, and deposits with audit event logging. |
| **Multi-Tier Tariff Rate Plans** | `lib/services/ipd-config.ts` | Basic implementation | **BUILD** | Single flat price per charge item blocks insurance/corporate adoption. Build `rate_plans` (Cash vs TPA vs Corporate). |
| **Advance Deposits & Refund Handling** | `app/(app)/ipd/deposits/page.tsx` | Fully implemented | **KEEP** | Clean handling of patient deposits, receipt issuance, and deduction from final inpatient settlement. |
| **Consultant Doctor Payouts Engine** | None in codebase | Not available | **BUILD** | High-value rules engine automating visiting doctor revenue-sharing (OPD splits, OT surgery splits minus consumables). |
| **Unbilled Services Leakage Detector** | None in codebase | Not available | **BUILD** | Cross-checks bedside nursing entries and diagnostic orders against settled bills to flag unbilled services. |

---

### 2.8 Discharge Management & Medico-Legal Security

| Submodule / Feature | Current Code Reference | Status | Disposition | Detailed Technical & Workflow Rationale |
|---|---|---|---|---|
| **5-Department Clearance Matrix** | `app/(app)/ipd/patients/[id]/discharge/page.tsx`| Fully implemented | **KEEP** | Atomic verification across Medical, Pharmacy, Nursing, Lab, and Billing. Essential hospital operational guard. |
| **Cryptographic Discharge Gate Pass** | `lib/services/ipd-clearance.ts` | Fully implemented | **KEEP** | SHA-256 HMAC anti-counterfeit QR token for security guards at hospital exits. |
| **Cryptographic Audit Ledger (`acct_events`)**| `lib/services/evidence.ts` | Fully implemented | **KEEP** | Forward-chained HMAC SHA-256 event hashing with hourly signed digests. Supreme asset for malpractice defense. |
| **Database Schema Drift on Clearances** | `lib/db/schema.ts:ipdDischargeClearances` | Drifted from migrations | **FIX** | Table exists in DB and schema, but has no migration SQL file. Generate clean migration to restore deployment safety. |

---

### 2.9 Notifications, Integrations & Interoperability

| Submodule / Feature | Current Code Reference | Status | Disposition | Detailed Technical & Workflow Rationale |
|---|---|---|---|---|
| **Native Meta WhatsApp Cloud API Bot** | `lib/services/whatsapp.ts`, `app/api/webhooks/whatsapp`| Fully implemented | **KEEP** | Direct Meta Graph API integration. 4-step interactive booking bot with zero vendor markups. |
| **Automated Notification Outbox Worker** | `scripts/worker-daemon.ts`, `notification_outbox`| Fully implemented | **KEEP** | Robust outbox pattern with exponential backoff and idempotency guards. |
| **ABDM Milestone 1 (M1) Integration** | None in codebase | Not available | **BUILD** | Implement ABHA creation and Scan & Share QR check-in to access national health network and DHIS subsidies. |
| **ABDM Milestone 2 & 3 (HIP / HIU)** | None in codebase | Not available | **DEFER** | Separate technical discovery track. Plan architecture, but defer full production commitment beyond 90-day MVP. |
| **FHIR R4 Schema Serialization** | None in codebase | Not available | **BUILD** | Lightweight TypeScript utility serializing encounters into NRCES-compliant FHIR R4 JSON bundles. |
