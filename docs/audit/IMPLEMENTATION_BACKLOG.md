# Qurio HMS — Master Implementation Backlog

**Document Title:** Prioritized Engineering Backlog Mapped by Phase & Operational Impact  
**Audit Path:** `docs/audit/IMPLEMENTATION_BACKLOG.md`  
**Audit Date:** November 2026  
**Status:** Baseline Implementation Plan  

---

## 1. Prioritization Framework & Phase Architecture

Every technical defect, workflow gap, and required capability identified during the repository audit is organized across three primary execution phases, prioritized by operational necessity:

- **P0 (Critical Reliability, Security, Data Integrity, or Essential Workflow Blockers):** Must be executed before any production or demonstration deployment.
- **P1 (Required for Core Multi-Specialty Hospital Demonstration):** Essential operational workflows required to show connected hospital operations.
- **P2 (High-Value Operational Improvements):** Workflows that reduce friction, automate exception handling, and elevate hospital efficiency.
- **P3 (Advanced Capabilities & Future Opportunities):** Long-term strategic differentiators.

```
┌───────────────────────────────────────────────────────────────────────────┐
│                     QURIO PHASE-WISE EXECUTION ARCHITECTURE               │
│                                                                           │
│   PHASE 1: FOUNDATION (Stabilize, Connect OPD-IPD & Doctor Speed)         │
│   • Reconcile Drizzle migration journal syntax & untracked schema         │
│   • Implement OPD-to-IPD medication order continuity (drafts + review)    │
│   • Build pre-bundled Rx-Groups for sub-30s prescribing (English only)    │
│   • Establish stable patient UHID & multi-factor duplicate detection      │
│                                                                           │
│   PHASE 2: OPERATIONAL COMPLETENESS (Connect Revenue Departments)         │
│   • Build Outpatient Retail Pharmacy POS, batch inventory & dispensing    │
│   • Implement multi-payer rate plans (Cash vs TPA Insurance vs Corporate) │
│   • Build Laboratory test worklist, numeric analyte entry & verification  │
│                                                                           │
│   PHASE 3: DIFFERENTIATION & OPTIMIZATION (Hospital Operations & Intel)   │
│   • Connect ward pharmacy indents & eMAR stock deduction                  │
│   • Build operational dashboards (unbilled services, pending discharge)   │
│   • Initial consultant doctor payout reporting                            │
│   • ABDM discovery & sandbox integration plan (separate discovery track)  │
└───────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Phase 1 — Foundation

### Item P1.1: Reconcile Migration Journal & Database Schema Drift
- **Status:** **COMPLETED** (Report: [`docs/modules/01-technical-reliability/COMPLETION_REPORT.md`](file:///d:/Projects/HospitalAutomation/docs/modules/01-technical-reliability/COMPLETION_REPORT.md))
- **Priority:** **P0 (Critical Technical Blocker)**
- **Resolution:** Reconciled `drizzle/meta/_journal.json`, created forward idempotent migrations `0072_ipd_discharge_clearances.sql` and `0073_take_home_rx_columns.sql`, synchronized migration hashes in `drizzle.__drizzle_migrations`, archived orphaned Track B files to `drizzle/archive/track-b/`.
- **Verification Evidence:**
  - `npm run db:lint-migrations`: 59 checked, 0 errors.
  - `npm run db:migrate:plan`: 59 applied, 0 pending, 0 warnings.
  - `npm run db:bootstrap`: role & RLS verified.
  - `npm test`: 78 test files, 956 tests 100% passing.

---

### Item P1.2: OPD-to-IPD Medication Order Porting & Continuity
- **Status:** **COMPLETED** (Report: [`docs/modules/02-opd-to-ipd-continuity/COMPLETION_REPORT.md`](file:///d:/Projects/HospitalAutomation/docs/modules/02-opd-to-ipd-continuity/COMPLETION_REPORT.md))
- **Priority:** **P0 (Critical Clinical Safety Blocker)**
- **Resolution:**
  - Implemented OPD dose & frequency schedule parser (`lib/domain/opd-to-ipd-parser.ts`).
  - Implemented transactional draft order porting service (`lib/services/ipd-admission-continuity.ts`) hooked into `shiftToIpd` (`lib/services/admissions.ts`).
  - Added doctor review, approval, and rejection server actions with RBAC and allergy conflict gates (`app/(app)/ipd/actions.ts`).
  - Integrated Amber OPD Draft Orders Review Banner in Orders tab (`components/ipd/orders/minimal-orders-tab.tsx`, `app/(app)/ipd/patients/[id]/orders/page.tsx`).
  - Added pending drafts attention item to Doctor Clinical Summary Cockpit (`lib/services/ipd-summary.ts`).
- **Verification Evidence:**
  - 100% test pass on continuity suites (32 tests across 5 test suites).
  - 100% test pass on inpatient test suite (41/41 tests passing).
  - 100% test pass on full regression suite (`npm test`: 79 files, 969 tests passing).
  - Adheres strictly to English-Only Mandate (Rule 2.2).

---

### Item P1.3: Doctor Productivity — Pre-Bundled "Rx-Groups"
- **Status:** **COMPLETED** (Report: [`docs/modules/03-doctor-speed-rx-groups/COMPLETION_REPORT.md`](file:///d:/Projects/HospitalAutomation/docs/modules/03-doctor-speed-rx-groups/COMPLETION_REPORT.md))
- **Priority:** **P1 (High Operational Impact)**
- **Resolution:**
  - Designed & implemented `rx_groups` and `rx_group_items` tables with multi-tenant RLS (`drizzle/0074_rx_groups.sql`).
  - Implemented service layer `lib/services/rx-groups.ts` with auto-seeding of 5 standard evidence-based clinical protocols (URI, Gastroenteritis, HTN, Diabetes, Pediatrics).
  - Built server actions `listRxGroupsDynamic` and `saveAsRxGroupDynamic` in `app/(app)/dashboard/consultation-actions.ts`.
  - Built UI components `<RxGroupsShelf />` with category tabs and `<SaveRxGroupModal />` dialog.
  - Integrated into `app/(app)/dashboard/consultation-panel.tsx` with duplicate prevention and safe diagnosis/advice auto-population.
  - Preserved full line-by-line editability and autonomy.
- **Verification Evidence:**
  - 100% test pass on new Rx-Groups test suites (16 tests across 5 test suites).
  - 100% test pass on full regression suite (`npm test`: 79 test files, 969 tests passing).
  - 60 migrations verified with 0 lint errors and 0 pending migrations.
  - Strictly adheres to English-Only Mandate (Rule 2.2).

---

### Item P1.4: Patient Record Foundations — Stable UHID & Duplicate Prevention
- **Status:** **COMPLETED** (Report: [`docs/modules/04-patient-identity-duplicate-prevention/COMPLETION_REPORT.md`](file:///d:/Projects/HospitalAutomation/docs/modules/04-patient-identity-duplicate-prevention/COMPLETION_REPORT.md))
- **Priority:** **P1 (High Operational Impact)**
- **Resolution:**
  - Standardized hospital UHID formatting `<HOSPITAL_PREFIX>-<YYYY>-<SEQUENCE>` in `lib/domain/uhid.ts` and `nextMrnInTx`.
  - Implemented Indian phonetic transliteration normalizer (`phoneticKey`) and Damerau-Levenshtein distance in `lib/domain/patient-match.ts`.
  - Implemented 4-tier multi-factor match scoring (`scorePatientMatch`).
  - Added database migration `0075_patient_merge_alerts.sql` and schema table `patient_merge_alerts` with multi-tenant RLS.
  - Implemented `lib/services/patient-merge.ts` (candidate search, critical merge checks, atomic merge execution).
  - Extended permissions matrix for `'patients.merge_records'` allowing receptionists and owners.
  - Implemented server actions in `app/(app)/dashboard/patient-identity-actions.ts`.
  - Built interactive `<PatientDuplicateShelf />` in walk-in modal and `<PatientMergeModal />` for administrative record merging.
- **Verification Evidence:**
  - 100% test pass on new test suites (88 tests across 8 test suites).
  - 100% test pass on full regression suite (`npm test`: 81 files, 981 tests passing).
  - 61 migrations verified with 0 lint errors and 0 pending migrations.
  - Strictly adheres to English-Only Mandate (Rule 2.2).

---

## 3. Phase 2 — Operational Completeness

### Item P2.1: Outpatient Retail Pharmacy POS & Inventory MVP [COMPLETED]
- **Status:** **Completed & Verified** (See [COMPLETION_REPORT.md](file:///d:/Projects/HospitalAutomation/docs/modules/05-retail-pharmacy-pos/COMPLETION_REPORT.md))
- **Priority:** **P0 (Critical Revenue Blocker for Market Readiness)**
- **Problem:** Zero pharmacy dispensing, batch tracking, or retail billing in Qurio. The hospital loses 100% of high-margin retail pharmaceutical sales to outside chemists.
- **Implemented Solution:**
  - Plan entitlement gating via `hasInhousePharmacy` (external pharmacy mode vs active in-house retail).
  - Dedicated `/pharmacy` cockpit with OPD Prescription Queue and Walk-in Counter Sale (POS).
  - First-Expiry-First-Out (FEFO) batch allocation with manual override capability.
  - Transaction-safe inventory deduction in `stockLedger` (`kind: 'give'`) and `stockBalances`.
  - Indian statutory GST calculation (0%, 5%, 12%, 18%) with CGST/SGST split down to the exact paise.
  - Printable thermal (80mm) cash memo and standard A4 tax invoice (Rule 2.2 compliant: English only).
  - Authorized returns workflow restocking inventory (`kind: 'receive'`) and logging refund details.
- **Delivered Files:**
  - `drizzle/0076_pharmacy_pos.sql` (migration)
  - `lib/db/schema.ts` (`pharmacySales`, `pharmacySaleItems`, `pharmacyReturns`, `pharmacyReturnItems`)
  - `lib/domain/pharmacy.ts` & `lib/domain/pharmacy.test.ts`
  - `lib/domain/entitlements.ts` & `lib/domain/entitlements.test.ts`
  - `lib/services/pharmacy.ts` & `lib/services/pharmacy.test.ts`
  - `app/(app)/pharmacy/actions.ts` & `app/(app)/pharmacy/actions.test.ts`
  - `app/(app)/pharmacy/page.tsx`
  - `components/pharmacy/ExternalPharmacyBanner.tsx`
  - `components/pharmacy/PharmacyCockpit.tsx`
  - `components/pharmacy/PrescriptionQueueTab.tsx`
  - `components/pharmacy/CounterSaleTab.tsx`
  - `components/pharmacy/PharmacyReceiptModal.tsx`
  - `components/pharmacy/pharmacy-pos.test.tsx`
  - `docs/modules/05-retail-pharmacy-pos/COMPLETION_REPORT.md`
- **Reverse Engineering Evidence:**
  - Practo Insta: `ev_bc25c9348db79d26993959b673930d646e20083d945bd6f792d492317b1e7b10`
  - Marg ERP: `ev_7f09fd3d49af79b3b016f33cb6daf090d15118d660b17d275ff4ca551e454f72`
- **Verification:** 100% pass across all 83 test files and 990 tests; 0 migration lint errors.

---

### Item P2.2: Multi-Tier Tariff Rate Plans (Cash vs. TPA Insurance vs. Corporate)
- **Status:** **COMPLETED** (Report: [`docs/modules/06-multi-tier-tariffs/COMPLETION_REPORT.md`](file:///d:/Projects/HospitalAutomation/docs/modules/06-multi-tier-tariffs/COMPLETION_REPORT.md))
- **Priority:** **P1 (High Commercial Value)**
- **Capabilities Delivered:**
  - Configurable `rate_plans` and granular `charge_item_tariffs` with tenant isolation RLS (`0077_multi_tier_rate_plans.sql`).
  - Pure calculation domain `lib/domain/tariff.ts` implementing deterministic priority resolution (Item Override -> Rate Plan Modifier -> Base Catalog Price).
  - Bed-days room charges and bedside nursing care entries automatically resolve effective tariff prices.
  - Inpatient medicines bypass tariff plans and charge standard medicine selling prices.
  - Strict historical bill immutability: billed items snapshot unit prices at insertion time.
  - Interactive Cockpit UI at `/settings/tariffs` with inline rupee editing for tariff matrices and plan configuration.
  - IPD admission integration with `ratePlanId` support on `encounter_payers`.
- **Delivered Files:**
  - `drizzle/0077_multi_tier_rate_plans.sql` (migration)
  - `lib/db/schema.ts` (`ratePlans`, `chargeItemTariffs`, `encounterPayers.ratePlanId`)
  - `lib/domain/tariff.ts` & `lib/domain/__tests__/tariff.test.ts`
  - `lib/domain/payer.ts` & `lib/domain/__tests__/payer.test.ts`
  - `lib/domain/permissions.ts` (`tariffs.manage`, `tariffs.view`)
  - `lib/services/tariffs.ts` & `lib/services/__tests__/tariffs.test.ts`
  - `lib/services/bed-days.ts` (integrated with tariff price resolution)
  - `lib/services/ipd-billing.ts` (integrated with tariff price resolution)
  - `lib/services/__tests__/ipd-billing-tariffs.test.ts`
  - `app/(app)/settings/tariffs/actions.ts`
  - `app/(app)/settings/tariffs/page.tsx`
  - `docs/modules/06-multi-tier-tariffs/COMPLETION_REPORT.md`
- **Reverse Engineering Evidence:**
  - Practo Insta / Industry Tariff Engine: `ev_ea615599a33f5bbb9e528e6a937a9a67595774d494c5209d465dc24760ee7819`
- **Verification:** 100% pass across all 84 test files and 998 tests; 0 migration lint errors.

---

### Item P2.3: Laboratory Management MVP — Worklist, Result Entry & Verification
- **Priority:** **P1 (High Operational Impact)**
- **Problem:** Test ordering exists, but laboratory technicians cannot record numeric analyte values, flag abnormal ranges, or issue verified pathology reports.
- **Proposed Solution:** Build a `/laboratory` dashboard:
  - Test order worklist (pending collection, in-progress, pending approval).
  - Numeric result entry form with age/gender-specific normal reference ranges.
  - Automatic red-highlight flagging for abnormal values.
  - Two-stage verification: technician draft entry $\to$ authorized pathologist release.
  - Printable official pathology report with digital approval metadata.
- **Affected Files:**
  - `app/(app)/laboratory/page.tsx` (new)
  - `components/laboratory/result-entry-form.tsx` (new)
  - `app/print/lab-report/[id]/page.tsx` (new)
  - `lib/services/laboratory.ts` (new)
  - `lib/domain/permissions.ts` (add `'lab_technician'`, `'lab_approver'` roles)
  - `lib/db/schema.ts` (`lab_orders`, `lab_test_templates`, `lab_results`)
- **Dependencies:** Reverse-engineer LIS workflows from CrelioHealth and Practo Insta via MCP tool.
- **Acceptance Criteria:**
  - Doctor orders CBC/LFT; order routes immediately to lab worklist.
  - Technician enters values; abnormal numbers are flagged based on reference ranges.
  - Pathologist approves report; report reflects immediately in patient EMR.

---

## 4. Phase 3 — Differentiation & Optimization

### Item P3.1: Pharmacy & IPD Integration (Ward Indents & eMAR Stock Deduction)
- **Priority:** **P1 (High Operational Efficiency)**
- **Problem:** Inpatient medication administration from eMAR does not deduct ward or central pharmacy inventory, causing inventory discrepancies.
- **Proposed Solution:**
  - Ward pharmacy indents: ward nurses raise digital requisitions for ward stock.
  - eMAR stock deduction: administering a medication deducts stock from the assigned ward location.
  - Automated near-expiry and low-stock alerts.
- **Affected Files:**
  - `lib/services/mar-stock.ts`
  - `components/ipd/bedside/bedside-treatment-chart.tsx`
  - `lib/services/stock.ts`
- **Dependencies:** Reverse-engineer ward stock flows from KareXpert and Bahmni via MCP tool.
- **Acceptance Criteria:**
  - Medication administration records exact batch consumed.
  - Missed, refused, or withheld doses do not trigger stock deductions.

---

### Item P3.2: Hospital Operational Intelligence & Executive Dashboards
- **Priority:** **P2 (Management Value)**
- **Problem:** Administrators lack visibility into unbilled services, discharge bottlenecks, and diagnostic delays.
- **Proposed Solution:** Build executive operational dashboards:
  - Unbilled services report: flags nursing care entries or lab tests missing from bills.
  - Pending discharge cockpit: highlights patients delayed by pending clearance or billing.
  - Lab turnaround time (TAT) compliance reports.
  - Pharmacy sales, stock aging, and expiry loss reports.
- **Affected Files:**
  - `app/(app)/reports/page.tsx`
  - `app/(app)/reports/unbilled/page.tsx` (new)
  - `lib/services/reports.ts`
- **Dependencies:** Reverse-engineer MIS reports from Practo Insta via MCP tool.

---

### Item P3.3: Initial Consultant Doctor Payout Reporting
- **Priority:** **P2 (Financial Value)**
- **Problem:** Visiting doctor commission splits are calculated manually on spreadsheets.
- **Proposed Solution:** Rules engine calculating doctor payouts based on configured percentages (OPD consultation fees, surgical procedure splits minus consumables).
- **Affected Files:**
  - `app/(app)/reports/doctor-payouts/page.tsx` (new)
  - `lib/services/payouts.ts` (new)
- **Dependencies:** Validate payout rules with pilot hospital stakeholders.

---

### Item P3.4: ABDM Discovery & Sandbox Planning (Separate Discovery Track)
- **Priority:** **P3 (Technical Discovery — Not a 90-Day Production Commitment)**
- **Problem:** Qurio is isolated from the national Ayushman Bharat Digital Mission (ABDM).
- **Tasks:**
  - Study NHA official documentation for M1, M2, and M3.
  - Formulate FHIR R4 data mapping strategy.
  - Assess sandbox onboarding requirements.
  - Deliver: `docs/integrations/ABDM_DISCOVERY.md`, `ABDM_GAP_ANALYSIS.md`, and `ABDM_SANDBOX_PLAN.md`.
- **Dependencies:** National Health Authority (NHA) ABDM developer portal.
