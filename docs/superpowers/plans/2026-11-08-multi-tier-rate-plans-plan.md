# Multi-Tier Tariff Rate Plans (Cash vs. TPA Insurance vs. Corporate) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement multi-tier tariff rate plans in Qurio HMS allowing hospitals to define custom pricing matrices and percentage modifiers for insurance/TPA, corporate tie-ups, and cash patients for IPD bed and care entry charges, while maintaining strict historical bill immutability and multi-tenant RLS.

**Architecture:** A pure pricing engine resolves charge item rates according to priority: explicit tariff override > rate plan modifier (basis points) > base catalog price. The database schema introduces `rate_plans` and `charge_item_tariffs` scoped to hospital tenants, with `encounter_payers` linking admissions to active rate plans. Bed-day calculations and bedside care entries resolve rates through the tariff service before inserting immutable snapshot lines into `bill_items`.

**Tech Stack:** Next.js 16 (App Router), TypeScript, PostgreSQL, Drizzle ORM, Vitest, Tailwind CSS.

**Spec:** [`docs/superpowers/specs/2026-11-08-multi-tier-rate-plans-design.md`](file:///d:/Projects/HospitalAutomation/docs/superpowers/specs/2026-11-08-multi-tier-rate-plans-design.md)

## Global Constraints

- Indian Healthcare Context: All pricing calculations operate strictly in integer paise (`1 INR = 100 paise`) to prevent floating-point inaccuracies.
- English-Only Mandate (Rule 2.2): Rate plan names, codes, billing descriptions, and UI copy must remain strictly in English.
- Reverse Engineering Verification (Rule 2.1): REA browser scenario `ev_ea615599a33f5bbb9e528e6a937a9a67595774d494c5209d465dc24760ee7819` guides tariff hierarchy.
- No Git Commits/Push: User explicitly requested no commits to GitHub; all changes remain in local working directory.
- Multi-Tenant Isolation (Rule 2.4): All tables must have `hospital_id`, RLS policies enabled, and foreign keys with cascade.

## Review Focus

1. **Negative or Extreme Rate Plan Modifiers:** If a rate plan defines `-10000 bp` (-100%) or deeper discount, the price must clamp to `0 paise` and never evaluate to a negative value.
2. **Rounding of Modifier Calculations:** For an odd base price like `155 paise` with a `+1000 bp` (+10%) modifier, `155 * 1.1 = 170.5` must round deterministically to `171 paise` via `Math.round`.
3. **Historical Bill Immutability:** Updating or voiding a rate plan or tariff item override must never alter existing draft or finalized `bill_items`.
4. **Exemption of Medicines:** Bedside administered medicines (`entry.medicineId`) must bypass tariff modifiers and charge standard medicine selling price.
5. **Single Default Plan Constraint:** A hospital cannot have two active rate plans marked `isDefault = true`.

---

### Task 1: Database Schema & Migration `0077_multi_tier_rate_plans.sql`

**Files:**
- Create: `drizzle/0077_multi_tier_rate_plans.sql`
- Modify: `drizzle/meta/_journal.json:430-440`
- Modify: `lib/db/schema.ts`
- Test: `lib/db/migrations/__tests__/lint.test.ts`

**Interfaces:**
- Consumes: `hospitals`, `users`, `payerKind`, `chargeItems`, `encounterPayers` from `lib/db/schema.ts`.
- Produces: `ratePlans` and `chargeItemTariffs` table schemas; `ratePlanId` column on `encounterPayers`.

- [ ] **Step 1: Author Migration File `drizzle/0077_multi_tier_rate_plans.sql`**
  Write migration defining `rate_plans`, `charge_item_tariffs`, altering `encounter_payers` to add `rate_plan_id`, adding unique indices on `(hospital_id, lower(code))` and `(hospital_id, rate_plan_id, charge_item_id)`, and enabling RLS policies.

- [ ] **Step 2: Register Migration in `drizzle/meta/_journal.json`**
  Add entry at `idx: 62`, `tag: "0077_multi_tier_rate_plans"`, `version: "7"`, `when: 1792550000000`, `breakpoints: true`.

- [ ] **Step 3: Update Drizzle Schema in `lib/db/schema.ts`**
  Export `ratePlans` and `chargeItemTariffs` pgTables matching migration columns, indices, and relations. Add `ratePlanId` field to `encounterPayers`.

- [ ] **Step 4: Verify Migration Lint**
  Run: `npm run db:lint-migrations`
  Expected: 0 errors reported.

---

### Task 2: Pure Domain Pricing Engine (`lib/domain/tariff.ts`)

**Files:**
- Create: `lib/domain/tariff.ts`
- Create: `lib/domain/__tests__/tariff.test.ts`

**Interfaces:**
- Consumes: None (pure calculations).
- Produces: `TariffResolutionInput`, `resolveTariffPrice(input: TariffResolutionInput): number | null`.

- [ ] **Step 1: Write failing unit test `lib/domain/__tests__/tariff.test.ts`**
  Test cases:
  1. Base price null returns null.
  2. Tariff price override takes precedence over base price and modifier.
  3. Positive modifier (+1000 bp = +10%) calculates `round(base * 1.1)`.
  4. Negative modifier (-1500 bp = -15%) calculates `round(base * 0.85)`.
  5. Modifier clamps to 0 when negative discount exceeds 100%.
  6. Zero modifier returns exact base price.
  7. Rounding handles odd paise cleanly (`155 paise` + 10% = `171 paise`).

- [ ] **Step 2: Run test to verify it fails**
  Run: `npx vitest run lib/domain/__tests__/tariff.test.ts`
  Expected: FAIL (cannot find module `lib/domain/tariff`).

- [ ] **Step 3: Implement `resolveTariffPrice` in `lib/domain/tariff.ts`**
  Export interface `TariffResolutionInput` and pure function `resolveTariffPrice`.

- [ ] **Step 4: Run test to verify it passes**
  Run: `npx vitest run lib/domain/__tests__/tariff.test.ts`
  Expected: PASS (all tests green).

---

### Task 3: Tariff Service Layer (`lib/services/tariffs.ts`) & Permissions

**Files:**
- Create: `lib/services/tariffs.ts`
- Create: `lib/services/__tests__/tariffs.test.ts`
- Modify: `lib/domain/permissions.ts`

**Interfaces:**
- Consumes: `resolveTariffPrice` from `lib/domain/tariff.ts`, `ratePlans` and `chargeItemTariffs` from `lib/db/schema.ts`.
- Produces: `listRatePlansInTx`, `getRatePlanByIdInTx`, `saveRatePlanInTx`, `setChargeItemTariffInTx`, `findEffectiveRatePlanForAdmissionInTx`, `resolveChargeItemPriceForStayInTx`.

- [ ] **Step 1: Update Permissions in `lib/domain/permissions.ts`**
  Add `'tariffs.manage'` (granted to `owner`, `admin`) and `'tariffs.view'` (granted to `owner`, `admin`, `receptionist`, `nurse`, `billing_executive`).

- [ ] **Step 2: Write failing service tests in `lib/services/__tests__/tariffs.test.ts`**
  Test cases:
  1. `saveRatePlanInTx`: creates plan with unique code; toggling `isDefault` clears default on prior plan.
  2. `setChargeItemTariffInTx`: creates or updates item override.
  3. `findEffectiveRatePlanForAdmissionInTx`: finds rate plan from `encounter_payers`, falling back to default plan.
  4. `resolveChargeItemPriceForStayInTx`: applies resolution hierarchy correctly.

- [ ] **Step 3: Run test to verify it fails**
  Run: `npx vitest run lib/services/__tests__/tariffs.test.ts`
  Expected: FAIL.

- [ ] **Step 4: Implement `lib/services/tariffs.ts`**
  Implement the transactional queries and mutations with tenant checking (`withTenant` or `hospitalId` scoping).

- [ ] **Step 5: Run test to verify it passes**
  Run: `npx vitest run lib/services/__tests__/tariffs.test.ts`
  Expected: PASS.

---

### Task 4: Hook Tariff Resolution into IPD Bed Days & Care Entries

**Files:**
- Modify: `lib/services/bed-days.ts`
- Modify: `lib/services/ipd-billing.ts`
- Create: `lib/services/__tests__/ipd-billing-tariffs.test.ts`

**Interfaces:**
- Consumes: `resolveChargeItemPriceForStayInTx` and `findEffectiveRatePlanForAdmissionInTx` from `lib/services/tariffs.ts`.
- Produces: Rate-plan-aware bed day charges and nursing care charges with immutable bill item snapshots.

- [ ] **Step 1: Write failing billing integration test in `lib/services/__tests__/ipd-billing-tariffs.test.ts`**
  Test cases:
  1. Bed day charge uses rate plan room tariff override if present.
  2. Bed day charge applies percentage modifier if no item override exists.
  3. Bedside procedure care entry applies rate plan tariff.
  4. Bedside medicine care entry ignores rate plan tariff and uses medicine selling price.
  5. Updating a tariff rate does not mutate already inserted `bill_items`.

- [ ] **Step 2: Run test to verify it fails**
  Run: `npx vitest run lib/services/__tests__/ipd-billing-tariffs.test.ts`
  Expected: FAIL.

- [ ] **Step 3: Modify `lib/services/bed-days.ts`**
  In `postBedDaysForAdmissionInTx`, look up the effective rate plan for the admission's active encounter payer, resolve the daily charge item price through `resolveChargeItemPriceForStayInTx`, and store it in `billItems.configuredUnitPricePaise` and `billItems.unitPricePaise`.

- [ ] **Step 4: Modify `lib/services/ipd-billing.ts`**
  In `postCareEntryLineInTx`, look up the admission's active encounter payer, resolve `entry.chargeItemId` using `resolveChargeItemPriceForStayInTx`, and set the resolved price on `bill_items`.

- [ ] **Step 5: Run tests to verify they pass**
  Run: `npx vitest run lib/services/__tests__/ipd-billing-tariffs.test.ts`
  Expected: PASS.

---

### Task 5: Server Actions & Rate Plan Management UI Cockpit

**Files:**
- Create: `app/(app)/settings/tariffs/actions.ts`
- Create: `app/(app)/settings/tariffs/page.tsx`
- Modify: `app/(app)/ipd/actions.ts` (allow setting `ratePlanId` when recording encounter payer)

**Interfaces:**
- Consumes: `lib/services/tariffs.ts` and `lib/domain/permissions.ts`.
- Produces: User-facing tariff configuration UI and admission payer rate plan assignment.

- [ ] **Step 1: Implement Server Actions in `app/(app)/settings/tariffs/actions.ts`**
  Implement `listRatePlansAction`, `saveRatePlanAction`, `setChargeItemTariffAction`, `bulkSetTariffsAction` protected by `tariffs.manage` permission.

- [ ] **Step 2: Implement UI Page `app/(app)/settings/tariffs/page.tsx`**
  Build clean UI adhering to Qurio design system (inline SVGs, Tailwind CSS):
  - Rate Plans shelf with active/default indicators.
  - Plan creation/edit modal (Name, Code, Payer Type, Modifier %, Default checkbox).
  - Charge Items Tariff Matrix with kind filter (`room`, `procedure`, `service`, `consumable`), base price display, and editable tariff price input in Rupees.

- [ ] **Step 3: Update IPD Admission Actions to Support `ratePlanId`**
  In `app/(app)/ipd/actions.ts` or payer input handling, persist `ratePlanId` onto `encounterPayers`.

---

### Task 6: Full Regression Verification & Completion Report

**Files:**
- Create: `docs/modules/06-multi-tier-tariffs/COMPLETION_REPORT.md`
- Modify: `docs/audit/IMPLEMENTATION_BACKLOG.md`
- Modify: Task artifact (`task.md`)

- [ ] **Step 1: Run Migration Linter**
  Run: `npm run db:lint-migrations`
  Expected: 0 errors.

- [ ] **Step 2: Run Full Regression Test Suite**
  Run: `npm test`
  Expected: 100% pass across all test suites (84+ suites, 1000+ tests).

- [ ] **Step 3: Author Completion Report**
  Write detailed report at `docs/modules/06-multi-tier-tariffs/COMPLETION_REPORT.md` documenting architecture, test evidence, immutability proof, and Rule 2.1/2.2 compliance.

- [ ] **Step 4: Update Backlog and Task Tracker**
  Update `docs/audit/IMPLEMENTATION_BACKLOG.md` and `task.md`.
