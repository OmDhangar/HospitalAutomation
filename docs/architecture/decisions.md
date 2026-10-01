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
