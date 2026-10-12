# IPD eMAR & Doctor Rounding Cockpit — Phase 1: Database & Domain Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement Phase 1 of `SPEC-IPD-EMAR-001`: the pure domain logic engines (scheduling, PRN limits, order state machine), PostgreSQL migration `0047_ipd_emar_foundation.sql` (8 tables, triggers, composite FKs, RLS policies), Drizzle ORM schemas in `lib/db/schema.ts`, and unit/integration test suites.

**Architecture:** Pure domain modules in `lib/domain/` contain deterministic business logic without database dependencies. Database migration `0047` establishes tamper-resistant clinical data models, triggers enforcing signed-order and template immutability, composite foreign keys binding admissions, orders, and round notes, and PostgreSQL Row-Level Security (`FORCE ROW LEVEL SECURITY`). Drizzle schema models map the tables into TypeScript.

**Tech Stack:** TypeScript, PostgreSQL 16, Drizzle ORM, Vitest.

**Spec:** [`docs/superpowers/specs/2026-10-12-ipd-doctor-rounding-prescriptions-design.md`](file:///d:/Projects/HospitalAutomation/docs/superpowers/specs/2026-10-12-ipd-doctor-rounding-prescriptions-design.md) (`SPEC-IPD-EMAR-001`)

## Global Constraints

- **Signed-Order Immutability:** Once signed, clinical instructions (`medicine_id`, dose, route, schedule, times, duration, prescriber) are strictly immutable. Renewals and amendments author successor rows with `supersedes_order_id = old.id` and shared `order_chain_id`.
- **Tenant Isolation:** All tables have `hospital_id UUID NOT NULL` and use `FORCE ROW LEVEL SECURITY` with `hospital_id = nullif(current_setting('app.hospital_id', true), '')::uuid`.
- **Retention Guarantee:** Zero cascading deletes on signed clinical entities; all clinical references use `ON DELETE RESTRICT`.
- **Discrete Doses Only (MVP Scope):** Routes strictly limited to discrete bolus administration (`oral`, `iv_push`, `iv_piggyback`, `im`, `sc`, `nebulization`, `topical`, `inhalation`, `sublingual`, `rectal`, `ophthalmic`, `otic`). Continuous and fixed-rate IV infusions are deferred.
- **Chart Day Boundary:** Medication Chart Day runs `08:00` to `08:00` (matching `chartDayOf` in `lib/domain/tpr.ts`).
- **Production Migration Prohibition:** Do not run production migrations. Schema changes are verified against test/scratch setups and test suites.

## Review Focus

1. **Midnight in Schedule Times:** Clock strings `"00:00"` vs `"24:00"` — `"00:00"` must be used exclusively; `"24:00"` is invalid.
2. **Chart Day Boundary Doses:** PRN dose at `07:59` belongs to the previous chart day; dose at `08:00` belongs to the new chart day.
3. **Cross-Version PRN Chain Accumulation:** Doses recorded under Version 1 must count against daily limits when administering under Version 2 of the same `order_chain_id`.
4. **Voided Dose Exclusion:** Administrations with `voided_at IS NOT NULL` must be omitted from PRN cooldown and cumulative daily quantities.
5. **RLS Fail-Closed:** Queries executed without setting `app.hospital_id` must return zero rows without error (`nullif` returns `NULL`).

---

### Task 1: Medication Scheduling Domain Engine

**Files:**
- Create: `lib/domain/ipd-schedule.ts`
- Test: `lib/domain/__tests__/ipd-schedule.test.ts`

**Interfaces:**
- Consumes: None (pure functions)
- Produces:
  - `FREQUENCY_DEFAULTS: Record<string, string[]>`
  - `isValidClockTime(time: string): boolean`
  - `getScheduleTimesForFrequency(frequencyCode: string): string[]`
  - `calculateScheduledOccurrences(args: { scheduleTimes: string[]; startsAt: Date; endsAt?: Date | null; from: Date; to: Date; timezone: string }): Date[]`
  - `getTaskTimeCategory(scheduledTime: Date, targetTime: Date): 'due_now' | 'overdue' | 'upcoming'`

- [ ] **Step 1: Write the failing tests**

Create `lib/domain/__tests__/ipd-schedule.test.ts`:
```typescript
import { describe, expect, it } from 'vitest';
import {
  FREQUENCY_DEFAULTS,
  isValidClockTime,
  getScheduleTimesForFrequency,
  calculateScheduledOccurrences,
  getTaskTimeCategory,
} from '@/lib/domain/ipd-schedule';

describe('ipd-schedule', () => {
  it('validates 24-hour clock time strings', () => {
    expect(isValidClockTime('08:00')).toBe(true);
    expect(isValidClockTime('00:00')).toBe(true);
    expect(isValidClockTime('23:59')).toBe(true);
    expect(isValidClockTime('24:00')).toBe(false);
    expect(isValidClockTime('8:00')).toBe(false);
    expect(isValidClockTime('invalid')).toBe(false);
  });

  it('returns default schedule times for standard frequencies', () => {
    expect(getScheduleTimesForFrequency('OD')).toEqual(['08:00']);
    expect(getScheduleTimesForFrequency('BD')).toEqual(['08:00', '20:00']);
    expect(getScheduleTimesForFrequency('TDS')).toEqual(['08:00', '14:00', '20:00']);
    expect(getScheduleTimesForFrequency('QID')).toEqual(['06:00', '12:00', '18:00', '00:00']);
    expect(getScheduleTimesForFrequency('Stat')).toEqual([]);
    expect(getScheduleTimesForFrequency('PRN')).toEqual([]);
  });

  it('calculates scheduled dose occurrences within a time window', () => {
    const startsAt = new Date('2026-10-12T06:00:00+05:30');
    const endsAt = new Date('2026-10-15T06:00:00+05:30');
    const occurrences = calculateScheduledOccurrences({
      scheduleTimes: ['08:00', '20:00'],
      startsAt,
      endsAt,
      from: new Date('2026-10-12T00:00:00+05:30'),
      to: new Date('2026-10-13T00:00:00+05:30'),
      timezone: 'Asia/Kolkata',
    });

    expect(occurrences).toHaveLength(2);
    expect(occurrences[0].toISOString()).toBe(new Date('2026-10-12T08:00:00+05:30').toISOString());
    expect(occurrences[1].toISOString()).toBe(new Date('2026-10-12T20:00:00+05:30').toISOString());
  });

  it('classifies dose task into due_now, overdue, or upcoming', () => {
    const target = new Date('2026-10-12T08:30:00Z');
    // within 60m: [07:30, 09:30]
    expect(getTaskTimeCategory(new Date('2026-10-12T08:00:00Z'), target)).toBe('due_now');
    expect(getTaskTimeCategory(new Date('2026-10-12T07:30:00Z'), target)).toBe('due_now');
    // older than 60m: before 07:30
    expect(getTaskTimeCategory(new Date('2026-10-12T07:00:00Z'), target)).toBe('overdue');
    // more than 60m in future: after 09:30
    expect(getTaskTimeCategory(new Date('2026-10-12T10:00:00Z'), target)).toBe('upcoming');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/domain/__tests__/ipd-schedule.test.ts`  
Expected: FAIL with module not found or functions not defined.

- [ ] **Step 3: Implement `lib/domain/ipd-schedule.ts`**

Implement clock validation, frequency mapping, timezone-aware occurrence generator, and time categorization window (`[-60m, +60m]`).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/domain/__tests__/ipd-schedule.test.ts`  
Expected: PASS 4/4 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/domain/ipd-schedule.ts lib/domain/__tests__/ipd-schedule.test.ts
git commit -m "feat(ipd): add medication scheduling domain engine"
```

---

### Task 2: PRN Limit & Cooldown Domain Calculator

**Files:**
- Create: `lib/domain/ipd-prn.ts`
- Test: `lib/domain/__tests__/ipd-prn.test.ts`

**Interfaces:**
- Consumes: `chartDayOf` from `lib/domain/tpr.ts`
- Produces:
  - `getPrnChainLockKey(orderChainId: string): string`
  - `getChartDayWindow(date: Date, timezone?: string): { start: Date; end: Date }`
  - `checkPrnEligibility(args: { order: PrnOrderConstraints; history: AdministrationHistoryEntry[]; requestedAt: Date; proposedDoseAmount?: number | null; timezone?: string }): PrnEligibilityResult`

- [ ] **Step 1: Write the failing tests**

Create `lib/domain/__tests__/ipd-prn.test.ts`:
```typescript
import { describe, expect, it } from 'vitest';
import {
  checkPrnEligibility,
  getChartDayWindow,
  getPrnChainLockKey,
} from '@/lib/domain/ipd-prn';

describe('ipd-prn', () => {
  it('generates stable advisory lock key for order chain', () => {
    const chainId = '11111111-2222-3333-4444-555555555555';
    expect(getPrnChainLockKey(chainId)).toBe('ipd_prn_chain:11111111-2222-3333-4444-555555555555');
  });

  it('calculates chart day window from 08:00 to 08:00', () => {
    // 10:00 on Oct 12 -> [Oct 12 08:00, Oct 13 08:00]
    const window1 = getChartDayWindow(new Date('2026-10-12T10:00:00+05:30'), 'Asia/Kolkata');
    expect(window1.start.toISOString()).toBe(new Date('2026-10-12T08:00:00+05:30').toISOString());
    expect(window1.end.toISOString()).toBe(new Date('2026-10-13T08:00:00+05:30').toISOString());

    // 07:30 on Oct 12 -> belongs to previous chart day [Oct 11 08:00, Oct 12 08:00]
    const window2 = getChartDayWindow(new Date('2026-10-12T07:30:00+05:30'), 'Asia/Kolkata');
    expect(window2.start.toISOString()).toBe(new Date('2026-10-11T08:00:00+05:30').toISOString());
    expect(window2.end.toISOString()).toBe(new Date('2026-10-12T08:00:00+05:30').toISOString());
  });

  it('enforces minimum cooldown interval between doses', () => {
    const lastGiven = new Date('2026-10-12T09:00:00+05:30');
    const requested = new Date('2026-10-12T11:00:00+05:30'); // only 2 hours later
    const result = checkPrnEligibility({
      order: { prnMinIntervalHours: 4, prnMaxDailyDoses: 4 },
      history: [{ actualTime: lastGiven, doseAmountNumeric: 500, voidedAt: null }],
      requestedAt: requested,
    });

    expect(result.eligible).toBe(false);
    expect(result.reason).toContain('Cooldown interval');
    expect(result.remainingCooldownMinutes).toBe(120);
  });

  it('enforces maximum daily doses per chart day', () => {
    const history = [
      { actualTime: new Date('2026-10-12T08:30:00+05:30'), doseAmountNumeric: 500, voidedAt: null },
      { actualTime: new Date('2026-10-12T13:00:00+05:30'), doseAmountNumeric: 500, voidedAt: null },
      { actualTime: new Date('2026-10-12T18:00:00+05:30'), doseAmountNumeric: 500, voidedAt: null },
    ];
    const result = checkPrnEligibility({
      order: { prnMinIntervalHours: 4, prnMaxDailyDoses: 3 },
      history,
      requestedAt: new Date('2026-10-12T23:00:00+05:30'),
    });

    expect(result.eligible).toBe(false);
    expect(result.reason).toContain('Daily limit reached');
  });

  it('enforces maximum daily cumulative substance quantity', () => {
    const history = [
      { actualTime: new Date('2026-10-12T08:30:00+05:30'), doseAmountNumeric: 1000, voidedAt: null },
      { actualTime: new Date('2026-10-12T14:00:00+05:30'), doseAmountNumeric: 1000, voidedAt: null },
    ];
    const result = checkPrnEligibility({
      order: { prnMinIntervalHours: 4, prnMaxDailyDoses: 6, prnMaxDailyQuantity: 2500, prnMaxDailyUnit: 'mg' },
      history,
      requestedAt: new Date('2026-10-12T20:00:00+05:30'),
      proposedDoseAmount: 1000, // 2000 + 1000 = 3000 > 2500
    });

    expect(result.eligible).toBe(false);
    expect(result.reason).toContain('Cumulative quantity limit exceeded');
  });

  it('excludes voided doses from cooldown and cumulative limits', () => {
    const history = [
      { actualTime: new Date('2026-10-12T09:00:00+05:30'), doseAmountNumeric: 1000, voidedAt: new Date('2026-10-12T09:10:00+05:30') },
    ];
    const result = checkPrnEligibility({
      order: { prnMinIntervalHours: 4, prnMaxDailyDoses: 2 },
      history,
      requestedAt: new Date('2026-10-12T10:00:00+05:30'),
    });

    expect(result.eligible).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/domain/__tests__/ipd-prn.test.ts`  
Expected: FAIL with module not found or functions not defined.

- [ ] **Step 3: Implement `lib/domain/ipd-prn.ts`**

Implement chart day window calculation, cooldown checker, dose count counter, and cumulative substance limit comparator, filtering out voided records.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/domain/__tests__/ipd-prn.test.ts`  
Expected: PASS 6/6 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/domain/ipd-prn.ts lib/domain/__tests__/ipd-prn.test.ts
git commit -m "feat(ipd): add PRN limits and cooldown domain calculator"
```

---

### Task 3: Order State Machine & Transition Rules

**Files:**
- Create: `lib/domain/ipd-order-state.ts`
- Test: `lib/domain/__tests__/ipd-order-state.test.ts`

**Interfaces:**
- Consumes: None
- Produces:
  - `IPD_ORDER_STATUSES`, `IPD_ORDER_ACTIONS`
  - `isOrderActionable(order: { status: string; endsAt?: Date | null }, now: Date): boolean`
  - `validateOrderTransition(args: { currentStatus: string; action: string; reason?: string | null; doctorId?: string | null; endsAt?: Date | null; now: Date }): { valid: boolean; nextStatus?: string; error?: string }`

- [ ] **Step 1: Write the failing tests**

Create `lib/domain/__tests__/ipd-order-state.test.ts`:
```typescript
import { describe, expect, it } from 'vitest';
import {
  isOrderActionable,
  validateOrderTransition,
} from '@/lib/domain/ipd-order-state';

describe('ipd-order-state', () => {
  it('determines if order is actionable at runtime', () => {
    const now = new Date('2026-10-12T12:00:00Z');
    expect(isOrderActionable({ status: 'active', endsAt: new Date('2026-10-12T13:00:00Z') }, now)).toBe(true);
    expect(isOrderActionable({ status: 'active', endsAt: null }, now)).toBe(true);
    // Expired by time even if status still active
    expect(isOrderActionable({ status: 'active', endsAt: new Date('2026-10-12T11:00:00Z') }, now)).toBe(false);
    // Non-active states
    expect(isOrderActionable({ status: 'draft' }, now)).toBe(false);
    expect(isOrderActionable({ status: 'on_hold' }, now)).toBe(false);
    expect(isOrderActionable({ status: 'discontinued' }, now)).toBe(false);
    expect(isOrderActionable({ status: 'voided' }, now)).toBe(false);
  });

  it('validates signing draft orders', () => {
    const res = validateOrderTransition({
      currentStatus: 'draft',
      action: 'sign',
      doctorId: 'doc-123',
      now: new Date(),
    });
    expect(res.valid).toBe(true);
    expect(res.nextStatus).toBe('active');

    const invalid = validateOrderTransition({
      currentStatus: 'draft',
      action: 'sign',
      doctorId: null,
      now: new Date(),
    });
    expect(invalid.valid).toBe(false);
    expect(invalid.error).toContain('doctor');
  });

  it('requires structured reason for hold, resume, discontinue, void', () => {
    expect(validateOrderTransition({ currentStatus: 'active', action: 'hold', reason: null, now: new Date() }).valid).toBe(false);
    expect(validateOrderTransition({ currentStatus: 'active', action: 'hold', reason: 'NPO for surgery', now: new Date() }).valid).toBe(true);

    expect(validateOrderTransition({ currentStatus: 'on_hold', action: 'resume', reason: 'Post-op cleared', now: new Date() }).valid).toBe(true);
    expect(validateOrderTransition({ currentStatus: 'active', action: 'discontinue', reason: 'Adverse reaction', now: new Date() }).valid).toBe(true);
    expect(validateOrderTransition({ currentStatus: 'active', action: 'void', reason: 'Wrong patient chart', now: new Date() }).valid).toBe(true);
  });

  it('transitions active to completed upon expiration', () => {
    const now = new Date('2026-10-12T15:00:00Z');
    const endsAt = new Date('2026-10-12T14:00:00Z');
    const res = validateOrderTransition({
      currentStatus: 'active',
      action: 'expire',
      endsAt,
      now,
    });
    expect(res.valid).toBe(true);
    expect(res.nextStatus).toBe('completed');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/domain/__tests__/ipd-order-state.test.ts`  
Expected: FAIL with module not found or functions not defined.

- [ ] **Step 3: Implement `lib/domain/ipd-order-state.ts`**

Implement order transition validator and runtime actionability checker adhering to the transition graph in §6.1.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/domain/__tests__/ipd-order-state.test.ts`  
Expected: PASS 4/4 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/domain/ipd-order-state.ts lib/domain/__tests__/ipd-order-state.test.ts
git commit -m "feat(ipd): add order state machine and transition rules"
```

---

### Task 4: Database Migration `0047_ipd_emar_foundation.sql`

**Files:**
- Create: `drizzle/0047_ipd_emar_foundation.sql`
- Test: `lib/db/migrations/__tests__/lint.test.ts`

**Interfaces:**
- Consumes: `admissions` unique index `admissions_tenant_encounter_key`, `medicines`, `doctors`, `hospitals`
- Produces: 8 database tables, composite foreign keys, immutability & audit triggers, and exhaustive RLS policies.

- [ ] **Step 1: Write migration SQL file**

Create `drizzle/0047_ipd_emar_foundation.sql` containing:
1. ANSI unique constraint on `admissions`:
   ```sql
   ALTER TABLE admissions ADD CONSTRAINT admissions_tenant_encounter_uq
     UNIQUE USING INDEX admissions_tenant_encounter_key;
   ```
2. Creation of `ipd_clinical_rounds`
3. Creation of `ipd_medication_orders`
4. Creation of `ipd_medication_order_actions`
5. Creation of `ipd_medication_administrations`
6. Creation of `ipd_allergy_assessments`
7. Creation of `ipd_order_sets` and `ipd_order_set_items`
8. Creation of `ipd_emar_integration_outbox`
9. Triggers:
   - `ipd_enforce_signed_order_immutability()` + `trg_ipd_med_orders_immutable`
   - `ipd_enforce_signed_round_immutability()` + `trg_ipd_clinical_rounds_immutable`
   - `ipd_prevent_audit_mutation()` + `trg_ipd_order_actions_append_only`
   - `ipd_enforce_admin_void_only()` + `trg_ipd_med_admin_void_only`
   - `ipd_enforce_order_set_immutability()` + `trg_ipd_order_sets_immutable` & `trg_ipd_order_set_items_immutable`
10. Row-Level Security:
    - Loop enabling and forcing RLS on all 8 tables.
    - `tenant_isolation` policy with `USING` and `WITH CHECK`.
    - `read_only_write` and `read_only_delete` restrictive policies.
    - `clinical_access` restrictive policy on the 5 clinical tables.

- [ ] **Step 2: Run migration lint test**

Run: `npx vitest run lib/db/migrations/__tests__/lint.test.ts`  
Expected: PASS (asserts migration formatting, breaks, syntax).

- [ ] **Step 3: Commit**

```bash
git add drizzle/0047_ipd_emar_foundation.sql
git commit -m "feat(ipd): create migration 0047 for eMAR and rounding cockpit foundation"
```

---

### Task 5: Drizzle Schema Additions in `lib/db/schema.ts`

**Files:**
- Modify: `lib/db/schema.ts`
- Test: `npm run typecheck`

**Interfaces:**
- Consumes: `drizzle-orm/pg-core`, `hospitals`, `admissions`, `medicines`, `doctors`, `users`
- Produces: Drizzle table objects (`ipdClinicalRounds`, `ipdMedicationOrders`, `ipdMedicationOrderActions`, `ipdMedicationAdministrations`, `ipdAllergyAssessments`, `ipdOrderSets`, `ipdOrderSetItems`, `ipdEmarIntegrationOutbox`) and inferred TypeScript types.

- [ ] **Step 1: Add table schemas and types to `lib/db/schema.ts`**

Map the 8 tables into Drizzle syntax with exact column types, foreign keys, unique constraints, and check constraints:
- `ipdClinicalRounds`
- `ipdMedicationOrders`
- `ipdMedicationOrderActions`
- `ipdMedicationAdministrations`
- `ipdAllergyAssessments`
- `ipdOrderSets`
- `ipdOrderSetItems`
- `ipdEmarIntegrationOutbox`
Export corresponding `InferSelectModel` and `InferInsertModel` types.

- [ ] **Step 2: Run TypeScript typecheck**

Run: `npm run typecheck`  
Expected: PASS with 0 type errors.

- [ ] **Step 3: Commit**

```bash
git add lib/db/schema.ts
git commit -m "feat(ipd): add eMAR and rounding tables to Drizzle schema"
```

---

### Task 6: Database Integration & RLS Test Suite

**Files:**
- Create: `lib/db/__tests__/ipd-emar-schema.integration.test.ts`
- Test: `vitest run lib/db/__tests__/ipd-emar-schema.integration.test.ts`

**Interfaces:**
- Consumes: `adminUrl`, `appUrl`, `asTenant` helper from `lib/db/__tests__/ipd-schema.integration.test.ts` pattern
- Produces: Integration verification suite for migration 0047 guarantees.

- [ ] **Step 1: Write integration test suite**

Create `lib/db/__tests__/ipd-emar-schema.integration.test.ts` verifying:
- Multi-tenant query isolation: Hospital A cannot see Hospital B medication orders.
- Composite foreign key enforcement: administration cannot reference order from another hospital or admission.
- Immutability trigger: direct update to `dose_amount` or `route` on a signed order throws `Signed clinical medication instructions are immutable`.
- Append-only actions trigger: `UPDATE` or `DELETE` on `ipd_medication_order_actions` throws exception.
- Administration void-only trigger: `DELETE` throws exception; updating `actual_time` or `outcome` throws exception.
- Order-set immutability trigger: updates to `approved` templates throw exception.
- RLS fails closed: queries without setting `app.hospital_id` return zero rows.

- [ ] **Step 2: Run test suite**

Run: `npx vitest run lib/db/__tests__/ipd-emar-schema.integration.test.ts`  
Expected: PASS (or skips safely when run without local postgres admin credentials).

- [ ] **Step 3: Commit**

```bash
git add lib/db/__tests__/ipd-emar-schema.integration.test.ts
git commit -m "test(ipd): add integration test suite for eMAR schema and RLS policies"
```

---

## Final Review & Hand-off

After completing Tasks 1 through 6:
- Run the full unit test suite: `npm test`
- Run typecheck: `npm run typecheck`
- Verify zero production migrations were executed.
- Report completion and link the plan to the user.
