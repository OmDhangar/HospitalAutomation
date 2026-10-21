# Claims Tracker & TPA Desk (Phase E1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the foundational Claims Tracker & TPA Desk (Phase E1) for inpatient commercial insurance and government schemes—providing platform-wide standardized payer profiles, tenant-isolated multi-claim cases per admission, AES-256-GCM authenticated field encryption with AAD binding, HMAC-SHA256 blind indexing, minute-accurate SLA tracking with privacy-safe worker alerts, an append-only forensic event ledger, paper document custody tracking, optimistic locking, and a high-density tabular operational desk.

**Architecture:** A dedicated security module (`lib/security/claims-encryption.ts`) provides AAD-bound AES-256-GCM encryption and blind indexing; migration `0066` establishes PostgreSQL RLS-protected tables with composite foreign keys to admissions and append-only event ledgers; a pure domain module (`lib/domain/claims.ts`) encapsulates the dual-path (cashless & reimbursement) state machine with optimistic locking; a core service layer (`lib/services/claims.ts`) coordinates mutations, audit logging, and nurse financial masking; the heartbeat worker (`lib/services/sweeps.ts`) evaluates minute SLAs emitting count-only alerts; and a high-density server/client interface (`/ipd/claims`) delivers rapid filtering and query dispatch.

**Tech Stack:** Next.js 15 (App Router, Server Actions), PostgreSQL, Drizzle ORM with Row Level Security (`withTenant`), Node.js `node:crypto` (AES-256-GCM, HMAC-SHA256), Vitest.

**Spec:** [`docs/superpowers/specs/2026-10-21-claims-e1-design.md`](file:///d:/Projects/HospitalAutomation/docs/superpowers/specs/2026-10-21-claims-e1-design.md)

---

## Global Constraints

- **Roadmap Boundary:** Phase E1 is a roadmap module; all tables, routes, and services must remain completely decoupled from the active pilot slice (§11.1), with the module registry `defaultState` set to `'off'`.
- **Non-Blocking Discharge:** Claim status, missing pre-authorizations, or open queries MUST NEVER block patient discharge, bed de-allocation, or doctor sign-off.
- **Fail-Closed Cryptography:** All encryption uses `CLAIMS_ENCRYPTION_KEY` exclusively; missing keys fail closed immediately with zero fallback to WhatsApp or platform keys.
- **AAD Cryptographic Binding:** All encrypted policy numbers and member IDs MUST bind `claim_cases.id` as Authenticated Additional Data (AAD).
- **Tenant Isolation & Composite Keys:** Every table enforces PostgreSQL RLS via `withTenant`, references `admissions(hospital_id, id)` and `encounter_payers(hospital_id, id)` via composite foreign keys, and includes a `client_id` unique key for idempotent retries.
- **Append-Only Immutability:** `claim_events` has no cascade delete (`onDelete: 'restrict'`) and cannot be mutated or purged once written.
- **Privacy-Safe Alerts:** Background sweeps and notification alerts MUST contain aggregate counts only—never patient names, MRNs, bed labels, or payer names.
- **Nurse Financial Concealment:** When a user with the role `nurse` reads claim data, the service layer MUST strip/nullify all financial amount fields.
- **SQL Idempotency:** Migration `0066` uses `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, and standard `text` with `CHECK` constraints (no `pgEnum`).

---

## Review Focus

1. **AAD Mismatch Protection:** Decrypting a policy number using an altered or transplanted `claimId` must fail authentication immediately and cleanly.
2. **Concurrent State Mutation Protection:** Two desk coordinators submitting conflicting state transitions concurrently must trigger `StaleClaimVersionError` on the second transaction without corrupting claim state or event logs.
3. **Nurse Financial Masking:** A nurse querying the claims list or patient file must receive active claim statuses and document checklists while all monetary fields (`preauth_amount_paise`, `approved_amount_paise`, `settled_amount_paise`, `deduction_amount_paise`, `co_pay_amount_paise`) remain `null`.
4. **Discharge Non-Interference:** An admission with an active claim in `query_raised` or missing pre-auth must execute `finalizeDischarge` and bed de-allocation without impediment or throwing claim errors.
5. **Sweeps Alert Anonymization:** Running `sweepClaimSlas()` against breached queries must generate `clinical_alerts` notifications whose message text strictly matches a generic count pattern (`/^\d+ TPA queries? require.*$/`) with zero patient or ward PII.

---

## Task Decomposition

### Task 1: Dedicated Cryptography & Blind Index Subsystem

**Files:**
- Create: `lib/security/claims-encryption.ts`
- Create: `lib/security/__tests__/claims-encryption.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type EncryptedIdentifier = {
    ciphertext: string;
    iv: string;
    tag: string;
    keyVersion: number;
    masked: string;
    blindIndex: string;
  };
  export function encryptClaimIdentifier(raw: string, claimId: string): EncryptedIdentifier;
  export function decryptClaimIdentifier(
    encrypted: { ciphertext: string; iv: string; tag: string; keyVersion: number },
    claimId: string
  ): string;
  export function computeClaimBlindIndex(raw: string): string;
  export function maskClaimIdentifier(raw: string): string;
  export class ClaimsKeyConfigurationError extends Error {}
  export class ClaimsDecryptionError extends Error {}
  ```

- [ ] **Step 1: Write failing crypto unit tests**
  Test roundtrip AES-256-GCM encryption/decryption, AAD tampering detection (throws `ClaimsDecryptionError` when `claimId` changes), blind index determinism using `CLAIMS_BLIND_INDEX_SALT`, 4-character masking (`•••• 1234`), and fail-closed behavior when `CLAIMS_ENCRYPTION_KEY` is missing.
- [ ] **Step 2: Run test to verify it fails**
  Run: `npx vitest run lib/security/__tests__/claims-encryption.test.ts`
  Expected: FAIL with module not found.
- [ ] **Step 3: Implement `lib/security/claims-encryption.ts`**
  Implement AES-256-GCM with 12-byte random IV, 16-byte auth tag, `setAAD(Buffer.from(claimId, 'utf8'))`, HMAC-SHA256 blind indexing, and key versioning reading `CLAIMS_ENCRYPTION_KEY`.
- [ ] **Step 4: Run test to verify it passes**
  Run: `npx vitest run lib/security/__tests__/claims-encryption.test.ts`
  Expected: PASS
- [ ] **Step 5: Commit**
  `git add lib/security/claims-encryption.ts lib/security/__tests__/claims-encryption.test.ts && git commit -m "feat(security): add AAD-bound AES-256-GCM encryption and blind indexing for claims"`

---

### Task 2: Domain State Machine, Operational Clocks & Validation Rules

**Files:**
- Create: `lib/domain/claims.ts`
- Create: `lib/domain/__tests__/claims.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type ClaimStatus =
    | 'draft'
    | 'preauth_submitted'
    | 'query_raised'
    | 'preauth_approved'
    | 'preauth_rejected'
    | 'enhancement_requested'
    | 'claim_ready'
    | 'final_submitted'
    | 'settled'
    | 'partially_settled'
    | 'claim_rejected'
    | 'appeal_in_progress'
    | 'appeal_submitted'
    | 'appeal_won'
    | 'appeal_lost'
    | 'reimbursement_draft'
    | 'reimbursement_docs_gathering'
    | 'reimbursement_dossier_ready'
    | 'dossier_handed_to_patient'
    | 'closed_cancelled';

  export type ClaimTransitionInput = {
    currentStatus: ClaimStatus;
    targetStatus: ClaimStatus;
    isReimbursement?: boolean;
    submissionDetails?: { sentAt: Date; channel: 'portal' | 'email' | 'physical_courier' | 'in_person'; reference: string };
  };

  export function validateClaimTransition(input: ClaimTransitionInput): void;
  export function isTerminalClaimStatus(status: ClaimStatus): boolean;
  export function calculatePreauthDeadlineMinutes(submittedAt: Date, slaMinutes: number): Date;
  export function calculateQueryDeadlineMinutes(receivedAt: Date, slaMinutes: number): Date;
  export class InvalidClaimTransitionError extends Error {}
  export class ImmutableSettledClaimError extends Error {}
  export class MissingSubmissionDetailsError extends Error {}
  ```

- [ ] **Step 1: Write failing domain state machine unit tests**
  Test allowed cashless transitions, reimbursement transitions, post-rejection and appeal transitions, rejection of invalid hops (e.g. `draft` $\to$ `settled`), immutability of `settled` / `partially_settled`, and enforcement of mandatory submission details on dispatch.
- [ ] **Step 2: Run test to verify it fails**
  Run: `npx vitest run lib/domain/__tests__/claims.test.ts`
  Expected: FAIL with module not found.
- [ ] **Step 3: Implement `lib/domain/claims.ts`**
  Implement the state machine transition table, transition validation logic, terminal status checks, and minute-based SLA clock calculations.
- [ ] **Step 4: Run test to verify it passes**
  Run: `npx vitest run lib/domain/__tests__/claims.test.ts`
  Expected: PASS
- [ ] **Step 5: Commit**
  `git add lib/domain/claims.ts lib/domain/__tests__/claims.test.ts && git commit -m "feat(domain): add claims state machine, transition guards, and SLA calculation"`

---

### Task 3: Database Schema & Migration 0066

**Files:**
- Create: `drizzle/0066_claims_tracker_and_tpa_desk.sql`
- Modify: `lib/db/schema.ts`
- Create: `lib/db/migrations/__tests__/claims-0066.test.ts`

**Interfaces:**
- Produces Drizzle table exports:
  - `payerProfiles` (platform-level)
  - `hospitalPayerConfigs` (tenant-isolated overrides)
  - `claimCases` (tenant-isolated, composite FKs, encrypted fields, blind indices, version column)
  - `claimEvents` (append-only ledger, `onDelete: 'restrict'`)
  - `claimDocumentRecords` (physical custody tracking & in-system links)
  - `claimQueries` (queries with minute SLA deadlines)
  - `claimRejections` (rejections and appeal tracking)

- [ ] **Step 1: Write SQL migration `drizzle/0066_claims_tracker_and_tpa_desk.sql`**
  Implement idempotent SQL (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`) for all 7 tables with composite foreign keys to `admissions(hospital_id, id)` and `encounter_payers(hospital_id, id)`, `CHECK (amount_paise >= 0)`, text check constraints for statuses, and RLS policies.
- [ ] **Step 2: Add Drizzle definitions to `lib/db/schema.ts`**
  Export `payerProfiles`, `hospitalPayerConfigs`, `claimCases`, `claimEvents`, `claimDocumentRecords`, `claimQueries`, and `claimRejections` using standard Drizzle types.
- [ ] **Step 3: Write migration lint and schema integrity test**
  Verify table structures, composite foreign keys, non-null constraints, and index declarations.
- [ ] **Step 4: Run test to verify migration and schema**
  Run: `npx vitest run lib/db/migrations/__tests__/claims-0066.test.ts`
  Expected: PASS
- [ ] **Step 5: Commit**
  `git add drizzle/0066_claims_tracker_and_tpa_desk.sql lib/db/schema.ts lib/db/migrations/__tests__/claims-0066.test.ts && git commit -m "feat(db): add 0066 migration and schema for claims tracker and tpa desk"`

---

### Task 4: Permission Matrix & Nurse Financial Shield

**Files:**
- Modify: `lib/domain/permissions.ts`
- Create: `lib/services/claims-masking.ts`
- Create: `lib/domain/__tests__/claims-permissions.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // Permissions added to PERMISSIONS record:
  // 'claims.view': ['owner', 'receptionist', 'doctor', 'nurse']
  // 'claims.edit': ['owner', 'receptionist']
  // 'claims.packet': ['owner', 'receptionist', 'doctor']
  // 'claims.admin': ['owner']

  export function maskClaimFinancialsForRole<T extends Record<string, any>>(
    claim: T,
    role: StaffRole
  ): T;
  ```

- [ ] **Step 1: Write failing permission & masking tests**
  Test permission assignments for all 4 staff roles and verify that `maskClaimFinancialsForRole` strips all paise amount fields (`preauthAmountPaise`, `approvedAmountPaise`, `claimedAmountPaise`, `settledAmountPaise`, `deductionAmountPaise`, `coPayAmountPaise`) when role is `'nurse'`.
- [ ] **Step 2: Run test to verify it fails**
  Run: `npx vitest run lib/domain/__tests__/claims-permissions.test.ts`
  Expected: FAIL
- [ ] **Step 3: Update `lib/domain/permissions.ts` and implement `lib/services/claims-masking.ts`**
  Add permissions to `PERMISSIONS` matrix and implement role-based financial masking.
- [ ] **Step 4: Run test to verify it passes**
  Run: `npx vitest run lib/domain/__tests__/claims-permissions.test.ts`
  Expected: PASS
- [ ] **Step 5: Commit**
  `git add lib/domain/permissions.ts lib/services/claims-masking.ts lib/domain/__tests__/claims-permissions.test.ts && git commit -m "feat(permissions): add claims permissions and nurse financial masking"`

---

### Task 5: Claims Core Service Operations & Optimistic Locking

**Files:**
- Create: `lib/services/claims.ts`
- Create: `lib/services/__tests__/claims.integration.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export async function createClaimCaseInTx(tx: Tx, args: {
    hospitalId: string;
    branchId: string;
    admissionId: string;
    encounterId: string;
    patientId: string;
    encounterPayerId: string;
    payerProfileId: string;
    claimType?: 'cashless' | 'reimbursement';
    priority?: 'standard' | 'urgent' | 'emergency';
    rawPolicyNumber?: string | null;
    rawMemberId?: string | null;
    estimatedCostPaise?: number | null;
    actorUserId: string;
    clientId: string;
  }): Promise<ClaimCaseRow>;

  export async function transitionClaimStatusInTx(tx: Tx, args: {
    claimId: string;
    hospitalId: string;
    expectedVersion: number;
    targetStatus: ClaimStatus;
    submissionDetails?: { sentAt: Date; channel: any; reference: string };
    amountPaise?: number | null;
    notes?: string | null;
    actorUserId: string;
    clientId: string;
  }): Promise<ClaimCaseRow>;

  export async function recordClaimQueryInTx(tx: Tx, args: { ... }): Promise<ClaimQueryRow>;
  export async function replyClaimQueryInTx(tx: Tx, args: { ... }): Promise<ClaimQueryRow>;
  export async function recordClaimSettlementInTx(tx: Tx, args: { ... }): Promise<ClaimCaseRow>;
  export class StaleClaimVersionError extends Error {}
  ```

- [ ] **Step 1: Write integration tests for claims service**
  Test creation with AAD encryption and blind index generation, append-only `claim_events` logging, optimistic locking conflict detection (throwing `StaleClaimVersionError` on version mismatch), settlement recording with discharge bill link, and access logging for policy decryption.
- [ ] **Step 2: Run test to verify it fails**
  Run: `npx vitest run lib/services/__tests__/claims.integration.test.ts`
  Expected: FAIL with module not found.
- [ ] **Step 3: Implement `lib/services/claims.ts`**
  Implement transactional core operations using `withTenant`, enforcing optimistic version increments, writing `claim_events` records, verifying foreign keys, and writing to `record_access_logs`.
- [ ] **Step 4: Run test to verify it passes**
  Run: `npx vitest run lib/services/__tests__/claims.integration.test.ts`
  Expected: PASS
- [ ] **Step 5: Commit**
  `git add lib/services/claims.ts lib/services/__tests__/claims.integration.test.ts && git commit -m "feat(services): implement claims management service with optimistic locking and audit logging"`

---

### Task 6: Operational SLA Background Sweeps & Privacy Alerts

**Files:**
- Modify: `lib/services/sweeps.ts`
- Create: `lib/services/__tests__/claims-sweeps.integration.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export async function sweepClaimSlas(
    now?: Date,
    options?: { hospitalId?: string }
  ): Promise<{ queriesWarning: number; queriesOverdue: number; preauthOverdue: number }>;
  ```

- [ ] **Step 1: Write failing sweeps integration tests**
  Seed queries with expiring deadlines (< 60m) and overdue pre-authorizations. Verify that `sweepClaimSlas` generates `clinical_alerts` notifications whose message strictly contains aggregate counts and zero patient/bed/payer names.
- [ ] **Step 2: Run test to verify it fails**
  Run: `npx vitest run lib/services/__tests__/claims-sweeps.integration.test.ts`
  Expected: FAIL with function missing.
- [ ] **Step 3: Implement `sweepClaimSlas` in `lib/services/sweeps.ts`**
  Query pending queries and open pre-auths, evaluate SLA deadlines against `now`, and insert aggregate alerts into `clinical_alerts`. Wire into the central sweeps interval.
- [ ] **Step 4: Run test to verify it passes**
  Run: `npx vitest run lib/services/__tests__/claims-sweeps.integration.test.ts`
  Expected: PASS
- [ ] **Step 5: Commit**
  `git add lib/services/sweeps.ts lib/services/__tests__/claims-sweeps.integration.test.ts && git commit -m "feat(sweeps): add minute-accurate claims SLA sweep with privacy-safe alert counts"`

---

### Task 7: Production-Grade Bootstrap CSV Import Engine

**Files:**
- Create: `lib/services/claims-import.ts`
- Create: `lib/services/__tests__/claims-import.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type CsvImportRow = {
    ipdNumber?: string;
    mrn?: string;
    patientName?: string;
    payerCode: string;
    policyNumber: string;
    memberId?: string;
    claimType: 'cashless' | 'reimbursement';
    status: ClaimStatus;
    preauthAmountRupees?: string;
    clientId: string;
  };
  export type CsvValidationResult = {
    totalRows: number;
    validCount: number;
    errorCount: number;
    errors: { rowIndex: number; field: string; message: string }[];
  };
  export async function validateClaimsCsv(csvText: string, hospitalId: string): Promise<CsvValidationResult>;
  export async function executeClaimsCsvImport(csvText: string, hospitalId: string, actorUserId: string): Promise<{ importedCount: number; updatedCount: number }>;
  ```

- [ ] **Step 1: Write CSV import unit and integration tests**
  Test 2 MB / 500-row file cap, refusal of phone-only matching, strict matching against active admissions by `ipd_number` or (`mrn` + patient name), dry-run report generation, idempotent upserting on re-import, and audit log generation.
- [ ] **Step 2: Run test to verify it fails**
  Run: `npx vitest run lib/services/__tests__/claims-import.test.ts`
  Expected: FAIL with module not found.
- [ ] **Step 3: Implement `lib/services/claims-import.ts`**
  Parse CSV stream, enforce size limits, validate against database schemas and existing admissions, and perform idempotent batch commits with audit logging.
- [ ] **Step 4: Run test to verify it passes**
  Run: `npx vitest run lib/services/__tests__/claims-import.test.ts`
  Expected: PASS
- [ ] **Step 5: Commit**
  `git add lib/services/claims-import.ts lib/services/__tests__/claims-import.test.ts && git commit -m "feat(import): implement production-grade CSV bootstrap import with dry-run validation"`

---

### Task 8: Module Registry Declaration & Access Gates

**Files:**
- Modify: `lib/modules/registry.ts`
- Create: `lib/modules/__tests__/claims-module.test.ts`

**Interfaces:**
- Produces:
  - `claims_tracker` entry in `MODULES` array with `defaultState: 'off'`, `dependsOn: ['core_ipd']`, routes, fileTabs, and printSheets.

- [ ] **Step 1: Write module registry assertion test**
  Verify `claims_tracker` exists in `MODULES`, depends on `core_ipd`, has `defaultState === 'off'`, declares route `/ipd/claims`, and assigns correct tab orders.
- [ ] **Step 2: Run test to verify it fails**
  Run: `npx vitest run lib/modules/__tests__/claims-module.test.ts`
  Expected: FAIL
- [ ] **Step 3: Update `lib/modules/registry.ts`**
  Add the `claims_tracker` definition matching spec §10.
- [ ] **Step 4: Run test to verify it passes**
  Run: `npx vitest run lib/modules/__tests__/claims-module.test.ts`
  Expected: PASS
- [ ] **Step 5: Commit**
  `git add lib/modules/registry.ts lib/modules/__tests__/claims-module.test.ts && git commit -m "feat(modules): register claims_tracker module with default off state"`

---

### Task 9: High-Density Claims Desk Table UI

**Files:**
- Create: `app/(app)/ipd/claims/page.tsx`
- Create: `components/ipd/claims/claims-table.tsx`
- Create: `components/ipd/claims/claims-kpi-strip.tsx`
- Create: `components/ipd/claims/claim-action-modals.tsx`

**Interfaces:**
- Produces:
  - Server-rendered page `/ipd/claims` gating on `claims.view` and `moduleAllows(hospitalId, 'claims_tracker')`.
  - KPI summary header: Active insured stays, pending pre-auths, urgent queries (< 60m remaining).
  - High-density table with sorting, filters (Branch, Payer, Stage, SLA urgency), and quick actions (Log Query, Mark Replied, Record Approval).

- [ ] **Step 1: Create UI components for KPI strip and table**
  Build `claims-kpi-strip.tsx` and `claims-table.tsx` with minute SLA countdown badges, masked policy display, and responsive desktop layout.
- [ ] **Step 2: Create action modals**
  Build `claim-action-modals.tsx` for query logging, reply recording, and pre-auth amount recording.
- [ ] **Step 3: Create `/ipd/claims/page.tsx`**
  Assemble server component fetching claims data, enforcing nurse financial masking, and rendering the operational desk.
- [ ] **Step 4: Verify manual or component rendering**
  Run typecheck and lint: `npm run lint` or `npx tsc --noEmit`.
- [ ] **Step 5: Commit**
  `git add app/\(app\)/ipd/claims/ components/ipd/claims/ && git commit -m "feat(ui): implement high-density claims desk table view and action modals"`

---

### Task 10: Inpatient Admission Claim Tab & Document Custody Checklist

**Files:**
- Create: `components/ipd/claims/claim-details-view.tsx`
- Create: `components/ipd/claims/claim-custody-checklist.tsx`
- Modify: `app/(app)/ipd/admissions/[id]/page.tsx`

**Interfaces:**
- Produces:
  - Tab view under `/ipd/admissions/[id]?tab=claims` displaying:
    - Chronological event timeline
    - Physical document custody checklist with "Paper Filed" ticks and box numbers
    - In-system linked records (discharge summary, finalized bill)
    - Query and appeal management card

- [ ] **Step 1: Build `claim-custody-checklist.tsx`**
  Interactive checklist for physical custody (Aadhaar, policy card, signed form) with user and timestamp recording.
- [ ] **Step 2: Build `claim-details-view.tsx`**
  Visual vertical timeline of claim events, queries, and pre-auth milestones.
- [ ] **Step 3: Integrate tab into `app/(app)/ipd/admissions/[id]/page.tsx`**
  Wire the `claims` tab when the `claims_tracker` module is active.
- [ ] **Step 4: Verify type safety**
  Run: `npx tsc --noEmit`
  Expected: Clean compilation with 0 errors.
- [ ] **Step 5: Commit**
  `git add components/ipd/claims/ app/\(app\)/ipd/admissions/\[id\]/ && git commit -m "feat(ui): add claims and physical document custody tab to patient file"`

---

## Execution Handoff

Plan complete and saved to [`docs/superpowers/plans/2026-10-21-claims-e1-implementation.md`](file:///d:/Projects/HospitalAutomation/docs/superpowers/plans/2026-10-21-claims-e1-implementation.md). Please review the plan. Which execution approach would you prefer?

- **Subagent-driven** - A fresh subagent implements each task and a fresh reviewer checks it before the next one starts, then a whole-branch review at the end. Most thorough; costs a fresh context per task and per review.
- **Native** - I implement every task myself in this session, the way this harness runs work, then one fresh reviewer on the most capable model checks the whole branch. Cheapest and fastest; no independent review until the end. Runs well with a mid-tier session model, since the plan carries the design.

**For this plan I recommend Subagent-driven, because the tasks involve strict cryptographic boundaries, tenant-isolated database constraints, and financial masking that benefit significantly from fresh, independent verification at each task gate.** Does the plan capture what you want, and which approach should we use?
