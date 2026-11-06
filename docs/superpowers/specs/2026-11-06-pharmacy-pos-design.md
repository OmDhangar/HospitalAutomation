# Outpatient Retail Pharmacy POS & Counter Dispensing — System Design

**Date:** 2026-11-06  
**Status:** Approved  
**Module:** Phase 2, Item 5.1 — Outpatient Retail Pharmacy POS & Counter Dispensing  
**Target Path:** `docs/superpowers/specs/2026-11-06-pharmacy-pos-design.md`

---

## 1. Executive Summary & Business Intent

In hospital operations, pharmacy dispensing is a high-volume, mission-critical revenue channel. However, hospital operational models diverge significantly:
1. **Hospitals with In-House Retail Pharmacy:** Operate an on-premise pharmacy serving both outpatient consultation prescriptions (OPD) and walk-in counter retail customers, requiring high-speed point-of-sale (POS), batch-level FEFO (First-Expiry-First-Out) stock tracking, statutory GST billing, and customer receipting.
2. **Hospitals without In-House Pharmacy (External Pharmacy Model):** Dispense no retail medicines directly to outpatients. Prescriptions issued by OPD doctors are fulfilled by external community chemists. However, internal hospital inpatient (IPD) ward medications, crash-cart stock, and nursing administrations *must* still be tracked and accounted for internally.

This specification delivers a comprehensive, multi-tenant architecture providing:
- **Plan Entitlement Gating (`hasInhousePharmacy`):** Clean separation between hospitals entitled to the in-house pharmacy retail subsystem and those operating with external pharmacies.
- **Dedicated Retail Pharmacy Subsystem (Approach A):** Dedicated sales, line-item, and return tables with atomic integration into Qurio's existing inventory ledger (`stockLedger` and `stockBalances`).
- **Automated FEFO Batch Allocation:** Minimizing stock expiry write-offs.
- **GST Compliance & Thermal/A4 Receipt Generation:** Instant billing with CGST/SGST breakdowns.
- **Strict English-Only Compliance (Rule 2.2):** All prescription instructions, dosage notations, and receipt line items remain exclusively in English.

---

## 2. Reverse Engineering Evidence & Industry Alignment (Rule 2.1)

Evidence collected using the **Reverse Engineer Anything (REA)** browser scenario tool (`capture_browser_scenario` with Edge browser):

### 2.1 Practo Insta HMS Analysis
- **REA Evidence ID:** `ev_bc25c9348db79d26993959b673930d646e20083d945bd6f792d492317b1e7b10`
- **Key Workflow Patterns Extracted:**
  - **OPD Prescription Queue:** Consultations with prescribed medications automatically generate active records in the pharmacy fulfillment dashboard. Pharmacists do not re-enter medicine names manually; they pull the doctor's prescription, verify doses against available stock, select batches, and dispense.
  - **Categorized Billing:** Discharges and IPD indents are billed to patient stay accounts, whereas outpatient prescriptions are billed as retail counter sales (Cash/Card/UPI).
  - **Return & Restock Workflow:** Returns of unconsumed medicines issue a credit note or refund and restock the active batch in the store ledger.

### 2.2 Marg ERP Pharmacy POS Analysis
- **REA Evidence ID:** `ev_7f09fd3d49af79b3b016f33cb6daf090d15118d660b17d275ff4ca551e454f72`
- **Key Workflow Patterns Extracted:**
  - **High-Speed Counter Sale:** Rapid walk-in billing requiring minimal customer metadata (Name, Phone, optional Doctor Name) without forcing deep patient master registration.
  - **Automated FEFO Batch Pop-up:** Upon selecting a medicine, batches are sorted by nearest expiry date. The earliest batch is pre-selected by default while allowing manual override.
  - **GST Tax Engine:** Automatic calculation of taxable value and split CGST/SGST based on Indian pharma tax slabs (0%, 5%, 12%, 18%).
  - **Standardized Receipt Formats:** Support for 80mm (3-inch) thermal receipts and standard A4 tax invoices.

---

## 3. Plan Entitlements & Module Gating Architecture

### 3.1 Feature Entitlement Definition
In [`lib/domain/entitlements.ts`](file:///d:/Projects/HospitalAutomation/lib/domain/entitlements.ts):
```typescript
export type FeatureKind =
  | 'display_board'
  | 'owner_report'
  | 'advanced_reports'
  | 'data_export'
  | 'audit_log'
  | 'inhouse_pharmacy'; // New entitlement
```

Add `hasInhousePharmacy: boolean` to:
- `planTiers` table (`lib/db/schema.ts`): Basic tiers default to `false`; comprehensive hospital tiers set to `true`.
- `hospitals` table (`lib/db/schema.ts`): Overridable per-hospital configuration `hasInhousePharmacy: boolean` defaulting to `false`.
- `Entitlements` domain type in `lib/domain/entitlements.ts`.
- `lib/services/entitlements.ts`: `resolveEntitlements(hospitalId)`.

### 3.2 Dual Operational Behavior

| Feature / Workflow | `hasInhousePharmacy = false` (External Pharmacy) | `hasInhousePharmacy = true` (In-House Pharmacy) |
|---|---|---|
| **Outpatient OPD Prescriptions** | Doctor issues prescription. Patient receives printed/digital copy to purchase at external chemist. No internal POS fulfillment queue. | Doctor issues prescription. Enters Pharmacy Queue at `/pharmacy`. Pharmacist dispenses directly. |
| **Retail Walk-in Counter Sales** | Gated / Disabled. Attempting to access displays "External Pharmacy Mode" notice. | Fully accessible. Rapid OTC billing with Cash/UPI/Card and GST receipt. |
| **IPD Ward Medications** | **Active & Tracked.** Ward stores, crash carts, nursing administration (eMAR), and daily IPD bed consumption are tracked in `stockLedger`. | **Active & Tracked.** Managed via ward stores and eMAR; central store supplies ward stock via transfers. |
| **Returns & Restocking** | Not applicable for outpatients. | Supported via itemized pharmacy returns and stock restocking. |

---

## 4. Database Schema (Approach A)

Forward migration: `drizzle/0076_pharmacy_pos.sql`

```sql
-- Pharmacy Sales Header
CREATE TABLE IF NOT EXISTS pharmacy_sales (
  id TEXT PRIMARY KEY,
  hospital_id TEXT NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  sale_no TEXT NOT NULL,                                -- e.g. PH-2026-0001
  sale_type TEXT NOT NULL,                              -- 'prescription' | 'counter'
  prescription_id TEXT REFERENCES prescriptions(id) ON DELETE SET NULL,
  patient_id TEXT REFERENCES patients(id) ON DELETE SET NULL,
  customer_name TEXT NOT NULL,
  customer_phone TEXT,
  doctor_name TEXT,
  payment_mode TEXT NOT NULL,                           -- 'cash' | 'upi' | 'card'
  subtotal_paise INTEGER NOT NULL,                      -- Net taxable amount
  cgst_paise INTEGER NOT NULL,                          -- CGST amount
  sgst_paise INTEGER NOT NULL,                          -- SGST amount
  discount_paise INTEGER NOT NULL DEFAULT 0,            -- Bill discount
  total_paise INTEGER NOT NULL,                         -- Net amount payable
  status TEXT NOT NULL DEFAULT 'completed',             -- 'completed' | 'returned' | 'partially_returned'
  dispensed_by_user_id TEXT NOT NULL REFERENCES users(id),
  dispensed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Pharmacy Sale Items
CREATE TABLE IF NOT EXISTS pharmacy_sale_items (
  id TEXT PRIMARY KEY,
  hospital_id TEXT NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  sale_id TEXT NOT NULL REFERENCES pharmacy_sales(id) ON DELETE CASCADE,
  medicine_id TEXT NOT NULL REFERENCES medicines(id),
  batch_id TEXT NOT NULL REFERENCES stock_batches(id),
  batch_no TEXT NOT NULL,
  expiry_date DATE NOT NULL,
  hsn_code TEXT,
  quantity INTEGER NOT NULL,
  unit_price_paise INTEGER NOT NULL,                    -- Price per unit before tax
  mrp_paise INTEGER NOT NULL,                           -- Max retail price
  discount_percent SMALLINT NOT NULL DEFAULT 0,
  gst_rate SMALLINT NOT NULL DEFAULT 12,                -- 0, 5, 12, 18
  taxable_amount_paise INTEGER NOT NULL,
  cgst_amount_paise INTEGER NOT NULL,
  sgst_amount_paise INTEGER NOT NULL,
  total_amount_paise INTEGER NOT NULL
);

-- Pharmacy Returns
CREATE TABLE IF NOT EXISTS pharmacy_returns (
  id TEXT PRIMARY KEY,
  hospital_id TEXT NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  return_no TEXT NOT NULL,                              -- e.g. RET-2026-0001
  sale_id TEXT NOT NULL REFERENCES pharmacy_sales(id),
  reason TEXT NOT NULL,
  refund_mode TEXT NOT NULL,                            -- 'cash' | 'upi' | 'credit_note'
  refund_amount_paise INTEGER NOT NULL,
  returned_by_user_id TEXT NOT NULL REFERENCES users(id),
  returned_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Pharmacy Return Items
CREATE TABLE IF NOT EXISTS pharmacy_return_items (
  id TEXT PRIMARY KEY,
  hospital_id TEXT NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  return_id TEXT NOT NULL REFERENCES pharmacy_returns(id) ON DELETE CASCADE,
  sale_item_id TEXT NOT NULL REFERENCES pharmacy_sale_items(id),
  batch_id TEXT NOT NULL REFERENCES stock_batches(id),
  quantity_returned INTEGER NOT NULL,
  refund_amount_paise INTEGER NOT NULL
);

-- Indexes for performance and multi-tenant RLS
CREATE INDEX IF NOT EXISTS idx_pharmacy_sales_hospital_created ON pharmacy_sales(hospital_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pharmacy_sales_prescription ON pharmacy_sales(hospital_id, prescription_id);
CREATE INDEX IF NOT EXISTS idx_pharmacy_sale_items_sale ON pharmacy_sale_items(sale_id);
CREATE INDEX IF NOT EXISTS idx_pharmacy_returns_sale ON pharmacy_returns(sale_id);

-- Prescription status extension
ALTER TABLE prescriptions ADD COLUMN IF NOT EXISTS fulfillment_status TEXT NOT NULL DEFAULT 'unfulfilled';
-- Values: 'unfulfilled', 'dispensed', 'partially_dispensed'
```

---

## 5. Domain Layer Architecture (`lib/domain/pharmacy.ts`)

Pure functions with zero database dependencies:
1. **GST & Pricing Calculations:**
   - `calculateItemTax(unitPricePaise, quantity, discountPercent, gstRate)`:
     - `gross = unitPricePaise * quantity`
     - `discount = round(gross * discountPercent / 100)`
     - `taxable = gross - discount`
     - `cgst = round((taxable * gstRate) / 200)`
     - `sgst = round((taxable * gstRate) / 200)`
     - `total = taxable + cgst + sgst`
2. **Bill Sequence Generator:**
   - `formatSaleNumber(prefix: string, year: number, seq: number)`: Returns `PH-2026-00001`.
   - `formatReturnNumber(prefix: string, year: number, seq: number)`: Returns `RET-2026-00001`.
3. **Receipt Formatter (Rule 2.2 Compliant):**
   - Pure representation of pharmacy cash memo containing:
     - Hospital Name, Address, Drug License No, GSTIN
     - Bill No, Date, Time, Cashier Name
     - Patient / Customer Name, Phone, Doctor Name
     - Table: Medicine Name, Batch No, Exp Date, Qty, MRP, Rate, Disc %, GST %, Net Amount
     - Summary: Subtotal, Total CGST, Total SGST, Grand Total, Payment Mode
     - Standard English footer: *"Medicines once sold can only be returned within 7 days with original receipt in intact packaging."*

---

## 6. Service Layer Architecture (`lib/services/pharmacy.ts`)

Encapsulates all database operations, multi-tenant scoping, and atomic transaction boundaries:

1. **`getPrescriptionFulfillmentQueue(hospitalId: string)`**:
   - Queries `prescriptions` joining `consultations`, `patients`, and `users` (doctor).
   - Filters `fulfillmentStatus = 'unfulfilled'` or `'partially_dispensed'`, ordered by consultation timestamp.
2. **`getAvailableBatchesForMedicine(hospitalId: string, locationId: string, medicineId: string)`**:
   - Fetches active batches for the given medicine in the pharmacy store.
   - Applies domain `fefo()` sorting (non-expired first, earliest expiration to latest).
3. **`processPharmacySale(hospitalId: string, input: ProcessSaleInput)`**:
   - Executes inside `db.transaction()`:
     - Verifies `hasInhousePharmacy` entitlement.
     - Validates stock availability for each selected batch.
     - Generates next sequential `saleNo`.
     - Inserts `pharmacy_sales` and `pharmacy_sale_items`.
     - Posts ledger deductions to `stockLedger` (`kind: 'give'`, `quantity: -qty`, `referenceType: 'pharmacy_sale'`).
     - Updates `stockBalances` for `(hospitalId, locationId, medicineId)`.
     - If linked to a `prescriptionId`, updates `prescriptions.fulfillmentStatus = 'dispensed'`.
     - Inserts audit log.
4. **`processPharmacyReturn(hospitalId: string, input: ProcessReturnInput)`**:
   - Executes inside `db.transaction()`:
     - Validates original sale and verifies returned quantities do not exceed sold quantities.
     - Generates next sequential `returnNo`.
     - Inserts `pharmacy_returns` and `pharmacy_return_items`.
     - Posts ledger additions to `stockLedger` (`kind: 'receive'`, `quantity: +qtyReturned`, `referenceType: 'pharmacy_return'`).
     - Updates `stockBalances`.
     - Updates `pharmacy_sales.status` to `'returned'` or `'partially_returned'`.
     - Inserts audit log.

---

## 7. User Interface Architecture (`/pharmacy`)

Route: `app/(app)/pharmacy/page.tsx`

### 7.1 Gated State (`hasInhousePharmacy === false`)
- Renders an informative, high-clarity status card:
  - Header: **External Pharmacy Mode Active**
  - Description: *"This hospital is configured with an external retail pharmacy. Outpatient prescriptions are issued to patients for external fulfillment. Internal IPD medications and ward stocks are managed under IPD Stock."*
  - Action: Link to IPD Stock Management / Hospital Settings.

### 7.2 Active Cockpit (`hasInhousePharmacy === true`)
- **Navigation Tabs:**
  1. **OPD Prescription Queue (Badge showing pending count):**
     - Table with: Time, Patient Name / MRN, Doctor, Prescribed Medicines Count, Action ("Dispense").
     - "Dispense Drawer / Dialog": Loads doctor-prescribed medications with dosage, pre-allocates batches via FEFO, displays unit prices and GST, allows cashier to accept payment (Cash/UPI/Card) and click "Dispense & Print Receipt".
  2. **Walk-in Counter Sale (Quick POS):**
     - Medicine search combobox (instant autocomplete by brand or generic molecule).
     - Batch selector pop-up showing available batches, expiry dates, and MRP.
     - Item table with editable quantity and discount.
     - Customer details panel (Name, Phone, Prescribing Doctor).
     - Financial summary card (Taxable, CGST, SGST, Net Total).
     - Big action button: **Complete Sale (Cash / UPI / Card)**.
  3. **Sales History & Returns:**
     - List of completed bills with filter by date, bill number, or patient phone.
     - "Process Return" modal allowing itemized quantity return with reason and refund method.
- **Print Modal / Component:**
  - Standardized thermal 80mm cash receipt and A4 tax invoice view ready for browser print (`window.print()`).

---

## 8. Non-Negotiable Rule 2.2 Compliance (English Only)

All medication directions, dosage instructions, and prescription receipts remain exclusively in English:
- Dosage frequencies: `"1-0-1"`, `"0-0-1"`, `"1-1-1"`, `"1-0-0"`
- Administration instructions: `"After food"`, `"Before food"`, `"With water"`, `"As directed by physician"`
- Receipt headers and footers: Pure English labels (`"TAX INVOICE"`, `"CASH MEMO"`, `"BATCH NO"`, `"EXPIRY"`, `"DISCOUNT"`, `"CGST"`, `"SGST"`).

---

## 9. Verification & Testing Strategy

1. **Unit Tests (`lib/domain/pharmacy.test.ts`):**
   - GST rate calculations (0%, 5%, 12%, 18%) for exact rounding down to paise.
   - Batch allocation matching domain `fefo()` order.
   - Receipt string formatting and bill number sequencing.
2. **Entitlement Tests (`lib/domain/entitlements.test.ts`):**
   - Correctly identifies `inhouse_pharmacy` feature enablement based on plan tier.
3. **Service Tests (`lib/services/pharmacy.test.ts`):**
   - Prescription queue retrieval.
   - Atomic sale execution: stock ledger deduction, balance reduction, prescription fulfillment status update.
   - Over-sale prevention when quantity requested exceeds batch balance.
   - Return processing: stock ledger restocking, credit note calculation, status update.
4. **Action & Permission Tests (`app/(app)/pharmacy/actions.test.ts`):**
   - Verifies role authorization (`pharmacist`, `receptionist`, `nurse`, `owner`).
   - Verifies denial when hospital lacks `hasInhousePharmacy` entitlement.
5. **UI & Component Tests (`components/pharmacy/...test.tsx`):**
   - Renders external pharmacy banner when entitlement is false.
   - Renders queue and POS counter when entitlement is true.
   - Thermal receipt component snapshot and print styling test.
6. **Regression & Migration Linting:**
   - `npm run db:lint-migrations`: 0 errors.
   - `npm run db:migrate:plan`: 0 errors.
   - `npm test`: 100% passing across the entire test suite.
