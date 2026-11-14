# Outpatient Retail Pharmacy POS & Counter Dispensing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a complete, market-ready Outpatient Retail Pharmacy POS and Dispensing subsystem (`/pharmacy`), featuring prescription fulfillment from OPD consultations, walk-in counter sales, FEFO-based stock deduction, retail GST billing, receipts, returns, and plan entitlement gating (`inhouse_pharmacy`).

**Architecture:** Approach A — Dedicated pharmacy tables (`pharmacy_sales`, `pharmacy_sale_items`, `pharmacy_returns`, `pharmacy_return_items`) with transactional integration into Qurio's existing `stockLedger` (`kind: 'give'` and `'receive'`) and `stockBalances`. The entire outpatient POS subsystem is gated behind the `inhouse_pharmacy` feature flag, allowing hospitals without in-house pharmacies to fulfill prescriptions externally while retaining internal IPD ward medication accounting.

**Tech Stack:** Next.js 15 (App Router, Server Actions), Drizzle ORM, PostgreSQL (RLS), Tailwind CSS, Lucide icons, Vitest.

**Spec:** [`docs/superpowers/specs/2026-11-06-pharmacy-pos-design.md`](file:///d:/Projects/HospitalAutomation/docs/superpowers/specs/2026-11-06-pharmacy-pos-design.md)

## Global Constraints

- **Rule 2.1:** Industry alignment with Practo Insta (`ev_bc25c9348db79d26993959b673930d646e20083d945bd6f792d492317b1e7b10`) and Marg ERP (`ev_7f09fd3d49af79b3b016f33cb6daf090d15118d660b17d275ff4ca551e454f72`).
- **Rule 2.2:** English-only prescription directions, dosage instructions, and receipt notation. No regional languages.
- **Rule 2.4:** Multi-tenant isolation using `withTenant(hospitalId, ...)` and PostgreSQL Row Level Security (RLS).
- **Financial Precision:** All currency amounts stored as integers in **paise** (1 INR = 100 paise).
- **Tax Accuracy:** Half-rate split for Intra-State GST (CGST = Rate / 2, SGST = Rate / 2) with deterministic integer rounding.

## Review Focus

1. **Attempting sale when hospital lacks in-house pharmacy entitlement:** Returns structured error rejecting sale and UI displays external pharmacy banner.
2. **Batch over-dispensing / race conditions:** Fails atomically inside transaction if available batch quantity is less than requested quantity.
3. **Prescription status idempotency:** Dispensing an OPD prescription transitions `fulfillmentStatus` to `'dispensed'` so it cannot be double-dispensed.
4. **GST slab rounding edge cases:** Quantities with odd discount percentages split CGST and SGST such that `cgst + sgst + taxable = total` exactly down to the paise.
5. **Excessive return quantity:** Processing a return with quantity greater than sold quantity is rejected before ledger posting.

---

### Task 1: Plan Entitlements & Module Gating (`inhouse_pharmacy`)

**Files:**
- Modify: [`lib/domain/entitlements.ts`](file:///d:/Projects/HospitalAutomation/lib/domain/entitlements.ts)
- Modify: [`lib/services/entitlements.ts`](file:///d:/Projects/HospitalAutomation/lib/services/entitlements.ts)
- Test: `lib/domain/entitlements.test.ts`

**Interfaces:**
- Consumes: Existing `FeatureKind`, `Entitlements` in `lib/domain/entitlements.ts`.
- Produces: `hasInhousePharmacy: boolean` field on `Entitlements` and `'inhouse_pharmacy'` in `FeatureKind`.

- [ ] **Step 1: Write the failing test**

```typescript
// lib/domain/entitlements.test.ts
import { describe, it, expect } from 'vitest';
import { hasFeature, type Entitlements } from './entitlements';

describe('Inhouse Pharmacy Entitlement', () => {
  const baseEntitlements: Entitlements = {
    maxBranches: 1,
    maxDoctors: 2,
    maxStaffLogins: 5,
    hasDisplayBoard: true,
    hasOwnerReport: true,
    hasAdvancedReports: false,
    hasDataExport: false,
    hasAuditLog: false,
    hasInhousePharmacy: false,
    supportTier: 'email',
  };

  it('correctly reports inhouse_pharmacy false when disabled', () => {
    expect(hasFeature(baseEntitlements, 'inhouse_pharmacy')).toBe(false);
  });

  it('correctly reports inhouse_pharmacy true when enabled', () => {
    expect(hasFeature({ ...baseEntitlements, hasInhousePharmacy: true }, 'inhouse_pharmacy')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test lib/domain/entitlements.test.ts`  
Expected: FAIL with compilation error that `'inhouse_pharmacy'` is not assignable to `FeatureKind`.

- [ ] **Step 3: Implement `inhouse_pharmacy` in `lib/domain/entitlements.ts` and `lib/services/entitlements.ts`**

Add `'inhouse_pharmacy'` to `FeatureKind`, add `hasInhousePharmacy: boolean` to `Entitlements` and `hasFeature()` switch case. Update default mock in `lib/services/entitlements.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test lib/domain/entitlements.test.ts`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/domain/entitlements.ts lib/services/entitlements.ts lib/domain/entitlements.test.ts
git commit -m "feat(entitlements): add inhouse_pharmacy feature flag and entitlement check"
```

---

### Task 2: Database Schema & Migration for Pharmacy POS (Approach A)

**Files:**
- Create: `drizzle/0076_pharmacy_pos.sql`
- Modify: [`lib/db/schema.ts`](file:///d:/Projects/HospitalAutomation/lib/db/schema.ts)
- Test: Migration linting & verification

**Interfaces:**
- Consumes: `hospitals`, `stockBatches`, `medicines`, `prescriptions`, `users`.
- Produces: `pharmacySales`, `pharmacySaleItems`, `pharmacyReturns`, `pharmacyReturnItems` Drizzle schema definitions and `fulfillmentStatus` on `prescriptions`.

- [ ] **Step 1: Write migration `0076_pharmacy_pos.sql`**

Create `drizzle/0076_pharmacy_pos.sql` with tables `pharmacy_sales`, `pharmacy_sale_items`, `pharmacy_returns`, `pharmacy_return_items`, column `fulfillment_status` on `prescriptions`, and column `has_inhouse_pharmacy` on `plan_tiers` and `hospitals`. Enable RLS and add tenant isolation policies.

- [ ] **Step 2: Update `lib/db/schema.ts`**

Declare Drizzle table definitions:
- `pharmacySales` (fields: `id`, `hospitalId`, `saleNo`, `saleType`, `prescriptionId`, `patientId`, `customerName`, `customerPhone`, `doctorName`, `paymentMode`, `subtotalPaise`, `cgstPaise`, `sgstPaise`, `discountPaise`, `totalPaise`, `status`, `dispensedByUserId`, `dispensedAt`, `createdAt`).
- `pharmacySaleItems` (fields: `id`, `hospitalId`, `saleId`, `medicineId`, `batchId`, `batchNo`, `expiryDate`, `hsnCode`, `quantity`, `unitPricePaise`, `mrpPaise`, `discountPercent`, `gstRate`, `taxableAmountPaise`, `cgstAmountPaise`, `sgstAmountPaise`, `totalAmountPaise`).
- `pharmacyReturns` & `pharmacyReturnItems`.
- Add `fulfillmentStatus` to `prescriptions`.
- Add `hasInhousePharmacy` to `planTiers` and `hospitals`.

- [ ] **Step 3: Verify migration journal & linting**

Run: `npm run db:lint-migrations; npm run db:migrate:plan`  
Expected: 0 lint errors, journal cleanly sequence-ordered.

- [ ] **Step 4: Commit**

```bash
git add drizzle/0076_pharmacy_pos.sql lib/db/schema.ts drizzle/meta/_journal.json
git commit -m "feat(db): add pharmacy POS schema and forward migration 0076"
```

---

### Task 3: Domain Calculations & Pricing Engine (`lib/domain/pharmacy.ts`)

**Files:**
- Create: `lib/domain/pharmacy.ts`
- Test: `lib/domain/pharmacy.test.ts`

**Interfaces:**
- Consumes: Pure inputs (prices, quantities, discounts, tax rates).
- Produces:
  - `calculateItemTax(unitPricePaise, quantity, discountPercent, gstRate)`
  - `calculateSaleTotals(items)`
  - `formatSaleNumber(prefix, year, seq)`
  - `formatReturnNumber(prefix, year, seq)`
  - `generateReceiptData(sale, items, hospitalDetails)`

- [ ] **Step 1: Write the failing tests**

```typescript
// lib/domain/pharmacy.test.ts
import { describe, it, expect } from 'vitest';
import { calculateItemTax, calculateSaleTotals, formatSaleNumber } from './pharmacy';

describe('Pharmacy Domain Tax Engine', () => {
  it('calculates 12% GST correctly on 10 units @ Rs 100 with 10% discount', () => {
    // 10 units @ 10,000 paise = 100,000 paise gross
    // 10% discount = 10,000 paise
    // Taxable = 90,000 paise
    // CGST 6% = 5,400 paise
    // SGST 6% = 5,400 paise
    // Total = 100,800 paise (Rs 1,008.00)
    const result = calculateItemTax({
      unitPricePaise: 10000,
      quantity: 10,
      discountPercent: 10,
      gstRate: 12,
    });

    expect(result.taxableAmountPaise).toBe(90000);
    expect(result.cgstAmountPaise).toBe(5400);
    expect(result.sgstAmountPaise).toBe(5400);
    expect(result.totalAmountPaise).toBe(100800);
  });

  it('formats sale number with standard hospital prefix and year', () => {
    expect(formatSaleNumber('PH', 2026, 42)).toBe('PH-2026-00042');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test lib/domain/pharmacy.test.ts`  
Expected: FAIL with "module not found".

- [ ] **Step 3: Implement `lib/domain/pharmacy.ts`**

Implement pure functions with zero database dependencies for item tax calculation, bill sequencing, and English-only receipt string generation.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test lib/domain/pharmacy.test.ts`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/domain/pharmacy.ts lib/domain/pharmacy.test.ts
git commit -m "feat(pharmacy): add pure domain pricing and receipt engine"
```

---

### Task 4: Service Layer & Stock Ledger Integration (`lib/services/pharmacy.ts`)

**Files:**
- Create: `lib/services/pharmacy.ts`
- Test: `lib/services/pharmacy.test.ts`

**Interfaces:**
- Consumes: `lib/domain/pharmacy.ts`, `lib/domain/stock.ts`, `lib/db/schema.ts`, `lib/services/stock.ts`.
- Produces:
  - `getPrescriptionFulfillmentQueue(hospitalId)`
  - `getAvailableBatches(hospitalId, locationId, medicineId)`
  - `processPharmacySale(hospitalId, input)`
  - `processPharmacyReturn(hospitalId, input)`

- [ ] **Step 1: Write the failing tests**

```typescript
// lib/services/pharmacy.test.ts
import { describe, it, expect, vi } from 'vitest';
import { processPharmacySale } from './pharmacy';

describe('Pharmacy Service Layer', () => {
  it('throws an error if hospital is not entitled to inhouse pharmacy', async () => {
    await expect(
      processPharmacySale('hosp-1', {
        hospitalEntitled: false,
        saleType: 'counter',
        customerName: 'Walk-in Patient',
        paymentMode: 'cash',
        items: [],
        dispensedByUserId: 'user-1',
      })
    ).rejects.toThrow(/In-house pharmacy module is not enabled/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test lib/services/pharmacy.test.ts`  
Expected: FAIL with "module not found".

- [ ] **Step 3: Implement `lib/services/pharmacy.ts`**

Implement transaction boundary:
- Check `hasInhousePharmacy` entitlement.
- Verify batch balances.
- Insert `pharmacySales` and `pharmacySaleItems`.
- Insert `stockLedger` with `kind: 'give'` and negative quantity.
- Decrement `stockBalances`.
- Update `prescriptions.fulfillmentStatus = 'dispensed'` if linked.
- Support return transaction with `kind: 'receive'` and positive quantity.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test lib/services/pharmacy.test.ts`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/services/pharmacy.ts lib/services/pharmacy.test.ts
git commit -m "feat(pharmacy): add pharmacy service with atomic stock ledger integration"
```

---

### Task 5: Server Actions & Permissions (`app/(app)/pharmacy/actions.ts`)

**Files:**
- Create: `app/(app)/pharmacy/actions.ts`
- Test: `app/(app)/pharmacy/actions.test.ts`

**Interfaces:**
- Consumes: `lib/services/pharmacy.ts`, session user context, permissions matrix.
- Produces: Server actions:
  - `getQueueAction()`
  - `searchMedicinesAndBatchesAction(query)`
  - `completeSaleAction(formData)`
  - `processReturnAction(formData)`

- [ ] **Step 1: Write the failing test**

```typescript
// app/(app)/pharmacy/actions.test.ts
import { describe, it, expect } from 'vitest';
import { completeSaleAction } from './actions';

describe('Pharmacy Server Actions', () => {
  it('rejects unauthorized roles from dispensing medicines', async () => {
    // verify role check rejects non-permitted users
    const res = await completeSaleAction({} as any);
    expect(res.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test app/\(app\)/pharmacy/actions.test.ts`  
Expected: FAIL.

- [ ] **Step 3: Implement `app/(app)/pharmacy/actions.ts`**

Verify session, check permissions (`owner`, `pharmacist`, `receptionist`, `nurse`), call `lib/services/pharmacy.ts`, and return typed action results `{ success: true, saleId }` or `{ success: false, error }`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test app/\(app\)/pharmacy/actions.test.ts`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/(app)/pharmacy/actions.ts app/(app)/pharmacy/actions.test.ts
git commit -m "feat(pharmacy): add server actions with role permission gating"
```

---

### Task 6: Frontend Cockpit & Receipt UI (`/pharmacy`)

**Files:**
- Create: `app/(app)/pharmacy/page.tsx`
- Create: `components/pharmacy/ExternalPharmacyBanner.tsx`
- Create: `components/pharmacy/PrescriptionQueueTab.tsx`
- Create: `components/pharmacy/CounterSaleTab.tsx`
- Create: `components/pharmacy/PharmacyReceiptModal.tsx`
- Test: `components/pharmacy/pharmacy-pos.test.tsx`

**Interfaces:**
- Consumes: Server actions, domain types.
- Produces: Responsive POS interface with tabbed queue, counter sale register, and thermal print dialog.

- [ ] **Step 1: Write component tests**

```typescript
// components/pharmacy/pharmacy-pos.test.tsx
import { describe, it, expect } from 'vitest';
import { renderToString } from 'react-dom/server';
import ExternalPharmacyBanner from './ExternalPharmacyBanner';

describe('Pharmacy UI Components', () => {
  it('renders external pharmacy banner with informative notice', () => {
    const html = renderToString(<ExternalPharmacyBanner />);
    expect(html).toContain('External Pharmacy Mode Active');
    expect(html).toContain('IPD medications and ward stocks');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test components/pharmacy/pharmacy-pos.test.tsx`  
Expected: FAIL.

- [ ] **Step 3: Implement components & page**

Build:
- `ExternalPharmacyBanner.tsx`: Clear, reassuring banner for hospitals without in-house pharmacy.
- `PrescriptionQueueTab.tsx`: Table listing OPD pending prescriptions with one-click "Dispense" dialog.
- `CounterSaleTab.tsx`: Instant OTC medicine lookup, auto-FEFO batch selection, quantity/discount inputs, GST calculation summary, and payment button.
- `PharmacyReceiptModal.tsx`: Printable 80mm thermal receipt and A4 tax invoice formatted strictly in English (Rule 2.2).
- `page.tsx`: Resolves hospital entitlements, rendering `ExternalPharmacyBanner` if `!hasInhousePharmacy` or full interactive tabs if enabled.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test components/pharmacy/pharmacy-pos.test.tsx`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/(app)/pharmacy/ components/pharmacy/
git commit -m "feat(pharmacy): add pharmacy POS cockpit, counter register, and receipt print UI"
```

---

### Task 7: End-to-End Verification & Documentation

**Files:**
- Create: `docs/modules/05-retail-pharmacy-pos/COMPLETION_REPORT.md`
- Modify: `docs/audit/IMPLEMENTATION_BACKLOG.md`

- [ ] **Step 1: Verify database migrations and schema consistency**

Run: `npm run db:lint-migrations; npm run db:migrate:plan`  
Expected: 0 errors.

- [ ] **Step 2: Run full test suite regression**

Run: `npm test`  
Expected: 100% pass across all test suites.

- [ ] **Step 3: Write Completion Report**

Author `docs/modules/05-retail-pharmacy-pos/COMPLETION_REPORT.md` documenting:
- Reverse engineering evidence IDs (`ev_bc25c9348db79d26993959b673930d646e20083d945bd6f792d492317b1e7b10`, `ev_7f09fd3d49af79b3b016f33cb6daf090d15118d660b17d275ff4ca551e454f72`).
- Plan entitlement gating mechanism (`hasInhousePharmacy`).
- Approach A database schema and stock ledger transaction architecture.
- Test coverage metrics.

- [ ] **Step 4: Commit**

```bash
git add docs/modules/05-retail-pharmacy-pos/ docs/audit/IMPLEMENTATION_BACKLOG.md
git commit -m "docs(pharmacy): add Item 5.1 completion report and backlog update"
```
