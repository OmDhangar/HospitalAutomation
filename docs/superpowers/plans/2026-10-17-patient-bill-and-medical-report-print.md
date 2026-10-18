# Patient Bill & Medical Report Print Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reformat patient running total and discharge bills into a structured, professional A4 receipt matching Guruved Hospital's format (with `Powered by QuriioHQ` branding in corner areas, no tagline), and provide a selectable option to print/export an integrated Medical Dossier containing all Lab investigations and Doctor progress notes.

**Architecture:** A domain helper groups line items into standardized categories (`HOSPITAL CHARGES`, `INVESTIGATION`, `PHARMACY & CONSUMABLES`, `ROOM & CLINICAL CHARGES`) with sub-totals and summary reconciliation. The print route `/print/ipd-bill/[billId]` is upgraded with an interactive toolbar offering print triggers and an `Include Lab & Doctor Progress Report` toggle. When toggled, the Medical Report is rendered on subsequent A4 pages with CSS page breaks. Navigation links in the billing and discharge cockpit tabs are redirected to these clean print routes rather than raw browser `window.print()`.

**Tech Stack:** Next.js (App Router, Server & Client Components), Tailwind CSS, Drizzle ORM, Vitest, TypeScript.

**Spec:** [docs/superpowers/specs/2026-10-17-patient-bill-and-medical-report-print-design.md](file:///d:/Projects/HospitalAutomation/docs/superpowers/specs/2026-10-17-patient-bill-and-medical-report-print-design.md)

## Global Constraints

- Header must NOT include any tagline; hospital name and round registration badge are displayed prominently.
- `Powered by QuriioHQ` must be placed discreetly in corner areas of printed documents for marketing.
- The document must be optimized for A4 printing (`@page { size: A4 portrait; margin: 10mm 12mm 12mm; }`) and look identical whether printed to physical paper or saved via browser "Save as PDF".
- No unstyled `window.print()` triggers on the main application dashboard or tab screens.
- Zero breaking changes to existing database schemas or billing calculations.

## Review Focus

1. **Items without a pre-assigned category:** Unmapped or custom items must safely fallback to `HOSPITAL CHARGES` without crashing or disappearing from the receipt.
2. **Patient with 0 payments made:** Less Net Payments must display `₹ 0` and Balance Due equals Net Amount without negative balances or null errors.
3. **Multi-page bill overflowing A4:** Category tables and signature blocks must use `break-inside: avoid;` to ensure headers and signatures do not orphan across page breaks.
4. **Draft / Interim bill safety:** Active inpatient bills must display `Interim Bill cum Receipt` and `Currently Admitted` so they cannot be misrepresented as final discharge clearance bills.
5. **Empty clinical notes or investigations:** If "Include Lab & Doctor Progress Report" is selected for a patient with no lab tests or notes, it must render an informative empty state instead of blank space or an error.

---

### Task 1: Domain Categorization & Receipt Computation Helper

**Files:**
- Create: `lib/domain/bill-receipt.ts`
- Test: `lib/domain/__tests__/bill-receipt.test.ts`

**Interfaces:**
- Produces:
  ```typescript
  export type ReceiptCategoryKey = 'HOSPITAL_CHARGES' | 'INVESTIGATION' | 'PHARMACY_CONSUMABLES' | 'ROOM_CLINICAL';
  export interface CategorizedBillGroup {
    categoryKey: ReceiptCategoryKey;
    categoryTitle: string;
    lines: {
      sNo: number;
      date: string;
      particulars: string;
      description: string;
      ratePaise: number;
      quantity: number;
      discountPaise: number;
      amountPaise: number;
    }[];
    subtotalPaise: number;
  }
  export function categorizeBillLines(lines: BillLine[], timezone: string): CategorizedBillGroup[];
  export function computeReceiptSummary(totals: { totalPaise: number; subtotalPaise: number; discountPaise: number }, payments: PaymentRow[]): {
    totalBillAmountPaise: number;
    netPaymentsPaise: number;
    balanceDuePaise: number;
    netAmountPaise: number;
  };
  ```

- [ ] **Step 1: Write the failing unit tests**

Create `lib/domain/__tests__/bill-receipt.test.ts` testing:
- Mapping room, medicine, consumable, procedure, service, and investigation items into proper categories with numbering and dates.
- Calculating category subtotals accurately.
- Reconciling payments, refunds, and balance due.
- Handling unmapped item types by falling back to `HOSPITAL CHARGES`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/domain/__tests__/bill-receipt.test.ts`  
Expected: FAIL with module not found or functions undefined.

- [ ] **Step 3: Implement `lib/domain/bill-receipt.ts`**

Implement:
- Category mapping table:
  - `room` -> `ROOM_CLINICAL` ("ROOM & CLINICAL CHARGES")
  - `service` / consultation -> `ROOM_CLINICAL`
  - `investigation` / lab / test -> `INVESTIGATION` ("INVESTIGATION")
  - `medicine` / `consumable` -> `PHARMACY_CONSUMABLES` ("PHARMACY & CONSUMABLES")
  - `procedure` / other -> `HOSPITAL_CHARGES` ("HOSPITAL CHARGES")
- Functions `categorizeBillLines` and `computeReceiptSummary`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/domain/__tests__/bill-receipt.test.ts`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/domain/bill-receipt.ts lib/domain/__tests__/bill-receipt.test.ts
git commit -m "feat(billing): add bill receipt categorization and summary computation"
```

---

### Task 2: Service Layer for Medical Report Data Fetching

**Files:**
- Create: `lib/services/medical-report.ts`
- Test: `lib/services/__tests__/medical-report.test.ts`

**Interfaces:**
- Consumes: `withTenant`, schema tables `careEntries`, `chargeItems`, `clinicalAuditLogs`, `ipdClinicalRounds`, `ipdDischargeSummaries`, `doctors`, `users`.
- Produces:
  ```typescript
  export interface PrintableMedicalReport {
    investigations: {
      id: string;
      name: string;
      category: string;
      orderedAt: Date;
      status: string;
      result: string | null;
      normalRange: string | null;
      isCritical: boolean;
    }[];
    progressNotes: {
      id: string;
      authorName: string;
      authorRole: string;
      createdAt: Date;
      noteType: 'SOAP' | 'NURSING' | 'HANDOVER';
      soapS?: string | null;
      soapO?: string | null;
      soapA?: string | null;
      soapP?: string | null;
      body?: string | null;
    }[];
    dischargeSummary?: {
      diagnosis: string | null;
      conditionAtDischarge: string | null;
      dischargeAdvice: string | null;
      takeHomePrescriptions: {
        medicineName: string;
        dosage: string;
        frequency: string;
        duration: string;
        instructions: string | null;
      }[];
    } | null;
  }
  export async function getMedicalReportForPrint(hospitalId: string, admissionId: string): Promise<PrintableMedicalReport>;
  ```

- [ ] **Step 1: Write the failing tests**

Create `lib/services/__tests__/medical-report.test.ts` mocking `withTenant` to verify querying investigations, progress notes, and discharge summary.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/services/__tests__/medical-report.test.ts`  
Expected: FAIL.

- [ ] **Step 3: Implement `lib/services/medical-report.ts`**

Fetch diagnostic tests, SOAP notes from doctor rounds & clinical audit logs, and discharge summary if finalized.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/services/__tests__/medical-report.test.ts`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/services/medical-report.ts lib/services/__tests__/medical-report.test.ts
git commit -m "feat(ipd): add medical report data retrieval service"
```

---

### Task 3: Bill Receipt Components (Header, Two-Column Metadata, Categorized Table & Signatures)

**Files:**
- Create: `components/print/bill-receipt-header.tsx`
- Create: `components/print/bill-receipt-table.tsx`
- Create: `components/print/bill-receipt-footer.tsx`
- Test: `components/print/__tests__/bill-receipt-components.test.tsx`

**Interfaces:**
- Produces:
  - `<BillReceiptHeader>`: Renders Hospital Name (large bold), Registration round seal badge, subtitle (`Bill cum Receipt` or `Interim Bill cum Receipt`), 2-column patient and admission grid, and `Powered by QuriioHQ` corner indicator.
  - `<BillReceiptTable>`: Renders categorized items with `S.No`, `Date`, `Service Particulars`, `Description`, `Rate`, `Qty`, `Discount`, `Amount`, and category `Sub Total`. Also renders bottom-right financial totals (Total Bill Amount, Less Net Payments, Balance Due, Net Amount).
  - `<BillReceiptFooter>`: Renders Patient Signature, Official Hospital Stamp in center, and Doctor's Signature & Credential Stamp (MBBS, MD, Reg. No.).

- [ ] **Step 1: Write component tests**

Create `components/print/__tests__/bill-receipt-components.test.tsx` checking that:
- Header renders hospital name, no tagline, and `Powered by QuriioHQ` in corner.
- Patient metadata displays formatted name, age, gender, address, location, doctor, department, IPD no, and bill date/time.
- Table groups items and renders bold sub-totals.
- Footer displays signatures and registration numbers.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run components/print/__tests__/bill-receipt-components.test.tsx`  
Expected: FAIL.

- [ ] **Step 3: Implement the 3 print receipt components**

Build `components/print/bill-receipt-header.tsx`, `components/print/bill-receipt-table.tsx`, and `components/print/bill-receipt-footer.tsx` using semantic HTML and print-optimized Tailwind styling (`@media print`, borders, high-contrast typography, `break-inside: avoid;`).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run components/print/__tests__/bill-receipt-components.test.tsx`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add components/print/bill-receipt-header.tsx components/print/bill-receipt-table.tsx components/print/bill-receipt-footer.tsx components/print/__tests__/bill-receipt-components.test.tsx
git commit -m "feat(print): add structured bill receipt header, table, and signature footer components"
```

---

### Task 4: Medical Report Printable Component & Print Controls Bar

**Files:**
- Create: `components/print/patient-medical-report.tsx`
- Create: `components/print/bill-print-controls.tsx`
- Test: `components/print/__tests__/patient-medical-report.test.tsx`

**Interfaces:**
- Produces:
  - `<BillPrintControls>`: Non-printable toolbar (`print:hidden`) with:
    - "← Back" button.
    - Checkbox toggle: `[✓] Include Lab & Doctor Progress Report`.
    - "Print / Save as PDF" button.
  - `<PatientMedicalReport>`: High-density printable report starting on a new page (`break-before: page;`):
    - Diagnostic Lab & Radiology test results table.
    - Doctor Clinical SOAP Progress notes.
    - Discharge clinical summary & take-home medications (if present).
    - `Powered by QuriioHQ` corner mark and Doctor signature line.

- [ ] **Step 1: Write component tests**

Create `components/print/__tests__/patient-medical-report.test.tsx` verifying:
- Medical report renders lab test details and normal ranges.
- Doctor SOAP notes are formatted cleanly.
- `Powered by QuriioHQ` is present.
- Empty states are shown gracefully when no tests or notes exist.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run components/print/__tests__/patient-medical-report.test.tsx`  
Expected: FAIL.

- [ ] **Step 3: Implement components**

Implement `components/print/patient-medical-report.tsx` and `components/print/bill-print-controls.tsx`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run components/print/__tests__/patient-medical-report.test.tsx`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add components/print/patient-medical-report.tsx components/print/bill-print-controls.tsx components/print/__tests__/patient-medical-report.test.tsx
git commit -m "feat(print): add printable medical dossier and interactive print controls"
```

---

### Task 5: Integration of Print Route (`/print/ipd-bill/[billId]`) and Navigation Links

**Files:**
- Modify: `app/print/ipd-bill/[billId]/page.tsx`
- Modify: `components/ipd/billing/billing-and-consumables-tab.tsx:48-76`
- Modify: `components/ipd/discharge/discharge-tab.tsx:71-98`
- Test: `app/print/ipd-bill/__tests__/ipd-bill-print-page.test.tsx`

- [ ] **Step 1: Write integration test**

Create `app/print/ipd-bill/__tests__/ipd-bill-print-page.test.tsx` verifying:
- Page loads bill, computes categorized groups, and renders `<BillReceiptHeader>`, `<BillReceiptTable>`, and `<BillReceiptFooter>`.
- Passes `includeReport` prop to conditionally render `<PatientMedicalReport>`.
- Renders `Powered by QuriioHQ` in corner areas.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/print/ipd-bill/__tests__/ipd-bill-print-page.test.tsx`  
Expected: FAIL.

- [ ] **Step 3: Update `app/print/ipd-bill/[billId]/page.tsx`**

Integrate the new receipt format, support both final bills and running bills, and render the optional medical report.

- [ ] **Step 4: Update navigation in `BillingAndConsumablesTab` and `DischargeTab`**

- In `BillingAndConsumablesTab`: Replace `window.print()` with a link/navigation to `/print/ipd-bill/[billId]` (or `/print/ipd-bill/draft?admissionId=${admissionId}`) opening in a new tab (`target="_blank"`).
- In `DischargeTab`: Update "Print Discharge Card" to open the formatted discharge summary print view instead of raw `window.print()`.

- [ ] **Step 5: Run all test suites**

Run: `npx vitest run`  
Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add app/print/ipd-bill/[billId]/page.tsx components/ipd/billing/billing-and-consumables-tab.tsx components/ipd/discharge/discharge-tab.tsx app/print/ipd-bill/__tests__/ipd-bill-print-page.test.tsx
git commit -m "feat(ipd): connect running total and discharge print buttons to structured bill receipt"
```

---

### Task 6: Visual & Print Verification

- [ ] **Step 1: Verify TypeScript & Next.js Build**

Run: `npm run build` or `npx tsc --noEmit`  
Expected: 0 errors.

- [ ] **Step 2: Browser Verification**

Navigate to a patient's Consumables & Inpatient Billing tab (`/ipd/patients/[id]/billing`):
- Click "Print Interim Bill" -> Verify it opens the print preview in a new tab.
- Verify receipt header has no tagline, has hospital name and registration badge, and shows `Powered by QuriioHQ` in corner.
- Verify 2-column patient/bill details and categorized items with subtotals.
- Toggle `[✓] Include Lab & Doctor Progress Report` -> Verify the medical report appends on page 2 with lab test results and doctor SOAP progress notes.
- Trigger Print (`Ctrl+P`) and verify clean A4 layout.

- [ ] **Step 3: Final Commit & Branch Summary**

Commit any final polish and prepare for user verification.
