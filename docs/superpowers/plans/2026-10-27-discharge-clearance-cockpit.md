# Discharge Clearance Cockpit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform the static 4-box discharge mockup into a production-grade 5-card Discharge Clearance Cockpit supporting live clinical readiness, bedside pharmacy returns with credit notes, nursing line removal safety checklists, discharge summary status, and a tamper-evident Exit Gate Pass.

**Architecture:** A dedicated tenant-scoped table (`ipd_discharge_clearances`) tracks auditable department sign-offs, returned bedside medicine inventory, and gate pass numbering. A domain service (`lib/services/ipd-clearance.ts`) aggregates live data across medical, pharmacy, nursing, discharge summary, and billing. The UI in `components/ipd/discharge/` renders a 5-card reactive clearance matrix with interactive drawers for pharmacy returns and gate pass printing.

**Tech Stack:** Next.js 15 (App Router, Server Actions), React 19, TypeScript, Drizzle ORM, PostgreSQL, Tailwind CSS, Lucide / Heroicons.

**Spec:** [`docs/superpowers/specs/2026-10-27-discharge-clearance-cockpit-design.md`](file:///d:/Projects/HospitalAutomation/docs/superpowers/specs/2026-10-27-discharge-clearance-cockpit-design.md)

## Global Constraints

- Tenant isolation: Every database query and mutation MUST be scoped by `hospitalId` using `withTenant`.
- Hard gate: Exit Gate Pass generation MUST strictly throw `ClearanceGateError` if any prerequisite department (Medical, Pharmacy, Nursing, Summary, Billing) has pending items.
- No dummy/mock state: Pharmacy returns MUST track real items, returned quantities, credit amounts, and credit note numbers.
- Zero data loss: Existing `admissions`, `medRecItems`, and `ipdDischargeSummaries` data and behaviors remain fully backward-compatible.

## Review Focus

1. Partial clearance attempt: A user tries to issue a Gate Pass while nursing lines (IV cannula/catheter) are still marked active — expect `ClearanceGateError` blocking the issuance.
2. Bedside pharmacy credit adjustment: Returning unconsumed medicine items generates an auditable credit note number and stores exact returned quantities.
3. Medical clearance revocation: Consultant revoking medical clearance resets `clinicalFitAt` and resets Gate Pass readiness.
4. Role-Based Access: Unauthorized role (e.g. receptionist) attempting to sign off nursing lines or medical clearance is rejected by RBAC check.
5. Reactive progress bar: UI instantly updates progress indicator (`X of 5 Cleared`) as individual cards are signed off or edited.

---

### Task 1: Database Schema for `ipd_discharge_clearances`

**Files:**
- Modify: `lib/db/schema.ts`
- Test: `lib/db/__tests__/ipd-discharge-clearance-schema.test.ts`

**Interfaces:**
- Produces: `ipdDischargeClearances`, `PharmacyReturnItem`, `DischargeClearanceStatus` exported from `lib/db/schema.ts`.

- [ ] **Step 1: Write the schema type and constraint test**

```typescript
// lib/db/__tests__/ipd-discharge-clearance-schema.test.ts
import { describe, it, expect } from 'vitest';
import { ipdDischargeClearances } from '@/lib/db/schema';

describe('ipdDischargeClearances schema', () => {
  it('defines the discharge clearances table with required columns', () => {
    expect(ipdDischargeClearances).toBeDefined();
    expect(ipdDischargeClearances.dischargeType).toBeDefined();
    expect(ipdDischargeClearances.pharmacyReturnItems).toBeDefined();
    expect(ipdDischargeClearances.ivCannulaRemoved).toBeDefined();
    expect(ipdDischargeClearances.gatePassNumber).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/db/__tests__/ipd-discharge-clearance-schema.test.ts`  
Expected: FAIL with `ipdDischargeClearances is not exported from '@/lib/db/schema'`.

- [ ] **Step 3: Define `ipdDischargeClearances` table and types in `lib/db/schema.ts`**

Add table definition with tenant scope, foreign keys to `hospitals` and `admissions`, unique index on `(hospitalId, admissionId)`, and JSON type `PharmacyReturnItem[]`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/db/__tests__/ipd-discharge-clearance-schema.test.ts`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/db/schema.ts lib/db/__tests__/ipd-discharge-clearance-schema.test.ts
git commit -m "feat(db): add ipd_discharge_clearances table schema"
```

---

### Task 2: Domain Service for Discharge Clearance (`lib/services/ipd-clearance.ts`)

**Files:**
- Create: `lib/services/ipd-clearance.ts`
- Test: `lib/services/__tests__/ipd-clearance.integration.test.ts`

**Interfaces:**
- Consumes: `ipdDischargeClearances`, `admissions`, `ipdMedicationOrders`, `medRecSignoffs`, `ipdDischargeSummaries` from `lib/db/schema.ts`.
- Produces:
  - `getDischargeClearance(hospitalId: string, admissionId: string): Promise<DischargeClearanceCockpitView>`
  - `updateMedicalClearance(args: MedicalClearanceArgs): Promise<void>`
  - `recordPharmacyClearance(args: PharmacyClearanceArgs): Promise<void>`
  - `updateNursingClearance(args: NursingClearanceArgs): Promise<void>`
  - `issueDischargeGatePass(args: GatePassArgs): Promise<{ gatePassNumber: string; issuedAt: Date }>`

- [ ] **Step 1: Write integration test for clearance workflows and hard gate**

```typescript
// lib/services/__tests__/ipd-clearance.integration.test.ts
import { describe, it, expect } from 'vitest';
import {
  getDischargeClearance,
  updateMedicalClearance,
  recordPharmacyClearance,
  updateNursingClearance,
  issueDischargeGatePass,
  ClearanceGateError,
} from '@/lib/services/ipd-clearance';

describe('ipd-clearance service', () => {
  it('blocks Gate Pass issuance if any department clearance is incomplete', async () => {
    // Attempting to issue gate pass without nursing clearance throws ClearanceGateError
    await expect(
      issueDischargeGatePass({ hospitalId: 'mock-hosp', admissionId: 'mock-adm', actorUserId: 'mock-user' })
    ).rejects.toThrow(ClearanceGateError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/services/__tests__/ipd-clearance.integration.test.ts`  
Expected: FAIL with module not found.

- [ ] **Step 3: Implement `lib/services/ipd-clearance.ts`**

Implement aggregation query (`getDischargeClearance`), sign-off handlers (`updateMedicalClearance`, `recordPharmacyClearance`, `updateNursingClearance`), and hard-gated gate pass generator (`issueDischargeGatePass`).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/services/__tests__/ipd-clearance.integration.test.ts`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/services/ipd-clearance.ts lib/services/__tests__/ipd-clearance.integration.test.ts
git commit -m "feat(ipd): implement ipd-clearance domain service with gate pass guard"
```

---

### Task 3: Server Actions for Cockpit Department Clearances

**Files:**
- Modify: `app/(app)/ipd/actions.ts`
- Test: `app/(app)/ipd/__tests__/clearance-actions.test.ts`

**Interfaces:**
- Consumes: Service functions from `lib/services/ipd-clearance.ts`.
- Produces:
  - `updateMedicalClearanceAction(payload)`
  - `recordPharmacyClearanceAction(payload)`
  - `updateNursingClearanceAction(payload)`
  - `issueDischargeGatePassAction(payload)`

- [ ] **Step 1: Write tests for action authorization and error handling**

Verify that non-clinical roles are rejected from signing medical or nursing lines, and valid sessions invoke the corresponding service functions.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/(app)/ipd/__tests__/clearance-actions.test.ts`  
Expected: FAIL.

- [ ] **Step 3: Implement actions in `app/(app)/ipd/actions.ts`**

Export RBAC-protected actions, wrapping calls in `requireWritableSession()` and verifying permission sets. Call `revalidatePath` on the discharge page.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/(app)/ipd/__tests__/clearance-actions.test.ts`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/(app)/ipd/actions.ts app/(app)/ipd/__tests__/clearance-actions.test.ts
git commit -m "feat(ipd): add RBAC-guarded server actions for discharge clearance cockpit"
```

---

### Task 4: Interactive Modals & Drawers (`PharmacyReturnDrawer`, `MedicalClearanceModal`, `GatePassModal`)

**Files:**
- Create: `components/ipd/discharge/drawers/pharmacy-return-drawer.tsx`
- Create: `components/ipd/discharge/drawers/medical-clearance-modal.tsx`
- Create: `components/ipd/discharge/drawers/gate-pass-modal.tsx`
- Test: `components/ipd/discharge/__tests__/drawers.test.tsx`

**Interfaces:**
- Produces: Reusable slide-over and modal dialog components for logging medicine returns, consultant fit certification, and printing the Gate Pass.

- [ ] **Step 1: Write component unit test for `PharmacyReturnDrawer`**

Test that entering return quantities calculates total credit amount and emits the payload correctly.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run components/ipd/discharge/__tests__/drawers.test.tsx`  
Expected: FAIL.

- [ ] **Step 3: Implement drawers and modals**

Build `PharmacyReturnDrawer` with item rows (dispensed, return qty, credit amount), `MedicalClearanceModal` with discharge type select and notes, and `GatePassModal` with printable slip formatting and QR code.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run components/ipd/discharge/__tests__/drawers.test.tsx`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add components/ipd/discharge/drawers/ components/ipd/discharge/__tests__/drawers.test.tsx
git commit -m "feat(ipd): create pharmacy return drawer, medical modal, and gate pass modal"
```

---

### Task 5: 5-Card Discharge Clearance Matrix & Container Integration

**Files:**
- Create: `components/ipd/discharge/cards/medical-clearance-card.tsx`
- Create: `components/ipd/discharge/cards/pharmacy-clearance-card.tsx`
- Create: `components/ipd/discharge/cards/nursing-clearance-card.tsx`
- Create: `components/ipd/discharge/cards/summary-clearance-card.tsx`
- Create: `components/ipd/discharge/cards/billing-gate-pass-card.tsx`
- Modify: `components/ipd/discharge/discharge-tab.tsx`
- Modify: `app/(app)/ipd/patients/[id]/discharge/page.tsx`
- Test: `app/(app)/ipd/patients/__tests__/discharge-tab-enhanced.test.tsx`

**Interfaces:**
- Consumes: Server actions from `app/(app)/ipd/actions.ts` and clearance view from `lib/services/ipd-clearance.ts`.
- Produces: Complete, interactive 5-pillar clearance cockpit replacing the static 4-box mockup.

- [ ] **Step 1: Update existing `discharge-tab-enhanced.test.tsx` with 5-card assertions**

Assert that all 5 cards render with live statuses: Medical, Pharmacy (with Returns button), Nursing (with line removal checklist), Discharge Summary, and Billing Gate Pass.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/(app)/ipd/patients/__tests__/discharge-tab-enhanced.test.tsx`  
Expected: FAIL.

- [ ] **Step 3: Implement the 5 clearance cards and update `discharge-tab.tsx` & `page.tsx`**

Integrate the progress counter (`X of 5 Cleared`), wire up drawer openers, and connect server actions.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/(app)/ipd/patients/__tests__/discharge-tab-enhanced.test.tsx`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add components/ipd/discharge/ app/(app)/ipd/patients/[id]/discharge/page.tsx app/(app)/ipd/patients/__tests__/discharge-tab-enhanced.test.tsx
git commit -m "feat(ipd): revamp discharge cockpit with 5-card multi-department clearance matrix"
```
