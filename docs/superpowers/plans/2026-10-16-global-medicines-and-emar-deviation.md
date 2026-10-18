# Global Medicines Catalogue, eMAR Timing Deviation & Prescription UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix bedside eMAR timing deviation error on administered doses, eliminate prescription count miscommunication when active orders exist, and establish a global medicine master database with non-blocking unpriced hospital prescribing.

**Architecture:** 
1. Relax rigid `now > order.endsAt` blocking check in `recordAdministration` to permit late doses and documented timing deviations within clinical shifts, and recalculate `endsAt` dynamically when rescheduling medication timings in `adjustMedicationScheduleTimes`.
2. Add a platform-level `global_medicines` database table and domain dataset containing standard medical practice medicines, and update search to union local tenant medicines with global unpriced medicines.
3. Enhance `CreateTreatmentPlanModal` to receive and display currently active patient prescriptions, frame the modal as adding new medications to an ongoing plan, and provide instant autocomplete with pricing status alerts.

**Tech Stack:** Next.js 16 (App Router), TypeScript, PostgreSQL, Drizzle ORM, Tailwind CSS.

**Spec:** [`docs/superpowers/specs/2026-10-16-global-medicines-and-emar-deviation-design.md`](file:///d:/Projects/HospitalAutomation/docs/superpowers/specs/2026-10-16-global-medicines-and-emar-deviation-design.md)

## Global Constraints
- Preserve tenant isolation and PostgreSQL row-level security for all hospital clinical data.
- Doctors must never be blocked from prescribing a medicine; unpriced medicines are auto-provisioned to the hospital catalogue with `sellingPricePaise: null`.
- eMAR dose administration must record nurse-provided timing deviation reasons without throwing runtime expiration errors.

---

## Task 1: Fix Bedside eMAR Timing & Expiry Gate

**Files:**
- Modify: `lib/services/ipd-emar.ts:330-340`
- Modify: `lib/services/ipd-medication-orders.ts:980-1015`
- Test: `lib/services/__tests__/ipd-emar.integration.test.ts`

**Interfaces:**
- Consumes: `RecordAdministrationInput`, `SelectIpdMedicationOrder`
- Produces: `recordAdministration`, `adjustMedicationScheduleTimes`

- [ ] **Step 1: Write the failing integration test for late dose administration and adjusted schedule timing**
In `lib/services/__tests__/ipd-emar.integration.test.ts`, add a test verifying that an order with a past `endsAt` can be administered if a clinical note or timing deviation is provided or within 48h stay window, and that `adjustMedicationScheduleTimes` extends `endsAt` appropriately.

- [ ] **Step 2: Run test to verify it fails**
Run: `npx vitest run lib/services/__tests__/ipd-emar.integration.test.ts`
Expected: FAIL on `Order has expired past its treatment duration`.

- [ ] **Step 3: Implement relaxed expiry check and schedule adjustment endsAt extension**
1. In `lib/services/ipd-emar.ts` (`recordAdministration`):
   - Replace strict `if (order.endsAt && now > order.endsAt)` with logic allowing administration if:
     - The nurse provides a clinical note or timing deviation reason (e.g. `args.input.clinicalNote`), OR
     - The time difference between `now` and `order.endsAt` is within standard in-hospital admission grace window (48 hours).
   - If past `endsAt`, append `[Late administration documented]` to the clinical note if not already present.
2. In `lib/services/ipd-medication-orders.ts` (`adjustMedicationScheduleTimes`):
   - When creating the successor order, compute `newEndsAt`:
     - If `order.durationDays` is set, `newEndsAt = new Date(now.getTime() + order.durationDays * 24 * 60 * 60 * 1000)`.
     - If `order.endsAt && order.endsAt > now`, preserve it.
     - Otherwise, set `newEndsAt` to at least 24 hours from now (or end of next day).

- [ ] **Step 4: Run test to verify it passes**
Run: `npx vitest run lib/services/__tests__/ipd-emar.integration.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add lib/services/ipd-emar.ts lib/services/ipd-medication-orders.ts lib/services/__tests__/ipd-emar.integration.test.ts
git commit -m "fix(ipd): allow late dose administration with clinical deviation notes and extend endsAt on schedule adjustment"
```

---

## Task 2: Global Medicines Table Schema, Domain Dataset & Migration

**Files:**
- Create: `lib/domain/global-medicines-data.ts`
- Modify: `lib/db/schema.ts`
- Create: `drizzle/0050_global_medicines.sql`
- Test: `lib/domain/__tests__/global-medicines.test.ts`

**Interfaces:**
- Produces: `globalMedicines` table, `GLOBAL_MEDICINES_DATA` array, `GlobalMedicine` type

- [ ] **Step 1: Write test for global medicines domain dataset**
Create `lib/domain/__tests__/global-medicines.test.ts` verifying that `GLOBAL_MEDICINES_DATA` includes key medical practice medicines (Augmentin, Ceftriaxone, Pantoprazole, Paracetamol, Tramadol, Metronidazole, Hydrocortisone, Ringer Lactate, Normal Saline, Insulin, etc.) and valid attributes.

- [ ] **Step 2: Run test to verify it fails**
Run: `npx vitest run lib/domain/__tests__/global-medicines.test.ts`
Expected: FAIL with module not found.

- [ ] **Step 3: Implement `GLOBAL_MEDICINES_DATA` and `globalMedicines` schema**
1. Create `lib/domain/global-medicines-data.ts` with comprehensive medicine list covering antibiotics, analgesics, IV fluids, PPIs/antacids, steroids, respiratory, cardiac, and antidiabetic drugs.
2. In `lib/db/schema.ts`, export `globalMedicines` table (not tenant-scoped).
3. Create migration `drizzle/0050_global_medicines.sql` creating the table and populating standard medicines with `ON CONFLICT DO NOTHING`.

- [ ] **Step 4: Run test and migration verification**
Run: `npx vitest run lib/domain/__tests__/global-medicines.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add lib/domain/global-medicines-data.ts lib/db/schema.ts drizzle/0050_global_medicines.sql lib/domain/__tests__/global-medicines.test.ts
git commit -m "feat(medicines): add global medicines table and comprehensive clinical dataset"
```

---

## Task 3: Unified Medicine Search Service, API & Non-Blocking Auto-Provisioning

**Files:**
- Modify: `lib/services/medicines.ts`
- Modify: `app/api/medicines/search/route.ts`
- Modify: `lib/services/ipd-medication-orders.ts` (`resolveMedicineIdInTx`)
- Test: `lib/services/__tests__/medicines-search.test.ts`

**Interfaces:**
- Consumes: `globalMedicines`, `medicines`
- Produces: `searchMedicines` with `isGlobal`, `isPriced` flags; `resolveMedicineIdInTx` auto-inserting into tenant `medicines`

- [ ] **Step 1: Write test for unified search returning global + tenant medicines**
Create `lib/services/__tests__/medicines-search.test.ts` testing that searching for a medicine returns local tenant matches first, and if not present, returns global matches marked with `isGlobal: true` and `isPriced: false`.

- [ ] **Step 2: Run test to verify it fails**
Run: `npx vitest run lib/services/__tests__/medicines-search.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement unified search and auto-provisioning**
1. In `lib/services/medicines.ts`:
   - Extend `MedicineOption` to include `isGlobal?: boolean`, `isPriced?: boolean`, `category?: string`, `defaultRoute?: string`, `defaultFrequency?: string`.
   - Update `searchMedicines` to query both tenant `medicines` and `globalMedicines`, deduplicating by lower-case identity.
2. In `lib/services/ipd-medication-orders.ts` (`resolveMedicineIdInTx`):
   - When a medicine is ordered without a tenant `medicineId` or from global catalogue, insert into `medicines` with `hospitalId = args.hospitalId`, `sellingPricePaise = null`, `active = true`.

- [ ] **Step 4: Run test to verify it passes**
Run: `npx vitest run lib/services/__tests__/medicines-search.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add lib/services/medicines.ts app/api/medicines/search/route.ts lib/services/ipd-medication-orders.ts lib/services/__tests__/medicines-search.test.ts
git commit -m "feat(medicines): unified search across hospital and global master with auto-provisioning"
```

---

## Task 4: Prescription Modal Active Prescriptions View & Dynamic Plan Mode

**Files:**
- Modify: `components/ipd/prescriptions/create-treatment-plan-modal.tsx`
- Modify: `components/ipd/summary/daily-medication-matrix.tsx`
- Modify: `components/ipd/summary/doctor-quick-actions.tsx`
- Modify: `components/ipd/orders/minimal-orders-tab.tsx`
- Test: `components/ipd/prescriptions/__tests__/create-treatment-plan-modal.test.tsx`

**Interfaces:**
- Consumes: `activeOrders` array (or `medications`)
- Produces: Dynamic title ("Add Prescriptions to Treatment Plan" vs "Create IPD Treatment Plan"), collapsible Active Orders list, clarified "New Prescriptions to Add (N)" heading

- [ ] **Step 1: Write test for active orders display and dynamic title**
Update `components/ipd/prescriptions/__tests__/create-treatment-plan-modal.test.tsx` verifying that when `activeOrders` are passed, the modal displays the active prescriptions banner, lists them, and labels the staging area as "New Prescriptions to Add".

- [ ] **Step 2: Run test to verify it fails**
Run: `npx vitest run components/ipd/prescriptions/__tests__/create-treatment-plan-modal.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement active orders display and adaptive modal states**
1. In `CreateTreatmentPlanModalProps`, accept `activeOrders?: Array<{ id: string; medicineName: string; strength?: string | null; form?: string | null; route: string; frequency?: string | null }>`.
2. Render collapsible "Currently Active Prescriptions (N)" card above the presets.
3. Label new prescriptions section "New Prescriptions to Add (${stagedOrders.length})".
4. Update callers (`DailyMedicationMatrix`, `DoctorQuickActions`, `MinimalOrdersTab`) to pass their active medications into `CreateTreatmentPlanModal`.

- [ ] **Step 4: Run test to verify it passes**
Run: `npx vitest run components/ipd/prescriptions/__tests__/create-treatment-plan-modal.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add components/ipd/prescriptions/create-treatment-plan-modal.tsx components/ipd/summary/daily-medication-matrix.tsx components/ipd/summary/doctor-quick-actions.tsx components/ipd/orders/minimal-orders-tab.tsx components/ipd/prescriptions/__tests__/create-treatment-plan-modal.test.tsx
git commit -m "feat(ipd): display active patient prescriptions in prescription modal and clarify add flow"
```

---

## Task 5: Medicine Autocomplete with Global Catalogue & Unpriced Alerts

**Files:**
- Modify: `components/ipd/prescriptions/create-treatment-plan-modal.tsx`
- Test: `components/ipd/prescriptions/__tests__/create-treatment-plan-modal.test.tsx`

**Interfaces:**
- Consumes: `/api/medicines/search` endpoint
- Produces: Instant debounced typeahead dropdown, auto-filling defaults, unpriced amber indicator

- [ ] **Step 1: Write test for medicine autocomplete and unpriced warning**
Add test in `create-treatment-plan-modal.test.tsx` testing that typing in the medicine input queries search, displays suggestions, highlights unpriced status, and populates dose/route defaults upon selection.

- [ ] **Step 2: Run test to verify it fails**
Run: `npx vitest run components/ipd/prescriptions/__tests__/create-treatment-plan-modal.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement autocomplete in `CreateTreatmentPlanModal`**
1. Add debounced fetch to `/api/medicines/search?q=...` as user types in `customMedName`.
2. Display floating dropdown with matched medicines, highlighting category, generic name, and `⚠️ Unpriced in Hospital (Can set in Settings)`.
3. On selecting an option:
   - Set medicine name, auto-select default route and frequency if available.
   - Show helpful dismissible tip: *"This medicine is unpriced for this hospital. You can add it to the prescription now, and hospital admins can set pricing later in Settings → Medicines."*

- [ ] **Step 4: Run test to verify it passes**
Run: `npx vitest run components/ipd/prescriptions/__tests__/create-treatment-plan-modal.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add components/ipd/prescriptions/create-treatment-plan-modal.tsx components/ipd/prescriptions/__tests__/create-treatment-plan-modal.test.tsx
git commit -m "feat(ipd): add global medicine autocomplete and unpriced warning in prescription modal"
```

---

## Task 6: End-to-End Verification Across eMAR and Prescriptions

**Files:**
- Test: Run all existing IPD integration tests and verify no regressions

- [ ] **Step 1: Run full test suite**
Run: `npm test`
Expected: ALL PASS.

- [ ] **Step 2: Run IPD integration tests**
Run: `npx vitest run lib/services/__tests__/ipd-emar.integration.test.ts lib/services/__tests__/ipd-medication-orders.integration.test.ts`
Expected: ALL PASS.

- [ ] **Step 3: Verification of live bedside administration flow**
Verify that confirming bedside dose with timing deviation succeeds without throwing expiration error.
