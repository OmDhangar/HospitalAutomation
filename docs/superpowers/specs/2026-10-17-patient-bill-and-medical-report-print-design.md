# Patient Bill & Medical Report Print Design Spec

**Date**: 2026-10-17  
**Status**: Approved in principle by User  
**Branding Requirement**: Clean header without tagline; include `Powered by QuriioHQ` in corner areas for marketing.

---

## 1. Overview & Objectives

Currently, clicking "Print Interim Bill" on the Consumables & Billing tab triggers an unstyled browser `window.print()` directly on the dashboard screen, resulting in an unformatted UI screenshot. Furthermore, the print bill page (`/print/ipd-bill/[billId]`) uses a generic day-wise list that does not reflect a standard, professional Indian hospital bill receipt.

This specification defines:
1. **Redesigned Bill cum Receipt**: A pixel-perfect, structured A4 bill receipt matching the physical format of Guruved Hospital & Criticare Centre:
   - Header with hospital name and official registration badge/seal (no tagline).
   - "Bill cum Receipt" (or "Interim Bill cum Receipt" when draft/inpatient).
   - Structured 2-column patient & admission grid (Name, Age, Gender, Address, Location, Phone, Patient ID/MRN, Doctor, Department; Bill No, Bill Date, IPD No, Admission Date & Time, Discharge Date & Time).
   - Service items categorized with category subtotals (`HOSPITAL CHARGES`, `INVESTIGATION`, `PHARMACY & CONSUMABLES`, `ROOM & CLINICAL VISITS`).
   - Financial totals: Total Bill Amount, Less Net Payments received, Balance Due, Net Amount.
   - Formal signature blocks: Patient signature on the left, Hospital stamp in the center, Doctor signature and credential stamp (MBBS, MD, Reg. No.) on the right.
   - Subtle branding in the corner: `Powered by QuriioHQ`.
2. **Medical Report Dossier (Lab Investigations + Doctor Progress Notes)**:
   - An option on the print page: a non-printing control bar with a checkbox `[✓] Include Lab & Doctor Progress Report`.
   - When checked, the medical report automatically appends on subsequent pages (`break-before: page;`):
     - Section A: **Laboratory & Diagnostic Investigations** (Test name, Ordered date/time, Specimen status, Result/Report findings, Reference range, Critical flags).
     - Section B: **Doctor Progress & SOAP Notes** (Daily rounding notes, S-O-A-P structure, consulting doctor name, nursing shift observations).
     - Section C: **Discharge Clinical Summary** (if finalized: primary diagnosis, condition at discharge, take-home prescriptions, and follow-up advice).
3. **Seamless Navigation & Print Integration**:
   - The "Print Interim Bill" button in `BillingAndConsumablesTab` routes directly to the dedicated print page in interim mode.
   - The "Print Bill" button on the discharge settlement page routes to the dedicated print page in final mode.
   - The "Print Discharge Card" button in `DischargeTab` routes to the discharge summary print view.

---

## 2. Architecture & Data Flow

### 2.1 Print Route
- Canonical print route: `/print/ipd-bill/[billId]`
- Query parameter options:
  - `?report=1`: Pre-checks "Include Lab & Doctor Progress Report"
  - `?print=0`: Disables auto-opening `window.print()` upon load (useful for previewing)
  - Supports both finalized bills (`bills.status = 'final'`) and draft running bills (`bills.status = 'draft'`).
  - For running stays accessed directly by admission ID: support `/print/ipd-admission/[admissionId]/bill` or fetching active bill by admission ID if needed.

### 2.2 Data Fetching
In `getBillForPrint`:
- Fetch bill, hospital, branch, doctor letterhead details, patient identity, and bed assignment.
- Fetch care lines categorized by item types:
  - Room & Bed charges -> Category: `ROOM & CLINICAL CHARGES`
  - Consultations & Doctor visits -> Category: `ROOM & CLINICAL CHARGES` or `DOCTOR VISITS`
  - Consumables & Bedside supplies -> Category: `PHARMACY & CONSUMABLES`
  - Medicines & IV fluids -> Category: `PHARMACY & CONSUMABLES`
  - Investigations (ECG, pathology, radiology) -> Category: `INVESTIGATION`
  - Procedures / Nursing / Intracath -> Category: `HOSPITAL CHARGES`
- Fetch payment receipts from `patientPayments` (amounts, date, method, kind).
- Fetch lab investigations from `careEntries` + `chargeItems` where `isTest = true`.
- Fetch clinical progress notes:
  - SOAP doctor notes from `ipdClinicalRounds` and `clinicalAuditLogs` (`tableName = 'clinical_notes'`).
  - Discharge summary if exists from `ipdDischargeSummaries`.

---

## 3. UI Component Details

### 3.1 Print Toolbar (Screen Only, `print:hidden`)
- Back button: Returns to patient chart / billing tab.
- Section Toggle Checkbox: `[✓] Include Lab & Doctor Progress Report`.
- Print Button: Triggers `window.print()` (which natively offers physical printing or "Save as PDF").

### 3.2 Bill cum Receipt Layout (A4, Print Optimized)
- Standard `@page { size: A4 portrait; margin: 10mm 12mm 12mm; }`.
- **Corner Marketing**: `Powered by QuriioHQ` rendered in top or bottom corner.
- **Header**:
  - Hospital Name: Bold 18pt font.
  - Subtitle: `Bill cum Receipt` (or `Interim Bill cum Receipt`).
  - Registration Stamp badge.
- **Metadata Grid**: 2 columns, clean labels and values with dot leaders / aligned colons.
- **Service Items Table**:
  - Bordered or ruled table matching standard Indian EMR format.
  - Category row: e.g. `HOSPITAL CHARGES` (uppercase bold header).
  - Item rows: `S.No` | `Date` | `Service Particulars` | `Description` | `Rate` | `Qty` | `Discount` | `Amount`.
  - Subtotal row: Aligned to right: `Sub Total: ₹ <sum>`.
- **Total Section**:
  - Aligned to right:
    - Total Bill Amount
    - Less Net Payments
    - Balance Due
    - Net Amount
- **Signatures & Stamps**:
  - Patient signature line with name.
  - Hospital stamp seal.
  - Doctor signature & medical stamp (Doctor name, qualifications, designation, council registration number).

### 3.3 Medical Report Layout (Starts on New Page)
- Applies `break-before: page;` (or `page-break-before: always;`).
- Letterhead mini-header + Patient info strip.
- **Diagnostic Investigations Section**:
  - Table: `Test Name`, `Category`, `Ordered Date & Time`, `Status`, `Result / Findings`, `Reference Range`.
  - Critical flags highlighted with high contrast.
- **Clinical Progress Notes Section**:
  - Chronological doctor round notes.
  - Formatted SOAP breakdown:
    - `S`: Subjective findings
    - `O`: Objective clinical vitals & exam
    - `A`: Assessment / Diagnosis
    - `P`: Plan of care
  - Doctor name and timestamp.
- **Discharge Summary Section** (if applicable):
  - Primary diagnosis & discharge condition.
  - Take-home prescription table (Medicine, Dose, Route, Frequency, Duration, Instructions).
  - Follow-up instructions.
- Footer: Doctor signature line + `Powered by QuriioHQ`.

---

## 4. Error Handling & Edge Cases
1. **Admission without any bill items yet**: Renders empty state with "No charges accrued yet" rather than crashing.
2. **Draft / Provisional bills**: Clearly labeled `Interim Bill cum Receipt` with `Discharged Date: Currently Admitted`, ensuring it cannot be mistaken for a finalized discharge clearance bill.
3. **No investigations or progress notes**: When the checkbox is selected but no notes exist, displays friendly informational note: "No diagnostic investigations or clinical notes recorded for this stay."
4. **Pagination**: Uses `break-inside: avoid;` on category groups, signature blocks, and summary boxes to prevent awkward page splits across pages.

---

## 5. Verification Plan
1. Unit & Component tests:
   - Category grouping function test: Verifies items are correctly placed into Hospital Charges, Investigations, Pharmacy, and Room/Bed categories with accurate subtotals.
   - Financial totals reconciliation: Verifies subtotal, discount, payments, and balance match sums.
2. End-to-end rendering check:
   - Test `/print/ipd-bill/[billId]` rendering with and without `?report=1`.
   - Verify interim bill rendering from `BillingAndConsumablesTab`.
   - Verify finalized bill rendering from `/ipd/admissions/[id]/bill`.
   - Verify `Powered by QuriioHQ` branding renders in corner areas.
