# FOUNDER VERIFICATION PACKET
**Target:** Qurio Healthcare SaaS Platform — Pilot Deployment Verification  
**Objective:** Executable verification suite to convert Medium and Low findings into High findings, or definitively prove/disprove architectural risks in the production environment.  
**Format:** `ID · What you suspect · Exact command or file to open · What the founder should see if you are right · What would prove you wrong`

---

### VP-01 · Disconnected Inpatient Medication Outbox Drain in CLI Worker
- **What you suspect:** While the HTTP route `/api/internal/tick` drains both notification and eMAR outboxes, the CLI background worker `scripts/tick.ts` omits `drainAllHospitalsIpdEmarOutbox()`. If the hospital runs background workers via cron or container tasks using `scripts/tick.ts`, bedside eMAR doses will accumulate indefinitely in `ipd_emar_outbox` without converting to billed items or stock deductions. `[Medium -> High]`
- **Exact command or file to open:**  
  Open `scripts/tick.ts` and compare lines 14–37 with `app/api/internal/tick/route.ts` lines 55–60. Also run against the production database:
  ```bash
  psql "$DATABASE_URL" -c "SELECT hospital_id, status, count(*) FROM ipd_emar_outbox GROUP BY hospital_id, status;"
  ```
- **What the founder should see if you are right:**  
  In `scripts/tick.ts`, only `drainOutbox()`, `drainNoticeCampaignOutbox()`, and `runSweeps()` are called; `drainAllHospitalsIpdEmarOutbox()` is completely absent. On production, if `scripts/tick.ts` is the active worker daemon, the query returns hundreds of rows stuck in `status = 'pending'`.
- **What would prove you wrong:**  
  The production scheduler exclusively executes `curl -X POST -H "Authorization: Bearer $INTERNAL_TICK_SECRET" https://app.qurio.health/api/internal/tick`, and the SQL query reports 0 rows stuck in `status = 'pending'`.

---

### VP-02 · Doctor Bedside Clinical Chart Lockout
- **What you suspect:** In `lib/domain/permissions.ts`, the `'ipd.record'` permission is assigned to `['owner', 'receptionist', 'nurse']` and excludes `'doctor'`. Because `app/(app)/ipd/layout.tsx` gates the "Ward" tab behind `can(session.role, 'ipd.record')`, doctors logging in to the web app cannot see the Ward tab or access bedside patient sheets directly. `[Medium -> High]`
- **Exact command or file to open:**  
  Open `lib/domain/permissions.ts` at line 91 and `app/(app)/ipd/layout.tsx` at line 26. In the browser, log in as `doctor@demo.hospital` and navigate to `http://localhost:3000/ipd`.
- **What the founder should see if you are right:**  
  The top navigation bar displays only "IPD Home" and "Admissions"; the "Ward" tab is completely absent for doctors. Navigating directly to `http://localhost:3000/api/ipd/care-entries` returns HTTP 403 Forbidden because the API route checks `await ipdCaller('ipd.record')`.
- **What would prove you wrong:**  
  Doctors are deliberately intended to only interact with patients via OPD consultation or doctor-specific order sheets, and hospital policy strictly mandates that only nurses and receptionists touch the ward bed list.

---

### VP-03 · Orphaned Migrations & Uncreated Clinical Tables in Production
- **What you suspect:** Seven migration files (`0047_test_follow_up.sql`, `0048_treatment_mar.sql`, `0049_due_engine.sql`, `0050_mar_stock.sql`, `0051_allergy_medrec.sql`, `0052_doctor_notes.sql`, `0053_discharge_summary.sql`) were never recorded in `drizzle/meta/_journal.json`. Consequently, tables such as `ipd_notes`, `treatment_orders`, and `time_critical_signoffs` were never created on PostgreSQL, causing 10 integration test suites to fail. `[High]`
- **Exact command or file to open:**  
  Run the following commands in the workspace terminal:
  ```bash
  npx vitest run lib/services/__tests__/notes.integration.test.ts
  ```
  And check database catalog in PostgreSQL:
  ```bash
  psql "$DATABASE_URL" -c "SELECT to_regclass('public.ipd_notes'), to_regclass('public.treatment_orders'), to_regclass('public.time_critical_signoffs');"
  ```
- **What the founder should see if you are right:**  
  The vitest command fails with `PostgresError: relation "ipd_notes" does not exist`. The SQL query outputs `NULL` for all three relations.
- **What would prove you wrong:**  
  The tables exist in the production database because someone executed raw SQL scripts out-of-band outside of the Drizzle migration runner.

---

### VP-04 · Dangerous Exclusive Table Lock in Claims Migration
- **What you suspect:** Migration `drizzle/0067_claims_lifecycle_corrections.sql` drops and recreates `CHECK` constraints on `claim_cases` and `claim_events` without specifying `NOT VALID`. When executed on a live database with large claims history, PostgreSQL acquires an `ACCESS EXCLUSIVE` lock while scanning the table, stalling all concurrent tenant traffic. `[High]`
- **Exact command or file to open:**  
  Run the automated migration linter:
  ```bash
  npm run db:lint-migrations
  ```
- **What the founder should see if you are right:**  
  The linter exits with 5 warnings on statements 5, 7, 9, 22, and 24 of `0067_claims_lifecycle_corrections`:
  `warning: 0067_claims_lifecycle_corrections statement 5: not-valid: a new CHECK or FOREIGN KEY on an existing table should be NOT VALID, then VALIDATE later`.
- **What would prove you wrong:**  
  The table `claim_cases` has 0 rows in production, so the table scan takes under 1ms, resulting in imperceptible lock duration.

---

### VP-05 · Unconditional Performance Overhead on withTenant Transactions
- **What you suspect:** In `lib/db/index.ts`, line 148 logs `[PERF:withTenant] acquire+begin: ... | set_config: ... | callback: ... | total: ...` on every single transaction execution. In production under pilot load, this floods standard output, degrades Node.js event-loop throughput, and inflates cloud log storage costs. `[High]`
- **Exact command or file to open:**  
  Open `lib/db/index.ts` lines 145–150:
  ```bash
  grep -n "PERF:withTenant" lib/db/index.ts
  ```
- **What the founder should see if you are right:**  
  Line 148 is an unconditional `console.log` statement not guarded by any `process.env.DEBUG` or `process.env.NODE_ENV !== 'production'` conditional. Live server logs in Vercel/CloudWatch show thousands of `[PERF:withTenant]` log lines per hour.
- **What would prove you wrong:**  
  The production build uses a compiler strip-log plugin or custom logger wrapper that automatically erases `console.log` invocations from production bundles.

---

### VP-06 · Divergent Discharge Summary Implementations & Split UI Routes
- **What you suspect:** Two separate implementations of the Discharge Summary exist in parallel: Track A (`lib/services/ipd-discharge-summary.ts`) storing data in `ipd_discharge_summaries`, and Track B (`lib/services/discharge-summary.ts`) storing data in `discharge_summaries`. The UI exposes two different URLs (`/ipd/patients/[id]/discharge` vs `/ipd/admissions/[id]/discharge-summary`), causing clinical confusion. `[Medium -> High]`
- **Exact command or file to open:**  
  Inspect the route structure:
  ```bash
  ls app/\(app\)/ipd/patients/\[id\]/discharge/page.tsx
  ls app/\(app\)/ipd/admissions/\[id\]/\(file\)/discharge-summary/page.tsx
  ```
- **What the founder should see if you are right:**  
  Both files exist and import different services. `admissions/[id]/discharge-summary` imports `getSummaryView` from `lib/services/discharge-summary.ts` (which queries non-existent table `discharge_summaries`), while `patients/[id]/discharge` imports from `lib/services/ipd-discharge-summary.ts`.
- **What would prove you wrong:**  
  One of the routes is deprecated, contains an active redirect, or is never linked from any user-facing navigation item.

---

### VP-07 · Production Startup Crash on Misconfigured DATABASE_URL
- **What you suspect:** The platform includes an active defense mechanism in `lib/db/index.ts` (`assertRestrictedRole`) that queries `pg_roles` on startup. If `DATABASE_URL` connects as a user with `rolsuper = true` or `rolbypassrls = true` when `NODE_ENV === 'production'`, the server deliberately crashes to protect tenant data. `[High]`
- **Exact command or file to open:**  
  View `lib/db/index.ts` lines 62–82:
  ```bash
  git grep -A 15 "assertRestrictedRole" lib/db/index.ts
  ```
- **What the founder should see if you are right:**  
  Lines 71–73 state:
  ```ts
  if (process.env.NODE_ENV === 'production') throw new Error(message);
  ```
  Connecting with `postgres` superuser credentials in production prevents the application from starting.
- **What would prove you wrong:**  
  The production environment connects exclusively via a restricted role (e.g. `qurio_app`) created according to `.env.example`.

---

### VP-08 · Fragmented Patient History Scoped Strictly to OPD Encounters
- **What you suspect:** When doctors consult with a returning patient in OPD, the "Earlier Visits" history card is populated by `getPatientHistory` (`lib/services/consultations.ts:689`), which queries only the `encounters` table. Any inpatient stays, diagnoses, or medications administered during an IPD admission are completely omitted from the history view. `[High]`
- **Exact command or file to open:**  
  Open `lib/services/consultations.ts` lines 709–716:
  ```bash
  git grep -A 10 "from(encounters)" lib/services/consultations.ts
  ```
- **What the founder should see if you are right:**  
  `getPatientHistory` queries `from(encounters)` and joins `diagnoses`, `clinicalNotes`, and `prescriptions`. It has zero joins or queries to `admissions`, `ipd_admissions`, `ipd_medication_administrations`, or `ipd_discharge_summaries`.
- **What would prove you wrong:**  
  A secondary component or tab on the consultation page separately loads and displays IPD admissions.

---

### VP-09 · Missing Dead-Letter Queue for Permanently Failed WhatsApp Outbox Messages
- **What you suspect:** When a notification reaches `MAX_ATTEMPTS` (5 failures), `lib/notify/worker.ts` marks the row as `status = 'failed'`, but there is no alerting webhook or admin console view to surface failed messages to hospital staff. `[Medium]`
- **Exact command or file to open:**  
  Open `app/(app)/admin/ui.tsx` or run grep for outbox failure monitoring:
  ```bash
  git grep "status = 'failed'" app/
  ```
- **What the founder should see if you are right:**  
  The admin console has tabs for "Hospitals", "Users", and "Entitlements", but zero screens displaying failed WhatsApp notifications or outbox dead-letters.
- **What would prove you wrong:**  
  Sentry or an external APM alert is wired to trigger whenever `status = 'failed'` is updated in the database.

---

### VP-10 · High NEWS2 Clinical Escalation Silent on Alerting Channels
- **What you suspect:** While the bedside UI computes the National Early Warning Score (NEWS2) and renders a red banner when score ≥ 5, the server action does not trigger an out-of-band notification (WhatsApp or SMS) to the on-call doctor. `[High]`
- **Exact command or file to open:**  
  Open `lib/services/tpr.ts` and inspect the function handling vitals recording.
- **What the founder should see if you are right:**  
  The vitals recording function saves the score to `ipd_vitals` and returns the computed score to the client, but contains no call to `queueNotification()` or the WhatsApp messaging service.
- **What would prove you wrong:**  
  The hospital explicitly requested that vitals escalations remain on-screen only, relying on physical ward alarms or intercoms.
