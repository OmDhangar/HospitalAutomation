# Qurio clinical extension: data model and API design (Features 1–3)

> **v1 architecture draft: partly superseded by [hms-expansion-plan.md](hms-expansion-plan.md) v2, section 4.**
> The following are replaced:
> - nullable `phone_e164` and the walk-in idempotency key (phone stays mandatory);
> - `charges`, `invoices`, `invoice_lines`, `tariff_items`, `drug_catalog` and `medication_orders`;
> - `RESTRICT` on master-data FKs (v2 uses `NO ACTION`).
>
> Still authoritative:
> - findings §0 #2–#5;
> - the `restrict_update_to()` trigger;
> - the RLS / clinical-access approach;
> - the lab tables;
> - `admissions`, `clinical_notes`, `patient_payments`, `document_sequences` and `record_access_logs`.

I read every file in the brief and didn't modify anything. The design follows the codebase's own rules: database constraints over app logic, append-only history, amounts copied onto rows, tenant scoping on everything, and fail-closed RLS.

## 0. Findings that shape the design

1. **Clearing `patients.phone_e164` NOT NULL is safe, and no new index is needed.** The unique index `patients_hospital_phone_name_key (hospital_id, phone_e164, name)` is a normal NULLS DISTINCT index. `createWalkIn`'s `ON CONFLICT (hospital_id, phone_e164, name)` still infers it. A NULL phone never conflicts, so every phone-less walk-in inserts a new patient row, which is the right behaviour (see §1).
2. **Staff messages can't go through `notification_outbox`.** `drainOutbox` (lib/notify/worker.ts ~L122) inner-joins `patients` and `appointments`, and marks anything that doesn't match as `failed: orphaned`. `usage.ts` (~L122) counts every `sent` outbox row into `messages_sent`, and the circuit breaker (`shouldSuppressNonCriticalMessages`) reads that ratio. Staff messages in the outbox would inflate the margin canary and could suppress patient nudges.
3. **Existing role checks use negation, so new roles would leak.** `app/(app)/layout.tsx:33` has `role !== 'doctor'`, which shows Reports. `dashboard/page.tsx:45-57` renders the reception view for any non-doctor role. `PlanExpiryNotice` has the same pattern. `StaffRole` in lib/services/auth.ts:11 is typed by hand rather than derived from the enum. `canMutateQueue` is correctly written as a whitelist. All of these must be fixed before any `nurse` or `lab` user exists.
4. **An owner who is also a doctor has one role.** `staff_memberships` is unique on (user, hospital), so the pilot owner-doctor is `owner`. Clinical authorship (prescribe, admit, order labs) must therefore depend on "user is linked to an active `doctors` row" (`doctors.user_id`), not on `role = 'doctor'`.
5. **Foreign-key checks ignore RLS.** A client-supplied `encounterId` from another tenant would pass an FK check while `hospital_id` passes `WITH CHECK`. For the new tables I use composite FKs `(hospital_id, encounter_id) → encounters(hospital_id, id)` so the database enforces same-tenant references.
6. **Name clashes.** `payments` and the `payment_status` enum already exist for SaaS billing, and so does lib/domain/billing.ts. Patient-side money uses `patient_payments` and `patient-billing.ts`.
7. **Deleting a doctor cascades to their appointments** (`appointments.doctor_id ON DELETE cascade`). Clinical and billing FKs to `doctors` use `restrict`: records must survive, and doctors are deactivated, not deleted.
8. **Precedent not to copy:** `web-booking.ts:~296` sends an unmetered, un-outboxed WhatsApp to the owner's phone with the patient's name and phone, outside the transaction.
9. **Double-taps on phone-less walk-ins create duplicates.** The one-active-token-per-patient index is what makes a double-tapped walk-in harmless today. Phone-less walk-ins always insert a new patient, so a double-tap would create two patients and two tokens. They need an idempotency key.

---

## 1. Feature 1: walk-in address, phone-less patients, paid toggle

### Phone-less patients: make the column nullable (recommended)

| Option | Verdict |
|---|---|
| **Nullable `phone_e164`, keep the existing unique index, add a CHECK that consent requires a phone** | **Recommended.** No index change. The upsert keeps working for patients with phones. WhatsApp can't be targeted at a NULL. |
| Sentinel phone (e.g. `+910000000000`) | Rejected. Two unrelated "Ramesh" patients would merge through the unique key. There's a risk of messaging a real number. It pollutes reports. |
| Separate `unidentified_patients` table | Rejected. `appointments.patient_id` is NOT NULL to `patients`, so this would fork every query. |

- Add `CHECK (phone_e164 IS NOT NULL OR whatsapp_opt_in_at IS NULL)`. The NOT NULL used to guarantee this invariant implicitly; the CHECK now guarantees it explicitly. Because the CTE only inserts a `queue_link` outbox row when `whatsapp_opt_in_at IS NOT NULL`, a phone-less patient can never enter the outbox.
- `createWalkIn` forces `optedIn = false` when there's no phone. Add a defensive guard in the worker (`if (!row.phoneE164)` → failed `no_phone`).
- Deduplication: each phone-less walk-in is a new patient. You can't safely deduplicate "unknown male, ~40" by name. Adding a phone later goes through `updatePatientContact`. If that phone+name already exists, it returns a `duplicate_patient` error; a merge tool comes later.
- The printed QR and public token still work, so queue behaviour is unchanged.

### Address: on `patients`

- `patients.address text` (max 500 characters, CHECK). The latest value wins, using `coalesce` on upsert like age and gender.
- Why here and not on the encounter: Feature 1 is ungated, so it has to work for hospitals without the clinical tier, and those have no encounter. Phone-less patients are always new rows anyway. For repeat patients with a phone, "current address" is what contact needs.
- The historical address that matters legally is the one on the bill, and `invoices` snapshots it (§2). Per-visit emergency-contact address can be added later as an `encounters.contact_*` column without restructuring.

### Payment status: a ledger with a one-tap toggle (recommended over a boolean)

Honest trade-off:
- **A boolean `appointments.paid_at`** takes a day to build. But it records no amount, the discharge bill can't include the OPD fee, and we'd end up with two sources of truth for "paid" plus a migration later.
- **The ledger:** tapping Paid runs one transaction that
  - (a) ensures an encounter exists for the appointment (lazy, idempotent through a unique index),
  - (b) ensures one consultation `charges` row (unique on `appointment_id` where not voided),
  - (c) inserts a `patient_payments` row for the outstanding balance, default method cash.
  
  Tapping Unpaid **voids** that payment; nothing is deleted. The badge is derived as `sum(charges) − sum(payments)` → Paid / Partial / Unpaid. It costs four small tables in Phase 1, and they are the same tables the discharge bill uses.

**Recommendation: the ledger.** It is still a one-tap toggle in the UI. The consultation fee comes from `tariff_items` (one per doctor), so nothing changes on `doctors`. Without `appointments` changes, the queue core stays untouched. The badge is read by a separate `getPaymentStatuses(tx, appointmentIds)` merged in `dashboard-loader.ts`, so `loadDayAppointments` doesn't change either.

---

## 2. Feature 2: the encounter spine (OPD → IPD → discharge)

### Model decision
- **One `encounters` row per episode of care.** It has a `stage` (`opd` → `ipd`, the highest care setting reached) and a `status` (`open`/`closed`/`cancelled`, which is clinical closure). Financial settlement is derived from the ledger, not from status.
- **IPD facts go in a 1:1 `admissions` sidecar.** This keeps OPD-only encounters free of null columns. Beds attach to `admissions` later. The census query is `admissions WHERE discharged_at IS NULL`.
- **Rejected: separate OPD and IPD rows under a parent episode.** It doubles joins and makes "which row does the bill hang off" ambiguous. That is the restructuring we're trying to avoid.
- **Link to appointments:** `encounters.appointment_id` is nullable and unique where not null. The encounter is created lazily when a doctor opens the record or someone taps Paid. Emergency or direct admissions have `appointment_id = NULL` and `origin = 'emergency' | 'direct'`. Appointments, queue_events and the state machine are untouched.
- **Follow-up OPD visits are new encounters.** The patient view lists every encounter. A `parent_encounter_id` can be added later if "episode of care" grouping is ever needed. I'm not carrying that shape speculatively.
- **OPD closure:** a nightly job in `sweeps.ts` closes OPD encounters from earlier service dates that were never admitted. This isn't tied to appointment completion, so the queue stays independent.

### Clinical entries: typed where billing or queries need structure, generic where it's text
- **Generic:** `clinical_notes` (visit reason, examination, progress, admission note, discharge summary, and vitals as text for now) is append-only.
- **Typed:** `medication_orders` (prescription), `medication_administrations` (what was given, and billable), `treatments` (billable procedures), and the lab tables. There is no EAV.
- **Short header fields are editable columns:** `encounters.chief_complaint` and `admissions.admission_reason`, because lists and the census display them. Every edit writes an `audit_logs` row with the old value.

### Corrections: amend, don't delete
Clinical and money rows allow **only** a one-way void (`voided_at/by/reason`) plus a few named state columns. A generic trigger enforces this:
```sql
CREATE FUNCTION restrict_update_to() RETURNS trigger AS $fn$
BEGIN
  -- TG_ARGV lists the columns this table lets change; everything else is frozen.
  IF (to_jsonb(NEW) - TG_ARGV) IS DISTINCT FROM (to_jsonb(OLD) - TG_ARGV) THEN
    RAISE EXCEPTION '% permits updates only to %', TG_TABLE_NAME, TG_ARGV
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF (to_jsonb(OLD)->>'voided_at') IS NOT NULL AND (to_jsonb(NEW)->>'voided_at') IS NULL THEN
    RAISE EXCEPTION 'a void cannot be undone' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;
-- e.g. CREATE TRIGGER clinical_notes_amend_only BEFORE UPDATE ON clinical_notes
--   FOR EACH ROW EXECUTE FUNCTION restrict_update_to('voided_at','voided_by_user_id','void_reason');
```
- **Amending** = void the old row and insert a new row with `supersedes_id`.
- **DELETE stays permitted**, matching 0001: erasure is a DPDP obligation and hospital offboarding cascades.

### Schema (abbreviated Drizzle)
```ts
// shared helpers
const hospitalFk = () => uuid('hospital_id').notNull().references(() => hospitals.id, { onDelete: 'cascade' });
const voidCols = () => ({
  voidedAt: timestamp('voided_at', { withTimezone: true }),
  voidedByUserId: uuid('voided_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  voidReason: text('void_reason'),
});
/** Same-tenant reference, enforced by the database (FK checks ignore RLS). */
const encounterRef = (t) => foreignKey({ columns: [t.hospitalId, t.encounterId],
  foreignColumns: [encounters.hospitalId, encounters.id] }).onDelete('cascade');

export const staffRole = pgEnum('staff_role', ['owner', 'receptionist', 'doctor', 'nurse', 'lab']);
export const encounterStage = pgEnum('encounter_stage', ['opd', 'ipd']);
export const encounterStatus = pgEnum('encounter_status', ['open', 'closed', 'cancelled']);
export const encounterOrigin = pgEnum('encounter_origin', ['queue', 'emergency', 'direct']);
export const clinicalNoteKind = pgEnum('clinical_note_kind', ['visit_reason', 'examination', 'general',
  'progress', 'admission', 'vitals', 'discharge_summary']);
export const medicationOrderStatus = pgEnum('medication_order_status', ['active', 'stopped', 'completed']);
export const dischargeType = pgEnum('discharge_type', ['recovered', 'referred', 'lama', 'death', 'other']);
export const chargeKind = pgEnum('charge_kind', ['consultation', 'medication', 'lab_test', 'treatment',
  'bed_day', 'service', 'misc']);
export const patientPaymentMethod = pgEnum('patient_payment_method', ['cash', 'upi', 'card', 'bank', 'insurance', 'other']);
export const patientPaymentKind = pgEnum('patient_payment_kind', ['payment', 'refund']);
export const invoiceStatus = pgEnum('invoice_status', ['final', 'cancelled']);

/* patients: the only changed tenant table */
phoneE164: text('phone_e164'),          // NOT NULL dropped
address: text('address'),               // + CHECK consent_needs_phone, CHECK length(address) <= 500

/**
 * The price master for services that have no domain catalog of their own
 * (consultation, procedures, bed-day, nursing). Drugs and lab tests carry
 * their price on their own catalogs. A price change here never rewrites
 * history, because every charge copies the price it was billed at.
 */
export const tariffItems = pgTable('tariff_items', {
  id: id(), hospitalId: hospitalFk(),
  kind: chargeKind('kind').notNull(),
  code: text('code'), name: text('name').notNull(),
  doctorId: uuid('doctor_id').references(() => doctors.id, { onDelete: 'restrict' }), // per-doctor consult fee
  unitPricePaise: integer('unit_price_paise').notNull(),
  hsnSacCode: text('hsn_sac_code'),                          // GST-ready, unused until registered
  taxRateBp: integer('tax_rate_bp').notNull().default(0),    // basis points: 1800 = 18%
  active: boolean('active').notNull().default(true), createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [
  uniqueIndex('tariff_items_one_consult_fee_per_doctor').on(t.hospitalId, t.doctorId)
    .where(sql`kind = 'consultation' and active`),
  index('tariff_items_kind_idx').on(t.hospitalId, t.kind),
]);

/**
 * The patient journey. OPD, IPD, lab and billing all hang off this row; a
 * queue appointment is one possible *origin*, never a requirement.
 */
export const encounters = pgTable('encounters', {
  id: id(), hospitalId: hospitalFk(),
  branchId: uuid('branch_id').notNull().references(() => branches.id, { onDelete: 'restrict' }),
  patientId: uuid('patient_id').notNull().references(() => patients.id, { onDelete: 'cascade' }),
  appointmentId: uuid('appointment_id').references(() => appointments.id, { onDelete: 'set null' }),
  attendingDoctorId: uuid('attending_doctor_id').notNull().references(() => doctors.id, { onDelete: 'restrict' }),
  origin: encounterOrigin('origin').notNull(),
  stage: encounterStage('stage').notNull().default('opd'),
  status: encounterStatus('status').notNull().default('open'),
  chiefComplaint: text('chief_complaint'),
  openedByUserId: uuid('opened_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
  closedAt: timestamp('closed_at', { withTimezone: true }),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [
  uniqueIndex('encounters_hospital_id_key').on(t.hospitalId, t.id),          // target of composite FKs
  uniqueIndex('encounters_appointment_key').on(t.appointmentId).where(sql`appointment_id is not null`),
  index('encounters_patient_idx').on(t.patientId, t.openedAt),
  index('encounters_open_idx').on(t.hospitalId, t.branchId, t.stage).where(sql`status = 'open'`),
  check('encounters_closed_at', sql`(status = 'open') = (closed_at is null)`),
]);

/** IPD facts, 1:1 with the encounter. Beds attach here later via bed_assignments(admission_id). */
export const admissions = pgTable('admissions', {
  id: id(), hospitalId: hospitalFk(), encounterId: uuid('encounter_id').notNull(),
  admittingDoctorId: uuid('admitting_doctor_id').notNull().references(() => doctors.id, { onDelete: 'restrict' }),
  admissionReason: text('admission_reason').notNull(),
  wardLabel: text('ward_label'),          // free text until wards/beds exist
  admittedAt: timestamp('admitted_at', { withTimezone: true }).notNull(),
  admittedByUserId: uuid('admitted_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  dischargedAt: timestamp('discharged_at', { withTimezone: true }),
  dischargeType: dischargeType('discharge_type'),
  dischargedByUserId: uuid('discharged_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [encounterRef(t),
  uniqueIndex('admissions_encounter_key').on(t.encounterId),
  index('admissions_census_idx').on(t.hospitalId, t.admittedAt).where(sql`discharged_at is null`),
  check('admissions_discharge_complete', sql`(discharged_at is null) = (discharge_type is null)`),
]);

/** Append-only clinical text. Corrections void and supersede; nothing is rewritten. */
export const clinicalNotes = pgTable('clinical_notes', {
  id: id(), hospitalId: hospitalFk(), encounterId: uuid('encounter_id').notNull(),
  kind: clinicalNoteKind('kind').notNull(),
  body: text('body').notNull(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(), // charting is often late
  authorUserId: uuid('author_user_id').references(() => users.id, { onDelete: 'set null' }),
  authorRole: staffRole('author_role').notNull(),   // a receptionist's progress note reads differently from a doctor's
  supersedesId: uuid('supersedes_id'),               // self-FK in SQL
  ...voidCols(), createdAt: createdAt(),
}, (t) => [encounterRef(t), index('clinical_notes_encounter_idx').on(t.encounterId, t.occurredAt)]);

/**
 * Per-hospital drug master. Optional from day one: every order and
 * administration stores `drug_name` as a snapshot and `drug_catalog_id` only
 * when matched. Free text therefore never blocks a catalog, and a later
 * backfill only fills the id (the one column the update trigger allows).
 */
export const drugCatalog = pgTable('drug_catalog', {
  id: id(), hospitalId: hospitalFk(),
  name: text('name').notNull(), genericName: text('generic_name'),
  form: text('form'), strength: text('strength'),
  billingUnit: text('billing_unit').notNull().default('unit'),  // tablet, vial, ml
  unitPricePaise: integer('unit_price_paise'),                    // null = unpriced
  hsnCode: text('hsn_code'), taxRateBp: integer('tax_rate_bp').notNull().default(0),
  sku: text('sku'),                                               // pharmacy inventory joins here later
  active: boolean('active').notNull().default(true), createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [uniqueIndex('drug_catalog_name_key').on(t.hospitalId, sql`lower(name)`, sql`coalesce(strength,'')`, sql`coalesce(form,'')`)]);

/** What was *prescribed*. Never billed: the bill needs what was given or dispensed. */
export const medicationOrders = pgTable('medication_orders', {
  id: id(), hospitalId: hospitalFk(), encounterId: uuid('encounter_id').notNull(),
  drugCatalogId: uuid('drug_catalog_id').references(() => drugCatalog.id, { onDelete: 'set null' }),
  drugName: text('drug_name').notNull(),
  dose: text('dose').notNull(), route: text('route'),
  frequency: text('frequency').notNull(),        // '1-0-1', 'BD', 'q8h': Indian convention, kept as text
  durationDays: smallint('duration_days'), instructions: text('instructions'),
  setting: encounterStage('setting').notNull(),  // OPD Rx vs IPD order: different print and summary
  prescriberDoctorId: uuid('prescriber_doctor_id').notNull().references(() => doctors.id, { onDelete: 'restrict' }),
  enteredByUserId: uuid('entered_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  status: medicationOrderStatus('status').notNull().default('active'),
  stoppedAt: timestamp('stopped_at', { withTimezone: true }), stopReason: text('stop_reason'),
  supersedesId: uuid('supersedes_id'),           // dose change = stop + new linked order
  ...voidCols(), createdAt: createdAt(),
}, (t) => [encounterRef(t), index('medication_orders_encounter_idx').on(t.encounterId, t.createdAt),
  index('medication_orders_active_idx').on(t.encounterId).where(sql`status = 'active' and voided_at is null`)]);
// trigger allows: status, stopped_at, stop_reason, drug_catalog_id, void cols

/** What was *given*. The billable fact until a pharmacy module bills dispensations instead. */
export const medicationAdministrations = pgTable('medication_administrations', {
  id: id(), hospitalId: hospitalFk(), encounterId: uuid('encounter_id').notNull(),
  medicationOrderId: uuid('medication_order_id').references(() => medicationOrders.id, { onDelete: 'restrict' }), // null = stat/PRN
  drugCatalogId: uuid('drug_catalog_id').references(() => drugCatalog.id, { onDelete: 'set null' }),
  drugName: text('drug_name').notNull(),
  doseGiven: text('dose_given').notNull(), route: text('route'),
  billableQuantity: integer('billable_quantity').notNull().default(1),   // CHECK >= 0; units of billing_unit
  administeredAt: timestamp('administered_at', { withTimezone: true }).notNull(),
  administeredByUserId: uuid('administered_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  notes: text('notes'), ...voidCols(), createdAt: createdAt(),
}, (t) => [encounterRef(t), index('med_admin_encounter_idx').on(t.encounterId, t.administeredAt)]);

/** Treatments/procedures performed (dressing, nebulisation, O2 hours). Billable. */
export const treatments = pgTable('treatments', {
  id: id(), hospitalId: hospitalFk(), encounterId: uuid('encounter_id').notNull(),
  tariffItemId: uuid('tariff_item_id').references(() => tariffItems.id, { onDelete: 'set null' }),
  name: text('name').notNull(), quantity: integer('quantity').notNull().default(1),
  performedAt: timestamp('performed_at', { withTimezone: true }).notNull(),
  performedByUserId: uuid('performed_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  notes: text('notes'), ...voidCols(), createdAt: createdAt(),
}, (t) => [encounterRef(t), index('treatments_encounter_idx').on(t.encounterId, t.performedAt)]);

/**
 * The ledger every billable source writes to. Sources are typed nullable FKs,
 * not (source_type, source_id): Postgres then guarantees the source exists,
 * and a partial unique index per source makes "bill this once" a database
 * fact, so a retried completion cannot double-bill. A new source is one
 * deliberate column and index (dispensation_id, bed_assignment_id +
 * service_date), not a restructure.
 */
export const charges = pgTable('charges', {
  id: id(), hospitalId: hospitalFk(), encounterId: uuid('encounter_id').notNull(),
  kind: chargeKind('kind').notNull(),
  description: text('description').notNull(),                   // snapshot
  tariffItemId: uuid('tariff_item_id').references(() => tariffItems.id, { onDelete: 'set null' }),
  appointmentId: uuid('appointment_id').references(() => appointments.id, { onDelete: 'set null' }),     // consult fee
  medicationAdministrationId: uuid('medication_administration_id').references(() => medicationAdministrations.id, { onDelete: 'restrict' }),
  treatmentId: uuid('treatment_id').references(() => treatments.id, { onDelete: 'restrict' }),
  labOrderItemId: uuid('lab_order_item_id').references(() => labOrderItems.id, { onDelete: 'restrict' }),
  quantity: integer('quantity').notNull().default(1),
  unitPricePaise: integer('unit_price_paise'),                  // null = unpriced; blocks invoice finalisation
  discountPaise: integer('discount_paise').notNull().default(0),
  amountPaise: integer('amount_paise').generatedAlwaysAs(sql`quantity * unit_price_paise - discount_paise`),
  taxRateBp: integer('tax_rate_bp').notNull().default(0), taxPaise: integer('tax_paise').notNull().default(0),
  hsnSacCode: text('hsn_sac_code'),
  serviceDate: date('service_date').notNull(),
  invoiceId: uuid('invoice_id'),                                // set at finalisation (Phase 5)
  createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  ...voidCols(), createdAt: createdAt(),
}, (t) => [encounterRef(t),
  check('charges_one_source', sql`num_nonnulls(appointment_id, medication_administration_id, treatment_id, lab_order_item_id) <= 1`),
  uniqueIndex('charges_appointment_once').on(t.appointmentId).where(sql`appointment_id is not null and voided_at is null`),
  uniqueIndex('charges_med_admin_once').on(t.medicationAdministrationId).where(sql`medication_administration_id is not null and voided_at is null`),
  uniqueIndex('charges_treatment_once').on(t.treatmentId).where(sql`treatment_id is not null and voided_at is null`),
  uniqueIndex('charges_lab_item_once').on(t.labOrderItemId).where(sql`lab_order_item_id is not null and voided_at is null`),
  index('charges_encounter_idx').on(t.encounterId).where(sql`voided_at is null`),
]);
// trigger allows: unit_price_paise (only while null), invoice_id, void cols; void refused once invoice_id is set

/** Money in. Not `payments`: that table is the SaaS subscription. Deposits are payments before any invoice. */
export const patientPayments = pgTable('patient_payments', {
  id: id(), hospitalId: hospitalFk(), encounterId: uuid('encounter_id').notNull(),
  invoiceId: uuid('invoice_id').references(() => invoices.id, { onDelete: 'restrict' }),
  kind: patientPaymentKind('kind').notNull().default('payment'),
  amountPaise: integer('amount_paise').notNull(),               // CHECK > 0; sign comes from kind
  method: patientPaymentMethod('method').notNull().default('cash'),
  reference: text('reference'),                                  // UPI txn id etc.
  provider: text('provider'), providerPaymentId: text('provider_payment_id'), // gateway later; partial unique
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  receivedByUserId: uuid('received_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  ...voidCols(), createdAt: createdAt(),
}, (t) => [encounterRef(t), index('patient_payments_encounter_idx').on(t.encounterId).where(sql`voided_at is null`)]);

/**
 * The bill as issued: a snapshot, reproducible after any price or name
 * change. Drafts are never stored: the pre-discharge "provisional bill" is
 * computed live from charges.
 */
export const invoices = pgTable('invoices', {
  id: id(), hospitalId: hospitalFk(),
  encounterId: uuid('encounter_id').notNull(),   // composite FK, ON DELETE RESTRICT (retention: see §6)
  invoiceNumber: text('invoice_number').notNull(), fiscalYear: text('fiscal_year').notNull(),
  status: invoiceStatus('status').notNull().default('final'),
  patientName: text('patient_name').notNull(), patientAddress: text('patient_address'),
  patientPhone: text('patient_phone'), doctorName: text('doctor_name').notNull(),
  admittedAt: timestamp('admitted_at', { withTimezone: true }), dischargedAt: timestamp('discharged_at', { withTimezone: true }),
  subtotalPaise: integer('subtotal_paise').notNull(), discountPaise: integer('discount_paise').notNull(),
  taxPaise: integer('tax_paise').notNull(), totalPaise: integer('total_paise').notNull(),
  issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
  issuedByUserId: uuid('issued_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  cancelledAt: timestamp('cancelled_at', { withTimezone: true }), cancelReason: text('cancel_reason'),
  supersedesInvoiceId: uuid('supersedes_invoice_id'),
}, (t) => [uniqueIndex('invoices_number_key').on(t.hospitalId, t.invoiceNumber),
  index('invoices_encounter_idx').on(t.encounterId)]);
// trigger allows only status 'final' -> 'cancelled' (+ cancelled_at, cancel_reason)

export const invoiceLines = pgTable('invoice_lines', {
  id: id(), hospitalId: hospitalFk(),
  invoiceId: uuid('invoice_id').notNull().references(() => invoices.id, { onDelete: 'cascade' }),
  chargeId: uuid('charge_id').references(() => charges.id, { onDelete: 'set null' }),
  kind: chargeKind('kind').notNull(), description: text('description').notNull(), serviceDate: date('service_date').notNull(),
  quantity: integer('quantity').notNull(), unitPricePaise: integer('unit_price_paise').notNull(),
  discountPaise: integer('discount_paise').notNull(), taxRateBp: integer('tax_rate_bp').notNull(),
  taxPaise: integer('tax_paise').notNull(), amountPaise: integer('amount_paise').notNull(),
  hsnSacCode: text('hsn_sac_code'), sortOrder: smallint('sort_order').notNull(),
}, (t) => [index('invoice_lines_invoice_idx').on(t.invoiceId)]);   // fully append-only (reject_history_update)

/** Gap-free numbering per series and fiscal year (a GST requirement). Locked like doctor_day_states. */
export const documentSequences = pgTable('document_sequences', {
  id: id(), hospitalId: hospitalFk(), series: text('series').notNull(),   // 'INV', later 'RCPT', 'CN'
  fiscalYear: text('fiscal_year').notNull(), lastNumber: integer('last_number').notNull().default(0),
}, (t) => [uniqueIndex('document_sequences_key').on(t.hospitalId, t.series, t.fiscalYear)]);

/** Who opened whose record. Append-only; one row per (user, encounter) per 15 minutes. */
export const recordAccessLogs = pgTable('record_access_logs', {
  id: id(), hospitalId: hospitalFk(),
  actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
  patientId: uuid('patient_id').notNull().references(() => patients.id, { onDelete: 'cascade' }),
  encounterId: uuid('encounter_id').references(() => encounters.id, { onDelete: 'cascade' }),
  action: text('action').notNull(),          // view_record | print_rx | print_bill | export
  createdAt: createdAt(),
}, (t) => [index('record_access_patient_idx').on(t.patientId, t.createdAt),
  index('record_access_hospital_idx').on(t.hospitalId, t.createdAt)]);
```

### Billing mechanics
- **Locking:** every encounter mutation (payment, admission, discharge, invoice) begins with `SELECT … FROM encounters WHERE id = $1 FOR UPDATE`. That serialises per encounter, the way `doctor_day_states` serialises per queue. It is what makes the Paid toggle safe against two receptionists tapping at once.
- **Balance:** `Σ amount(charges, not voided) − Σ(payments − refunds, not voided)`. This is pure in `lib/domain/patient-billing.ts`, integer paise throughout, and tested exhaustively like `lib/domain/billing.ts`.
- **Finalise:** lock the encounter. Refuse if any line is unpriced. Take the next number from `document_sequences` with an upsert returning `last_number`. Snapshot the patient, doctor and dates. Copy the uninvoiced charges into `invoice_lines` and set `charges.invoice_id`. If there are no uninvoiced charges, it's a no-op that returns the latest invoice, which makes it idempotent. Charges added later produce a supplementary invoice. Cancelling an invoice clears `invoice_id` on its charges (credit notes come later).
- **Insurance/TPA later:** add `encounter_payers` and `claims`. Payments with `method = 'insurance'` gain a `claim_id`. Split billing adds `invoices.payer_id`. None of this requires restructuring.
- **Beds later:** `wards`, `beds (tariff_item_id)`, `bed_assignments (admission_id, bed_id, from, to)` with a partial unique index on (bed_id) where `to` is null. A nightly job adds `charges.bed_assignment_id` plus a unique index on (bed_assignment_id, service_date).
- **Pharmacy later:** `stock_items`, `stock_movements`, `dispensations (medication_order_id, drug_catalog_id, qty, batch)` and `charges.dispensation_id`. A hospital setting switches the medication charge source from administration to dispensation.

---

## 3. Feature 3: lab referral and notification

```ts
export const labItemStatus = pgEnum('lab_item_status', ['ordered', 'sample_collected', 'in_progress', 'resulted', 'cancelled']);
export const labPriority = pgEnum('lab_priority', ['routine', 'urgent']);
export const resultFlag = pgEnum('lab_result_flag', ['normal', 'low', 'high', 'abnormal', 'critical']);

export const labTestCatalog = pgTable('lab_test_catalog', {
  id: id(), hospitalId: hospitalFk(),
  code: text('code'), name: text('name').notNull(), department: text('department'),
  sampleType: text('sample_type'), turnaroundHours: smallint('turnaround_hours'),
  pricePaise: integer('price_paise'), hsnSacCode: text('hsn_sac_code'), taxRateBp: integer('tax_rate_bp').notNull().default(0),
  active: boolean('active').notNull().default(true), createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [uniqueIndex('lab_test_catalog_name_key').on(t.hospitalId, sql`lower(name)`)]);
// Panels (CBC -> analytes) later: lab_test_components(test_id, analyte, unit, ref_range); results gain component_id.

/** One doctor request = one order = one notification unit. */
export const labOrders = pgTable('lab_orders', {
  id: id(), hospitalId: hospitalFk(), encounterId: uuid('encounter_id').notNull(),
  branchId: uuid('branch_id').notNull().references(() => branches.id, { onDelete: 'restrict' }),
  orderingDoctorId: uuid('ordering_doctor_id').notNull().references(() => doctors.id, { onDelete: 'restrict' }),
  orderedByUserId: uuid('ordered_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  priority: labPriority('priority').notNull().default('routine'),
  clinicalNote: text('clinical_note'),
  createdAt: createdAt(),
}, (t) => [encounterRef(t), index('lab_orders_encounter_idx').on(t.encounterId)]);

export const labOrderItems = pgTable('lab_order_items', {
  id: id(), hospitalId: hospitalFk(),
  labOrderId: uuid('lab_order_id').notNull().references(() => labOrders.id, { onDelete: 'cascade' }),
  encounterId: uuid('encounter_id').notNull(),          // denormalised: record view and charges read by encounter
  labTestId: uuid('lab_test_id').references(() => labTestCatalog.id, { onDelete: 'set null' }),
  testName: text('test_name').notNull(),                 // snapshot; free text allowed
  reason: text('reason').notNull(),                      // "what's needed and why", per test
  status: labItemStatus('status').notNull().default('ordered'),
  sampleCollectedAt: timestamp('sample_collected_at', { withTimezone: true }), sampleCollectedByUserId: uuid('sample_collected_by_user_id'),
  startedAt: timestamp('started_at', { withTimezone: true }),
  resultedAt: timestamp('resulted_at', { withTimezone: true }), resultedByUserId: uuid('resulted_by_user_id'),
  cancelledAt: timestamp('cancelled_at', { withTimezone: true }), cancelReason: text('cancel_reason'),
  acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),   // doctor saw the result: closes the loop
  acknowledgedByUserId: uuid('acknowledged_by_user_id'),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [encounterRef(t),
  index('lab_items_worklist_idx').on(t.hospitalId, t.status, t.createdAt)
    .where(sql`status in ('ordered','sample_collected','in_progress')`),
  index('lab_items_unacked_idx').on(t.hospitalId, t.resultedAt).where(sql`status = 'resulted' and acknowledged_at is null`),
  index('lab_items_order_idx').on(t.labOrderId), index('lab_items_encounter_idx').on(t.encounterId),
  check('lab_items_resulted_at', sql`(status = 'resulted') = (resulted_at is not null)`),
  check('lab_items_cancelled', sql`(status = 'cancelled') = (cancelled_at is not null)`),
]);

/** Append-only. Amended results void and supersede, and the history stays visible. */
export const labResults = pgTable('lab_results', {
  id: id(), hospitalId: hospitalFk(),
  labOrderItemId: uuid('lab_order_item_id').notNull().references(() => labOrderItems.id, { onDelete: 'cascade' }),
  valueText: text('value_text'), valueNumeric: numeric('value_numeric'), unit: text('unit'),
  referenceRange: text('reference_range'), flag: resultFlag('flag'), notes: text('notes'),
  // attachmentId later -> attachments(id, storage_key, mime, sha256)
  recordedByUserId: uuid('recorded_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
  supersedesId: uuid('supersedes_id'), ...voidCols(),
}, (t) => [index('lab_results_item_idx').on(t.labOrderItemId, t.recordedAt),
  check('lab_results_has_value', sql`value_text is not null or value_numeric is not null`)]);
```

- **Lifecycle:** pure transitions in `lib/domain/lab.ts`, mirroring `lib/domain/queue.ts`:
  - `ordered` → `sample_collected` → `in_progress` → `resulted`
  - `cancelled` is reachable from any state before `resulted`.
  - `resulted` is only reachable inside the transaction that inserts the first `lab_results` row.
- **Charging:** one function, `chargeLabItem(tx, item)`, inserts a charge with `lab_order_item_id` at a single configured transition. The partial unique index makes it idempotent. Cancelling voids the charge, provided it isn't on a final invoice. The brief says "on completion"; I recommend charging at order time (see open decisions).
- **Notifications, default in-app:** the `/lab` worklist page uses the existing `components/auto-refresh.tsx` (about every 15 seconds, paused when the tab is hidden). It groups items by order, shows patient name and age, the tests, the per-test reason and a priority badge, and plays the existing call chime when the count of new `ordered` items goes up. The "last seen" marker is kept client-side, so no notification table is needed. Doctors get a "results to review" badge from `lab_items_unacked_idx`.
- **WhatsApp to lab staff: optional, Phase 4b, separately metered.** It doesn't fit the outbox, for the reasons in §0 #2. It would use a new `staff_notification_outbox` with:
  - columns `recipient_user_id` and `lab_order_id`;
  - a dedup unique index on `(lab_order_id, recipient_user_id, kind)`;
  - a separate drain function that reuses `getProvider()`;
  - its own count on the platform dashboard, never included in `messages_sent`.
  
  It also needs a recipient phone, which is a later change to an existing table (`staff_memberships.notify_phone_e164`). The payload must carry **no patient identifiers or reasons**, only "2 new lab orders (1 urgent) – open Qurio", because health data shouldn't go to personal phones.

---

## 4. Roles, permissions, RLS, entitlements

**Roles:** add `nurse` and `lab` to `staff_role`. Derive the `StaffRole` TypeScript type from `staffRole.enumValues`. Fix the three negation checks (§0 #3) and the `ROLES` list in admin actions and settings labels. Put a pure `lib/domain/permissions.ts` `can(actor, action)` behind a tested matrix. Here **Clinician** means a user linked to an active `doctors` row, whatever their role.

| Action | Owner | Reception | Doctor | Nurse | Lab |
|---|---|---|---|---|---|
| Queue and walk-in (unchanged) | ✓ | ✓ | ✓ | – | – |
| Toggle paid, record payment or deposit | ✓ | ✓ | ✓ | – | – |
| View patient record | ✓ | ✓ | ✓ | ✓ | lab view only* |
| Chief complaint, OPD note | clinician | – | ✓ | – | – |
| Prescribe or stop medication | clinician | – | ✓ | – | – |
| Admit (attending doctor required) | ✓ | ✓ | ✓ | – | – |
| IPD progress note, treatment, administration | ✓ | ✓ | ✓ | ✓ | – |
| Order lab tests, acknowledge result | clinician | – | ✓ | – | – |
| Lab worklist, collect, result, amend | ✓ | – | view | – | ✓ |
| Discharge (clinical) | clinician | – | ✓ | – | – |
| Finalise bill, void charge (with reason) | ✓ | ✓ | – | – | – |
| Cancel invoice | ✓ | – | – | – | – |
| Tariff, drug and lab catalogs | ✓ | – | – | – | – |
| View record access logs | ✓ | – | – | – | – |

\*Lab view: patient name, age, gender, the tests, reasons and the order note. No notes and no prescriptions.

**RLS:** every new table gets the three policies, `tenant_isolation`, `read_only_write` and `read_only_delete`, in the 0001/0023 `DO $outer$ FOREACH` form. Recommended addition: a `public.app_clinical_access()` function reading `app.clinical_access`, which `withTenant(..., { clinical: true })` sets. Only clinical services set it, and never for impersonated sessions. A restrictive policy on `clinical_notes`, `medication_orders`, `medication_administrations`, `treatments`, `admissions`, `lab_order_items` and `lab_results` then makes clinical rows invisible to support sessions, reports, exports and public token pages by default, and the database fails closed. Billing tables stay outside this so the queue's Paid badge keeps working. The cost is a small change to `withTenant` in lib/db/index.ts.

**Hot-query indexes** are listed inline above:
- Record view: encounters by patient; notes, orders and lab items by encounter.
- IPD census: `admissions_census_idx`.
- Lab worklist: `lab_items_worklist_idx`.
- Bill: `charges_encounter_idx` and `patient_payments_encounter_idx`.
- Queue badge: `encounters_appointment_key` and `charges_appointment_once`.

**Entitlements:** follow the 0021 pattern.
- Add `has_clinical_records` (OPD record, IPD, discharge, invoices) and `has_lab` to **both** `plan_tiers` and `subscriptions` (snapshotted), default `false`.
- Extend `FeatureKind` with `'clinical_records' | 'lab'`, plus the `Entitlements` type, the `hasFeature` switch, `UNRESTRICTED` (true), the tier definitions in `lib/domain/pricing.ts`, `custom-plans.ts` and `platform-accounts.ts`.
- `hasFeature(e, 'lab')` returns `e.hasLab && e.hasClinicalRecords`, because lab hangs off encounters.
- Checks go in the service layer (`assertFeature`), as lib/services/entitlements.ts argues.
- **A downgrade blocks writes, never reads.** Clinical records must stay retrievable, which extends the existing grandfathering rule.
- Feature 1 (address, phone-less, Paid toggle) is ungated.

---

## 5. API surface

New pure modules: `lib/domain/encounter.ts`, `lab.ts`, `patient-billing.ts` and `permissions.ts`. Services go in `lib/services`, each wrapping `withTenant`. Actions follow the `*Dynamic` pattern, returning `{ ok, error? }` after `requireWritableSession()` + `can()`. **(I)** marks a call that takes a client-generated `idempotencyKey`, claimed through `idempotency_keys` inside the same transaction, the same way `booking.ts:461` does.

**Feature 1**
- `createWalkIn(args & { patient: { phoneE164: string | null; address?: string | null; … }; idempotencyKey?: string })` **(I)**. The CTE only gets new column values plus a leading `insert into idempotency_keys … on conflict do nothing`.
- `setConsultationPaid({ hospitalId, appointmentId, paid, method?, actorUserId }) → { badge, balancePaise }`. Idempotent by design: lock, then compute the balance.
- `getPaymentStatuses(tx, appointmentIds) → Map<id, 'paid' | 'partial' | 'unpaid' | 'none'>`
- `ensureEncounterForAppointment(tx, { appointmentId, actorUserId })` (internal: insert on conflict do nothing, then select)
- `setDoctorConsultationFee({ doctorId, pricePaise })`, `listTariffItems`, `upsertTariffItem`
- `updatePatientContact({ patientId, phoneE164?, address? })` → `duplicate_patient` on collision
- Actions: `addWalkInDynamic` (optional phone, address, `paid`, key), `togglePaidDynamic({ appointmentId, paid })`

**Feature 2** (`encounters.ts`, `clinical.ts`, `medications.ts`, `patient-billing.ts`)
- `openRecordForAppointment({ appointmentId, actor }) → encounterId`; `getPatientRecord({ encounterId, actor })` (writes the access log); `listPatientEncounters({ patientId })`
- `setChiefComplaint`, `addClinicalNote({ encounterId, kind, body, occurredAt? })` **(I)**, `amendClinicalNote({ noteId, body, reason })`
- `prescribe({ encounterId, items[] })` **(I)**, `stopMedicationOrder({ orderId, reason })`
- `recordAdministration({ encounterId, medicationOrderId?, drugName, doseGiven, billableQuantity, administeredAt })` **(I)** writes a charge. `recordTreatment(...)` **(I)** writes a charge.
- `admitPatient({ encounterId, admittingDoctorId, admissionReason, wardLabel? })`; `admitDirect({ branchId, patient, attendingDoctorId, admissionReason, origin })` **(I)**; `listAdmitted({ branchId? })`
- `dischargePatient({ encounterId, dischargeType, summary, finalizeBill })` stops active orders, adds the summary note, closes the encounter and optionally finalises the bill, all in one transaction.
- `getBillPreview`, `addManualCharge` **(I)**, `priceCharge`, `voidCharge`, `finalizeInvoice` (lock-idempotent), `cancelInvoice`, `recordPayment` **(I)**, `voidPayment`
- `upsertDrug`, `searchDrugs(q)` (catalog plus recent free-text names); `erasePatient({ patientId, mode: 'delete' | 'anonymise' })`
- Route handler: `GET /api/drugs/search?q=` (debounced typeahead; a GET is more appropriate than a POST action). Printing the prescription and bill are print-CSS pages (`/encounters/[id]/rx`, `/invoices/[id]`), not route handlers.
- Pages: `/encounters/[id]`, `/patients/[id]`, `/ipd`, `/settings/tariff`, `/settings/catalog`.

**Feature 3** (`lab.ts`)
- `orderLabTests({ encounterId, items: { labTestId?, testName, reason }[], priority, clinicalNote? })` **(I)**
- `listLabWorklist({ branchId?, statuses? })`; `transitionLabItem({ itemId, action: 'collect' | 'start' | 'cancel', reason? })`
- `recordLabResult({ itemId, valueText?, valueNumeric?, unit?, referenceRange?, flag?, notes? })` sets `resulted` and charges if configured; `amendLabResult({ resultId, …, reason })`
- `acknowledgeLabResult({ itemId })`; `listUnacknowledgedResults({ doctorId })`; `upsertLabTest`, `listLabTests`
- Page: `/lab` with AutoRefresh.

---

## 6. Privacy: this becomes an EMR

The claim in docs/compliance.md ("no diagnosis field, no prescription … no place to put one") and app/privacy/page.tsx both become false. Minimum concrete measures:
1. **Paperwork.** Update the compliance doc, the privacy notice and the DPA to cover health data. We stay Processor; the hospital decides retention.
2. **Erasure vs retention.** Clinical and billing tables cascade from `patients`/`encounters`, except `invoices`, which is `RESTRICT`. `erasePatient` then works like this:
   - With no invoices, it hard-deletes (as today).
   - With invoices, it **anonymises**: patient name becomes "Erased", phone, address and age become NULL, and clinical rows are deleted. The invoice snapshot stays, because tax law needs it.
   - The hospital must confirm this path.
   - Retention periods are configurable per hospital later, with a sweep job.
3. **Access logging** via `record_access_logs` on record open, print and export.
4. **No clinical reads for support sessions**, enforced by RLS through `app.clinical_access`.
5. **No clinical data in WhatsApp payloads, console logs** (PERF logs must never include bodies), **the display board or data export** unless export is extended deliberately.
6. **Region.** Health data makes an "India region" request much more likely, and ABDM later pushes the same way. Flag this to sales.

---

## 7. Migration plan

Every migration also gets a hand-added entry in `drizzle/meta/_journal.json`, as 0021–0024 did.

| # | Contents | Touches existing tables? |
|---|---|---|
| **0025_walkin_phoneless_address** | `patients`: DROP NOT NULL `phone_e164`; ADD `address`; ADD CHECK `consent_needs_phone` (NOT VALID, then VALIDATE) and the address length CHECK | **Yes, `patients`** |
| **0026_patient_billing_core** | Enums; `tariff_items`, `encounters`, `charges` (appointment source only), `patient_payments`; `restrict_update_to()` function and triggers; RLS and read-only policies | No |
| **0027_plan_clinical_entitlements** | ADD `has_clinical_records` and `has_lab` to `plan_tiers` and `subscriptions`; set top tiers | **Yes, both** |
| **0028_opd_records** | `clinical_notes`, `drug_catalog`, `medication_orders`, `record_access_logs`; `app_clinical_access()` and restrictive policies; append-only trigger on access logs | No |
| **0029_staff_roles** | `ALTER TYPE staff_role ADD VALUE 'nurse'`, `'lab'` (alone, because a new enum value can't be used in the transaction that adds it) | **Yes, enum** |
| **0030_ipd** | `admissions`, `medication_administrations`, `treatments`; `charges` ADD the two source FKs, unique indexes and the recreated `num_nonnulls` CHECK | No (charges is new since 0026) |
| **0031_lab** | `lab_test_catalog`, `lab_orders`, `lab_order_items`, `lab_results`; `charges.lab_order_item_id` | No |
| **0032_invoices** | `document_sequences`, `invoices`, `invoice_lines`; `charges.invoice_id` FK; immutability triggers | No |

Why each existing-table change is necessary:
1. **`phone_e164` nullable:** it is the only representation of a phone-less patient that keeps the appointment FK, the upsert and deduplication intact.
2. **`address`:** required by Feature 1 on the ungated path, where no encounter exists.
3. **The consent CHECK:** keeps the one guarantee the NOT NULL gave WhatsApp.
4. **Enum values:** required for lab and nurse users.
5. **Plan flags:** the only existing mechanism for selling a tier (the 0021 precedent).

**Not touched:** `appointments`, `queue_events`, `doctor_day_states`, `notification_outbox`, `doctors`.

---

## 8. Phased build order

1. **Phase 1, Feature 1 (about 1–2 weeks). Migrations 0025 and 0026.**
   - Walk-in form: "No phone" switch, address, Paid toggle; the walk-in idempotency key.
   - Paid/Unpaid pill on queue rows; per-doctor fee in Settings; worker null-phone guard.
   - Immediate value at the desk, and the billing spine is in place.
2. **Phase 2, OPD record (about 2 weeks). Migrations 0027 and 0028.**
   - "Open record" from the doctor's queue row: chief complaint, notes, prescription with catalog or free text, printable Rx, patient history.
   - The pilot doctor feels this every day.
3. **Phase 3, IPD stay and discharge (about 3 weeks). Migrations 0029 and 0030.**
   - Admit from the record, and direct emergency admission; the `/ipd` census.
   - Progress notes, administrations and treatments, which write charges.
   - Deposits, a live provisional bill, and discharge with a printed provisional bill.
   - The role fixes ship here.
4. **Phase 4, Lab (about 2 weeks). Migration 0031.**
   - Order from the record; `/lab` worklist with AutoRefresh and chime; results and amendments; charges; doctor acknowledgement.
   - **4b (optional):** staff WhatsApp with a separate meter.
5. **Phase 5, numbered invoices (about 1 week). Migration 0032.**
   - Finalise and cancel, FY numbering, invoice print. GST-ready, with GST still off.

Dependencies: 2 needs 1's encounters. 3 needs 2's orders and notes. The final bill (5) should follow lab (4) so it truly contains "all tests run". Lab could be swapped ahead of IPD if the pilot orders tests more often than it admits (see decision 1).

---

## 9. Open decisions for the product owner

1. **Phase order after OPD: IPD first or lab first?** *Recommend IPD first* if the pilot admits patients weekly, otherwise lab.
2. **Paid toggle: ledger or boolean?** *Recommend the ledger* (§1); it's about a week more in Phase 1 and there's no rework later.
3. **Toggle when no fee is configured?** *Recommend* disabling the toggle with a "Set fee" link, and collecting fees during onboarding. The alternative is an inline amount prompt on first use.
4. **Phone-less deduplication:** always a new patient, with a later merge tool? *Recommend yes.*
5. **When is a lab test charged?** Brief says result. *Recommend at order*, auto-voided on cancel; that's standard Indian practice (pay before sample), and results never entered then don't leak revenue. It's a single function either way.
6. **Medication billing source:** administration now, switchable to dispensation when pharmacy ships. *Recommend yes.*
7. **May receptionists and nurses record ad-hoc (orderless) administrations?** *Recommend yes, with a required note.* Prescribing stays clinician-only.
8. **Can every doctor see every patient in the hospital?** *Recommend yes*, with access logging. Per-doctor restriction can come later.
9. **Can receptionists read clinical notes?** *Recommend yes* for small hospitals (the brief has them logging IPD care), with access logging.
10. **Erasure when invoices exist:** anonymise, keeping invoice snapshots. *Recommend yes*; needs legal sign-off in the DPA.
11. **Packaging:** one `clinical_records` flag plus `lab`, or a separate billing-only SKU? *Recommend the two flags now.* Add `has_billing` only if a customer asks for billing without the EMR.
12. **Staff WhatsApp:** off by default. If enabled, it's a paid add-on, never counted in `messages_sent`, and carries no patient identifiers. *Recommend deferring.*
13. **Block clinical reads in support sessions (RLS flag)?** *Recommend yes.*
14. **Follow-ups:** a new encounter per visit. *Recommend yes.*
15. **OPD encounter auto-close:** a nightly sweep for earlier service dates. *Recommend yes.*

### Critical Files for Implementation
- D:\Projects\HospitalAutomation\lib\db\schema.ts
- D:\Projects\HospitalAutomation\lib\services\queue.ts (`createWalkIn` CTE, ~L373–612)
- D:\Projects\HospitalAutomation\drizzle\0023_platform_console.sql (the RLS and read-only policy pattern to copy; also 0001_rls.sql)
- D:\Projects\HospitalAutomation\lib\domain\entitlements.ts (with lib/services/entitlements.ts and lib/domain/pricing.ts)
- D:\Projects\HospitalAutomation\lib\notify\worker.ts (null-phone guard; the reason staff messages need their own outbox)
- D:\Projects\HospitalAutomation\app\(app)\layout.tsx and D:\Projects\HospitalAutomation\lib\services\auth.ts (role negation fixes, `StaffRole`)