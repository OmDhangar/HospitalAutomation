# IPD eMAR Phase 2: Clinical Services & Outbox Processing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the transactional clinical services (`ipd-medication-orders.ts`, `ipd-emar.ts`, and `ipd-emar-outbox.ts`) providing round evaluation signing, order versioning, bedside eMAR due/PRN administration, and transactional outbox billing integration.

**Architecture:** Domain-driven transactional service layer built on top of Drizzle ORM and PostgreSQL. Doctor rounding decisions atomically sign evaluations and create immutable order versions. Bedside nursing eMAR serializes PRN checks using PostgreSQL transactional advisory locks (`ipd_prn_chain:<uuid>`) and enqueues accounting events to `ipd_emar_integration_outbox`. Background worker processes outbox rows with lease locking (`FOR UPDATE SKIP LOCKED`), exponential backoff, and non-blocking `pending_pricing` handling for unpriced formulary items.

**Tech Stack:** TypeScript, Node.js, Next.js, PostgreSQL (with row-level security and triggers), Drizzle ORM, Vitest.

**Spec:** [`docs/superpowers/specs/2026-10-12-ipd-doctor-rounding-prescriptions-design.md`](file:///d:/Projects/HospitalAutomation/docs/superpowers/specs/2026-10-12-ipd-doctor-rounding-prescriptions-design.md)

## Global Constraints

- Never mutate signed clinical instructions (`dose_amount`, `route`, `schedule_type`, `schedule_times`, `starts_at`, `ends_at`) in place; renewals and modifications must create a new successor order row with `supersedes_order_id = old.id` and shared `order_chain_id`.
- Unsigned draft orders must be completely invisible to bedside nursing eMAR queries.
- PRN evaluations must serialize across concurrent nurses and order versions via `pg_advisory_xact_lock(hashtext('ipd_prn_chain:' || order_chain_id::text))`.
- Administration events must enforce idempotent retries on `client_id`.
- Outbox worker must never block on unpriced medicines; unpriced items transition to `status = 'pending_pricing'` and are skipped until catalog pricing reconciliation.
- Continuous and fixed-rate IV infusions are explicitly out of scope for MVP (discrete bolus doses only).
- Do NOT run production migrations (`npm run db:migrate`).

## Review Focus

1. **Concurrent PRN administrations on different devices or order versions:** Two nurses attempting to administer PRN analgesics to the same patient within seconds must serialize on the database advisory lock so the second nurse receives a cooldown/limit rejection.
2. **Concurrent order discontinuation while nurse is administering:** If an attending doctor discontinues an order between rounds while a nurse has the administration modal open, recording the dose must fail with an order inactive error rather than creating an orphan administration.
3. **Draft leakage to nursing eMAR:** Orders in `draft` status must never appear in `dueNow`, `upcoming`, or `prn` buckets on the bedside eMAR.
4. **Stat order immediate completion:** An order with `schedule_type = 'stat'` must transition to `status = 'completed'` immediately within the same transaction that records its administration.
5. **Idempotent client retries:** If a network blip causes a mobile tablet to submit the same administration request (`client_id`) twice, the second request must return the existing administration record with zero duplicates and zero duplicate outbox billing events.

---

### Task 1: Medication Orders & Rounding Service (`lib/services/ipd-medication-orders.ts`)

**Files:**
- Create: `lib/services/ipd-medication-orders.ts`
- Test: `lib/services/__tests__/ipd-medication-orders.integration.test.ts`

**Interfaces:**
- Consumes:
  - `ipdClinicalRounds`, `ipdMedicationOrders`, `ipdMedicationOrderActions`, `admissions`, `medicines`, `doctors` from `lib/db/schema.ts`
  - `isOrderActionable`, `validateOrderTransition` from `lib/domain/ipd-order-state.ts`
- Produces:
  - `listActiveOrders(args: { hospitalId: string; admissionId: string; now?: Date }): Promise<ActiveOrderSummary[]>`
  - `saveRoundDraft(args: { hospitalId: string; admissionId: string; doctorId: string; authorUserId: string; notes?: string; draftOrders?: DraftOrderInput[] }): Promise<{ roundId: string }>`
  - `signRoundOrders(args: { hospitalId: string; admissionId: string; doctorId: string; authorUserId: string; notes: string; resolutions: OrderResolutionInput[] }): Promise<{ roundId: string; signedOrderIds: string[] }>`
  - `executeOrderAction(args: { hospitalId: string; orderId: string; action: 'hold' | 'resume' | 'discontinue'; reason: string; actorUserId: string; doctorId?: string }): Promise<{ success: boolean; nextStatus: string }>`
  - `voidOrder(args: { hospitalId: string; orderId: string; reason: string; actorUserId: string }): Promise<{ success: boolean }>`

- [ ] **Step 1: Write integration tests for medication orders service**

Create `lib/services/__tests__/ipd-medication-orders.integration.test.ts` verifying:
- `listActiveOrders` returns only active and held orders, excluding drafts, voided, completed, and superseded orders.
- `saveRoundDraft` persists draft notes and draft orders without making them actionable.
- `signRoundOrders`:
  - Continues ongoing orders without alteration.
  - Renews orders by creating a new successor version with updated `ends_at`, linking `supersedes_order_id`, and setting prior version to `superseded`.
  - Modifies orders by creating a successor version with new dosage/route, marking old version `superseded`.
  - Discontinues orders with structured reason and logs action audit row.
  - Holds orders with structured reason and logs action audit row.
  - Finalizes round notes with `status = 'signed'`.
- `executeOrderAction` transitions orders (`hold`, `resume`, `discontinue`) with validation.
- `voidOrder` marks order `voided` with reason and logs audit action.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/services/__tests__/ipd-medication-orders.integration.test.ts`  
Expected: FAIL with module not found.

- [ ] **Step 3: Implement `lib/services/ipd-medication-orders.ts`**

Implement order query, draft saving, atomic round signing with successor order versioning, ad-hoc state transitions, and order voiding adhering to the state machine rules and foreign key integrity.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/services/__tests__/ipd-medication-orders.integration.test.ts`  
Expected: PASS all tests.

- [ ] **Step 5: Commit**

```bash
git add lib/services/ipd-medication-orders.ts lib/services/__tests__/ipd-medication-orders.integration.test.ts
git commit -m "feat(ipd): add medication orders and rounding service"
```

---

### Task 2: Bedside Nursing eMAR Service (`lib/services/ipd-emar.ts`)

**Files:**
- Create: `lib/services/ipd-emar.ts`
- Test: `lib/services/__tests__/ipd-emar.integration.test.ts`

**Interfaces:**
- Consumes:
  - `ipdMedicationOrders`, `ipdMedicationAdministrations`, `ipdEmarIntegrationOutbox` from `lib/db/schema.ts`
  - `generateScheduleOccurrences`, `categorizeDueWindow` from `lib/domain/ipd-schedule.ts`
  - `checkPrnEligibility`, `getChartDayWindow` from `lib/domain/ipd-prn.ts`
  - `medicineRiskClasses` from `lib/db/schema.ts`
- Produces:
  - `getBedsideEmar(args: { hospitalId: string; admissionId: string; targetTime?: Date }): Promise<BedsideEmarView>`
  - `recordAdministration(args: { hospitalId: string; admissionId: string; orderId: string; input: RecordAdministrationInput; actorUserId: string }): Promise<AdministrationResult>`
  - `recordException(args: { hospitalId: string; admissionId: string; orderId: string; input: RecordExceptionInput; actorUserId: string }): Promise<AdministrationResult>`
  - `voidAdministration(args: { hospitalId: string; administrationId: string; reason: string; actorUserId: string }): Promise<{ success: boolean }>`
  - `correctAdministration(args: { hospitalId: string; administrationId: string; correctedInput: RecordAdministrationInput; reason: string; actorUserId: string }): Promise<AdministrationResult>`

- [ ] **Step 1: Write integration tests for eMAR service**

Create `lib/services/__tests__/ipd-emar.integration.test.ts` verifying:
- `getBedsideEmar` organizes active orders into `dueNow`, `overdue`, `upcoming`, `prn`, `onHold`, and `recentHistory`.
- `recordAdministration` on scheduled doses:
  - Records given dose and enqueues billing outbox event.
  - Idempotent on retry with same `clientId`.
  - For stat order: transitions order to `completed` in same transaction.
- `recordAdministration` on PRN doses:
  - Serializes concurrent executions via advisory lock `pg_advisory_xact_lock(hashtext('ipd_prn_chain:' || order_chain_id::text))`.
  - Rejects doses during cooldown period.
  - Rejects doses when chart day ceiling is exceeded.
  - Cross-version history counts against limits.
- `recordException` logs non-administered events (`omitted`, `refused`, `held`) with required reason and decision time.
- `voidAdministration` strikes through dose, preserves execution findings, and enqueues `void` event to outbox.
- `correctAdministration` voids original record and links corrected replacement, enqueuing `correction` event to outbox.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/services/__tests__/ipd-emar.integration.test.ts`  
Expected: FAIL with module not found.

- [ ] **Step 3: Implement `lib/services/ipd-emar.ts`**

Implement eMAR bucket resolver, scheduled dose administration, PRN lock acquisition and limits validation, exception recording, voiding, and replacement correction with outbox integration event creation.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/services/__tests__/ipd-emar.integration.test.ts`  
Expected: PASS all tests.

- [ ] **Step 5: Commit**

```bash
git add lib/services/ipd-emar.ts lib/services/__tests__/ipd-emar.integration.test.ts
git commit -m "feat(ipd): add bedside nursing eMAR service"
```

---

### Task 3: eMAR Outbox Processing Worker (`lib/services/ipd-emar-outbox.ts`)

**Files:**
- Create: `lib/services/ipd-emar-outbox.ts`
- Test: `lib/services/__tests__/ipd-emar-outbox.integration.test.ts`

**Interfaces:**
- Consumes:
  - `ipdEmarIntegrationOutbox`, `ipdMedicationAdministrations`, `medicines`, `careEntries`, `billItems` from `lib/db/schema.ts`
  - `postCareEntryLineInTx`, `voidCareEntryLineInTx` from `lib/services/ipd-billing.ts`
- Produces:
  - `claimOutboxBatch(args: { hospitalId?: string; limit?: number; now?: Date }): Promise<OutboxItem[]>`
  - `recoverStuckOutboxClaims(args: { maxClaimAgeMs?: number; now?: Date }): Promise<number>`
  - `processOutboxItem(args: { item: OutboxItem; actorUserId?: string }): Promise<ProcessOutboxResult>`
  - `reconcilePendingPricingItems(args: { hospitalId: string; medicineId: string }): Promise<number>`
  - `processPendingOutboxBatch(args: { hospitalId?: string; limit?: number }): Promise<{ processed: number; pendingPricing: number; failed: number }>`

- [ ] **Step 1: Write integration tests for outbox worker**

Create `lib/services/__tests__/ipd-emar-outbox.integration.test.ts` verifying:
- `claimOutboxBatch` leases pending rows with `claimed_at` timestamp using `SKIP LOCKED`.
- `recoverStuckOutboxClaims` resets rows in `processing` older than 5 minutes back to `pending`.
- `processOutboxItem` for billing:
  - When medicine is priced, creates `care_entries` row, posts to bill draft via `postCareEntryLineInTx`, links `care_entry_id` to administration, and marks outbox item `processed`.
  - When medicine is unpriced (`selling_price_paise IS NULL`), moves outbox item to `status = 'pending_pricing'` without failing or incrementing attempts.
  - When `reconcilePendingPricingItems` runs after price update, transitions `pending_pricing` back to `pending`.
  - Handles `void` event by voiding linked care entry line via `voidCareEntryLineInTx`.
  - Handles `correction` event by voiding old line and posting corrected line.
- Error handling:
  - Retries failed items with exponential backoff.
  - Sets `status = 'failed'` after 5 failed attempts.

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/services/__tests__/ipd-emar-outbox.integration.test.ts`  
Expected: FAIL with module not found.

- [x] **Step 3: Implement `lib/services/ipd-emar-outbox.ts`**

Implement outbox batch claiming, lease recovery, transactional billing dispatch, unpriced medicine queue isolation, reconciliation, and retry backoff.

- [x] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/services/__tests__/ipd-emar-outbox.integration.test.ts`  
Expected: PASS all tests.

- [x] **Step 5: Commit**

```bash
git add lib/services/ipd-emar-outbox.ts lib/services/__tests__/ipd-emar-outbox.integration.test.ts
git commit -m "feat(ipd): add eMAR outbox worker for billing and inventory integration"
```

---

### Task 4: End-to-End Clinical Lifecycle Verification

**Files:**
- Create: `lib/services/__tests__/ipd-lifecycle.integration.test.ts`
- Test: `vitest run lib/services/__tests__/ipd-lifecycle.integration.test.ts`

**Interfaces:**
- Consumes: `ipd-medication-orders.ts`, `ipd-emar.ts`, `ipd-emar-outbox.ts`
- Produces: Complete end-to-end verification of the closed-loop medication management cycle.

- [x] **Step 1: Write comprehensive lifecycle integration test**

Create `lib/services/__tests__/ipd-lifecycle.integration.test.ts` asserting:
1. Attending doctor evaluates patient and signs a round note with 3 orders (Scheduled, PRN, and Stat).
2. Nursing eMAR immediately shows the scheduled dose under `dueNow`, the PRN dose under `prn`, and the Stat dose under `dueNow`.
3. Nurse administers the Stat dose:
   - Stat order transitions immediately to `completed`.
   - Nursing eMAR shows Stat dose cleared.
4. Nurse administers the Scheduled dose:
   - Administration is logged.
   - Outbox item is generated.
   - Background worker processes outbox item and posts billing charge.
5. Nurse administers PRN dose:
   - Advisory lock serializes and validates 4-hour cooldown.
   - A concurrent PRN administration within cooldown is rejected.
6. Doctor modifies the Scheduled medication order in the evening round:
   - Generates successor version with new dosage.
   - Old order marked `superseded`.
   - Nursing eMAR updates next due dose to reflect new dosage version without losing past administration history.

- [x] **Step 2: Run test to verify it passes**

Run: `npx vitest run lib/services/__tests__/ipd-lifecycle.integration.test.ts`  
Expected: PASS.

- [x] **Step 3: Run full suite and typecheck**

Run: `npm test` and `npm run typecheck`  
Expected: Zero failures, zero typecheck errors across all files.

- [x] **Step 4: Commit**

```bash
git add lib/services/__tests__/ipd-lifecycle.integration.test.ts
git commit -m "test(ipd): add end-to-end clinical rounding and eMAR lifecycle integration test"
```

---

## Final Review & Hand-off

After completing Tasks 1 through 4:
- Run all unit and integration tests.
- Run typecheck.
- Confirm zero production migrations were executed.
- Hand off to Phase 3 (Doctor Rounding Cockpit UI).
