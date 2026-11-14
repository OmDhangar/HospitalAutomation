# Multi-Tier Tariff Rate Plans (Cash vs. TPA Insurance vs. Corporate) — Design Specification

- **Module:** Phase 2, Item 5.2 (P2.2)
- **Author:** Antigravity Pairing Agent
- **Date:** 2026-11-08
- **Status:** Approved (Pre-Implementation)
- **Target Release:** Qurio Inpatient (IPD) & Revenue Subsystem

---

## 1. Executive Summary

In Indian hospital operations, medical service charges are fundamentally multi-tiered based on payer category. Hospitals negotiate specific discounted or capped tariff schedules with Third-Party Administrators (TPAs like Star Health, Medi Assist, Vidal, Paramount) and government healthcare schemes (CGHS, ECHS, Ayushman Bharat), while charging premium rates or standard rates for Corporate tie-ups and private Cash-paying walk-ins.

This specification delivers a robust, multi-tenant tariff rate plan subsystem enabling Qurio HMS to:
1. **Define Multi-Tier Rate Plans (`rate_plans`):** Configurable schedules linked to payer categories (`self`, `insurer`, `tpa`, `corporate`) with optional general percentage modifiers (e.g., `+10%` for private corporate, `-15%` for CGHS).
2. **Support Granular Item Overrides (`charge_item_tariffs`):** Exact price overrides per non-medicine hospital charge item (Room charges, nursing care entries, lab tests, procedures) that supersede general modifiers.
3. **Seamless IPD Admission Integration:** Automatic matching of rate plans when reception registers an encounter payer, with full support for manual staff selection.
4. **Deterministic Tariff Resolution Engine:** Pure calculation domain resolving prices in order: `item override -> plan modifier -> base catalog price`.
5. **Strict Historical Bill Immutability:** Billed items snapshot their unit price at the time of insertion; subsequent rate plan updates never alter historical bills.
6. **English-Only Mandate (Rule 2.2):** All rate plan codes, names, labels, and line items remain strictly in English.

---

## 2. Reverse Engineering Evidence & Industry Alignment (Rule 2.1)

Evidence collected using the **Reverse Engineer Anything (REA)** browser scenario tool (`capture_browser_scenario` with Edge browser):

### 2.1 Practo Insta HMS & Industry Tariff Model Analysis
- **REA Evidence ID:** `ev_ea615599a33f5bbb9e528e6a937a9a67595774d494c5209d465dc24760ee7819`
- **Key Workflow Patterns Extracted:**
  - **Tariff Master Hierarchy:** Standard catalog prices serve as the base default. Contracted rate plans either modify prices by a category/blanket percentage or define specific rupee overrides for high-volume items (ICU days, doctor visits, standard surgical procedures).
  - **Decoupled Payer Billing:** When an IPD admission is initiated under insurance/TPA or corporate coverage, the billing engine resolves all room and nursing care entries through the attached rate plan rather than manual discounts on individual lines.
  - **Audit Integrity & Pre-auth Caps:** Pre-authorized amounts (`preauthAmountPaise`) are evaluated against active draft bills running on negotiated tariffs, preventing claim rejections caused by unapproved tariff rates.

---

## 3. Scope & Architectural Boundaries

Based on architectural scoping and user approval:
1. **Governed Items:** Multi-Tier Tariffs apply strictly to **IPD hospital stay charges** (`wards.dailyChargeItemId` / room charges and `care_entries` for procedures, services, and nursing consumables).
2. **Exempt Items:**
   - **Medicines & Drugs:** Medicines follow standard MRP and stock ledger selling prices (`medicines.sellingPricePaise`).
   - **OPD Outpatient Orders:** Walk-in OPD lab tests and consultations remain on base catalog prices unless admitted.
3. **Calculation Hierarchy:**
   - Level 1: Explicit `charge_item_tariffs` row for `(ratePlanId, chargeItemId)`.
   - Level 2: Rate plan general `modifierBp` (basis points offset against base catalog price).
   - Level 3: Base catalog price (`charge_items.sellingPricePaise`).

---

## 4. Data Model & Database Migration

### 4.1 Schema Migration (`drizzle/0077_multi_tier_rate_plans.sql`)

```sql
-- Rate plans table
CREATE TABLE IF NOT EXISTS "rate_plans" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "hospital_id" uuid NOT NULL REFERENCES "hospitals"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "code" text NOT NULL,
  "payer_kind" "payer_kind" NOT NULL DEFAULT 'self',
  "payer_name" text,
  "modifier_bp" integer NOT NULL DEFAULT 0,
  "is_default" boolean NOT NULL DEFAULT false,
  "active" boolean NOT NULL DEFAULT true,
  "created_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  "voided_at" timestamp with time zone,
  "void_reason" text
);

-- Item-specific tariff overrides
CREATE TABLE IF NOT EXISTS "charge_item_tariffs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "hospital_id" uuid NOT NULL REFERENCES "hospitals"("id") ON DELETE CASCADE,
  "rate_plan_id" uuid NOT NULL REFERENCES "rate_plans"("id") ON DELETE CASCADE,
  "charge_item_id" uuid NOT NULL REFERENCES "charge_items"("id") ON DELETE CASCADE,
  "tariff_price_paise" integer NOT NULL,
  "created_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  "voided_at" timestamp with time zone,
  "void_reason" text
);

-- Add rate_plan_id to encounter_payers
ALTER TABLE "encounter_payers" ADD COLUMN IF NOT EXISTS "rate_plan_id" uuid REFERENCES "rate_plans"("id") ON DELETE SET NULL;

-- Unique and indexing constraints
CREATE UNIQUE INDEX IF NOT EXISTS "rate_plans_code_idx" ON "rate_plans" ("hospital_id", lower("code")) WHERE "voided_at" IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "rate_plans_default_idx" ON "rate_plans" ("hospital_id") WHERE "is_default" IS TRUE AND "voided_at" IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "charge_item_tariffs_unique_idx" ON "charge_item_tariffs" ("hospital_id", "rate_plan_id", "charge_item_id") WHERE "voided_at" IS NULL;

-- Row Level Security
ALTER TABLE "rate_plans" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "charge_item_tariffs" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "rate_plans_tenant_isolation" ON "rate_plans"
  FOR ALL USING (hospital_id = current_setting('app.current_hospital_id', true)::uuid);

CREATE POLICY "charge_item_tariffs_tenant_isolation" ON "charge_item_tariffs"
  FOR ALL USING (hospital_id = current_setting('app.current_hospital_id', true)::uuid);
```

### 4.2 Drizzle Schema Declarations (`lib/db/schema.ts`)

```typescript
export const ratePlans = pgTable(
  'rate_plans',
  {
    id: id(),
    hospitalId: uuid('hospital_id')
      .notNull()
      .references(() => hospitals.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    code: text('code').notNull(),
    payerKind: payerKind('payer_kind').notNull().default('self'),
    payerName: text('payer_name'),
    modifierBp: integer('modifier_bp').notNull().default(0),
    isDefault: boolean('is_default').notNull().default(false),
    active: boolean('active').notNull().default(true),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    ...voidColumns(),
  },
  (t) => [
    uniqueIndex('rate_plans_tenant_key').on(t.hospitalId, t.id),
    uniqueIndex('rate_plans_code_idx').on(t.hospitalId, sql`lower(${t.code})`).where(sql`voided_at is null`),
    uniqueIndex('rate_plans_default_idx').on(t.hospitalId).where(sql`is_default is true and voided_at is null`),
  ],
);

export const chargeItemTariffs = pgTable(
  'charge_item_tariffs',
  {
    id: id(),
    hospitalId: uuid('hospital_id')
      .notNull()
      .references(() => hospitals.id, { onDelete: 'cascade' }),
    ratePlanId: uuid('rate_plan_id')
      .notNull()
      .references(() => ratePlans.id, { onDelete: 'cascade' }),
    chargeItemId: uuid('charge_item_id')
      .notNull()
      .references(() => chargeItems.id, { onDelete: 'cascade' }),
    tariffPricePaise: integer('tariff_price_paise').notNull(),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    ...voidColumns(),
  },
  (t) => [
    uniqueIndex('charge_item_tariffs_tenant_key').on(t.hospitalId, t.id),
    uniqueIndex('charge_item_tariffs_unique_idx')
      .on(t.hospitalId, t.ratePlanId, t.chargeItemId)
      .where(sql`voided_at is null`),
  ],
);
```

---

## 5. Pure Pricing Domain Engine (`lib/domain/tariff.ts`)

```typescript
export interface TariffResolutionInput {
  basePricePaise: number | null;
  tariffPricePaise?: number | null;
  modifierBp?: number | null;
}

/**
 * Resolves the effective charge item unit price in paise based on tariff hierarchy:
 * 1. Specific item override (tariffPricePaise) takes absolute precedence.
 * 2. Rate plan modifier (modifierBp) applies percentage offset to base price.
 * 3. Base catalog selling price (basePricePaise).
 */
export function resolveTariffPrice(input: TariffResolutionInput): number | null {
  if (input.basePricePaise === null) return null;

  // 1. Exact item override
  if (input.tariffPricePaise !== undefined && input.tariffPricePaise !== null) {
    return Math.max(0, input.tariffPricePaise);
  }

  // 2. Blanket plan modifier in basis points (10000 bp = 100%, +1000 bp = +10%, -1500 bp = -15%)
  if (input.modifierBp !== undefined && input.modifierBp !== null && input.modifierBp !== 0) {
    const factor = 10000 + input.modifierBp;
    return Math.max(0, Math.round((input.basePricePaise * factor) / 10000));
  }

  // 3. Fallback to base price
  return input.basePricePaise;
}
```

---

## 6. Service Layer Integration

### 6.1 Tariff Management Service (`lib/services/tariffs.ts`)
- `listRatePlansInTx(tx, hospitalId)`: Returns active rate plans with item override counts.
- `getRatePlanByIdInTx(tx, hospitalId, ratePlanId)`: Returns a rate plan with its tariff overrides.
- `saveRatePlanInTx(tx, hospitalId, data, actorUserId)`: Creates or updates a plan, enforcing single default plan.
- `setChargeItemTariffInTx(tx, hospitalId, data, actorUserId)`: Upserts an item override.
- `findEffectiveRatePlanForAdmissionInTx(tx, admissionId)`: Helper looking up the encounter payer's active `ratePlanId` (falling back to hospital default).
- `resolveChargeItemPriceForStayInTx(tx, { hospitalId, chargeItemId, ratePlanId })`: Returns the resolved price in paise.

### 6.2 Bed Days Billing (`lib/services/bed-days.ts`)
In `postBedDaysForAdmissionInTx`:
1. Look up the admission's active encounter payer and associated `ratePlanId`.
2. Look up the effective room rate for `wards.dailyChargeItemId`:
   ```typescript
   const effectivePrice = await resolveChargeItemPriceForStayInTx(tx, {
     hospitalId: encounter.hospitalId,
     chargeItemId: spell.chargeItemId,
     ratePlanId: encounterPayer?.ratePlanId,
   });
   ```
3. Insert into `bill_items` with `configuredUnitPricePaise: effectivePrice` and `unitPricePaise: effectivePrice`.

### 6.3 Inpatient Care Entries (`lib/services/ipd-billing.ts`)
In `postCareEntryLineInTx`:
1. If `entry.chargeItemId` is present, resolve its price using the encounter's rate plan.
2. If `entry.medicineId` is present, keep standard medicine price (`sellingPricePaise`).
3. Snapshot resolved price on `bill_items`.

---

## 7. User Interface Specifications

### 7.1 Settings Cockpit: `/settings/tariffs`
1. **Plan Selector & Overview:**
   - Cards showing active rate plans: Name, Code, Payer Type, Modifier %, Default Badge.
   - Action button: "+ Add Rate Plan".
2. **Item Tariff Matrix:**
   - Filter by Item Kind: `room`, `procedure`, `service`, `consumable`.
   - Table columns: Item Name, Category, Base Price (₹), Tariff Price (₹), Status (`Override Active` or `Modifier Applied`).
   - Inline edit for tariff price with quick save.

### 7.2 IPD Admission Modal Integration
1. When selecting `Payer Type: TPA / Insurance / Corporate`:
   - An intuitive **Rate Plan** dropdown appears.
   - Automatically pre-selects the first active rate plan matching the payer kind / name.
   - Allows manual selection of any active rate plan or "Standard / Cash Default".

---

## 8. Permissions & RBAC

In `lib/domain/permissions.ts`:
- Permission `'tariffs.manage'`: Assigned to `owner`, `admin`. Allows creating rate plans and editing item tariff overrides.
- Permission `'tariffs.view'`: Assigned to `owner`, `admin`, `receptionist`, `nurse`, `billing_executive`. Allows viewing and assigning rate plans on admissions.

---

## 9. Verification & Quality Plan

1. **Unit Tests:** `lib/domain/__tests__/tariff.test.ts` (100% pure function coverage).
2. **Service Tests:** `lib/services/__tests__/tariffs.test.ts` (Plan creation, single default constraint, override matrix, tenant isolation).
3. **Billing Integration Tests:** `lib/services/__tests__/ipd-billing-tariffs.test.ts` (Bed-day room charges under TPA tariff, nursing care entry with corporate modifier, medicine exclusion, historical immutability check).
4. **Migration Linting:** `npm run db:lint-migrations` (0 errors, clean journal registration `0077_multi_tier_rate_plans.sql`).
5. **Full Regression:** `npm test` (all test suites pass 100%).
6. **No Git Commits to GitHub:** All changes remain strictly in local working tree.
