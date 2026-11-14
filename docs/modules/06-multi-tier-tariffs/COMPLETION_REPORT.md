# Phase 2, Item 5.2: Multi-Tier Tariff Rate Plans — Completion Report

**Date:** 2026-11-08  
**Module:** Phase 2, Item 5.2 — Multi-Tier Tariff Rate Plans (Cash vs. TPA Insurance vs. Corporate)  
**Status:** Completed & Fully Verified (100% Pass)  

---

## 1. Executive Summary

We have designed, implemented, and verified **Item 5.2: Multi-Tier Tariff Rate Plans** for Qurio HMS. This provides hospitals with a multi-tenant tariff management subsystem to configure customized pricing matrices and general percentage modifiers for Third-Party Administrators (TPAs), insurance carriers, government schemes (CGHS/ECHS), and corporate tie-ups, while preserving strict historical bill immutability and multi-tenant RLS isolation.

### Key Capabilities Delivered
1. **Multi-Tier Rate Plans (`rate_plans`):**
   - Configurable rate plan schedules defined per hospital with `code`, `name`, `payerKind` (`'self' | 'insurer' | 'tpa' | 'corporate'`), `payerName`, `modifierBp` (basis points modifier), and `isDefault`.
   - Single default rate plan per hospital constraint automatically enforced at both the database level (filtered unique index) and service level.
2. **Item-Specific Tariff Overrides (`charge_item_tariffs`):**
   - Allows exact rupee overrides for non-medicine charge items (`room`, `procedure`, `service`, `consumable`) under any rate plan.
   - Override takes absolute precedence over plan modifiers.
3. **Deterministic Pure Pricing Domain (`lib/domain/tariff.ts`):**
   - `resolveTariffPrice` executes a 3-tier hierarchy: Specific item override -> Rate plan basis points modifier -> Base catalog selling price.
   - Clamps negative discounts to `0 paise` and handles odd paise rounding deterministically (`Math.round`).
4. **Admission & Billing Integration:**
   - `encounter_payers` records `ratePlanId`.
   - Bed-day room charge generator (`lib/services/bed-days.ts`) automatically resolves daily room rates according to the admission's active rate plan.
   - Bedside care entry billing (`lib/services/ipd-billing.ts`) resolves procedure and consumable charges through the attached rate plan.
   - Inpatient medicines (`entry.medicineId`) bypass tariff plans, charging standard medicine selling prices as specified.
5. **Strict Historical Bill Immutability:**
   - `bill_items` snapshots `configuredUnitPricePaise` and `unitPricePaise` at insertion. Subsequent edits to rate plans or tariffs never mutate existing draft or closed bills.
6. **Cockpit UI & Server Actions (`/settings/tariffs`):**
   - Interactive rate plans manager showing active schedules and default badges.
   - Inline tariff override matrix with category filtering (`room`, `procedure`, `service`, `consumable`) and live calculation feedback.
7. **Rule 2.2 Compliance:**
   - 100% English-only copy, code, and documentation.

---

## 2. Reverse Engineering Evidence (Rule 2.1 Compliance)

Captured and studied live platform architectures using the **Reverse Engineer Anything (REA)** browser scenario tool:
- **Practo Insta HMS & Industry Standards:** `ev_ea615599a33f5bbb9e528e6a937a9a67595774d494c5209d465dc24760ee7819`
  - Granular multi-tier rate master decoupling cash prices from TPA/corporate rates.
  - Room category and ward tariff schedules.
  - Package masters and claim deduction minimization.

---

## 3. Database Migration & Schema

- **Migration:** `drizzle/0077_multi_tier_rate_plans.sql`
- **Journal Index:** idx 62, `0077_multi_tier_rate_plans` in `drizzle/meta/_journal.json`
- **Tables Created / Altered:**
  - `rate_plans` (Header, tenant RLS, unique code index, single default constraint)
  - `charge_item_tariffs` (Item overrides, tenant RLS, composite unique index)
  - `encounter_payers` (Added `rate_plan_id` foreign key)
- **Migration Linting:** `npm run db:lint-migrations` -> 63 migrations checked, 0 errors, 5 legacy warnings.

---

## 4. Verification & Test Evidence

### 4.1 Unit & Service Tests
- `lib/domain/__tests__/tariff.test.ts`: 8/8 passed (exact overrides, positive/negative modifiers, odd paise rounding, clamping to 0).
- `lib/services/__tests__/tariffs.test.ts`: 4/4 passed (single default rate plan enforcement, override upsert, price resolution hierarchy).
- `lib/services/__tests__/ipd-billing-tariffs.test.ts`: 3/3 passed (bed days TPA override snapshot, corporate modifier on nursing care entries, medicine exemption).
- `lib/domain/__tests__/payer.test.ts`: 5/5 passed (`ratePlanId` parsing and serialization).
- `lib/domain/__tests__/permissions.test.ts`: 32/32 passed (`tariffs.manage`, `tariffs.view`).

### 4.2 Full Regression Suite
- Total Test Files: **84 passed (84)**
- Total Tests: **998 passed (998)**
- Total Suites Regressed: 100% pass rate.
- Database Linter: 0 errors across 63 migrations.
