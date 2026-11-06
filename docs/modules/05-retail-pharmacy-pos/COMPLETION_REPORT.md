# Phase 2, Item 5.1: Outpatient Retail Pharmacy POS & Counter Dispensing — Completion Report

**Date:** 2026-11-06  
**Module:** Phase 2, Item 5.1 — Outpatient Retail Pharmacy POS & Counter Dispensing  
**Status:** Completed & Fully Verified (100% Pass)  

---

## 1. Executive Summary

We have designed, implemented, and verified **Item 5.1: Outpatient Retail Pharmacy POS & Counter Dispensing** for Qurio HMS.

### Key Capabilities Delivered
1. **Entitlement & Plan Gating (`hasInhousePharmacy`):**
   - Implemented `hasInhousePharmacy` in `lib/domain/entitlements.ts`, `plan_tiers`, and `hospitals`.
   - Hospitals with external pharmacy arrangements issue OPD prescriptions for external chemist fulfillment and display an informative notice at `/pharmacy`. Internal IPD ward stock, crash-cart inventory, and nursing administration (eMAR) remain fully tracked in internal stock.
   - Hospitals with the in-house pharmacy module enabled have access to the full outpatient retail pharmacy POS subsystem.
2. **Dedicated Pharmacy Subsystem (Approach A):**
   - Created tables: `pharmacy_sales`, `pharmacy_sale_items`, `pharmacy_returns`, and `pharmacy_return_items` with tenant isolation RLS (`0076_pharmacy_pos.sql`).
   - Added `fulfillment_status` to `prescriptions` (`'unfulfilled'`, `'dispensed'`, `'partially_dispensed'`).
3. **FEFO Stock Allocation & Ledger Deductions:**
   - Integrated with pure domain `fefo()` logic in `lib/domain/stock.ts`.
   - Atomically records deductions in `stockLedger` with `kind: 'give'` and negative quantities, with database triggers automatically updating `stockBalances` and preventing shortfall.
4. **Indian Statutory GST Calculation & Receipting:**
   - Implemented `lib/domain/pharmacy.ts` calculating taxable amounts, split CGST/SGST (0%, 5%, 12%, 18%), and total amounts down to the exact paise.
   - Generates standardized, printable thermal (80mm) and A4 retail cash memos.
5. **Non-Negotiable Rule 2.2 Compliance:**
   - 100% English-only medication instructions, dosage frequencies, and receipt labels.
6. **Cockpit UI (`/pharmacy`):**
   - OPD Prescription Queue tab with one-click "Dispense & Bill" dialog.
   - Walk-in Counter Sale (Quick POS) tab with fast autocomplete and FEFO batch selection.
   - Printable receipt modal with browser print integration.

---

## 2. Reverse Engineering Evidence (Rule 2.1 Compliance)

Captured and studied live platform architectures using the **Reverse Engineer Anything (REA)** browser scenario tool:
- **Practo Insta HMS:** `ev_bc25c9348db79d26993959b673930d646e20083d945bd6f792d492317b1e7b10`
  - OPD prescription-to-pharmacy fulfillment queue.
  - Distinction between external chemist prescriptions and internal IPD stay charges.
  - Return indents with stock restocking.
- **Marg ERP Pharmacy POS:** `ev_7f09fd3d49af79b3b016f33cb6daf090d15118d660b17d275ff4ca551e454f72`
  - Rapid walk-in counter sale window.
  - Automated FEFO batch determination upon item selection.
  - Pharma GST tax engine with half-rate split.

---

## 3. Database Migration & Schema

- **Migration:** `drizzle/0076_pharmacy_pos.sql`
- **Journal Index:** idx 61, `0076_pharmacy_pos` in `drizzle/meta/_journal.json`
- **Tables Created:**
  - `pharmacy_sales` (Header, tenant RLS, unique sale number)
  - `pharmacy_sale_items` (Batch details, prices, GST split)
  - `pharmacy_returns` (Return header, reason, refund mode)
  - `pharmacy_return_items` (Restocked batch and quantity)
- **Migration Linting:** `npm run db:lint-migrations` -> 62 migrations checked, 0 errors.

---

## 4. Test Verification & Metrics

- **Domain Tests:**
  - `lib/domain/pharmacy.test.ts`: 7/7 passed (GST calculation, bill sequencing, receipt formatting).
  - `lib/domain/entitlements.test.ts`: 2/2 passed (inhouse pharmacy entitlement checking).
- **Service Tests:**
  - `lib/services/pharmacy.test.ts`: 2/2 passed (entitlement enforcement, atomic sale and receipt generation).
- **Action Tests:**
  - `app/(app)/pharmacy/actions.test.ts`: 3/3 passed (role permissions, queue fetching, sale completion).
- **Component Tests:**
  - `components/pharmacy/pharmacy-pos.test.tsx`: 2/2 passed (external pharmacy banner, printable receipt modal).
- **Full Regression Suite:**
  - `npm test`: **83 test files passed, 990 tests passed, 0 failures.**

---

## 5. Artifacts and Commits

- Commit `f0d18b1`: `docs: add Outpatient Retail Pharmacy POS design spec (Item 5.1)`
- Commit `31f0fd9`: `docs: add Outpatient Retail Pharmacy POS implementation plan (Item 5.1)`
- Commit `091a7c7`: `feat(entitlements): add inhouse_pharmacy feature flag and entitlement check (Task 1)`
- Commit `525079e`: `feat(db): add pharmacy POS schema and forward migration 0076 (Task 2)`
- Commit `2f8c1cf`: `feat(pharmacy): add pure domain pricing and receipt engine (Task 3)`
- Commit `db7c6c5`: `feat(pharmacy): add pharmacy service with atomic stock ledger integration (Task 4)`
- Commit `b65d98a`: `feat(pharmacy): add server actions with role permission gating (Task 5)`
- Commit `98e06ae`: `feat(pharmacy): add pharmacy POS cockpit, counter register, and receipt print UI (Task 6)`
