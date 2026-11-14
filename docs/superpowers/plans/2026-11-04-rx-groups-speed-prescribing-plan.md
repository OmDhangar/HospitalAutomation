# Doctor Consultation Speed & Rx-Groups — Implementation Plan

**Spec Reference:** [`docs/superpowers/specs/2026-11-04-rx-groups-speed-prescribing-design.md`](file:///d:/Projects/HospitalAutomation/docs/superpowers/specs/2026-11-04-rx-groups-speed-prescribing-design.md)  
**Task Tracker:** Phase 1, Item 4.3  

---

### Task 1: Database Migration & Schema Definition
**Files:**
- Modify: `lib/db/schema.ts`
- Create: `drizzle/0074_rx_groups.sql`
- Modify: `drizzle/meta/_journal.json`

- [ ] **Step 1: Add `rxGroups` and `rxGroupItems` tables to `lib/db/schema.ts`**
  - Fields: `id`, `hospitalId`, `branchId`, `doctorId`, `name`, `description`, `category`, `defaultDiagnosis`, `defaultAdvice`, `defaultFollowUpDays`, `sortOrder`, `active`, `createdAt`, `updatedAt`.
  - Indexes: composite tenant unique index, doctor index.
  - `rxGroupItems`: `id`, `hospitalId`, `rxGroupId`, `medicineId`, `medicineName`, `dose`, `frequency`, `durationDays`, `instructions`, `sortOrder`, `createdAt`.
- [ ] **Step 2: Create migration `drizzle/0074_rx_groups.sql`**
  - Include CREATE TABLE statements with strict FKs, check constraints, unique indexes, and RLS policies (`tenant_isolation`, `read_only_write`, `read_only_delete`).
- [ ] **Step 3: Update `drizzle/meta/_journal.json`**
  - Register migration `0074_rx_groups` cleanly with next sequential timestamp `1792400000000`.
- [ ] **Step 4: Execute database migration**
  - Run `npx tsx scripts/migrate-v2.ts`.
- [ ] **Step 5: Verify migration integrity**
  - Run `npm run db:lint-migrations` (ensure 0 errors).
  - Run `npm run db:migrate:plan` (ensure 0 warnings).

---

### Task 2: Service Layer for Rx-Groups
**Files:**
- Create: `lib/services/rx-groups.ts`
- Create: `lib/services/__tests__/rx-groups.test.ts`

- [ ] **Step 1: Write unit tests in `lib/services/__tests__/rx-groups.test.ts`**
  - List Rx-groups (hospital-wide + doctor personal).
  - Create Rx-group with nested items.
  - Multi-tenant boundary isolation.
  - Default seeding for hospitals without bundles.
- [ ] **Step 2: Run test to verify failure**
  - Run: `npx vitest run lib/services/__tests__/rx-groups.test.ts`
- [ ] **Step 3: Implement `lib/services/rx-groups.ts`**
  - `listRxGroups`
  - `createRxGroup`
  - `deleteRxGroup`
  - `seedDefaultRxGroups`
- [ ] **Step 4: Run test to verify pass**
  - Run: `npx vitest run lib/services/__tests__/rx-groups.test.ts`

---

### Task 3: Server Actions for Consultation Panel
**Files:**
- Modify: `app/(app)/dashboard/consultation-actions.ts`
- Create: `app/(app)/dashboard/__tests__/rx-groups-actions.test.ts`

- [ ] **Step 1: Write action tests in `app/(app)/dashboard/__tests__/rx-groups-actions.test.ts`**
  - RBAC checks (`consultation.write`).
  - `listRxGroupsAction` returns active groups.
  - `createRxGroupFromPrescriptionAction` saves current prescription items as a bundle.
- [ ] **Step 2: Run test to verify failure**
  - Run: `npx vitest run "app/(app)/dashboard/__tests__/rx-groups-actions.test.ts"`
- [ ] **Step 3: Implement server actions in `consultation-actions.ts`**
  - Export `listRxGroupsAction` and `saveAsRxGroupAction`.
- [ ] **Step 4: Run test to verify pass**
  - Run: `npx vitest run "app/(app)/dashboard/__tests__/rx-groups-actions.test.ts"`

---

### Task 4: Consultation Panel UI Enhancements
**Files:**
- Modify: `app/(app)/dashboard/consultation-panel.tsx`
- Create: `app/(app)/dashboard/__tests__/rx-groups-panel.test.tsx`

- [ ] **Step 1: Write component tests for Rx-Groups shelf**
  - Renders Rx-Group badges (e.g. URI Pack, Gastroenteritis).
  - Clicking bundle appends items to prescription lines.
  - Diagnosis and advice auto-fill when currently blank.
  - "Save as Rx-Group" button triggers save drawer.
- [ ] **Step 2: Run test to verify failure**
  - Run: `npx vitest run "app/(app)/dashboard/__tests__/rx-groups-panel.test.tsx"`
- [ ] **Step 3: Update `ConsultationPanel` component**
  - Fetch and display Rx-Groups shelf.
  - Add 1-click bundle applicator.
  - Add "Save as Rx-Group" modal.
- [ ] **Step 4: Run test to verify pass**
  - Run: `npx vitest run "app/(app)/dashboard/__tests__/rx-groups-panel.test.tsx"`

---

### Task 5: End-to-End Verification & Completion Report
- [ ] Run `npm run db:lint-migrations` (0 errors).
- [ ] Run `npm run db:migrate:plan` (0 warnings).
- [ ] Run `npm test` (100% passing across all suites).
- [ ] Verify English-only mandate (Rule 2.2).
- [ ] Document in `docs/modules/03-doctor-speed-rx-groups/COMPLETION_REPORT.md`.
