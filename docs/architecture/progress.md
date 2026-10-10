# Progress log

What each phase delivered, in the order it was built. The roadmap and the
reasoning behind it are in [../plans/hms-expansion-plan.md](../plans/hms-expansion-plan.md);
from IPD onwards, in [../plans/ipd-mvp-implementation-plan.md](../plans/ipd-mvp-implementation-plan.md).
The decisions made along the way are in [decisions.md](decisions.md).

| Phase | What | Status |
|---|---|---|
| 0 | Permission matrix, role-check fixes | Done, committed (`ae68611`) |
| 1 | Walk-in address, billing foundation, Paid toggle | Done, committed (`ae68611`), migrated |
| 1+ | Security fix: RLS on two schedule tables | Done, committed (`ae68611`), migrated |
| 2 | Medicine catalogue, OPD consultation and prescription, print, history | Built and tested, **not yet committed or migrated** |
| 3 | IPD: Shift to IPD, beds, nurse bedside entries, bed-days, discharge bill, doctor phone view (IPD plan T1.1–T3.1) | Built and tested on branch `feat/ipd-mvp`, **migrations 0031–0033 not yet applied** |
| 4 | Lab-lite, reports, hardening (IPD plan Stage 4) | Planned: 8 Feb – 26 Mar 2027 |

---

## Phase 0: permissions

**Problem:** Three role checks were negations (`role !== 'doctor'`). A future
nurse or lab login would have seen Reports and the reception desk.

**Built:**
- `lib/domain/permissions.ts`: the `can(role, permission)` matrix.
  `StaffRole` is derived from the database enum.
- `app/(app)/layout.tsx`, `dashboard/page.tsx`: use the matrix.
- Settings rejects an unknown role instead of failing in the database.

## Phase 1: walk-in address and billing foundation

**For the hospital:**
- An optional **Address** field on the walk-in form.
- A one-tap **Paid / Unpaid** pill on every queue row (read-only for doctors).
- A **Seen today** card, so reception can collect after the consultation.
- A **consultation fee** per doctor in Settings.

**Built:**
- Migrations 0025 (`patients.address`) and 0026 (`encounters`, `services`,
  `bills`, `bill_items`, `patient_payments`, freeze triggers, RLS).
- `lib/domain/patient-billing.ts`: bill arithmetic in paise.
- `lib/services/patient-billing.ts`: fees, draft bill, charge once, pay and void.
- `components/paid-toggle.tsx`: optimistic pill, and the fee prompt for owners.
- `scripts/verify-migrations.mts`: rehearse migrations on a scratch database.

**Found and fixed along the way:**
- **Migration 0027:** `doctor_slot_overrides` and `doctor_interval_blocks` had no
  row-level security since 0015. A new test now asserts that no tenant table
  is unprotected.
- Production had no default privileges for the app role. New tables would have
  been invisible to the app. Fixed before migrating.

## Phase 2: medicines and OPD prescriptions

**For the hospital:**
- **Settings → Medicines:** the owner's catalogue.
  - Add, price, rename and remove medicines.
  - A "No price yet" filter.
  - One click adds 65 common generics (no prices).
- **Settings → Doctors → Doctor's login:** link each doctor to the login they
  use. **Required once per doctor** before they can write prescriptions.
- **Consultation panel** on the doctor's dashboard, under Now Serving:
  - Diagnosis, notes, prescription, advice and follow-up on one card.
  - Medicine search, with "add it if it's missing".
  - One-tap "Frequent" medicines, carrying the doctor's usual dose.
  - **Repeat last prescription** for returning patients.
  - Autosaved as you type.
  - "Complete & Call Next" saves the consultation first, and won't advance if
    saving fails.
  - After saving, the record is read-only. Revise creates a new version.
- **Earlier visits:** the patient's history, built from the records. Every view
  is logged.
- **Printable prescription** (A5): hospital, doctor, patient, diagnosis,
  medicines, advice, follow-up. No prices. Superseded prescriptions print with
  a banner.

**Built:**
- Migration 0028:
  - `medicines`, `consultation_drafts`, `diagnoses`, `clinical_notes`,
    `prescriptions`, `prescription_items`, `record_access_logs`.
  - The `clinical_access` key.
  - Guard triggers.
  - One-login-per-doctor index.
- `lib/db/index.ts`: `withTenant(…, { clinical: true })`.
- `lib/domain/consultation.ts`, `medicine.ts`, `starter-medicines.ts`.
- `lib/services/encounters.ts`, moved out of billing because both modules use
  it.
- `lib/services/consultations.ts`, `medicines.ts`; `hospital.ts#setDoctorUser`.
- `app/(app)/dashboard/consultation-panel.tsx` + `consultation-actions.ts`.
- `components/clinical/`: `medicine-picker.tsx`, `consultation-gate.tsx`.
- `app/print/prescription/[id]/`: the printable page.
- `app/api/medicines/search/route.ts`: typeahead (no prices for doctors).
- `app/(app)/settings/medicines/`: catalogue screen.

**Tests:**
- Unit tests for consultation validation, medicines and permissions.
- `consultations.integration.test.ts`:
  - saves are atomic;
  - old prescriptions keep their names after a rename;
  - removed medicines are refused on new prescriptions, and old ones still print;
  - revisions supersede, and saving unchanged content does nothing;
  - saved prescriptions can't be edited;
  - clinical rows are hidden without the key and from support sessions;
  - hospitals can't see each other's records;
  - drafts detect conflicts;
  - history is logged;
  - one login can't be linked to two doctors.

**Before the pilot doctor can use it:**
1. Apply migration 0028 (`npm run db:migrate`).
2. Settings → Doctors: link the doctor to their login.
3. Settings → Medicines: "Add common medicines" (or add their own).

## What is next: Phase 3 (IPD)

- Admit from the consultation panel, or directly for emergencies.
- An **Admitted** list for the ward.
- A per-patient timeline: progress notes, treatments, drugs given.
- The IPD bill: pick a medicine and a quantity, and the server prices it.
  Deposits, interim and final bills with numbering.
- Discharge summary and printout.

Open questions for the pilot are in [../plans/hms-expansion-plan.md §12](../plans/hms-expansion-plan.md).

## Phase 3: IPD (IPD plan T1.1–T3.1)

Built on `feat/ipd-mvp`, one commit per task. Plan: [../plans/ipd-mvp-implementation-plan.md](../plans/ipd-mvp-implementation-plan.md).

**For the hospital:**
- Doctor: one-click **Shift to IPD** (with Undo) on the OPD dashboard; **My patients** phone view with Discharge ready and Tests.
- Desk: IPD home (Awaiting bed · Wards · Discharge ready), admission sheet with payer and deposit, emergency admission, bed transfer, patient IPD page.
- Nurse: ward grid → bed → item → Save on a phone, offline outbox, 2-minute Undo. Each nurse signs in with her own login.
- Billing: every bedside entry is a bill line at once; nightly bed-day charges; discharge bill with flags, reasoned corrections, payer split, gap-free numbers; A4 itemised print; family running-bill link (en/hi/mr).
- Owner: wards and beds, IPD price list with CSV import, one-screen "Set prices", starter catalogues loaded for new hospitals.

**Built:** migrations 0031 (enums), 0032 (IPD core), 0033 (discharge billing). A shared-ward-tablet/PIN module (T1.9) was built and then removed on 3 Oct 2026: nurses use their own login (D-DV).

**Verified:** typecheck, lint, `next build`; 513 unit tests; migrations rehearsed on `qurio_scratch` (35 apply); IPD integration suites (schema, set-up, admissions, care entries, ward devices, bed-days, discharge billing, doctor view) pass there; a 33-check HTTP smoke test of every new screen ran against a production build on the scratch database. The one existing integration failure (`usage.integration.test.ts`, a fixed-date subscription case) is unrelated and predates this work.

**Before go-live:** review and merge; apply 0031–0033 with `npm run db:migrate` (0031 must commit before 0032, which the runner does); price the starter items; create nurse logins (Settings → Staff → Nurse). WhatsApp sending of the running-bill link uses a wa.me link from the desk; an approved template for automatic sending is not yet added.

**Undo everywhere (3 Oct 2026):** every staff action in IPD and its set-up shows an Undo beside its "Saved" message (`components/saved-notice.tsx`, `lib/services/ipd-undo.ts`). Set-up undoes within 1 hour while unused; desk and bill actions within 10 minutes while nothing has been recorded since; a final bill is *reopened* (with a reason) on the day of discharge — the numbered bill is kept as cancelled so numbering stays gap-free, and 0033 lets a cancelled bill's lines be voided for that. Price changes are tagged with a batch id in `audit_logs`, which is the undo journal; no new table.

**Beds:** typing a single number now means a count ("12" → beds 1–12; in a ward with 1–12, "4" → 13–16), with a live preview of the exact beds before saving.


## IPD sheets plan: pilot slice (from 10 Oct 2026)

Plan: [../plans/ipd-sheets-plan.md](../plans/ipd-sheets-plan.md) (Rev 5, approved for the pilot slice
only). Decisions: ADR-021 to ADR-030.

**A1 migration runner v2 (in progress):**
- `lib/db/migrations/`: reads `drizzle/` exactly as drizzle does (same hash and history), plans
  what to apply and refuses what drizzle would get wrong silently (an unapplied entry older than
  the last applied one, `when` going backwards, a number used twice), and lints migrations from
  0041 on for idempotency and expand-only changes. 34 unit tests, in `npm test`.
- `scripts/migrate-v2.ts`: one transaction per migration, `lock_timeout` with retries,
  `-- qurio:no-transaction` files, an advisory lock, `--dry-run`, `--rerun-check`. Same
  `drizzle.__drizzle_migrations` history as `migrate()`. `npm run db:migrate` **still uses the old
  runner** until the owner's dry run on production-sized data (`npm run db:migrate:plan`).
- `npm run db:lint-migrations`: the journal and lint checks without a database (CI).
- `scripts/synth/generate.ts`: production-sized synthetic hospitals (tiny / small / design
  profiles) generated inside Postgres, refusing any database not named `qurio_load*` or
  `qurio_scratch`; writes k6 fixtures to `loadtest/.sessions.json` (git-ignored).
- `loadtest/`: k6 shift-change scenario with the §2.2 budgets as thresholds.

**Verified on local Postgres 17 (10 Oct 2026):**
- v2 applied all 40 migrations to an empty database; `pg_dump --schema-only` and the migration
  history are identical to a database built by the old runner.
- A `-- qurio:no-transaction` file with `CREATE INDEX CONCURRENTLY`, an expand migration, and
  `--rerun-check` all pass; a table locked by another session makes v2 give up after 3 s and retry
  (2 s, 4 s) until it succeeds, instead of queueing queries behind it.
- A 0040 promoted with an old `when` is refused (`when_not_increasing`, `would_be_skipped`); drizzle
  would have skipped it silently.
- Generator: `tiny` in 3 s; `small` (50 hospitals, 1,939 beds, 39,967 stays, 1.12 M entries) in
  109 s, about 11k entries/s on a laptop, so `design` (~250 M entries) needs staging hardware and
  hours. No bed is double-booked; occupancy 83%; no entry outside its stay. It refuses `opd_db`.
- The real services on that data (largest hospital, 139 beds): `getIpdCensus` p95 24.5 ms,
  `listEntriesForAdmission` p95 35.3 ms, `recordCareEntries` p95 21.2 ms, all inside §2.2.

**Still to do for A1:** run `loadtest/shift-change.js` with k6 against a production build (k6 is not
installed here); the owner's dry run of v2 on a production-sized snapshot before `db:migrate` switches
to it; a CI job for `npm run db:lint-migrations`.

**A4-min foundation (10 Oct 2026), migration 0041:**
- `hospital_features` (module state, ward rollout, stage, settings; tenant RLS), text letterhead
  columns on `hospitals` and `doctors`, `admissions.ipd_number` (unique per hospital),
  `record_access_logs.device_id` / `session_id` and three new actions (CHECK added `NOT VALID`;
  validate in a later migration), `policy_acknowledgements` (append-only). Idempotent; passes the
  lint and `--rerun-check`.
- `lib/modules/registry.ts`: modules declared once (core: `core_ipd`, `patient_file`,
  `letterhead`); effective state with dependency limits, ward rollout, tabs and print sheets
  generated from it. Guards: `requireModule` / `assertModule` (`lib/auth/modules.ts`) and
  `ipdCaller(…, { module })`. A coverage test fails if a switchable module's route skips the guard.
- IPD numbers: given with the first bed (`assignBed`, `createDirectAdmission`), from
  `document_sequences` kind `ipd_number`, never reused; Settings → Letterhead sets where they
  continue from and numbers patients already in a bed, oldest first.
- Patient file: `/ipd/admissions/[id]` is now a `(file)` route group whose layout holds the header
  (with IPD No.), registry tabs, "Print file", and the view log (once per 10 minutes per user and
  patient). `/print/ipd-file/[id]?sheets=cover` prints the letterhead, the patient strip and the
  file cover; every print is logged.
- Settings → Letterhead and Settings → Modules (owner).

**Verified:** typecheck; 727 unit tests; `ipd-foundation.integration.test.ts` (11) plus the IPD and
RLS suites (84) on a local Postgres with 0041 applied; browser check on the local demo hospital at
1280 and 375 px (letterhead save, doctor degrees, "continue from 6159" numbering three in-bed
patients 6159–6161, file cover print, one view log per visit window, no console errors).
**Not applied to production:** 0041 is for the owner to apply (`npm run db:migrate:plan` first).

**A5-min staff access (10 Oct 2026), migration 0042 (ADR-022):**
- **Ward tablet (Mode A):** the owner adds a tablet in Settings → Staff access and gets a one-time
  8-character code (15 minutes; shown through a short-lived httpOnly cookie, never the URL). The
  tablet types it at `/ward-device` and stays enrolled until removed or unused for 90 days. It then
  shows "Who is recording?"; each person unlocks with their own 4-digit PIN for a session that is
  theirs (`sessions.channel = 'ward_device'`), ends after 10 idle minutes or 24 hours, and has its
  role capped on the server (`wardRoleFor`: owner → doctor, reception → nurse). `proxy.ts` keeps
  `w_` sessions on IPD pages. Switch user is always in the header.
- **PINs:** set by the person under My login and PIN, confirmed with their password; obvious PINs and
  years refused; scrypt. Five wrong tries lock the person's PIN for 15 minutes; twenty on one
  tablet in an hour lock the tablet for an hour. A PIN works only within 30 days of a password
  sign-in. The owner can clear a PIN, unlock a tablet, remove a tablet, and sign anyone out
  everywhere.
- **Personal device (Mode B):** nurses and doctors lock after 15 idle minutes (owner's choice,
  5–30) or 5 minutes in the background; the lock is held on the server (`sessions.locked_at`) and
  unlocked with the PIN or password at `/unlock`. Owners end after 8 idle hours / 7 days, others
  after 12 hours / 14 days. `components/session-guard.tsx` locks the screen itself; a
  `qurio_locked` hint cookie makes the next page read the lock from the database, not the cache.
- **Who may use what:** per role in Settings → Staff access (owner always on their own device),
  enforced every time a session resolves. Deactivating staff deletes their sessions at once.
- **Recorded:** device id cookie (`qurio_device`, set by `proxy.ts`), channel and device on sessions,
  bedside entries (`care_entries.recorded_channel/device_id`) and access-log rows; audit rows for
  login, logout, switch user, PIN set/reset/failure/login, tablet created/enrolled/locked/removed,
  lock and unlock.
- **Monitoring notice:** en/mr/hi **draft** wording at `/notice`, accepted once per version into
  `policy_acknowledgements`. **Off by default**; switch on only after legal item L3 closes.
- `Permissions-Policy: camera=(self)` for bed-QR scanning later.

**Verified:** typecheck, lint; 747 unit tests (20 new access rules); `staff-access.integration.test.ts`
(15) and the whole integration suite (293) on local Postgres; browser check on the demo hospital
(PIN refused/accepted, tablet enrolment, wrong and right PIN, capped role and IPD-only scope,
switch user, lock → `/unlock` → PIN unlock, audit trail). The tests found and fixed one bypass: a PIN
guess for a made-up person rolled back and never counted against the tablet.
**Not done in A5-min:** TOTP for owners (plan §5), bed QR codes (B3), staff roster.

**B1 T.P.R. chart (10 Oct 2026), migration 0043 (module `charts`, off by default):**
- **Table:** `chart_entries`, partitioned by month on `observed_at` (plan §9.4 rule 8). Typed columns
  for the paper's boxes (pulse, B.P., SpO2, temperature as °F × 10, BSL, R.R., abd girth, oxygen,
  AVPU, drain/urine/RT aspirate/oral/IV ml, note) plus `extra` for template fields later. Clinical
  (`clinical_access`), void-only, composite tenant FKs, unique `(hospital_id, client_id,
  observed_at)`. `ensure_monthly_partitions()` makes the months; each partition has RLS forced with
  no policy, so it is reachable only through the parent. The sweep keeps 12 months ahead (checked
  every 6 hours).
- **Rules** (`lib/domain/tpr.ts`): °F as typed or °C converted (under 45 is °C); B.P. as two
  numbers; High/Low flags in words as well as colour (adult ranges, 100.0 °F and above is high); the
  chart day runs 8 am to 8 am; paper rows front 8 am–10 pm, back 11 pm–7 am; shifts 8–2–8 with
  intake/output per shift and for 24 hours; "late entry" when written more than 2 hours after it was
  taken.
- **Recording** (`lib/services/tpr.ts`, `/api/ipd/tpr`): each reading its own transaction (like
  bedside entries); a retry with the same client id is charted once; refused for a future time, no
  bed, a discharged stay, or a ward outside the module's rollout. Undo: own reading, 2 minutes
  (`/undo`). Correct: anyone who charts, with a reason; the reading is struck through, never edited
  (`/void`, audited). Branch, channel, device and session come from the server.
- **Screens:** "TPR chart" tab in the patient file and a "TPR chart" button on the nurse's bed
  screen. Phone: a list by the paper's hours. Tablet and desktop: the paper grid with the Time column
  pinned. Entry sheet in paper order with number pads, last value as a hint, oxygen carried forward,
  AVPU, intake/output, note and "taken at". Readings are added on today's sheet only.
- **Offline:** its own outbox (`qurio-ward-tpr`); the bedside outbox (`qurio-ward` v1) is unchanged.
  Both now share `components/ipd/outbox-core.ts`, and the outbox status bar sends both, on the TPR
  tab too.
- **Print:** each chart day on two A4 landscape pages (front and back), Treatment column filled from
  the bedside entries, shift and 24-hour totals, corrected entries listed struck through.
  "Print this sheet" prints one day; "Print file" prints every day of the stay with something on
  it; `?day=…&blank=1` prints an empty sheet for the paper fallback.

**Verified:** typecheck, lint on all changed files; 761 unit tests (14 new); `tpr.integration.test.ts`
(11) and the whole integration suite (304) on local Postgres with 0043; the RLS coverage test now
also checks partitioned parents and requires partitions to be policy-free with RLS forced. Browser
check on the demo hospital at 375, 768 and 1280 px: bed-screen link, °C → °F conversion, High/Low
flags, save with 2-minute Undo, Correct with reason, shift totals, print front/back, whole-file print,
and an offline save that synced once when the connection came back.
**Not applied to production:** 0043 is for the owner to apply (`npm run db:migrate:plan` first).
**Not done in B1:** hospital-specific chart templates (`extra` is ready for them), the early warning
score (module `ews`), and vitals-frequency tasks on the due board (B3b).

**A6-min evidence log (10 Oct 2026), migration 0044 (module `acct_core`, core), ADR-027, ADR-031:**
- **What is recorded:** `acct_events`, monthly partitions, filled by capture triggers on the source
  tables, so no code path can write without its event: T.P.R. readings, bedside items, bill lines
  (created, voided, changed), admissions and bed moves, patient records opened or printed, staff
  notice acceptances, and every audited action with a hospital (sign-in, PIN, switch user, tablet
  enrolment, module and settings changes, support sessions). Each row has who, when it happened,
  when it was written, channel (ward tablet or own device), device and session. Payloads are ids,
  numbers and codes only — never names, notes or reasons. No foreign keys: the evidence outlives
  the rows it describes, the hospital included.
- **Nobody can change it:** a trigger refuses UPDATE and DELETE for every role; the app role has no
  UPDATE, DELETE or TRUNCATE privilege; the database gives each row its number and hash, so the app
  cannot forge either. Reading needs the clinical key (payloads carry vitals); writing does not, so a
  sign-in or a support session's read always gets its event.
- **Seals:** every hour (sweep, every 5 minutes for hospitals due) each hospital's new rows are sealed
  into `acct_digests`: an RFC 6962 Merkle root (Certificate Transparency's test vectors pass),
  chained to the previous seal, signed with an Ed25519 evidence key (`EVIDENCE_SIGNING_KEY`, made by
  `npm run evidence:keygen`; no new dependency), and copied once to an anchor directory
  (`EVIDENCE_ANCHOR_DIR`) for the S0 tooling to sync to an Object Lock bucket. A writer still in
  flight is never sealed past: every insert holds a shared advisory lock until commit, and the sealer
  only tries the exclusive lock (never queueing in front of writers).
- **Checks:** `verifyEvidence` rebuilds every row's hash from its columns (not trusting the database's
  function), each seal's root, count, hash, chain, signature and outside copy. The worker checks new
  seals hourly; the owner can "Check now"; `npm run evidence:verify -- --all` checks everything from
  the first seal and exits 1 on any problem. A failure is recorded, logged as an event, shown on the
  page and printed as `[evidence] CRITICAL` for the operators' alert.
- **Accountability page** (`/accountability`, owner, nav next to Activity): last seal (signed? copy
  kept outside?), events since, last check with any problems in plain words, "Check now", and the
  activity list filtered by kind and person, 50 at a time. Opening it is itself logged. The page says
  it is a record to look into, not a judgement.
- **Fixed on the way (ADR-031):** no browser request had ever carried its session, channel, device,
  staff user or (for support) read-only flag into the database — the request context was set with
  `enterWith` and lost under Next.js. Now kept per request; verified from a route, a page render and a
  server action.
- **Also fixed:** the check's row query sorted the event number as text ("100" before "95"), which
  raised a false tamper alarm whenever numbering gained a digit inside a check; a regression test
  forces the counter across a power of ten.

**Verified:** typecheck, lint on changed files; 769 unit tests (8 new: Merkle vectors, row and digest
hashing, key handling); `evidence.integration.test.ts` (11: capture with origin, numbers only;
append-only for app and administrator; tenant and clinical-key isolation; signed, anchored, chained
seals checked from the worker and the owner's page; in-flight writer; digit boundary; tampering with
a row, a row's hash, a removed or slipped-in row, a rewritten seal, a changed outside copy), 2 new request-context tests, and the
whole integration suite (317) on local Postgres with 0044; migration lint and re-run check; browser check
on the demo hospital (page, filters, Check now, seal signed with outside copy, phone width).
**Not applied to production:** 0044 is for the owner to apply (`npm run db:migrate:plan` first).
**Before production:** legal item L3 (staff monitoring policy) gates the evidence log going live;
generate the evidence key and keep the public half off the server; point `EVIDENCE_ANCHOR_DIR` at a
directory the S0 stack syncs to the Object Lock bucket. Events start from the migration: earlier
activity is in `audit_logs`, not in the log.
**Not done in A6-min:** the S3 anchor inside the app (needs the AWS SDK, decision D-STO), the KMS
key, stock and MAR events (B4a, B3-min), detectors and cases (B6), the quality-officer role (A4-full),
inclusion proofs for single-event exports (L6).

**A6 record History (10 Oct 2026, plan Rev 5.1), migration 0045:**
- For any record, its whole story from the evidence log: who made it, who changed or struck it
  through (with the reason the record holds), who opened it — each with role, ward tablet or own
  device, which device and session, when it happened and, if over two hours later, when it was
  written — and which hourly seal holds each step. A bedside item's history includes the bill line it
  posted; an admission's includes its bed moves.
- Page `/accountability/record/[type]/[id]`, owner only; opening it is recorded on the same record.
  Reached from every row of the Accountability list, a "History" link on each T.P.R. reading and
  each bedside entry, and a "History" button on the patient file.
- Index `acct_events_object_idx (hospital_id, object_id)` (0045). Records made before 0044 have no
  history; the page says so.
- **Plan Rev 5.1** (owner decisions): C4a test orders and lab follow-up comes after B4a; the
  not-arrived clock starts per lab (order or payment); the lab's assigned staff own the follow-up;
  calls only. Planned migration numbers moved: 0046 B4a, 0047 C4a, 0048 B3-min, 0049 B3b.

**Verified:** typecheck, lint; 770 unit tests; `evidence.integration.test.ts` (12, new: a reading's
story with makers, device, session, late writing and seals; a bedside item with its bill line;
another hospital sees nothing); migration lint and re-run check; browser check on the demo hospital
(links on readings and entries, History of a reading, an admission and a new bedside item).
