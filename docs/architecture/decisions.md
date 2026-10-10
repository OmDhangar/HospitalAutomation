# Decision log

Why the system is the way it is. Each entry records the decision, what it
replaced or ruled out, and what it costs. Add new ones at the bottom. Mark an
entry *superseded* rather than deleting it.

Codes like **D2** refer to the open questions in
[../plans/hms-expansion-plan.md §12](../plans/hms-expansion-plan.md).

---

### ADR-001 · One encounter row per episode of care
*Sept 2026 · Phase 1*

**Decision:** OPD visits, and later IPD stays, are one `encounters` row with a
`stage`. Bills, diagnoses and prescriptions all reference it. The encounter
points at the appointment; the appointment never points back.

**Instead of:** Separate OPD and IPD rows under a parent "episode", or hanging
prescriptions directly off `appointments`.

**Why:** One row means one answer to "which record does this bill belong to?".
The one-way link let billing and clinical modules ship with **no change to the
queue**. Hanging things off appointments would have broken for emergency
admissions, which have no token.

**Cost:** An extra join to reach the appointment. The encounter is created
lazily, so code must call `openEncounterForAppointmentInTx` rather than assume
it exists.

### ADR-002 · Billing is a ledger, even for the one-tap Paid toggle (D2)
*Sept 2026 · Phase 1*

**Decision:** Tapping Paid charges the doctor's fee as a `bill_items` row and
records a `patient_payments` row. Tapping Unpaid voids the payment.

**Instead of:** A `paid boolean` on appointments (about a week faster to build).

**Why:** The IPD discharge bill needs the OPD consultation on it. Payments need
amounts, methods and partial states. A boolean would have been a second source
of truth, plus a migration later.

**Cost:** Four tables in Phase 1 for what looks like a checkbox.

### ADR-003 · Money is integer paise; prices are copied onto bill lines
*Sept 2026 · Phase 1*

**Decision:** All money is integer paise. A bill line stores the configured
price, the charged price and the tax as they were when it was charged. The
server reads prices; the browser never sends them.

**Why:** Floats turn ₹10.00 into ₹9.99. An old bill must not change when the
price list does.

### ADR-004 · Correct by voiding, never by editing, enforced by triggers
*Sept 2026 · Phases 1–2*

**Decision:** Bill items, payments, diagnoses, notes and prescriptions can be
voided or superseded but not edited. Postgres triggers enforce this.

**Why:** A printed bill or prescription must be reproducible. A rule that only
lives in TypeScript is skipped by the first hand-written `UPDATE`.

**Cost:** Corrections create rows. DELETE is still allowed, because DPDP
erasure requires it.

### ADR-005 · Permission checks are one allow-list matrix
*Sept 2026 · Phase 0*

**Decision:** `lib/domain/permissions.ts` with `can(role, permission)`. No
`role !== 'x'` checks anywhere.

**Instead of:** Scattered role comparisons, three of which were negations that
would have given a future nurse or lab role access to Reports and the
reception desk.

**Why:** Adding a role must fail closed. The matrix is typed so a new role
doesn't compile until someone decides what it can do.

### ADR-006 · Only the owner sets prices; reception takes money
*Sept 2026 · Phase 1*

**Decision:** `billing.price` is owner-only. When a doctor has no fee yet, the
first Paid tap asks the owner for it. A receptionist is told to ask the owner.

**Supersedes:** The v1 plan, where the first Paid tap let *anyone* set the fee.

**Why:** Whoever collects money should not also decide the price (the medicine
billing spec, §10 and §40).

### ADR-007 · Phone number stays mandatory
*Sept 2026 · product decision*

**Decision:** Walk-ins always need a phone number. The optional address field
covers the "reach the family" case.

**Instead of:** A nullable phone with a "no phone" checkbox (plan v1).

**Why:** Product owner's call: the phone is central to identity, WhatsApp, and
duplicate detection.

### ADR-008 · Tenant-safe composite foreign keys
*Sept 2026 · Phase 1*

**Decision:** New child tables reference parents by `(hospital_id, id[, patient_id])`.

**Why:** Foreign-key checks ignore row-level security. This makes a
cross-hospital reference a constraint violation, not something every service
has to remember.

### ADR-009 · Prescriptions are separate from the catalogue and from billing
*Sept 2026 · Phase 2*

**Decision:** `medicines` (hospital catalogue, with price) → `prescriptions` +
`prescription_items` (clinical, no price, no quantity) → billing reads the
catalogue independently. Items copy the medicine name, strength and form.

**Instead of:** One table for prescribed, given and billed medicines.

**Why:** Prescribed ≠ dispensed ≠ billed. A prescription must stay valid
after a price change or a rename. Future pharmacy and IPD modules need each
concept on its own.

### ADR-010 · Every prescription item must come from the catalogue; doctors may add unpriced ones (D15)
*Sept 2026 · Phase 2*

**Decision:** `prescription_items.medicine_id` is required. If a medicine is
missing, the doctor adds it from the prescription screen, without a price. The
owner prices it later under Settings → Medicines → "No price yet".

**Why:** Free-text-only medicines would make inventory and billing impossible
later. Blocking the doctor would make them go back to paper.

### ADR-011 · Drafts live in their own table, outside the record
*Sept 2026 · Phase 2*

**Decision:** Autosave writes to `consultation_drafts` (mutable, versioned,
deleted at Save). Prescriptions are born `final`; there is no `draft` status on
them.

**Instead of:** A `draft → final` status on prescriptions (the spec's
suggestion).

**Why:** It gives the same guarantee, that a saved prescription never changes,
with less machinery. The clinical tables are append-only from their first row.
It also means diagnosis and notes autosave too, without mixing them into the
prescription. Drafts are kept on the server, not in `localStorage`, so a
shared desk computer doesn't hold patient notes after the tab closes.

### ADR-012 · Only the linked attending doctor writes a consultation (D16)
*Sept 2026 · Phase 2*

**Decision:** Writing needs `clinical.write` **and** the user must be the login
linked to the visit's doctor (`doctors.user_id`). Any clinical role may *read*,
and reads of history are logged.

**Why:** A prescription says who wrote it. That must be the person who was
signed in. The owner-doctor of a small hospital can write their own patients'
records, and nobody else's.

**Cost:** Each doctor must be linked to their login once, in Settings →
Doctors. When Phase 2 shipped, no doctor in production was linked yet.

**If the pilot says staff type prescriptions from paper:** change
`clinical.write` in the matrix and `writeRefusal()` in
`lib/services/consultations.ts`. Those are the only two places.

### ADR-013 · Medical records need a second key, which support sessions never get
*Sept 2026 · Phase 2*

**Decision:** Clinical tables have a restrictive `clinical_access` policy.
`withTenant(…, { clinical: true })` sets it, and it is refused whenever the
request is read-only, which every support session is.

**Why:** Turning a queue system into a medical record changes the privacy
stakes (DPDP Act). Reports, exports, public pages and support staff should see
no clinical rows by construction, not by everyone remembering.

### ADR-014 · The doctor's medicine search returns no prices
*Sept 2026 · Phase 2*

**Decision:** `/api/medicines/search` returns names only. `?priced=1` adds the
price, for roles that bill.

**Why:** Pricing is not part of a clinical decision (spec §41). Leaving the
field out of the response is stronger than hiding it in the UI.

### ADR-015 · Medicine search is a GET route, not a server action
*Sept 2026 · Phase 2*

**Decision:** Typeahead uses `fetch('/api/medicines/search')`.

**Why:** Next.js runs a page's server actions one at a time. A search would
queue behind an in-flight autosave, and a typeahead that lags a keystroke
feels broken.

### ADR-016 · Migrations are rehearsed on a scratch database first
*Sept 2026 · Phase 1*

**Decision:** `scripts/verify-migrations.mts` builds a throwaway database next to
the real one, applies every migration, and the integration suite runs against
it. Only then does `db:migrate` run for real.

**Why:** The database holds a live pilot hospital's data. This rehearsal caught
three real problems in Phase 1, including missing default privileges that would
have made the new tables invisible to the app.

### ADR-017 · Plan gating for clinical features is deferred
*Sept 2026 · Phase 2*

**Decision:** Prescriptions are available to every hospital for now. The
planned `has_clinical_records` / `has_lab` plan flags (D12) are not built yet.

**Why:** There is one pilot customer. Gating touches pricing tiers, custom
plans and the platform console, which is effort with no revenue until a second
tier exists. When it is built, a downgrade must block writes, never reads.

### ADR-018 · IPD capture is distributed and billed at the bedside
*Oct 2026 · IPD plan*

**Decision:** Nurses record medicines, consumables and procedures at the
bedside on a phone or tablet. Each entry becomes a server-priced bill line at
once, which reverses D20 (billing desk adds IPD items). The patient is
identified by tapping the bed on the ward grid; there are no bed QR codes or
wristbands. Reception enters the bed, payer and deposit on the admission sheet.
Common medicines, consumables, procedures, room charges and tests are loaded
unpriced when a hospital is created, so staff pick instead of typing and the
owner only enters prices. ABDM and prescription capture are not in the MVP.
Details: [../plans/ipd-mvp-implementation-plan.md](../plans/ipd-mvp-implementation-plan.md).

**Why:** Field feedback from doctors, administrators and staff (2 Oct 2026).
Billing at the desk from paper notes is where IPD charges get missed. Doctors
will not type prescriptions, and a nurse at the bedside will not type item
names. Scanning needs label printing and camera code before it pays off, and
the ward grid already shows who is in which bed.

### ADR-019 · Tokens are fixed; arrival, priority and late returns decide the order
*Oct 2026 · Queue and capacity*

**Decision:**
- **Fixed tokens.** A token number is a permanent booking identity, and nothing renumbers it.
- **One queue.** Every booking is WAITING; there is no separate arrival state (an `arrived_at` check-in was
  tried and removed in 0036 because it split the desk's line in two).
- **Next.** It calls the next WAITING patient in one order (`orderQueue` in `lib/domain/queue.ts`):
  1. Priority patients, first-come first-served by when priority was given (`priority_seq`).
  2. Everyone else by token.
- **Absence.** A patient who is not there when called is put on hold (Pause/Hold) and leaves the line. Resume
  (desk), "I'm back" (patient) or the timed auto-resume brings them back.
- **Late returns.** A patient whose turn has passed (token below the highest normal token already called) is placed behind the next N waiting patients (`queue_after_token`, `hospitals.late_rejoin_after_patients`). This covers a skipped or held patient who returns.
- **ETA.** It counts patients ahead on the same order, so the estimate and Next never disagree.
- **Doctor start.** `session_started_at` is written only by Start OPD.
  - Before it, estimates count from the scheduled start.
  - Once 15 minutes past the scheduled start, the patient page says "not started" instead of moving the time.
- **Daily quota (per doctor, optional).** Its parts:
  - Tokens 1..W are reserved for walk-ins.
  - A shared pool, numbered after the reserved range, is used by online bookings and further walk-ins.
  - Same-day online queue booking opens a set time before the scheduled start.
  - Releasing unused reserved capacity adds to the shared *count*, never hands out low numbers.
  - After the quota, only the owner can issue an EXTRA token, and only once total active appointments reach it.
  - The plan's daily capacity is not enforced during trials (`PLAN_CAPACITY_ENFORCED`).

**Why:**
- **Changing token numbers:** renumbering breaks patient trust, the unique index and every message already sent.
- **Ordering by booking time:** that let a remote booking from 7am hold the line against people standing in the corridor.
- **Absent patients:** handled by the existing hold/resume, not a second queue.
- **Priority:** it was ordered by enqueue time, so a later-prioritised patient could jump an earlier one.
- **Delay:** a recorded delay would have been added on top of a now-based wait for the rest of the day.

### ADR-020 · The serving order is shown as a call number, not a token
*Oct 2026 · Queue*

**Decision:**
- **Call number.** Each doctor-day issues a call number (1, 2, 3…) at the moment Next calls a patient
  (`appointments.call_number`, `doctor_day_states.last_call_number`).
- **Waiting patients.** They see the call number Next will give them. It comes from `projectedCallNumber` in
  `lib/domain/queue.ts`, which uses the same order as Next and the ETA.
- **Where it shows.** The dashboard, patient page, waiting-room TV and WhatsApp "currently serving" lead with
  the call number, with the token beside it.
- **Tokens.** They stay the permanent booking identity and are never renumbered.

**Why:** a token served first for a legitimate reason looked like it had jumped lower tokens. Examples are an
arrived later token, a priority patient and an emergency; for instance, "Now serving 31" with 29 and 30 waiting.
Call numbers only ever count up, so the order patients see is the order they are seen in.


### ADR-021 · IPD paper sheets ship as switchable modules from one registry
*Oct 2026 · IPD sheets plan §4*

**Decision:** Every new IPD capability (TPR chart, MAR, stock, accountability detectors, consents
and the rest) is a module declared once in `lib/modules/registry.ts`. Each hospital has a row per
module in `hospital_features` with a state (`on`, `read_only`, `off`), a rollout scope (all wards or
named wards) and a stage (`observe`, `warn`, `enforce`). Pages, route handlers and server actions
check the module on the server; a test fails if a module route skips the check. Tabs, print lists,
nav, checklists and reports are generated from the registry. Modules talk through small typed ports
and in-transaction events, never by importing each other's services. Turning a module off hides it
and blocks its API; it never deletes data, and the owner's whole-file print still includes old
records. A plan downgrade uses `read_only` (ADR-017).

**Why:** hospitals want different features, and rollout must go ward by ward with a way back. One
list avoids hand-maintained menus drifting from what the server allows.

### ADR-022 · Bed QR codes are back, and ward devices sign people in with a PIN (reverses D-ID, D-DV)
*Oct 2026 · IPD sheets plan §5*

**Decision:** Two staff access modes, both always available unless the owner turns one off per
role:
- **Ward device:** a tablet enrolled once by the owner stays enrolled (never signed out for being
  unused; ends on revoke or after 90 days without use). Each person unlocks it with their own
  4-digit PIN; the PIN session locks after 10 minutes idle and is capped at 24 hours. Switch user is
  always visible. Entries are attributed to the PIN-verified person, never the device.
- **Personal login:** password (TOTP for owners and admins). Clinical roles lock after 15 minutes
  idle and after 5 minutes in the background; the lock is held on the server.
- Every entry records the channel (`ward_device` or `personal`), device and session.
- Each bed gets a printable QR code that opens that bed's file after login. Risk-class medicines
  given from a personal phone need a bed or wristband scan.

**Why:** the pilot's main complaint is that there is no device where the work happens. D-ID (no
QR) and D-DV (no PIN, 2-3 Oct 2026) assumed every nurse would use her own phone; field feedback and
the drug-diversion problem (ADR-027) need both shared tablets and proof of presence.

### ADR-023 · Roles become configurable and scoped to branch, department and ward
*Oct 2026 · IPD sheets plan §4.3-4.4 (roadmap after the pilot slice)*

**Decision:** Move from the four-value `staff_role` enum to per-hospital roles built from templates,
assigned with a scope (branch, department or ward). Clinical tables carry `branch_id` with a
restrictive RLS policy. Break-glass access needs a reason, lasts 60 minutes and is reviewed. The old
`can(role, perm)` stays as a shim until a production shadow run shows no differences for two weeks
and a role x permission x scope matrix test passes for two releases; a flag switches back.

**Why:** multispecialty hospitals need ward- and department-level access, and new roles (lab,
pharmacist, quality officer) should not need enum migrations.

### ADR-024 · Clinical data moves to India (Mumbai), starting with a small S0 stack
*Oct 2026 · IPD sheets plan §9*

**Decision:** Move the database from Neon Singapore to India before the pilot's new IPD data is
created. Stage S0: the app on an India VPS and either the smallest managed PostgreSQL in Mumbai or
PostgreSQL on the VPS with WAL archiving; encrypted backups in S3 Mumbai with a copy in Hyderabad;
monthly restore drills. Cut over by logical replication with a short write pause that the offline
outbox absorbs. Move to S1, S2 and S3 at the triggers in the plan; contracts never promise more
uptime than the current stage supports (S0 99.0%, S1 99.5%, S2 99.9%).

**Why:** hospitals, auditors and schemes expect India residency, and the move is cheapest while the
data is small. Neon has no India region.

### ADR-025 · Migration runner v2: one migration per transaction, idempotent SQL, expand/contract
*Oct 2026 · IPD sheets plan §9.3-9.4*

**Decision:** Replace drizzle's `migrate()` (all pending migrations in one transaction) with a
runner that applies each migration in its own transaction with `lock_timeout`, supports
no-transaction files for `CREATE INDEX CONCURRENTLY`, and keeps the same `__drizzle_migrations`
history. New migrations must be idempotent and are run twice in CI. Changes are expand-only within a
release; backfills run in batches outside migrations; drops happen in a later contract release.

**Why:** at production size one long transaction holds locks across several migrations, and a
failure mid-way must be safe to re-run.

### ADR-026 · Doctor notes and orders: typed by the doctor, or transcribed and countersigned
*Oct 2026 · IPD sheets plan §1 (partly reverses ADR-018's "doctors will not type")*

**Decision:** A doctor may type notes and orders, or a nurse or RMO enters them as "told by Dr X".
A transcribed entry is flagged until the named doctor countersigns it with one tap; only that
doctor's linked login can countersign. Unsigned orders show their age (red after 24 hours).

**Why:** some doctors will not type, but orders must be digital for the MAR, time-critical alerts
and drug accountability.

### ADR-027 · Accountability: an append-only evidence log with anchored digests, and detectors that raise leads
*Oct 2026 · IPD sheets plan §7*

**Decision:** Every clinical, stock and due-outcome write, every login and PIN event, and every read
of accountability data is written to `acct_events`, which the application role can only insert and
select. Hourly Merkle digests are signed and copied to write-once storage (S3 Object Lock) that
neither the app nor hospital admins can rewrite; a verification job alerts on any mismatch.
Detectors run on a schedule, start in observe mode with a learning period, and raise flags for human
review. Flags are leads, never findings; staff can see and explain their own flags once a case is
opened. Quality-only signals (late time-critical doses) go to the nursing superintendent, not into
fraud cases.

**Why:** the pilot doctor reports fake medication entries used to divert drugs. Evidence has to be
trustworthy for everyone, including owners and us, and fair to staff.

### ADR-028 · Risk-class medicines need a witness, an order link and daily blind counts
*Oct 2026 · IPD sheets plan §7.2-7.3*

**Decision:** Each hospital keeps its own list of risk-class medicines. For them: a Given must link
to an active signed order; a second person witnesses give and waste, either on the shared ward
device with their own PIN or by approving a request in their own session (never by typing their PIN
on someone else's phone); stock is counted blind every day by someone who did not issue it, and
variances need a reason and a different approver. Each control rolls out observe, then warn, then
enforce.

**Why:** these are the standard controls against diversion, and NDPS and Schedule H1 records come
from the same ledger. Register formats stay "draft" until legal review confirms them.

### ADR-029 · MAR with a shared due engine and time-critical alerts
*Oct 2026 · IPD sheets plan §7.10, §8*

**Decision:** Orders become a MAR with due times. One pure due engine (`lib/domain/due.ts`, also run
on the phone) computes due instances for medicines and timed tasks from the order's clock times or
interval, a two-sided window and the late-dose policy (clock: keep; interval: shift). Only medicines
the hospital's doctor has signed off as time-critical alert; alerts are in-app only, escalate to the
ward in-charge and then the doctor on call, and never carry patient data in notifications. Future due
instances are computed, not stored; only outcomes and escalations are written.

**Why:** some injections (for example every 12 hours) must be given on time, and NABH expects a MAR.
Computing instances keeps writes low and keeps settings live without per-day copies.

### ADR-030 · Patient messages carry only a link; the PIN never travels on WhatsApp
*Oct 2026 · IPD sheets plan §16*

**Decision:** IPD sends at most two WhatsApp utility messages per admission: the family status link
(only with a signed family-sharing consent and opt-in) and the final-bill link. Message bodies hold
the hospital name and a link only, never a name, amount or diagnosis. The PIN is printed on the
admission or discharge slip. Each message is sent exactly once (`admission_messages` unique per
admission and kind). The old `/b` running-bill link is retired into the PIN-protected family page.
IPD messages are counted per admission, separately from the OPD canary.

**Why:** Meta bills every business message, and patient data must not sit in WhatsApp chats.

### ADR-031 · Per-request facts are kept per request, not only in AsyncLocalStorage
*10 Oct 2026 · found while building the evidence log (phase A6-min)*

**Decision:** The read-only flag, the staff user and the request's session, channel and device
(`lib/db/request-context.ts`) are stored in a record per web request, found by Next's per-request
`headers()` object (registered by `lib/auth/session.ts`). An explicit `withRequestContext` (tests,
the worker, scripts) still wins. The readers are async; `withTenant` reads them once, before it
opens its transaction. `getSessionState` and `getSession` re-mark the record in every caller.

**Why:** the facts used to be set with `AsyncLocalStorage.enterWith` deep inside session
resolution. Under Next.js that never reached the page, route or action that resolved the session,
and React's `cache()` hid it from every branch but the first. So no browser request carried its
session, channel or device (none was ever recorded on an entry or access-log row), its staff user
(the identity definer functions saw none), or — for a support session — its read-only flag at the
database (the app's own checks still refused writes). Tests passed because they always set the
context explicitly; `lib/db/__tests__/request-context.test.ts` now also covers the per-request path.
