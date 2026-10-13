# IPD Unified Design System & Complete Patient Chart Specification

**Date:** 2026-10-13  
**Status:** Draft for Review  
**Scope:** Inpatient Department (IPD) Hub pages and complete 8-Tab Patient Chart suite.  
**Theme:** Excel-dense, high-efficiency hospital cockpit design system consistent across every screen.

---

## 1. Problem Statement & Motivation

During early iterations of IPD, hub pages (such as `My Patients` and `Wards`) were created with oversized cards, low informational density, thick border rings, and large buttons. In contrast, the recently deployed Doctor's Summary page (`/ipd/patients/[id]/summary`) features an Excel-dense, hospital-grade dashboard that clinicians praise for clarity and speed.

Currently, the IPD interface suffers from visual and functional discontinuity:
1. **Hub Page Inconsistency:** `My Patients` renders massive white cards with green borders, large fonts, and excessive whitespace, forcing unnecessary vertical scrolling.
2. **Bedside Inconsistency & Bugs:** Bedside view carries minor styling artifacts and a duplicate `"Dr. Dr."` consultant title bug.
3. **Incomplete Patient Chart Tabs:** Several tabs in the 8-tab patient chart navigation (`Vitals & I/O`, `Notes`, `Investigations`, `Consumables & Billing`) lack dedicated, unified views or remain placeholders.

This specification unifies the entire IPD module into one consistent design language and provides functional, robust implementations for every patient chart tab.

---

## 2. Design System Tokens & Layout Hierarchy

All IPD views must strictly adhere to the following visual primitives:

### 2.1 Typography & Density
- **Page & Section Titles:** `text-sm font-bold text-ink-950 tracking-tight`
- **Subheads / Section Markers:** `text-[11px] font-bold uppercase tracking-wider text-ink-500`
- **Data Labels & Field Values:** `text-xs text-ink-700 font-medium`
- **Clinical Metrics & Numbers:** `font-mono text-xs tabular-nums text-ink-900`
- **Micro Badges / Chips:** `text-[10px] sm:text-[11px] font-bold px-2 py-0.5 rounded border`

### 2.2 Containers & Surfaces
- **Cards / Panels:** `bg-white rounded-xl border border-ink-200/80 shadow-2xs p-3.5 sm:p-4`
- **Tables:** Spreadsheet-style tables with sticky header row (`bg-ink-50 text-[11px] font-bold text-ink-600 uppercase`), light horizontal cell borders (`border-ink-200/60`), subtle zebra striping (`even:bg-ink-50/20`), and hover highlight (`hover:bg-brand-50/30`).
- **Headers:** Compact single-row bars with 36px–40px height to reclaim vertical viewport space.

### 2.3 Interactive Elements & Plain English Copy
- **Primary Buttons:** `bg-brand-700 hover:bg-brand-800 text-white rounded-lg px-3 py-1.5 text-xs font-bold shadow-2xs`
- **Secondary / Action Buttons:** `bg-white hover:bg-ink-50 text-ink-700 border border-ink-300 rounded-lg px-2.5 py-1.5 text-xs font-semibold shadow-2xs`
- **Plain Everyday English:** No confusing clinical acronyms for common staff actions:
  - `Give Medicine` (not "Administer")
  - `Change Time` (not "Adjust Timing / Reschedule")
  - `Skip Dose` (not "Withhold / Missed")
  - `+ Give Extra Medicine` (not "Emergency / STAT Dose")
  - `+ Record Vitals` (not "Log Biometric Observations")
  - `+ Add Clinical Note` (not "Create SOAP Documentation")

---

## 3. Rewired Hub Pages

### 3.1 `My Patients` (`/ipd/my-patients`)
Replace the giant card layout with an **Excel-dense clinical roster table**:
- **Table Columns:**
  1. **Bed & Ward:** `font-mono font-bold text-ink-900` (e.g. `Bed 12 · Gen Ward A`)
  2. **Patient Name & UHID:** Name in title case with clickable link to `/ipd/patients/[admissionId]/summary`, UHID badge
  3. **Day of Stay:** `Day N` badge with admitted date tooltip
  4. **Primary Diagnosis:** Working diagnosis chip or "Not recorded"
  5. **Medication Status:** "Last given Xh ago" or "Doses pending"
  6. **Discharge Status:** `Ready for discharge` (green chip) or `In Care` (slate chip)
  7. **Direct Actions:** Compact action cluster (`[Patient File →]`, `[Discharge Ready]`, `[+ Tests]`)
- **Header:** Condensed title with count badge and search/filter by patient name or bed number.

### 3.2 `IPD Overview & Wards` (`/ipd`, `/ipd/ward`, `/ipd/ward/[wardId]`)
- **Awaiting Bed Queue:** Clean tabular list of patients shifted from OPD/Emergency awaiting bed allocation with 1-click bed assign.
- **Ward Bed Grid:** Compact grid cards with occupancy indicators, patient identifier chip, and quick navigation to Bedside chart.

### 3.3 `Bedside Treatment View` (`/ipd/ward/[wardId]/bed/[bedId]`)
- **Consultant Prefix Fix:** Sanitize doctor name to prevent `"Dr. Dr."` duplication.
- **Header Alignment:** Compact bed identification card aligned with the patient banner layout tokens.

---

## 4. Complete 8-Tab Patient Chart Suite (`/ipd/patients/[id]/*`)

All tabs share the persistent top `PatientBanner` and `TabNavigation` (total vertical height ~110px).

```
+----------------------------------------------------------------------------------------------------+
| PatientBanner: Kavita Shinde 33 yrs · Female | IPD #6159 | Gen Ward A · Bed 12 Day 11 | Dr. Mehra   |
+----------------------------------------------------------------------------------------------------+
| [Summary] [Orders] [eMAR] [Vitals & I/O] [Notes] [Investigations] [Consumables & Billing] [Discharge]
+----------------------------------------------------------------------------------------------------+
| TAB CONTENT AREA (Excel-dense spreadsheet / cockpit cards)                                          |
+----------------------------------------------------------------------------------------------------+
```

### 4.1 Tab 1: `Summary` (`/ipd/patients/[id]/summary`)
- Already implemented as the 60/40 cockpit:
  - Daily Medication Checkbox Matrix (`[✓] Given`, `[ ] Due`, `[ ! ] Overdue`, `[ ⏸ ] Skipped`).
  - TPR & NEWS2 flowsheet.
  - 24-Hour Fluid Balance summary card.
  - Admission Overview & Care Team.
  - Patient Chart Sheets launcher cards (links seamlessly to all other 7 tabs).

### 4.2 Tab 2: `Orders` (`/ipd/patients/[id]/orders`)
- **Active Orders Table:** Complete list of scheduled, SOS, and infusion orders.
  - Columns: Medicine Name & Strength, Route & Frequency, Scheduled Times, Start Date, Prescribing Doctor, Status.
  - Actions: `Change Time`, `Hold`, `Stop Order`, `Renew`.
- **Order History Section:** Past / discontinued orders with discontinuation timestamp and reason.
- **Header Action:** `+ Prescribe Medication` button linking directly to doctor round prescribing drawer.

### 4.3 Tab 3: `eMAR` (`/ipd/patients/[id]/emar`)
- **24-Hour Administration Timeline:** Chronological matrix of all scheduled doses for the current day.
- **Status Cells:** Given (green with nurse initials & exact time), Due (blue), Overdue (red), Skipped (amber with documented reason).
- **Administration Ledger:** Audit trail of all dose administrations with lot number, route, and verification.

### 4.4 Tab 4: `Vitals & I/O` (`/ipd/patients/[id]/vitals`)
- **Comprehensive TPR Flowsheet:**
  - Multi-reading matrix displaying: Time/Slot, Temp (°F), Pulse (bpm), BP Systolic/Diastolic, Resp Rate, SpO2 (%), Pain Score, AVPU, NEWS2 risk score.
  - Highlighting for abnormal parameters (fever > 100.4°F, tachycardia > 100, hypoxemia < 95%).
- **24-Hour Fluid Balance Ledger (Intake vs. Output):**
  - **Intake:** Oral fluids, IV infusions, Enteral feeds (ml).
  - **Output:** Urine, Surgical drains, RT aspirate, Vomitus (ml).
  - **Net Balance:** Dynamic calculation (`Net = Total Intake - Total Output`).
- **Interactive Modals:**
  - `+ Record Vitals`: Clean form with auto-calculated NEWS2 score.
  - `+ Record Fluid Balance`: Quick entry for intake/output with type selector and amount (ml).

### 4.5 Tab 5: `Notes` (`/ipd/patients/[id]/notes`)
- **Chronological Progress Notes Ledger:**
  - Filterable by note type: `All Notes`, `Doctor Rounds (SOAP)`, `Nursing Notes`, `Shift Handover`.
  - Structured SOAP view:
    - **S (Subjective):** Patient complaints & symptoms.
    - **O (Objective):** Clinical observations & vitals summary.
    - **A (Assessment):** Working diagnosis & clinical trajectory.
    - **P (Plan):** Treatment plan & orders for next 24h.
  - Note Card Metadata: Author name, role badge (`Doctor`, `Staff Nurse`), exact timestamp.
- **Action Modal:**
  - `+ Add Clinical Note`: Clean slide-over or modal with SOAP fields and plain text option.

### 4.6 Tab 6: `Investigations` (`/ipd/patients/[id]/investigations`)
- **Laboratory & Radiology Tracker:**
  - Columns: Test Name, Category (Biochemistry, Hematology, Microbiology, Imaging), Ordered At, Sample Status (`Ordered`, `Sample Collected`, `In Laboratory`, `Result Available`), Result Summary, Normal Range, Flag.
  - Highlighting: Abnormal / Critical values highlighted in red with badge `CRITICAL`.
- **Action:** `+ Order Tests` chip modal for quick test selection.

### 4.7 Tab 7: `Consumables & Billing` (`/ipd/patients/[id]/billing`)
- **Running IPD Ledger:**
  - Itemized table grouped by category:
    1. **Bed Charges:** Room/ward tariff × days of stay.
    2. **Medications Administered:** Unit price × doses recorded in eMAR.
    3. **Consumables & Supplies:** Syringes, IV sets, bandages, gloves recorded by nurses.
    4. **Doctor Round Fees:** Daily consultation visits.
    5. **Lab & Investigation Charges:** Executed diagnostic tests.
- **Financial Summary Card:**
  - Gross charges, applicable discounts, advance deposits paid, and current estimated balance due.
- **Actions:**
  - `+ Add Supply / Item`: Quick bedside consumable entry.
  - `Print Interim Bill`: Clean printable summary for patient relatives.

### 4.8 Tab 8: `Discharge` (`/ipd/patients/[id]/discharge`)
- **Structured 4-Step Discharge Clearance Cockpit:**
  1. **Medical Clearance:** Doctor sign-off (`Ready for discharge` toggle with discharge date & notes).
  2. **Pharmacy Return & Reconciliation:** Verification that unused medications are returned to pharmacy.
  3. **Billing Clearance:** Verification of final invoice generation and payment clearance.
  4. **Discharge Summary & Instructions:**
     - Discharge medications list with instructions.
     - Follow-up appointment date & instructions.
     - Emergency red flags & return precautions.
     - `Print Discharge Card / Summary` button.

---

## 5. Technical Architecture & Component Mapping

| URL Route | Component | Service / Action |
|-----------|-----------|------------------|
| `/ipd/my-patients` | `MyPatientsTable` | `listMyAdmittedPatients`, `setDischargeReadyAction` |
| `/ipd/ward/[wardId]/bed/[bedId]` | `BedsideTreatmentChart` | `getBedsideEmarData`, `administerDoseAction` |
| `/ipd/patients/[id]/summary` | `IpdSummaryCockpit` | `getIpdSummaryData` |
| `/ipd/patients/[id]/orders` | `OrdersTab` | `getMedicationOrdersForAdmission`, `stopMedicationOrderAction` |
| `/ipd/patients/[id]/emar` | `EmarTab` | `getBedsideEmarData`, `getAdministrationAuditHistory` |
| `/ipd/patients/[id]/vitals` | `VitalsAndIoTab` | `getVitalsReadings`, `getIntakeOutputSummary`, `recordVitalReadingAction`, `recordIntakeOutputAction` |
| `/ipd/patients/[id]/notes` | `NotesTab` | `getClinicalNotesForAdmission`, `recordClinicalNoteAction` |
| `/ipd/patients/[id]/investigations` | `InvestigationsTab` | `getInvestigationsForAdmission`, `orderTestsAction` |
| `/ipd/patients/[id]/billing` | `BillingAndConsumablesTab` | `getInterimBillForAdmission`, `recordSupplyAction` |
| `/ipd/patients/[id]/discharge` | `DischargeTab` | `getAdmissionSummary`, `toggleDischargeReadyClientAction` |

---

## 6. Verification & Quality Gates

1. **Visual Consistency Check:** Verify that padding, typography, border colors, and table structures across all pages match the design system tokens.
2. **Type Integrity:** `npx tsc --noEmit` must exit 0 with zero TypeScript errors.
3. **Unit & Integration Tests:**
   - Dedicated Vitest test files for each newly implemented or overhauled tab.
   - 100% pass on all 109+ existing test suites.
4. **Data Isolation (RLS):** All queries respect `tenant_isolation` policies on all tables.
