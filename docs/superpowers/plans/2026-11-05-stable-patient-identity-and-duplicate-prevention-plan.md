# Stable Patient Identity & Duplicate Prevention Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish standardized hospital-scoped UHIDs (`<HOSPITAL_PREFIX>-<YYYY>-<SEQUENCE>`), a multi-factor phonetic duplicate matching engine for Indian clinical settings, an interactive pre-registration duplicate prevention shelf in the front-desk walk-in modal, and an administrative duplicate merge service with critical admin alerts.

**Architecture:** 
1. Upgrade UHID sequencing to generate standardized, zero-padded `<PREFIX>-<YYYY>-<SEQUENCE>` identifiers per hospital using atomic row-locked sequences in `document_sequences`.
2. Expand `patient-match.ts` with Indian transliteration phonetic normalization (`phoneticKey`) and Damerau-Levenshtein distance to reliably catch spelling variants (*Patil/Patel*, *Choudhary/Chowdhry*, *Pooja/Puja*).
3. Build a debounced candidate search and interactive `<PatientDuplicateShelf />` in `AddWalkInModal` enabling 1-click returning patient selection (`[Use This Patient]`) and 1-click shared family mobile confirmation (`[Different Person (Family Member)]`).
4. Extend merge permissions to `receptionist` and `mrd` roles, detecting critical merges (active IPD, unpaid dues, conflicting gender, or age gap > 5 years) and recording audit alerts in `patient_merge_alerts` for executive administrative oversight.

**Tech Stack:** TypeScript, Next.js 16 (React 19), PostgreSQL, Drizzle ORM, Vitest, Tailwind CSS.

**Spec:** [`docs/superpowers/specs/2026-11-05-stable-patient-identity-and-duplicate-prevention-design.md`](file:///d:/Projects/HospitalAutomation/docs/superpowers/specs/2026-11-05-stable-patient-identity-and-duplicate-prevention-design.md)

---

## Global Constraints

- Rule 2.1: Domain Grounding — extend existing `patients`, `document_sequences`, `patient_merges`, and `audit_logs` without breaking `qurio_name_key` or `resolveRow`.
- Rule 2.2: English-Only Mandate — all patient-facing directions, system badges, error messages, and audit reasons must remain in professional English.
- Rule 2.3: UI & Styling — strict Tailwind CSS tokens (`bg-surface`, `text-ink-950`, `bg-brand-600`, `ring-ink-200`) and keyboard accessibility.
- Rule 2.4: Multi-Tenant Scoping — all queries and mutations must be executed within `withTenant(hospitalId, ...)`.
- Format Standard: UHID must follow `<HOSPITAL_PREFIX>-<YYYY>-<SEQUENCE>` (e.g., `QR-2026-00042`).

---

## Review Focus

1. **Shared Family Phone Collisions:** Ensuring entering a shared family mobile number does not auto-merge distinct individuals; clicking `[Different Person]` cleanly sets `forceNew: true`.
2. **Indian Phonetic Spelling Equivalences:** Ensuring transliteration variations (*Patil/Patel*, *Choudhary/Chowdhry*, *Pooja/Puja*) score as `high` confidence matches when phone or demographics match.
3. **Concurrent UHID Number Generation:** Ensuring atomic sequencing in `document_sequences` guarantees strictly monotonic, non-colliding sequential numbers even under simultaneous intake.
4. **Critical Merge Interstitial & Administrative Alerting:** Ensuring an active IPD admission or unpaid balance triggers mandatory justification and creates an alert record in `patient_merge_alerts`.
5. **Non-Destructive History Resolution:** Ensuring merging patient A into patient B redirects all future reads via `resolveRow` and `patientGroupIds` without orphaned clinical encounters or prescriptions.

---

## Task Decomposition

### Task 1: Domain Logic — Standardized UHID & Indian Phonetic Matching Engine

**Files:**
- Create: `lib/domain/__tests__/uhid-format.test.ts`
- Modify: `lib/domain/uhid.ts`
- Create: `lib/domain/__tests__/patient-match-phonetics.test.ts`
- Modify: `lib/domain/patient-match.ts`

**Interfaces:**
- Consumes: None (Pure Domain Logic)
- Produces:
  - `formatUhid(prefix: string, year: number, seq: number): string`
  - `parseUhid(uhid: string): { prefix: string; year: number; seq: number } | null`
  - `isValidUhid(uhid: string): boolean`
  - `phoneticKey(name: string): string`
  - `editDistance(a: string, b: string): number`
  - `scorePatientMatch(typed: MatchCandidate, existing: MatchCandidate): MultiFactorMatchResult`

- [ ] **Step 1: Write failing tests for UHID formatting and Indian phonetic matching**
  - Create `lib/domain/__tests__/uhid-format.test.ts` testing `formatUhid('QR', 2026, 42)` $\rightarrow$ `'QR-2026-00042'`, parsing, and regex validation.
  - Create `lib/domain/__tests__/patient-match-phonetics.test.ts` testing phonetic transliterations (*Patil/Patel*, *Pooja/Puja*, *Choudhary/Chowdhry*) and multi-factor match scoring.

- [ ] **Step 2: Run tests to verify they fail**
  - Run: `npx vitest run "lib/domain/__tests__/uhid-format.test.ts" "lib/domain/__tests__/patient-match-phonetics.test.ts"`
  - Expected: FAIL with missing exports / functions.

- [ ] **Step 3: Implement UHID formatting in `lib/domain/uhid.ts`**
  - Add `formatUhid`, `parseUhid`, and `isValidUhid` validating `<PREFIX>-<YYYY>-<SEQUENCE>`.
  - Preserve all existing Crockford Base32 QID functions (`isValidQid`, `generateQid`, `normalizeQid`).

- [ ] **Step 4: Implement Indian Phonetic Normalizer and Multi-Factor Scoring in `lib/domain/patient-match.ts`**
  - Implement `phoneticKey` normalizing vowel and consonant variations.
  - Implement `editDistance` using Damerau-Levenshtein metric.
  - Implement `scorePatientMatch` returning `{ tier, score, reasons, isFamilyPhone, isProbableDuplicate }`.
  - Preserve backward compatibility with existing `scoreMatch` function for regression stability.

- [ ] **Step 5: Run tests to verify they pass**
  - Run: `npx vitest run "lib/domain/__tests__/uhid-format.test.ts" "lib/domain/__tests__/patient-match-phonetics.test.ts" "lib/domain/__tests__/patient-match.test.ts"`
  - Expected: PASS all tests.

---

### Task 2: Database Migration & Schema — Patient Merge Alerts

**Files:**
- Create: `drizzle/0075_patient_merge_alerts.sql`
- Modify: `drizzle/meta/_journal.json`
- Modify: `lib/db/schema.ts`

**Interfaces:**
- Consumes: PostgreSQL, Drizzle ORM
- Produces: `patientMergeAlerts` table in schema with multi-tenant RLS.

- [ ] **Step 1: Add `patientMergeAlerts` table in `lib/db/schema.ts`**
  - Define table `patient_merge_alerts` with columns:
    - `id` (uuid PK)
    - `hospitalId` (uuid FK)
    - `alertType` (text default `'critical_patient_merge'`)
    - `actorUserId` (uuid FK to users)
    - `actorRole` (text)
    - `fromPatientId` (uuid FK to patients)
    - `toPatientId` (uuid FK to patients)
    - `fromUhid` (text)
    - `toUhid` (text)
    - `fromPatientName` (text)
    - `toPatientName` (text)
    - `criticalReasons` (jsonb array of strings)
    - `justification` (text)
    - `reviewedAt` (timestamptz, nullable)
    - `reviewedByUserId` (uuid FK to users, nullable)
    - `createdAt` (timestamptz)
  - Add indexes: `(hospitalId, createdAt)`, `(hospitalId, reviewedAt)`.

- [ ] **Step 2: Create SQL migration `drizzle/0075_patient_merge_alerts.sql`**
  - Include `CREATE TABLE IF NOT EXISTS patient_merge_alerts`.
  - Include `ALTER TABLE patient_merge_alerts ENABLE ROW LEVEL SECURITY`.
  - Add `tenant_isolation`, `read_only_insert`, `read_only_update`, and `read_only_delete` policies.
  - Register migration in `drizzle/meta/_journal.json` as entry 60.

- [ ] **Step 3: Run migration and verify with lint and plan**
  - Run: `npm run db:migrate`
  - Run: `npm run db:lint-migrations`
  - Run: `npm run db:migrate:plan`
  - Expected: 61 migrations checked, 0 errors, 0 pending.

---

### Task 3: Service Layer — Standardized UHID Sequencing & Patient Merge Service

**Files:**
- Modify: `lib/services/patients.ts`
- Create: `lib/services/patient-merge.ts`
- Create: `lib/services/__tests__/patient-merge.test.ts`

**Interfaces:**
- Consumes: `lib/db`, `lib/domain/uhid.ts`, `lib/domain/patient-match.ts`
- Produces:
  - `nextMrnInTx`: upgraded to format `<PREFIX>-<YYYY>-<SEQUENCE>`.
  - `findPatientDuplicates(hospitalId, criteria)`
  - `checkPatientMergeCriticality(hospitalId, fromId, toId)`
  - `executePatientMerge(hospitalId, actorUserId, actorRole, params)`
  - `listPatientMergeAlerts(hospitalId)`
  - `reviewPatientMergeAlert(hospitalId, actorUserId, alertId)`

- [ ] **Step 1: Write unit tests for `patient-merge.ts` and UHID generation in `lib/services/__tests__/patient-merge.test.ts`**
  - Test critical merge detection when patient has active admission.
  - Test critical merge detection when patient has unpaid balance or conflicting gender.
  - Test merge execution generating an alert record in `patient_merge_alerts`.

- [ ] **Step 2: Run tests to verify they fail**
  - Run: `npx vitest run "lib/services/__tests__/patient-merge.test.ts"`
  - Expected: FAIL with missing module.

- [ ] **Step 3: Update `nextMrnInTx` in `lib/services/patients.ts`**
  - Format output as `${prefix}-${year}-${lpad(seq, 5, '0')}`.
  - Default prefix to `coalesce(nullif(trim(h.mrn_prefix), ''), 'QR')`.
  - Use current year in hospital timezone for `fiscal_year` in `document_sequences`.

- [ ] **Step 4: Implement `lib/services/patient-merge.ts`**
  - Implement `findPatientDuplicates`: queries matching candidates by phone (exact) or name (prefix/phonetic), computes `scorePatientMatch`, and ranks by score descending.
  - Implement `checkPatientMergeCriticality`: inspects active admissions in `admissions` (`status = 'admitted'`), unpaid dues in `bills`, and gender/age divergence.
  - Implement `executePatientMerge`: atomic PostgreSQL transaction setting `merged_into_id`, updating `patient_merges`, and writing to `patient_merge_alerts` if critical.
  - Implement `listPatientMergeAlerts` and `reviewPatientMergeAlert`.

- [ ] **Step 5: Run tests to verify they pass**
  - Run: `npx vitest run "lib/services/__tests__/patient-merge.test.ts"`
  - Expected: PASS all tests.

---

### Task 4: Server Actions & Permissions Updates

**Files:**
- Modify: `lib/domain/permissions.ts`
- Create: `app/(app)/dashboard/patient-identity-actions.ts`
- Create: `app/(app)/dashboard/__tests__/patient-identity-actions.test.ts`

**Interfaces:**
- Consumes: `lib/services/patients.ts`, `lib/services/patient-merge.ts`, `lib/domain/permissions.ts`
- Produces:
  - Permission `'patients.merge': ['owner', 'receptionist']`
  - `findPatientDuplicatesDynamic(criteria)`
  - `checkMergeCriticalityDynamic(fromId, toId)`
  - `mergePatientsDynamic(params)`
  - `listMergeAlertsDynamic()`
  - `reviewMergeAlertDynamic(alertId)`

- [ ] **Step 1: Write tests for patient identity actions in `app/(app)/dashboard/__tests__/patient-identity-actions.test.ts`**
  - Test staff authentication and permission verification.
  - Test `findPatientDuplicatesDynamic` returns sorted candidates with match tiers.
  - Test `mergePatientsDynamic` enforces justification for critical merges.

- [ ] **Step 2: Run tests to verify they fail**
  - Run: `npx vitest run "app/(app)/dashboard/__tests__/patient-identity-actions.test.ts"`
  - Expected: FAIL with missing actions.

- [ ] **Step 3: Update `lib/domain/permissions.ts`**
  - Update `'patients.merge': ['owner', 'receptionist']`.

- [ ] **Step 4: Implement `app/(app)/dashboard/patient-identity-actions.ts`**
  - Implement `findPatientDuplicatesDynamic`, `checkMergeCriticalityDynamic`, `mergePatientsDynamic`, `listMergeAlertsDynamic`, and `reviewMergeAlertDynamic` with proper error handling and tenant isolation.

- [ ] **Step 5: Run tests to verify they pass**
  - Run: `npx vitest run "app/(app)/dashboard/__tests__/patient-identity-actions.test.ts"`
  - Expected: PASS all tests.

---

### Task 5: Front-Desk UI — Pre-Registration Duplicate Shelf in Walk-In Modal

**Files:**
- Create: `components/queue/patient-duplicate-shelf.tsx`
- Create: `components/clinical/patient-merge-modal.tsx`
- Modify: `app/(app)/dashboard/dashboard-queue-actions.tsx`
- Create: `components/queue/__tests__/patient-duplicate-shelf.test.tsx`

**Interfaces:**
- Consumes: `findPatientDuplicatesDynamic`, `PatientDuplicateMatch`
- Produces:
  - `<PatientDuplicateShelf />` component
  - `<PatientMergeModal />` component
  - Integrated duplicate warning and returning-patient auto-fill in `AddWalkInModal`.

- [ ] **Step 1: Write component tests for `<PatientDuplicateShelf />`**
  - Create `components/queue/__tests__/patient-duplicate-shelf.test.tsx`.
  - Test rendering candidate with UHID, Age, Gender, and match badge.
  - Test clicking `[Use This Patient]` calls `onSelectPatient`.
  - Test clicking `[Different Person]` calls `onForceNew`.

- [ ] **Step 2: Run test to verify it fails**
  - Run: `npx vitest run "components/queue/__tests__/patient-duplicate-shelf.test.tsx"`
  - Expected: FAIL with missing component.

- [ ] **Step 3: Implement `components/queue/patient-duplicate-shelf.tsx`**
  - Build responsive card rendering candidate matches.
  - Color-code match badges: Green (`Exact Returning Patient`), Amber (`Possible Duplicate`), Blue (`Family Member on File`).
  - Action buttons: `Use This Patient` and `Different Person (Family Member)`.

- [ ] **Step 4: Implement `components/clinical/patient-merge-modal.tsx`**
  - Dialog for selecting Source Duplicate Patient and Target Survivor Patient.
  - Criticality alert banner when active IPD or unpaid balance is detected.
  - Mandatory clinical justification text input for critical merges.

- [ ] **Step 5: Integrate `<PatientDuplicateShelf />` into `AddWalkInModal` in `app/(app)/dashboard/dashboard-queue-actions.tsx`**
  - Add debounced effect (300ms) on `phone` and `name` changes.
  - Surface `<PatientDuplicateShelf />` when matches are found.
  - On `onSelectPatient`: auto-fill name, age, address, phone, and store `selectedPatientId`.
  - On `onForceNew`: dismiss shelf and mark `forceNew = true`.
  - Update submission to pass `patientInput: selectedPatientId ? { kind: 'existing', patientId: selectedPatientId } : { kind: 'details', details: { ... }, forceNew }`.

- [ ] **Step 6: Run tests to verify they pass**
  - Run: `npx vitest run "components/queue/__tests__/patient-duplicate-shelf.test.tsx"`
  - Expected: PASS.

---

### Task 6: End-to-End Verification, Database Reconciliation & Regression Testing

**Files:**
- Update `docs/modules/04-patient-identity-duplicate-prevention/COMPLETION_REPORT.md`
- Update `task.md` and `docs/audit/IMPLEMENTATION_BACKLOG.md`

- [ ] **Step 1: Verify database migration and schema**
  - Run: `npm run db:lint-migrations` (0 errors)
  - Run: `npm run db:migrate:plan` (0 pending)

- [ ] **Step 2: Run all newly created test suites**
  - Run: `npx vitest run "lib/domain/__tests__/uhid-format.test.ts" "lib/domain/__tests__/patient-match-phonetics.test.ts" "lib/services/__tests__/patient-merge.test.ts" "app/(app)/dashboard/__tests__/patient-identity-actions.test.ts" "components/queue/__tests__/patient-duplicate-shelf.test.tsx"`
  - Expected: PASS all tests.

- [ ] **Step 3: Run full regression test suite**
  - Run: `npm test`
  - Expected: 100% PASS across all 80+ test files.

- [ ] **Step 4: Document completion in `docs/modules/04-patient-identity-duplicate-prevention/COMPLETION_REPORT.md`**
  - Record architectural decisions, test metrics, and operational impact.
  - Update `task.md` and `docs/audit/IMPLEMENTATION_BACKLOG.md`.
