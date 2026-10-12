# IPD Doctor Rounding Cockpit UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the single-screen IPD Doctor Rounding Cockpit UI enabling attending physicians to review clinical context (vitals freshness, allergy status, 24h treatment timeline), review and act on active medication orders (continue, renew via successor, modify, hold, discontinue), quickly prescribe new regimens with frequency presets, and record signed daily round assessments that update the bedside nursing eMAR.

**Architecture:** Client-server hybrid architecture in Next.js App Router. A dedicated patient-file tab (`/ipd/admissions/[id]/(file)/rounds`) loads clinical context and active orders server-side. An interactive client cockpit manages proposed order resolutions, rapid prescribing drafts, and progress notes, while transactional Server Actions execute immutable signing and drafts via `lib/services/ipd-medication-orders.ts`.

**Tech Stack:** Next.js 15 (App Router, Server Actions, Server Components), Tailwind CSS / Vanilla tokens, Drizzle ORM, PostgreSQL RLS (`withTenant`), Vitest, TypeScript.

**Spec:** [`docs/superpowers/specs/2026-10-12-ipd-doctor-rounding-prescriptions-design.md`](file:///d:/Projects/HospitalAutomation/docs/superpowers/specs/2026-10-12-ipd-doctor-rounding-prescriptions-design.md) (Section 8.1, Section 9, Phase 3).

## Global Constraints

- **Signed-Order Immutability:** Never mutate signed clinical instructions in place; renewed and modified orders generate successor rows referencing `supersedes_order_id` and maintain `order_chain_id`.
- **Draft Isolation:** Unsigned round drafts and uncommitted order proposals must never leak into the active nursing eMAR.
- **Tenant Isolation:** All database reads and mutations execute within `withTenant(hospitalId, ..., { clinical: true })`.
- **No Production Migrations:** Zero new migrations or `npm run db:migrate` invocations. Use existing tables (`ipd_clinical_rounds`, `ipd_medication_orders`, `ipd_allergy_assessments`, `ipd_medication_order_actions`).
- **No Infusion Sessions:** Discrete point-in-time bolus doses only in MVP.

## Review Focus

1. **Unsigned Draft Visibility:** Verify that saving a draft round note creates a `draft` record in `ipd_clinical_rounds` without creating active rows in `ipd_medication_orders` or showing in `getBedsideEmar`.
2. **Order Resolution Precision:** Verify that selecting "Renew" or "Modify" for an order carries its full lineage (`orderChainId`, `supersedesOrderId`) and mandatory reason to the signing service.
3. **Allergy Alerting & NKDA:** Verify that an unreviewed allergy displays a prominent warning banner and allows immediate 1-click NKDA verification or documented drug allergy capture.
4. **Vitals Freshness Boundary:** Verify that vitals older than 6 hours display a clear staleness indicator so doctors don't round on obsolete clinical data.
5. **Mobile & Sticky Ergonomics:** Verify that the rounding cockpit fits cleanly on mobile screens (the primary device for doctors on hospital rounds) and provides quick 1-tap chip presets for rapid prescribing.

---

### Task 1: Permissions, Module Registry & Navigation Entry

**Files:**
- Modify: `lib/domain/permissions.ts`
- Modify: `lib/domain/__tests__/permissions.test.ts`
- Modify: `lib/modules/registry.ts`
- Modify: `app/(app)/ipd/my-patients/page.tsx`
- Test: `vitest run lib/domain/__tests__/permissions.test.ts`

**Interfaces:**
- `PERMISSIONS`:
  - `'ipd.prescribe': ['owner', 'doctor']`
  - `'ipd.administer': ['owner', 'nurse']`
- `MODULES`:
  - Register `rounds` sheet tab on `core_ipd` or `patient_file` with `slug: 'rounds'`, `label: 'Doctor rounds'`, `permission: 'ipd.view'`, `order: 5`.
- `/ipd/my-patients`:
  - Each patient card provides a primary "Rounds" / "Start Round" button navigating to `/ipd/admissions/[id]/rounds`.

- [ ] **Step 1: Write failing tests in `lib/domain/__tests__/permissions.test.ts`**

Add tests for `ipd.prescribe` and `ipd.administer` permissions ensuring only doctors and owners can prescribe, and nurses and owners can administer.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run lib/domain/__tests__/permissions.test.ts`  
Expected: FAIL due to missing permission keys.

- [ ] **Step 3: Update `lib/domain/permissions.ts` and `lib/modules/registry.ts`**

Define `ipd.prescribe` and `ipd.administer`. Add the `rounds` tab under `patient_file` module in `lib/modules/registry.ts`. Update `app/(app)/ipd/my-patients/page.tsx` to include the direct "Rounds" link.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run lib/domain/__tests__/permissions.test.ts`  
Expected: PASS.

- [ ] **Step 5: Commit Task 1**

```bash
git add lib/domain/permissions.ts lib/domain/__tests__/permissions.test.ts lib/modules/registry.ts app/\(app\)/ipd/my-patients/page.tsx
git commit -m "feat(ipd): add prescribing permissions, rounds file tab, and doctor rounding navigation"
```

---

### Task 2: Cockpit Data Loader & Server Actions

**Files:**
- Create: `lib/services/ipd-rounding-cockpit.ts`
- Create: `lib/services/__tests__/ipd-rounding-cockpit.integration.test.ts`
- Modify: `app/(app)/ipd/actions.ts`
- Test: `vitest run lib/services/__tests__/ipd-rounding-cockpit.integration.test.ts`

**Interfaces:**
- `getRoundingCockpitData(args: { hospitalId: string; admissionId: string; userId: string; timezone: string })`:
  - Returns `{ admission, vitalsFreshness, allergyAssessment, activeOrders, past24hAdministrations, draftRound, formularyChips }`.
- `saveAllergyAssessmentAction(formData: FormData)`:
  - Updates patient allergy status (`nkda` or allergens JSONB array) with user attribution and timestamp.
- `saveRoundDraftAction(formData: FormData)`:
  - Saves doctor's notes and proposed order resolutions as non-actionable draft.
- `signRoundOrdersAction(payload: SignRoundOrdersPayload)`:
  - Signs round notes, resolves orders via `signRoundOrders`, and revalidates `/ipd/admissions/[id]`.

- [ ] **Step 1: Write integration tests in `lib/services/__tests__/ipd-rounding-cockpit.integration.test.ts`**

Test:
1. `getRoundingCockpitData` aggregates active orders, TPR vitals freshness, and current allergy assessment.
2. Saving allergy assessment marks prior as `is_current = false` and preserves audit history.
3. Saving round draft saves to `ipd_clinical_rounds` with `status = 'draft'` and leaves active orders unchanged.
4. Signing round orders publishes active orders and updates round status to `'signed'`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/services/__tests__/ipd-rounding-cockpit.integration.test.ts`  
Expected: FAIL with module not found.

- [ ] **Step 3: Implement `lib/services/ipd-rounding-cockpit.ts` and actions in `app/(app)/ipd/actions.ts`**

Implement data assembly query, allergy assessment revision tracking, draft persistence, and signing bridge.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/services/__tests__/ipd-rounding-cockpit.integration.test.ts`  
Expected: PASS all tests.

- [ ] **Step 5: Commit Task 2**

```bash
git add lib/services/ipd-rounding-cockpit.ts lib/services/__tests__/ipd-rounding-cockpit.integration.test.ts app/\(app\)/ipd/actions.ts
git commit -m "feat(ipd): add rounding cockpit data service and server actions"
```

---

### Task 3: Clinical Context & Active Orders Review UI Components

**Files:**
- Create: `components/ipd/rounding/vitals-freshness-bar.tsx`
- Create: `components/ipd/rounding/allergy-banner.tsx`
- Create: `components/ipd/rounding/active-orders-review.tsx`
- Test: Unit/component test or page integration test.

**Interfaces:**
- `VitalsFreshnessBar`:
  - Renders Pulse, BP, SpO2, Temp, Resp, Sugar with relative timestamp.
  - Highlights stale vitals (>6 hours) with an amber warning badge.
- `AllergyBanner`:
  - Shows green badge for `NKDA`, amber for `Unreviewed`, and prominent high-contrast red alert for documented drug allergies.
  - Interactive modal/drawer for 1-tap "Verify NKDA" or adding allergen strings.
- `ActiveOrdersReview`:
  - Displays all active/held orders with drug name, dose, frequency, route, duration, and last given time.
  - Action selector per row: `[Continue] [Renew] [Modify] [Hold] [Discontinue]`.
  - Expandable inputs for Renewal (+days) and Modification (new dose, frequency, reason).

- [ ] **Step 1: Implement `components/ipd/rounding/vitals-freshness-bar.tsx`**

Build responsive vitals freshness bar with collection timestamp, abnormal thresholds, and stale-data warnings.

- [ ] **Step 2: Implement `components/ipd/rounding/allergy-banner.tsx`**

Build allergy banner supporting `unreviewed`, `nkda`, and `allergies_documented` states with interactive assessment update modal.

- [ ] **Step 3: Implement `components/ipd/rounding/active-orders-review.tsx`**

Build active medication orders review list with interactive per-order resolution state machine (`continue`, `renew`, `modify`, `hold`, `discontinue`).

- [ ] **Step 4: Commit Task 3**

```bash
git add components/ipd/rounding/
git commit -m "feat(ipd): add vitals freshness bar, allergy banner, and active orders review components"
```

---

### Task 4: Accelerated Inpatient Prescribing & Order Signing Flow

**Files:**
- Create: `components/ipd/rounding/quick-prescribe-section.tsx`
- Create: `components/ipd/rounding/round-note-editor.tsx`
- Create: `components/ipd/rounding/order-signing-modal.tsx`
- Test: Component verification.

**Interfaces:**
- `QuickPrescribeSection`:
  - 1-tap frequent formulary chips (e.g. Pantoprazole 40mg IV, Paracetamol 650mg Oral SOS, Ondansetron 4mg IV, Ceftriaxone 1g IV BD).
  - Formulary search typeahead.
  - Prescribing form with frequency presets (`OD`, `BD`, `TDS`, `QID`, `Stat`, `PRN`), route selector, schedule clock times, PRN indication/interval, and duration days.
- `RoundNoteEditor`:
  - Textarea for doctor's clinical findings, assessment, and daily plan.
  - Secondary button: "Save Draft" (persists draft round note).
  - Primary button: "Sign & Authorize Orders" (launches signing confirmation modal).
- `OrderSigningModal`:
  - Summarizes all proposed actions:
    - Continued orders count
    - Renewed / modified orders (showing predecessor -> successor diff)
    - Held / discontinued orders (with mandatory reasons)
    - Newly prescribed orders
  - Prescriber confirmation and PIN / password submission to execute `signRoundOrdersAction`.

- [ ] **Step 1: Implement `components/ipd/rounding/quick-prescribe-section.tsx`**

Build accelerated prescribing interface with hospital frequent chips, frequency presets, and PRN constraints.

- [ ] **Step 2: Implement `components/ipd/rounding/round-note-editor.tsx`**

Build clinical round note editor with draft saving and review triggering.

- [ ] **Step 3: Implement `components/ipd/rounding/order-signing-modal.tsx`**

Build order review and authorization modal presenting comprehensive resolution diff before final signing.

- [ ] **Step 4: Commit Task 4**

```bash
git add components/ipd/rounding/
git commit -m "feat(ipd): add accelerated prescribing, round note editor, and order signing modal"
```

---

### Task 5: Cockpit Page Integration & End-to-End Verification

**Files:**
- Create: `components/ipd/rounding/rounding-cockpit.tsx`
- Create: `app/(app)/ipd/admissions/[id]/(file)/rounds/page.tsx`
- Create: `app/(app)/ipd/admissions/[id]/(file)/rounds/__tests__/rounding-cockpit.integration.test.ts`
- Test: Full integration test suite & `npm run typecheck`.

**Interfaces:**
- `RoundingCockpit`:
  - Client orchestrator connecting Vitals Freshness, Allergy Banner, Active Orders Review, Quick Prescribing, Notes Editor, and Signing Modal into a unified workspace.
- `RoundsPage`:
  - Server component under `/ipd/admissions/[id]/(file)/rounds` loading data via `getRoundingCockpitData` and rendering `RoundingCockpit`.

- [ ] **Step 1: Implement `components/ipd/rounding/rounding-cockpit.tsx` and `app/(app)/ipd/admissions/[id]/(file)/rounds/page.tsx`**

Wire up data fetching, client state management for resolutions and new draft orders, and Server Action invocations.

- [ ] **Step 2: Write page integration test in `app/(app)/ipd/admissions/[id]/(file)/rounds/__tests__/rounding-cockpit.integration.test.ts`**

Assert:
1. Accessing `/ipd/admissions/[id]/rounds` renders the patient header, vitals, allergy status, and active orders.
2. Saving a draft round note preserves doctor's work without altering active eMAR orders.
3. Signing round orders transitions the round note to signed, updates active orders, and reflects immediately on the bedside eMAR.

- [ ] **Step 3: Run integration test to verify it passes**

Run: `npx vitest run app/\(app\)/ipd/admissions/\[id\]/\(file\)/rounds/__tests__/rounding-cockpit.integration.test.ts`  
Expected: PASS.

- [ ] **Step 4: Run full test suite and typecheck**

Run: `npm test` and `npm run typecheck`  
Expected: 0 failures, 0 type errors.

- [ ] **Step 5: Commit Task 5**

```bash
git add app/\(app\)/ipd/admissions/\[id\]/\(file\)/rounds/ components/ipd/rounding/
git commit -m "feat(ipd): complete doctor rounding cockpit page and end-to-end integration"
```

---

## Final Review & Hand-off

After completing Tasks 1 through 5:
- Verify all unit and integration tests pass.
- Verify `npm run typecheck` passes with zero errors.
- Confirm zero production migrations were executed.
- Hand off to Phase 4 (Bedside Nursing eMAR).
