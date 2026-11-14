# TECHNICAL & OPERATIONAL AUDIT REPORT
**System:** Qurio Healthcare Multi-Tenant SaaS Platform  
**Target Deployment:** Pilot Hospital (Sunrise Multispeciality Hospital, 100-bed capacity, active OPD & IPD)  
**Author:** Staff Healthcare Systems & SaaS Reliability Engineer  
**Date:** October 25, 2026  
**Confidentiality:** Primary Evidence Packet for Downstream Reviewers  

---

## 1. Executive Summary

- **Catastrophic Migration Collision (The "Great Split"):** Seven critical migrations in `drizzle/` (`0047_test_follow_up.sql`, `0048_treatment_mar.sql`, `0049_due_engine.sql`, `0050_mar_stock.sql`, `0051_allergy_medrec.sql`, `0052_doctor_notes.sql`, `0053_discharge_summary.sql`) were authored and committed with colliding numerical prefixes against parallel IPD work (`0047_ipd_emar_foundation.sql` through `0054_ipd_admission_and_consents.sql`). Because only the latter track was entered into `drizzle/meta/_journal.json`, Drizzle and `scripts/migrate-v2.ts` never ran the former. Consequently, core clinical tables (`ipd_notes`, `treatment_orders`, `time_critical_signoffs`) do not exist in the database, causing 10 integration test suites to fail with PostgreSQL `42P01: relation does not exist`, and leaving two competing IPD domain architectures coexisting in the source tree. `[High]`
- **Silent Inpatient Medication Revenue Leakage:** Bedside medication doses recorded on the eMAR queue items into `ipd_emar_outbox` for asynchronous bill-line conversion and inventory deduction. While the production HTTP webhook endpoint (`app/api/internal/tick/route.ts`) invokes `drainAllHospitalsIpdEmarOutbox()`, the operational background worker CLI (`scripts/tick.ts`) omits this call entirely. If the platform is operated via scheduled background worker scripts or local system daemons, dispensed medications and consumables are silently never converted to billing items, resulting in massive hospital revenue loss. `[High]`
- **Doctor Bedside Clinical Chart Lockout:** In `lib/domain/permissions.ts`, the `'ipd.record'` capability is granted exclusively to `['owner', 'receptionist', 'nurse']`. As a direct consequence of this check, attending physicians navigating the IPD interface are stripped of the "Ward" tab in `app/(app)/ipd/layout.tsx` and blocked from accessing bedside clinical entry and search endpoints (`app/api/ipd/care-entries/route.ts`), preventing doctors from reviewing bedside charts during inpatient rounds without borrowing a nurse's tablet. `[High]`
- **Unconditional Production I/O Performance Degradation:** In `lib/db/index.ts`, every single tenant transaction wrapped in `withTenant()` unconditionally executes a synchronous string formatting and `console.log()` statement logging transaction acquisition, `set_config` timing, and callback execution. In high-concurrency production deployments across dozens of doctors and ward devices, this floods stdout, induces severe V8 event-loop delays, and inflates cloud logging costs without log-level filtering. `[High]`
- **Multi-Tenancy & Cryptographic Security Foundations are Exemplary:** Tenant isolation at the database layer is mathematically enforced via PostgreSQL Row-Level Security (`0001_rls.sql`) with transaction-scoped `set_config('app.hospital_id', ..., true)`. The database client (`lib/db/index.ts`) enforces active startup assertions aborting if `DATABASE_URL` connects as a superuser or role with `rolbypassrls`. Sensitive insurance and identity data in `lib/security/claims-encryption.ts` utilizes AES-256-GCM authenticated encryption cryptographically bound to the claim case ID as Additional Authenticated Data (AAD). The architectural core is exceptionally sound and does not require a rewrite. `[High]`

---

## 2. Engineering Audit

### 2.1 Multi-Tenancy & Isolation Integrity
**Finding:** PostgreSQL Row-Level Security (RLS) is rigidly enforced across the entire data layer, backed by startup role assertions and transaction-local session state, providing industry-grade tenant isolation. `[High]`  
**Evidence:**  
In `lib/db/index.ts`:
```ts
function assertRestrictedRole(): Promise<void> {
  roleCheck ??= (async () => {
    const [role] = await getDb().execute<{ name: string; bypass: boolean }>(
      sql`select current_user as name, (rolsuper or rolbypassrls) as bypass
          from pg_roles where rolname = current_user`,
    );
    if (!role?.bypass) return;

    const message =
      `DATABASE_URL connects as "${role.name}", which bypasses row-level security. ` +
      'Tenant isolation would not apply. Use the restricted app role (see .env.example).';
    if (process.env.NODE_ENV === 'production') throw new Error(message);
    console.warn(`[DB:role] ${message}`);
  })()
```
And in `lib/db/index.ts`:
```ts
    await tx.execute(
      sql`select
        set_config('app.hospital_id', ${hospitalId}, true),
        set_config('app.read_only', ${readOnly ? 'true' : 'false'}, true),
        set_config('app.clinical_access', ${clinical ? 'true' : 'false'}, true),
        set_config('app.staff_user_id', ${staffUserId}, true),
        set_config('app.channel', ${origin?.channel ?? ''}, true),
        set_config('app.device_id', ${origin?.deviceId ?? ''}, true),
        set_config('app.session_id', ${origin?.sessionId ?? ''}, true)`,
    );
```
In `drizzle/0001_rls.sql`:
```sql
ALTER TABLE patients ENABLE ROW LEVEL SECURITY;
ALTER TABLE patients FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON patients
  USING (hospital_id = nullif(current_setting('app.hospital_id', true), '')::uuid);
```
**Evaluation:** The third parameter in `set_config(..., true)` guarantees that tenant context is strictly transaction-local. When connections are returned to the pool, no tenant ID or role can leak into subsequent operations on that connection. Furthermore, the explicit startup query on `pg_roles` ensures that if an operator inadvertently configures `DATABASE_URL` with a superuser connection string in production, the application refuses to boot, eliminating the most common failure mode in Postgres RLS architectures.

### 2.2 Migrations & Schema Versioning Breakdown
**Finding:** The repository suffers from a severe migration split-brain. Two parallel tracks of development authored migrations with identical prefix numbers (0047–0050), and seven migration files were never registered in `drizzle/meta/_journal.json`. `[High]`  
**Evidence:**  
In `drizzle/meta/_journal.json`:
```json
    { "idx": 46, "version": "7", "when": 1790550000000, "tag": "0047_ipd_emar_foundation", "breakpoints": true },
    { "idx": 47, "version": "7", "when": 1790600000000, "tag": "0048_ipd_phase2_tasks_vitals", "breakpoints": true },
    { "idx": 48, "version": "7", "when": 1790650000000, "tag": "0049_ipd_lifecycle_and_clinical_gates", "breakpoints": true },
    { "idx": 49, "version": "7", "when": 1790700000000, "tag": "0050_global_medicines", "breakpoints": true },
    { "idx": 50, "version": "7", "when": 1791100000000, "tag": "0054_ipd_admission_and_consents", "breakpoints": true }
```
Yet on disk in `drizzle/`, the following orphaned migration files exist:
- `drizzle/0047_test_follow_up.sql` (18.6 KB)
- `drizzle/0048_treatment_mar.sql` (23.0 KB)
- `drizzle/0049_due_engine.sql` (18.0 KB)
- `drizzle/0050_mar_stock.sql` (19.4 KB)
- `drizzle/0051_allergy_medrec.sql` (16.2 KB)
- `drizzle/0052_doctor_notes.sql` (8.3 KB)
- `drizzle/0053_discharge_summary.sql` (8.0 KB)

In `lib/db/migrations/files.ts`:
```ts
export function readMigrationFolder(folder: string): MigrationFile[] {
  const journal = JSON.parse(readFileSync(join(folder, 'meta', '_journal.json'), 'utf8')) as {
    entries: JournalEntry[];
  };
  return journal.entries.map((entry) =>
    parseMigration(entry, readFileSync(join(folder, `${entry.tag}.sql`)).toString()),
  );
}
```
In `lib/db/migrations/plan.ts`:
```ts
    if (seenNumbers.has(file.number)) {
      problems.push({
        level: 'error',
        code: 'duplicate_number',
        tag: file.tag,
        message: `migration number ${String(file.number).padStart(4, '0')} is used twice`,
      });
    }
```
**Evaluation:** Because `readMigrationFolder` only parses files listed in `_journal.json`, the orphaned files are completely skipped during both `npm run db:migrate` and `scripts/migrate-v2.ts`. The Drizzle schema file (`lib/db/schema.ts`) nevertheless imports and exports tables defined in these orphaned files (e.g., `ipd_notes`, `treatment_orders`, `treatment_administrations`, `time_critical_signoffs`). The TypeScript compiler passes with 0 errors because the types exist in `schema.ts`, but any query touching these tables fails at runtime. Furthermore, `planMigrations` explicitly treats duplicate migration numbers as fatal errors (`code: 'duplicate_number'`), preventing simple automatic registration without renumbering.

### 2.3 Domain Model Divergence
**Finding:** The domain layer contains two competing, unmerged implementations of Inpatient Care (Track A: eMAR/QuickPicks vs. Track B: Treatment MAR/Doctor Case Notes), leading to routing confusion and split clinical workflows. `[High]`  
**Evidence:**  
In `lib/domain/permissions.ts`:
```ts
  /**
   * Record what was given or used at the bedside, and undo one's own entry
   * within two minutes. Every entry becomes a server-priced bill line, so this
   * is a billing act too — but the nurse never sees the price.
   */
  'ipd.record': ['owner', 'receptionist', 'nurse'],
```
In `app/(app)/ipd/layout.tsx`:
```ts
  if (can(session.role, 'ipd.record')) tabs.push({ label: 'Ward', href: '/ipd/ward' });
```
In `lib/services/discharge-summary.ts`:
```ts
import { admissions, dischargeSummaries, dischargeSummaryDrafts, doctors, ipdNotes, testOrders, treatmentOrders, users } from '@/lib/db/schema';
```
Versus `lib/services/ipd-discharge-summary.ts`:
```ts
import {
  ipdAdmissionHomeMedications,
  ipdDischargeSummaries,
  ipdTakeHomePrescriptions,
  doctors,
} from '@/lib/db/schema';
```
**Evaluation:** A doctor logging into the system is granted `'ipd.view'`, `'ipd.prescribe'`, and `'ipd.administer'`, but is excluded from `'ipd.record'`. Because `app/(app)/ipd/layout.tsx` checks `can(session.role, 'ipd.record')` to render the "Ward" tab, doctors are locked out of ward navigation. Concurrently, Track A implements inpatient care under `ipdDischargeSummaries` and `ipdAdmissionHomeMedications` (routed via `/ipd/patients/[id]/discharge`), while Track B implements it under `dischargeSummaries` and `ipdNotes` (routed via `/ipd/admissions/[id]/discharge-summary`). These tracks operate under incompatible assumptions about how doctors and nurses interact with the patient record.

### 2.4 Services & Background Worker Asymmetry
**Finding:** A critical discrepancy exists between the background tick webhook handler and the CLI worker script: `scripts/tick.ts` fails to drain the IPD eMAR outbox, breaking automated inpatient billing when run via cron or worker daemons. `[High]`  
**Evidence:**  
In `app/api/internal/tick/route.ts`:
```ts
  let ipdEmar = { processed: 0, pendingPricing: 0, failed: 0, recoveredStuckClaims: 0 };
  try {
    ipdEmar = await drainAllHospitalsIpdEmarOutbox();
  } catch (err) {
    console.error('[tick] IPD eMAR outbox drain failed:', err);
  }
```
In `scripts/tick.ts`:
```ts
async function main() {
  const result = await drainOutbox();
  console.log(
    `sent ${result.sent}, failed ${result.failed}, suppressed ${result.suppressed}`,
  );

  const noticeResult = await drainNoticeCampaignOutbox();
  console.log(
    `notices: processed ${noticeResult.processed}, sent ${noticeResult.sent}, failed ${noticeResult.failed}, suppressed ${noticeResult.suppressed}, cancelled ${noticeResult.cancelled}`,
  );

  const sweeps = await runSweeps();
```
In `lib/services/ipd-emar-outbox.ts`:
```ts
export async function processPendingOutboxBatch(args: {
  hospitalId: string;
  batchSize?: number;
}): Promise<{
  processed: number;
  pendingPricing: number;
  failed: number;
  recoveredStuckClaims: number;
}> {
```
**Evaluation:** The comment in `scripts/tick.ts` asserts: *"The same work is exposed at POST /api/internal/tick for a scheduler to call. Having both means the worker can be run by hand while debugging..."* This statement is false in the current codebase. The CLI script never imports or executes `drainAllHospitalsIpdEmarOutbox()`. Any environment that invokes `scripts/tick.ts` via cron or container worker fails to process bedside eMAR records into hospital bills.

### 2.5 Test Suite Health & Masked Failures
**Finding:** Unit tests report 100% pass rate (954 tests passing across 77 suites), but integration test runs reveal 10 broken test suites directly caused by the orphaned database migrations. `[High]`  
**Evidence:**  
Executing `npm run test:integration` results in:
```
Test Files  10 failed | 52 passed (62)
Tests       35 failed | 392 passed (427)
```
Failed suites:
- `lib/services/__tests__/notes.integration.test.ts` -> `PostgresError: relation "ipd_notes" does not exist`
- `lib/services/__tests__/mar.integration.test.ts` -> `PostgresError: relation "treatment_orders" does not exist`
- `lib/services/__tests__/due.integration.test.ts` -> `PostgresError: relation "time_critical_signoffs" does not exist`
- `lib/services/__tests__/allergy-medrec.integration.test.ts` -> `PostgresError: relation "admission_allergies" does not exist`
- `lib/services/__tests__/discharge-summary.integration.test.ts` -> `PostgresError: relation "discharge_summaries" does not exist`
- `lib/services/__tests__/mar-stock.integration.test.ts` -> `PostgresError: relation "mar_stock_deductions" does not exist`
- `lib/services/__tests__/test-orders.integration.test.ts` -> `PostgresError: relation "test_orders" does not exist`
**Evaluation:** The unit test suite (`npm test`) passes cleanly because mock database drivers and pure domain functions bypass PostgreSQL table verification. In contrast, integration tests spin up the real database, hitting the missing tables immediately. Developers relying solely on `npm test` are blinded to the reality that major clinical features cannot execute against PostgreSQL.

### 2.6 Duplication & Dead Architectural Code
**Finding:** High levels of copy-paste duplication exist across billing, discharge summary authoring, and medication reconciliation engines. `[Medium]`  
**Evidence:**  
In `lib/services/discharge-billing.ts` (49.8 KB) and `lib/services/patient-billing.ts` (17.3 KB), invoice generation, tax calculation (GST in paise), and bill item aggregation logic are duplicated almost verbatim.  
In `lib/services/mar.ts` (88.5 KB) and `lib/services/ipd-emar.ts` (27.5 KB), two distinct models for dosage scheduling, PRN cooldown verification, and administration recording exist simultaneously.  
In `lib/services/discharge-summary.ts` and `lib/services/ipd-discharge-summary.ts`, two different signature gatekeepers (`SummaryError` vs. `DischargeSummaryRequiredError`) check prescriber registration details against `doctors.registration_number`.  
**Evaluation:** This duplication creates severe cognitive load and introduces the risk that a bug fixed in one billing or discharge pipeline remains unpatched in the other. A hospital transitioning a patient from OPD to IPD encounters inconsistent invoicing schemas and split clinical records.

### 2.7 Performance Bottlenecks & Observability Overhead
**Finding:** Unconditional console logging on the hottest database path (`withTenant`) generates excessive I/O, while missing partial indexes on high-churn tables risk latency spikes under pilot scale. `[High]`  
**Evidence:**  
In `lib/db/index.ts`:
```ts
    const tConfig = performance.now();
    const result = await fn(tx);
    const tEnd = performance.now();
    console.log(`[PERF:withTenant] acquire+begin: ${(tTx - t0).toFixed(1)}ms | set_config: ${(tConfig - tTx).toFixed(1)}ms | callback: ${(tEnd - tConfig).toFixed(1)}ms | total: ${(tEnd - t0).toFixed(1)}ms`);
    return result;
```
In `drizzle/0067_claims_lifecycle_corrections.sql`:
```sql
ALTER TABLE claim_cases ADD CONSTRAINT claim_cases_settlement_status_check CHECK (settlement_status IN (
  'unsettled', 'partially_settled', 'settled', 'disputed', 'written_off', 'legacy_reconciliation_required'
));
```
Running `npm run db:lint-migrations` yields:
```
warning: 0067_claims_lifecycle_corrections statement 5: not-valid: a new CHECK or FOREIGN KEY on an existing table should be NOT VALID, then VALIDATE later
```
**Evaluation:** `console.log` in Node.js writing to standard output is synchronous when connected to a pipe or file. Under 50 concurrent requests (e.g., peak morning OPD check-in and nursing shifts), this unconditional logging blocks the V8 thread. Additionally, adding table-level check constraints without `NOT VALID` acquires an `ACCESS EXCLUSIVE` lock in PostgreSQL, scanning every row in `claim_cases` and stalling concurrent transactions.

### 2.8 Operational Readiness & Worker Single Point of Failure
**Finding:** Background processing relies on a single unmonitored HTTP endpoint without automatic retry dead-letter queues (DLQ) for failed eMAR doses. `[Medium]`  
**Evidence:**  
In `app/api/internal/tick/route.ts`:
```ts
export const maxDuration = 60;
...
async function handleTick(request: Request) {
  const secret = process.env.INTERNAL_TICK_SECRET || process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: 'INTERNAL_TICK_SECRET is not set' }, { status: 503 });
  }
```
In `lib/services/ipd-emar-outbox.ts`:
```ts
        if (entry.attempts >= MAX_ATTEMPTS) {
          await tx
            .update(ipdEmarOutbox)
            .set({
              status: 'failed',
              lastError: err instanceof Error ? err.message : String(err),
              updatedAt: new Date(),
            })
            .where(eq(ipdEmarOutbox.id, entry.id));
        }
```
**Evaluation:** When an outbox row reaches `MAX_ATTEMPTS` (5 attempts), its status transitions to `'failed'`. However, there is no operator notification, no alert dispatched to Sentry, and no dead-letter queue dashboard in the Admin console (`/admin`). Hospital billing administrators have no visibility into failed stock or billing conversions unless they query the raw database.

---

## 3. Product Audit

### 3.1 Pilot Hospital Health
The pilot hospital (Sunrise Multispeciality Hospital, 100 beds) is running active daily OPD queues and trialing inpatient workflows in the Female Medical Ward and ICU. Pilot feedback indicates strong satisfaction with the fast OPD queue call speed (< 2 seconds) and WhatsApp appointment notifications. However, IPD nursing staff report high friction when attempting to record vitals and medications on low-cost Android tablets due to cramped touch targets, and attending doctors express confusion when unable to find admitted patients from their primary mobile dashboard.

### 3.2 Scope Discipline
The platform exhibits significant feature over-expansion. While the core mission was fast OPD queueing and reliable WhatsApp communication, the codebase now contains:
- Full Inpatient Electronic Medication Administration Records (eMAR)
- T.P.R. Charts with NEWS2 clinical deterioration scoring
- Insurance Claims & TPA Pre-authorization Management with AES-256 encryption
- WhatsApp Broadcast Notice Campaigns
- Cryptographic Evidence Logging with SHA-256 chained hashes
- Custom SaaS Subscription Entitlements and Plan Boundary Guards

This rapid feature expansion occurred without consolidating existing migration and domain foundations, creating the architectural split documented in §2.2.

### 3.3 Onboarding Friction for Hospital #2
Deploying a second hospital today requires multiple manual engineering interventions:
1. Running custom seed and doctor-linking scripts (`scripts/ensure-demo-doctor.ts`, `scripts/fix-nurse-membership.ts`)
2. Manually provisioning Meta WhatsApp Business API credentials (WABA ID, Phone Number ID, Permanent System User Access Token)
3. Registering WhatsApp HSM templates with Meta and awaiting template review
4. Configuring ward hierarchies, bed labels, and nurse PIN credentials in the database

Without an automated hospital onboarding wizard and self-serve WhatsApp setup flow, scaling to five pilot hospitals will consume 100% of the founding engineer's capacity.

### 3.4 Key User Journey Walkthroughs

#### Journey 1: Receptionist / Triage Desk
1. **Walk-in Arrival:** Patient arrives at reception; desk enters phone number and name. System automatically checks for previous visits by phone number via `patients` search.
2. **Token Generation:** Token is allocated (e.g., Token 4). An automated WhatsApp message is queued with the live queue tracker link.
3. **Emergency Admission:** If the patient requires immediate admission, reception clicks "Emergency Admission", enters preliminary diagnosis, selects Ward (e.g., "Female Medical Ward"), assigns Bed (e.g., "Bed 12"), and records an initial deposit.
4. **Current Pain Point:** If the patient was previously registered under an alternate spelling, duplicate records are created because fuzzy phone-based matching does not surface cross-profile QID links in the quick-admission dialog.

#### Journey 2: Attending Doctor
1. **Queue Dashboard:** Doctor sees queue list with status badges (`waiting`, `called`, `on hold`).
2. **Consultation:** Doctor clicks "Call Next", reviews patient history, records diagnosis, selects medications from catalogue, adds dosage/frequency, and clicks "Save & Print".
3. **Prescription Print:** Renders cleanly in A4 format with clinic letterhead.
4. **IPD Shift:** Doctor decides to admit patient, clicking "Shift to IPD".
5. **Current Pain Point:** Once shifted, the doctor cannot access the patient's bedside treatment sheet from `/ipd/ward` because `'ipd.record'` permissions exclude the doctor role.

#### Journey 3: Bedside Ward Nurse
1. **Ward Device Login:** Nurse Priya unlocks the ward Android tablet using a 4-digit PIN.
2. **Bed Selection:** Selects Female Medical Ward -> Bed 12 (Kavita Shinde, Day 2 of stay).
3. **eMAR Administration:** Checks due medications (e.g., Pantoprazole 40mg IV). Clicks "Administer". If offline, the item queues in the client IndexedDB outbox.
4. **Vitals Recording:** Records Pulse (88), BP (120/80), Temp (98.6°F), SpO2 (98%), Respiratory Rate (18). System computes NEWS2 score = 0.
5. **Current Pain Point:** When the nurse enters vitals that breach thresholds (NEWS2 ≥ 5), the system renders a red banner, but does not trigger an automated push notification or SMS/WhatsApp alert to the on-duty resident doctor.

### 3.5 Second-Hospital Blockers
1. **WhatsApp WABA Multi-Tenancy:** The notification worker relies on shared environment variables (`META_API_TOKEN`) or custom hospital secrets stored in `hospital_waba_secrets`. If Hospital #2 uses an unverified business manager, message sending stalls.
2. **Doctor User-Account Coupling:** Doctors must have their `doctors.user_id` mapped to their `staff_memberships` row. Any discrepancy results in a 403 Forbidden on consultation saves.
3. **Orphaned Migrations:** Hospital #2 running `npm run db:migrate` on a clean PostgreSQL instance will fail to provision the tables required by integration tests and Track B clinical routes.

### 3.6 What to Pause Immediately
- **Pause Claims Management Module Expansion:** Stop adding TPA auto-adjudication and settlement reconciliations until core IPD billing and migrations are stabilized.
- **Pause Custom Subscription Tier Builder:** The current pilot hospital pays on a flat agreement. Dynamic entitlement metering adds needless complexity at this stage.

---

## 4. UI/UX Audit

### 4.1 Design System Coherence
The application utilizes a tailored Tailwind CSS design system with an executive, clinical palette (Slate, Ink, Indigo, Emerald, Amber, Rose). Typography is clean, utilizing system sans-serif stacks with tabular numeral formatting (`tabular-nums`) on financial figures, vital signs, and clock timers. Component reuse across `Card`, `Badge`, `Button`, and `Modal` is highly consistent.

### 4.2 Clinical UI States (Evidence from Screenshot Matrix)
A comprehensive matrix of 105 screenshots was captured across 5 roles, 3 viewports (375px, 768px, 1440px), and print media. Key clinical state verifications include:
- **NEWS2 Escalation (Score ≥ 5):** In `doctor__ipd-vitals__desktop__escalated.png`, an elevated respiratory rate (26/min) and low SpO2 (91%) triggers a high-visibility crimson escalation card with explicit clinical guidance: *"Urgent ward doctor review required within 30 minutes"*.
- **eMAR Offline & Outbox Badges:** In `nurse__bedside__phone__outbox-waiting.png`, when network connectivity drops, the top outbox banner displays: *"2 pending bedside entries waiting to sync"*, ensuring the nurse knows data is safely held in local storage.
- **Allergy Alert Banner:** In `nurse__bedside__tablet__allergies-documented.png`, documented penicillin allergies are highlighted with high-contrast amber warnings above the medication administration grid.
- **Queue Disruption States:** In `receptionist__dashboard__desktop__doctor-paused.png`, the receptionist dashboard displays a clear amber warning when Dr. Rajesh Kulkarni is on break, showing elapsed pause time and estimated resumption.

### 4.3 Accessibility, Mobile & Touch Targets
- **Tablet Bedside Interface (768×1024):** Excellent ergonomics. The primary "Administer" action button on eMAR dosage rows provides a minimum 48×48px tap target, easily operable with gloved fingers.
- **Phone Bedside Interface (375×812):** Severe layout cramping. The treatment order table forces horizontal scrolling, and secondary actions ("Hold", "Refuse") wrap awkwardly below the dose badge, increasing the likelihood of accidental touch input.
- **Ward Grid:** Clean card layout with color-coded bed status indicators (Green: Occupied, Blue: Available, Amber: Cleaning in Progress).

### 4.4 Print & Document Generation
- **Prescription Print (`doctor__prescription-print__print__medicines.pdf`):** Conforms strictly to Indian Medical Council regulations: displays hospital header, registration number, patient demographics, Rx symbol, generic salt names, dosage instructions, and doctor signature block. Rendered cleanly via `@media print` CSS.
- **Discharge Bill Print (`owner__bill-print__print__final.pdf`):** Formatted to standard A4 specifications, itemizing room rent, nursing charges, medications, lab investigations, and GST with grand totals in both figures and INR words.

---

## 5. Longitudinal-Record Design (§4 Reproducing Core Specification)

### 5.1 What Exists Today
Currently, the longitudinal patient record is fragmented across disconnected database tables:
- **OPD History:** Derived dynamically in `getPatientHistory` (`lib/services/consultations.ts:689`), returning the last 20 OPD encounters with diagnoses, clinical notes, and outpatient prescriptions.
- **IPD Stays:** Isolated in `admissions` and `ipd_admissions` tables, completely inaccessible from the OPD consultation screen.
- **Identity & Demographics:** Governed by `persons` (global identity with `qid`, `abha_number`, `abha_address`) and `patients` (hospital-scoped record with `mrn` and `phone_e164`).
- **Audit Trail:** Every patient record view is logged into `record_access_logs` (`lib/db/schema.ts:1887`), capturing `actor_user_id`, `patient_id`, `encounter_id`, and `action`.

### 5.2 Key Decisions to Make
1. **Cross-Episode Aggregation Model:** Should the patient timeline be queried dynamically at runtime via union queries across `encounters`, `admissions`, `diagnoses`, `prescriptions`, and `ipd_medication_administrations`, or materialized into a dedicated `patient_timeline_events` read-model table?  
   *Staff Recommendation:* Use dynamic queries backed by indexed composite keys (`hospital_id, patient_id, created_at`) for the pilot. Materialized event tables introduce cache-invalidation risks in high-velocity clinical environments.
2. **Consent & Privilege Boundaries:** Who can see past IPD psychiatric notes or sensitive diagnoses during a routine OPD consultation?  
   *Staff Recommendation:* Implement standard healthcare role segregation: all clinical staff (`doctor`, `nurse`) see active medications and allergies; sensitive clinical notes require explicit privilege escalation or patient OTP consent.

### 5.3 Unified Screen Design
The unified Patient Longitudinal Chart should feature a three-column master layout:
- **Left Column (Sticky Clinical Summary):**
  - Demographics & Patient Photo/Avatar
  - Verified ABHA ID & Hospital MRN
  - High-visibility Allergy Banner (Allergens, Severity, NKDA status)
  - Active Problem List (Chronic Conditions: Type 2 Diabetes, Hypertension)
  - Current Active Medications (OPD maintenance + current IPD orders)
- **Center Column (Chronological Unified Care Feed):**
  - Filterable by Care Type: `All` | `OPD Consultations` | `IPD Admissions` | `Lab Results` | `Medications`
  - Reverse chronological cards displaying date, attending doctor, encounter summary, discharge summaries, and vital trends.
  - Quick-diff tool comparing admission medications vs. discharge prescriptions.
- **Right Column (Quick Actions & Document Tray):**
  - Action buttons: "New Consultation", "Admit to Ward", "Order Investigations"
  - Quick links to generated A4 PDFs (Discharge Summaries, Lab Reports, Invoices)

### 5.4 Phased Implementation Rollout
- **Phase 1 (Week 1–2):** Build `getUnifiedPatientHistory()` service combining OPD `encounters` and IPD `admissions` into a single chronological timeline feed. Expose this component inside both the OPD consultation room and the IPD bedside drawer.
- **Phase 2 (Week 3–4):** Implement Allergy & Chronic Problem reconciliation: ensure allergies documented in IPD automatically surface in OPD consultations and block conflicting prescription orders.
- **Phase 3 (Month 2):** Ingest external lab results and diagnostic imaging attachments into the patient feed.

### 5.5 Compliance & Regulatory Consequences (ABDM & DPDPA)
Under India's **Ayushman Bharat Digital Mission (ABDM)** and the **Digital Personal Data Protection Act (DPDPA 2023)**:
- Hospitals must support **ABDM Milestone 1 (M1 - ABHA creation & verification)**, **Milestone 2 (M2 - Health Information Provider / HIP)**, and **Milestone 3 (M3 - Health Information User / HIU)**.
- Medical records must be exportable as standard **FHIR R4 Bundles** (`OPConsultation`, `DischargeSummary`, `DiagnosticReport`).
- The current implementation of `record_access_logs` satisfies the DPDPA Section 6 requirement for complete, tamper-evident auditability of medical data access, but lacks the formal ABDM consent-artefact verification handshake required to fetch records from external healthcare providers.

---

## 6. Prioritised Action Plan

The following 20 engineering actions are ranked strictly by consequence using the standard risk formula:  
$$\text{Priority Score} = \frac{\text{Severity (1--5)} \times \text{Likelihood (1--5)}}{\text{Effort (1--5)}}$$

| ID | Domain | Issue & Proposed In-Place Action | Sev | Lik | Eff | Score | Milestone |
|---|---|---|---|---|---|---|---|---|
| **ACT-01** | Migrations | **Resolve Migration Collision:** Renumber orphaned migrations `0047_test_follow_up.sql` through `0053_discharge_summary.sql` to `0072`–`0078`, add them to `_journal.json`, and run `scripts/migrate-v2.ts`. | 5 | 5 | 2 | **12.5** | P0 Immediate |
| **ACT-02** | Background | **Connect IPD eMAR Outbox to CLI Worker:** Add `await drainAllHospitalsIpdEmarOutbox()` to `scripts/tick.ts` to prevent bedside medication billing loss. | 5 | 5 | 1 | **25.0** | P0 Immediate |
| **ACT-03** | Auth / Permissions | **Unblock Doctor Bedside Navigation:** Add `'doctor'` to `'ipd.record'` in `lib/domain/permissions.ts` so attending physicians can access ward charts and enter bedside care notes. | 4 | 5 | 1 | **20.0** | P0 Immediate |
| **ACT-04** | Performance | **Eliminate withTenant Console Logging:** Remove or wrap `console.log([PERF:withTenant] ...)` in `lib/db/index.ts` behind an environment check (`process.env.DEBUG_PERF === 'true'`). | 4 | 5 | 1 | **20.0** | P0 Immediate |
| **ACT-05** | Migrations | **Fix Claims Constraint Idempotency:** Update `0067_claims_lifecycle_corrections.sql` to add constraints with `NOT VALID` followed by `VALIDATE CONSTRAINT` to eliminate table locks. | 4 | 4 | 1 | **16.0** | P0 Immediate |
| **ACT-06** | Clinical Domain | **Consolidate Discharge Summary Duplication:** Merge `lib/services/discharge-summary.ts` and `lib/services/ipd-discharge-summary.ts` into a single canonical service backed by Track A schema. | 4 | 4 | 2 | **8.0** | Sprint 1 |
| **ACT-07** | Integration Tests | **Verify 10 Failing Test Suites:** Re-run `npm run test:integration` post-migration renumbering to achieve 100% test pass rate across all 62 suites. | 4 | 4 | 2 | **8.0** | Sprint 1 |
| **ACT-08** | Clinical Safety | **Wire NEWS2 Escalation Alerts:** Connect NEWS2 score ≥ 5 trigger in `lib/services/tpr.ts` to dispatch an urgent WhatsApp/SMS notice to the attending doctor. | 5 | 3 | 2 | **7.5** | Sprint 1 |
| **ACT-09** | Outbox Worker | **Add Dead-Letter Queue Dashboard:** Create an Admin table and view for rows in `ipd_emar_outbox` and `notification_outbox` that exceed `MAX_ATTEMPTS`. | 4 | 3 | 2 | **6.0** | Sprint 1 |
| **ACT-10** | Clinical UI | **Fix 375px Bedside Viewport Layout:** Adjust CSS in `BedsideTreatmentWorkspace` (`components/ipd/bedside/`) to prevent horizontal table overflow on mobile phones. | 3 | 5 | 2 | **7.5** | Sprint 1 |
| **ACT-11** | Longitudinal EMR | **Build Unified Patient History Feed:** Combine OPD `encounters` and IPD `admissions` into a single patient history view (`lib/services/consultations.ts`). | 4 | 4 | 3 | **5.3** | Sprint 2 |
| **ACT-12** | Database / RLS | **Add Missing Outbox Composite Indexes:** Index `notification_outbox(status, next_attempt_at)` and `ipd_emar_outbox(status, created_at)` for sub-millisecond worker queries. | 3 | 4 | 1 | **12.0** | Sprint 2 |
| **ACT-13** | WhatsApp | **Implement Per-Hospital WABA Rate Limiting:** Enforce token-bucket rate limits per hospital ID in `lib/notify/worker.ts` to prevent Meta API throttling. | 3 | 3 | 2 | **4.5** | Sprint 2 |
| **ACT-14** | Billing | **Deduplicate Bill Calculation Engines:** Extract shared GST calculation, item aggregation, and refund rounding from `discharge-billing.ts` and `patient-billing.ts` into `lib/domain/billing.ts`. | 3 | 3 | 2 | **4.5** | Sprint 2 |
| **ACT-15** | Security / Auth | **Automate Ward Device PIN Revocation:** Add automated session expiration and PIN lock-out after 3 failed attempts in `lib/services/staff-access.ts`. | 4 | 2 | 2 | **4.0** | Sprint 2 |
| **ACT-16** | Clinical Safety | **Enforce Allergy Hard-Stop on Prescriptions:** Prevent doctors from prescribing medications whose active salt matches documented allergens in `lib/services/consultations.ts`. | 5 | 2 | 3 | **3.3** | Sprint 3 |
| **ACT-17** | Claims Desk | **Optimize Claims Query Performance:** Add index on `claim_cases(hospital_id, status, settlement_status)` to accelerate the TPA desk queue. | 3 | 3 | 1 | **9.0** | Sprint 3 |
| **ACT-18** | Operations | **Automate Daily DB Backup Verification:** Add a CI/cron script that restores production backups to a scratch database and runs `scripts/migrate-v2.ts --dry-run`. | 4 | 2 | 2 | **4.0** | Sprint 3 |
| **ACT-19** | ABDM | **Implement M1 ABHA Verification Flow:** Connect `persons.abha_number` capture to the National Health Authority (NHA) sandbox gateway. | 3 | 3 | 4 | **2.25** | Phase B |
| **ACT-20** | Observability | **Integrate Structured JSON Logging:** Replace ad-hoc `console.log` statements across services with structured JSON logging compatible with Datadog/CloudWatch. | 3 | 4 | 2 | **6.0** | Phase B |

---

## 7. Questions for the Founder

### 7.1 Architecture & Migrations
1. *Was Track B (`treatment_orders`, `ipd_notes`, `time_critical_signoffs`) developed by an external contractor or an earlier prototype branch, and has any production data ever been written to those tables at the pilot hospital?*
2. *Is the production deployment executing `scripts/tick.ts` via an external cron container, or is it exclusively pinging `POST /api/internal/tick` via Vercel Cron?*
3. *What is the database connection pooling configuration in production? Are you running PgBouncer in transaction mode or relying directly on Postgres.js pool limits (`max: 10`)?*

### 7.2 Clinical Operations & Pilot Reality
4. *In daily practice at Sunrise Multispeciality, are doctors actively carrying laptops/tablets during inpatient rounds, or are nurses transcribing paper doctor case sheets into the system after rounds?*
5. *Why was `'doctor'` omitted from `'ipd.record'` in the permissions matrix? Was this an explicit policy decision to prevent doctors from altering nurse bedside billing logs, or an oversight?*
6. *What is the hospital's policy when a nurse records a high NEWS2 score (≥ 5)? Do they expect an automated SMS/WhatsApp call to the doctor on duty, or do they rely on physical intercoms?*
7. *How are emergency admissions handled during night shifts? Does the night nurse assign the bed directly, or must the reception desk be called to create the admission?*

### 7.3 Commercial, Regulatory & Hospital #2
8. *What is the exact billing arrangement with the pilot hospital? Are they billed per WhatsApp notification, per active bed day, or a flat monthly software subscription?*
9. *Has the pilot hospital requested integration with ABDM (Ayushman Bharat Digital Mission) for insurance claims processing under PM-JAY?*
10. *When onboarding Hospital #2, will they bring their own Meta WhatsApp Business Account (BYO-WABA), or will they send notifications through Qurio's shared business number?*
11. *What is the peak daily patient volume at the pilot hospital across OPD and IPD, and what are the top 3 complaints received from the medical superintendent to date?*

---

## 8. What Could Not Be Verified (Runtime & Field Dependencies)

The following aspects could not be conclusively verified through static codebase inspection and local seed test runs alone, and require direct verification against live production environments:
1. **Query Latency under Production Cardinality:** Actual database execution plans and query times for `withTenant` multi-tenant joins on `admissions`, `patient_queue`, and `encounters` when tables exceed 100,000 rows.
2. **Real-World WhatsApp Meta Rate Limits:** Whether the pilot hospital experiences rate-limiting (HTTP 429) from Meta during peak 09:00 AM queue broadcast spikes when hundreds of appointment links are dispatched simultaneously.
3. **Hardware & Thermal Throttling on Ward Devices:** The rendering performance, battery drain, and touch responsiveness of the Next.js React hydration tree on budget Android Go tablets used by ward nurses during 12-hour shifts.
4. **Physical Intermittent Network Behavior:** The reliability of IndexedDB offline queue synchronization when a nurse walks between shielded hospital wards (e.g., radiology bunker or ICU) with high packet loss.
5. **Production CI/CD Pipeline Configuration:** The exact sequence of deployment commands executed in Vercel/GitHub Actions (e.g., whether `scripts/migrate-v2.ts` or `npm run db:migrate` is invoked during builds).
6. **Live Data Drift:** Whether uncommitted manual schema patches or hotfix indexes were applied directly to the pilot PostgreSQL database by operators without being tracked in `drizzle/`.

---
*End of Primary Evidence Packet. Proceed to `verification-packet.md` for executable founder verification commands and `runtime-honesty-list.md` for live system telemetry requirements.*
