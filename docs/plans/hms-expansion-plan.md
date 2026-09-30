# HMS expansion plan: walk-in, clinical & billing foundation, OPD → IPD → discharge, lab, waiting-room translation

**Status: draft v2 for sign-off. No code has been written.**

Changes in v2:
- **Phone number stays mandatory.** Phone-less walk-ins are removed from scope.
- **The Medication, Prescription & IPD Billing Foundation spec is folded in** (section 4). It replaces the v1 `charges`/`invoices` ledger with `bills`/`bill_items` and adds a priced medicine master and draft→final prescriptions.

The appendix, [hms-expansion-appendix-schema.md](hms-expansion-appendix-schema.md), is the v1 architecture draft. It is still the reference for RLS patterns, triggers and lab tables, but **section 4 of this document supersedes its billing and medication tables.**

Section 12 lists the decisions I need from you.

---

## 0. Summary

- **Four ledgers, linked but never merged.** The medicine master is what the hospital offers. Prescriptions are what the doctor ordered. Medication administrations are what was given. Bills are what was charged. Each is its own table, linked by foreign keys, and none depends on another's current state.
- **One spine: `encounters`.** An encounter is one episode of care, and diagnoses, notes, prescriptions, admission and bills all hang off it. It *points at* an appointment (nullable). `appointments`, `queue_events`, `doctor_day_states` and the queue state machine are **not modified**.
- **Prices come from configuration, never from the browser.** Staff pick a medicine and a quantity. The server reads the hospital's selling price inside the transaction and snapshots it onto the bill item. Old bills never change when a price does.
- **Historical records are stable.**
  - Prescription items snapshot the medicine's name, strength and form.
  - Finalised prescriptions and finalised bills are frozen by database triggers.
  - Corrections are explicit: a prescription is revised, a bill item is voided, a bill is cancelled and reissued.
- **Future modules add columns and tables, not redesigns.** Pharmacy, stock, lab billing, radiology, procedures and room charges each fit in without touching existing tables' meaning (section 4.9).
- **Six phases, about 10 weeks.** Walk-in address and the paid toggle ship first. Waiting-room translation (Feature 4) runs in parallel.

---

## 1. Scope sanity check (research findings, unchanged from v1)

Players studied: Practo Insta HMS, MocDoc (the closest analogue for 11–50-staff hospitals), KareXpert, HealthPlix / Eka Care (OPD-first), and eHospital@NIC (public sector). The newer challengers pitch "flat price, few clicks, WhatsApp, ABDM-ready", which is our positioning.

**The doctor will ask for these in week 2, so the plan includes them:**
- a printable discharge summary;
- advance deposits and a running interim bill;
- a printable prescription;
- partial payments with a payment method;
- emergency / direct admission.

**Deliberately not building yet:**
- structured nursing charts (MAR);
- TPA / PM-JAY claims;
- sample barcodes;
- pharmacy stock, batches and expiry;
- OT, dietary and HR modules;
- full ABDM M1–M3 certification.

---

## 2. Engineering prerequisites (Phase 0)

1. **Role checks use negation, so new roles would leak access.**
   - `app/(app)/layout.tsx:33` uses `role !== 'doctor'`, which shows Reports.
   - `dashboard/page.tsx` renders the reception view for any non-doctor role.
   - `PlanExpiryNotice` has the same pattern.

   Replace these with a pure `lib/domain/permissions.ts` `can(actor, action)` backed by a tested matrix, and derive `StaffRole` from `staffRole.enumValues`.
2. **Clinical authorship comes from `doctors.user_id`, not the role.** The pilot doctor logs in as `owner`, and `staff_memberships` allows one role per user per hospital.
3. **Staff notifications must not use `notification_outbox`.** The worker inner-joins patients and appointments, and every sent row feeds the `messages_sent / completed_appointments` margin canary.
4. **Tenant-safe foreign keys.** Foreign-key checks ignore RLS, so new child tables use composite FKs such as `(hospital_id, encounter_id, patient_id) → encounters(hospital_id, id, patient_id)`. One constraint enforces both same-tenant and same-patient.
5. **Use `NO ACTION`, not `RESTRICT`, for "don't delete if referenced" FKs** (medicines, doctors, services). This corrects the appendix. `RESTRICT` is checked mid-statement and can break the `hospitals → … ON DELETE CASCADE` offboarding path, where cascade order isn't guaranteed. `NO ACTION` is checked at the end of the statement: it still blocks deleting a referenced medicine on its own, but lets a whole-hospital cascade succeed.
6. **Name clash.** `payments`, `payment_status` and `lib/domain/billing.ts` belong to SaaS billing. Patient money uses `bills`, `patient_payments` and `lib/domain/patient-billing.ts`. The latter reuses the repo's conventions: integer paise, half-up rounding and `formatRupees`.

---

## 3. Feature 1: walk-in address + paid toggle

**Phone stays mandatory**, so the patient identity rules, the upsert and double-tap protection (the one-active-token index) are all unchanged.

| Change | Detail |
|---|---|
| `patients.address text` (nullable, ≤500 chars) | Single free-text field, as you specified. On upsert the newest non-empty value wins (`coalesce`, like age and gender). The final bill snapshots it, so the historical copy that matters is preserved. |
| Paid toggle | Backed by the section 4 billing foundation, not a boolean (section 4.7). One tap for reception. |

`createWalkIn` only gains the `address` column in its single-roundtrip query.

**UX:**
- The walk-in form stays *name → phone → Enter*. **Address** sits after phone, with the placeholder "Village / area (optional)".
- A **○ Unpaid / ✓ Paid** chip, default Unpaid.
- A `PaidToggle` pill on queue rows. It flips in one tap, glyph plus text, audited. **The doctor sees it read-only.**
- The first Paid tap for a doctor with no consultation fee asks for the fee once and saves it to that doctor's consultation service.

---

## 4. Clinical & billing foundation (the Medication, Prescription & IPD Billing spec)

### 4.1 What exists today, and the design answer

| Question | Today | Answer |
|---|---|---|
| Is there an encounter concept? | No; only `appointments` (a queue token) | **Add a lean `encounters` table.** It is justified now, not speculative: IPD bills and admissions need a parent that isn't an appointment (emergency admission has no token; a stay spans days). Hanging prescriptions on `appointment_id` would need migrating in the very next phase. |
| Money representation | Integer paise, half-up rounding | Same, everywhere. Tax rates are basis points (`1800` = 18%). |
| Audit | `audit_logs` (action, object, metadata jsonb) | Reused for prescription finalised/revised, bill item added/voided/overridden, bill finalised/cancelled and **medicine price changed** (metadata `{from, to}`). That entry is the price history; there is no extra table. |
| Enums | `pgEnum` throughout, lowercase values | Same. New values are added with `ALTER TYPE … ADD VALUE` in its own migration file, because Postgres won't use a new value in the transaction that adds it. |
| RLS | `ENABLE` + `FORCE`, `hospital_id = nullif(current_setting('app.hospital_id', true), '')::uuid` for USING and WITH CHECK, plus read-only-session policies (0001 / 0023 pattern) | Every new table gets exactly this, with no weaker variant. |

### 4.2 Entity map

```
patients (identity only: no clinical columns added)
   │
   └── encounters  (stage opd→ipd · status open/closed/cancelled · origin queue/emergency/direct)
         │  appointment_id? ─────────────► appointments (UNCHANGED)
         │
         ├── diagnoses            clinical: what the doctor concluded
         ├── clinical_notes       clinical: visit reason, notes, progress
         ├── prescriptions        clinical: what the doctor ORDERED (draft → final → superseded)
         │     └── prescription_items ──► medicines (snapshot name/strength/form)
         │
         ├── admissions (1:1, Phase 3)
         ├── medication_administrations (Phase 3)   operational: what was GIVEN
         │
         ├── bills                financial: what is CHARGED (draft → final | cancelled)
         │     └── bill_items ──► medicines | services | (later) lab items, administrations
         │                         snapshot: description, configured price, charged price, tax
         └── patient_payments     financial: money in (deposits, payments, refunds)

medicines   hospital catalogue: identity + selling price   ─ configuration
services    hospital catalogue: consultation fee (later: procedures, room, nursing)   ─ configuration
```

The encounter carries no status that mirrors the bill, and the bill carries none that mirrors the prescription or appointment. **Clinical completion and financial settlement are independent state machines.** A consultation can complete while its bill stays unpaid.

### 4.3 Configuration tables

```ts
/**
 * What the hospital offers. Identity is name + strength + form, because
 * "Paracetamol 500 mg tablet" and "Paracetamol syrup" are different products.
 * Never hard-deleted once referenced: deactivate instead (FKs are NO ACTION).
 */
export const medicines = pgTable('medicines', {
  id: id(), hospitalId: hospitalFk(),
  name: text('name').notNull(),                  // as the doctor knows it (brand or generic)
  genericName: text('generic_name'),
  strength: text('strength'),                    // '500 mg', '5 mg/ml'
  form: text('form'),                            // tablet, syrup, injection …
  unit: text('unit').notNull().default('unit'),  // the BILLING unit: tablet, strip, vial, bottle
  /**
   * The hospital's configured selling price per `unit`. Deliberately not
   * `price` and not MRP: a pharmacy module may later add mrp, purchase price
   * or batch prices beside it without changing what this column means.
   * Null = not yet priced: prescribable in OPD, refused on a bill.
   */
  sellingPricePaise: integer('selling_price_paise'),   // CHECK >= 0
  taxRateBp: integer('tax_rate_bp').notNull().default(0),
  active: boolean('active').notNull().default(true),   // repo convention (doctors.active)
  createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [
  uniqueIndex('medicines_identity_key').on(t.hospitalId, sql`lower(name)`, sql`coalesce(lower(strength),'')`, sql`coalesce(lower(form),'')`),
  // Prefix search ("para…") on name and generic name; active only.
  index('medicines_name_search_idx').on(t.hospitalId, sql`lower(name) text_pattern_ops`).where(sql`active`),
  index('medicines_generic_search_idx').on(t.hospitalId, sql`lower(generic_name) text_pattern_ops`).where(sql`active and generic_name is not null`),
]);

/** Non-medicine chargeables. Phase 1 uses only consultation fees. */
export const services = pgTable('services', {
  id: id(), hospitalId: hospitalFk(),
  kind: serviceKind('kind').notNull(),          // enum: 'consultation' now; procedure/room/nursing added when built
  name: text('name').notNull(),                 // "Consultation", "Follow-up consultation"
  doctorId: uuid('doctor_id').references(() => doctors.id),   // per-doctor fee; NO ACTION
  sellingPricePaise: integer('selling_price_paise').notNull(),
  taxRateBp: integer('tax_rate_bp').notNull().default(0),
  active: boolean('active').notNull().default(true),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [uniqueIndex('services_identity_key').on(t.hospitalId, t.kind, sql`lower(name)`, sql`coalesce(doctor_id::text,'')`)]);
```

**Search:** a server-side prefix match on `lower(name)` or `lower(generic_name)`, active only, hospital-scoped, `LIMIT 10`. It uses the two partial indexes above. A catalogue is a few thousand rows per hospital, so a `pg_trgm` substring search is deferred until someone asks for it. The browser never loads the whole catalogue.

### 4.4 Clinical tables

```ts
export const encounters = pgTable('encounters', {
  id: id(), hospitalId: hospitalFk(),
  branchId: uuid('branch_id').notNull().references(() => branches.id),
  patientId: uuid('patient_id').notNull().references(() => patients.id, { onDelete: 'cascade' }),
  appointmentId: uuid('appointment_id').references(() => appointments.id, { onDelete: 'set null' }),
  attendingDoctorId: uuid('attending_doctor_id').notNull().references(() => doctors.id),
  origin: encounterOrigin('origin').notNull(),              // queue | emergency | direct
  stage: encounterStage('stage').notNull().default('opd'),  // opd → ipd
  status: encounterStatus('status').notNull().default('open'),
  openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
  closedAt: timestamp('closed_at', { withTimezone: true }),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [
  uniqueIndex('encounters_tenant_patient_key').on(t.hospitalId, t.id, t.patientId),   // composite-FK target
  uniqueIndex('encounters_appointment_key').on(t.appointmentId).where(sql`appointment_id is not null`),
  index('encounters_patient_idx').on(t.patientId, t.openedAt),                        // patient history
  index('encounters_open_idx').on(t.hospitalId, t.branchId, t.stage).where(sql`status = 'open'`),
]);

/** Free-text now; `code` exists so ICD-10 can be added later without a new table. */
export const diagnoses = pgTable('diagnoses', {
  id: id(), hospitalId: hospitalFk(), encounterId: uuid('encounter_id').notNull(), patientId: uuid('patient_id').notNull(),
  text: text('text').notNull(), code: text('code'),
  recordedByDoctorId: uuid('recorded_by_doctor_id').notNull().references(() => doctors.id),
  ...voidCols(), createdAt: createdAt(),
}, (t) => [encounterFk(t), index('diagnoses_encounter_idx').on(t.encounterId)]);

export const clinicalNotes = /* as appendix: kind visit_reason | note | progress | admission; append-only, void+supersede */;

/**
 * A doctor's clinical instruction. Never priced, never billed by itself.
 * draft: autosaved while the doctor types (items replaced freely).
 * final: printed or shared; frozen by trigger. Editing it later creates a
 *        new draft with supersedes_prescription_id; finalising that marks the old one 'superseded'.
 */
export const prescriptions = pgTable('prescriptions', {
  id: id(), hospitalId: hospitalFk(),
  encounterId: uuid('encounter_id').notNull(), patientId: uuid('patient_id').notNull(),   // composite FK → encounters
  prescriberDoctorId: uuid('prescriber_doctor_id').notNull().references(() => doctors.id),
  kind: prescriptionKind('kind').notNull().default('opd'),     // opd | ipd | discharge
  status: prescriptionStatus('status').notNull().default('draft'),
  advice: text('advice'),                                      // "Plenty of fluids"
  followUpOn: date('follow_up_on'),                            // prints on the Rx; shows in history
  supersedesPrescriptionId: uuid('supersedes_prescription_id'),
  finalizedAt: timestamp('finalized_at', { withTimezone: true }),
  finalizedByUserId: uuid('finalized_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [encounterFk(t),
  uniqueIndex('prescriptions_one_draft_key').on(t.encounterId, t.prescriberDoctorId, t.kind).where(sql`status = 'draft'`),
  index('prescriptions_patient_idx').on(t.patientId, t.finalizedAt).where(sql`status = 'final'`),   // history
  index('prescriptions_doctor_idx').on(t.prescriberDoctorId, t.createdAt),                          // "today's Rx"
  check('prescriptions_final_stamped', sql`(status = 'draft') = (finalized_at is null)`),
]);

export const prescriptionItems = pgTable('prescription_items', {
  id: id(), hospitalId: hospitalFk(),
  prescriptionId: uuid('prescription_id').notNull().references(() => prescriptions.id, { onDelete: 'cascade' }),
  medicineId: uuid('medicine_id').notNull().references(() => medicines.id),     // NO ACTION: canonical identity
  // Snapshots: what the doctor saw and printed, stable if the master is renamed.
  medicineName: text('medicine_name').notNull(), strength: text('strength'), form: text('form'),
  dose: text('dose').notNull(),               // "1 tab"
  frequency: text('frequency').notNull(),     // "1-0-1", "SOS": Indian notation, preset in the UI
  durationDays: smallint('duration_days'),
  route: text('route'), instructions: text('instructions'),   // "after food"
  sortOrder: smallint('sort_order').notNull(),
  createdAt: createdAt(),
}, (t) => [index('prescription_items_rx_idx').on(t.prescriptionId),
           index('prescription_items_medicine_idx').on(t.medicineId)]);   // "frequently prescribed"
```

**There is deliberately no quantity on prescription items.** Prescribed ≠ dispensed ≠ billed; the spec's section 33 covers this. A future `dispensations(prescription_item_id, medicine_id, quantity, batch_id)` table links to prescription items without changing them.

**Integrity triggers** (the `restrict_update_to()` pattern from the appendix):
- `prescriptions`: once `final`, only `status: final → superseded` may change.
- `prescription_items`: INSERT, UPDATE or DELETE is refused unless the parent prescription is `draft`.

### 4.5 Financial tables

```ts
/**
 * What the hospital charges for an encounter. Totals and patient snapshot are
 * written at finalisation; a draft's totals are always computed live from its items.
 */
export const bills = pgTable('bills', {
  id: id(), hospitalId: hospitalFk(),
  encounterId: uuid('encounter_id').notNull(), patientId: uuid('patient_id').notNull(),   // composite FK
  status: billStatus('status').notNull().default('draft'),     // draft | final | cancelled
  billNumber: text('bill_number'), fiscalYear: text('fiscal_year'),                     // set at finalisation
  subtotalPaise: integer('subtotal_paise'), discountPaise: integer('discount_paise'),
  taxPaise: integer('tax_paise'), totalPaise: integer('total_paise'),
  patientName: text('patient_name'), patientPhone: text('patient_phone'), patientAddress: text('patient_address'),
  finalizedAt: timestamp('finalized_at', { withTimezone: true }), finalizedByUserId: uuid('finalized_by_user_id'),
  cancelledAt: timestamp('cancelled_at', { withTimezone: true }), cancelledByUserId: uuid('cancelled_by_user_id'),
  cancelReason: text('cancel_reason'), supersedesBillId: uuid('supersedes_bill_id'),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [encounterFk(t),
  uniqueIndex('bills_one_draft_key').on(t.encounterId).where(sql`status = 'draft'`),
  uniqueIndex('bills_number_key').on(t.hospitalId, t.billNumber).where(sql`bill_number is not null`),
  index('bills_encounter_idx').on(t.encounterId),
  check('bills_final_complete', sql`(status = 'draft') = (finalized_at is null and bill_number is null and total_paise is null)`),
]);

/**
 * One chargeable line. Every money column is computed server-side by
 * lib/domain/patient-billing.ts#calculateBillItem and stored. The CHECKs below
 * are a database backstop so no code path can store inconsistent arithmetic.
 */
export const billItems = pgTable('bill_items', {
  id: id(), hospitalId: hospitalFk(),
  billId: uuid('bill_id').notNull().references(() => bills.id, { onDelete: 'cascade' }),
  itemType: billItemType('item_type').notNull(),      // consultation | medicine | other  (lab_test etc. added later)
  // Typed sources, not (type, id): Postgres guarantees they exist, and each gets its own "bill once" index.
  medicineId: uuid('medicine_id').references(() => medicines.id),     // NO ACTION
  serviceId: uuid('service_id').references(() => services.id),        // NO ACTION
  appointmentId: uuid('appointment_id').references(() => appointments.id, { onDelete: 'set null' }), // consult dedupe
  description: text('description').notNull(),         // snapshot: "Paracetamol 500 mg tablet"
  quantity: integer('quantity').notNull(),            // CHECK > 0, in the source's billing unit
  configuredUnitPricePaise: integer('configured_unit_price_paise'),   // master price at this moment (null for 'other')
  unitPricePaise: integer('unit_price_paise').notNull(),              // what was actually charged
  priceOverrideReason: text('price_override_reason'),
  subtotalPaise: integer('subtotal_paise').notNull(),
  discountPaise: integer('discount_paise').notNull().default(0),
  taxRateBp: integer('tax_rate_bp').notNull(),
  taxPaise: integer('tax_paise').notNull(),
  totalPaise: integer('total_paise').notNull(),
  createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  ...voidCols(), createdAt: createdAt(),
}, (t) => [
  index('bill_items_bill_idx').on(t.billId).where(sql`voided_at is null`),
  uniqueIndex('bill_items_consult_once').on(t.appointmentId).where(sql`appointment_id is not null and voided_at is null`),
  check('bill_items_source', sql`
    (item_type = 'medicine'     and medicine_id is not null and service_id is null) or
    (item_type = 'consultation' and service_id  is not null and medicine_id is null) or
    (item_type = 'other'        and medicine_id is null and service_id is null)`),
  check('bill_items_override', sql`configured_unit_price_paise is null or unit_price_paise = configured_unit_price_paise or price_override_reason is not null`),
  check('bill_items_math', sql`subtotal_paise = quantity * unit_price_paise and total_paise = subtotal_paise - discount_paise + tax_paise`),
]);

/** Money in, per encounter: deposits land before any bill is final. */
export const patientPayments = /* as appendix: encounter_id, bill_id?, kind payment|refund, amount_paise, method cash|upi|card|…, void cols */;

/** Gap-free bill numbers per fiscal year; locked like doctor_day_states. */
export const documentSequences = /* as appendix */;
```

**Bill item lifecycle trigger:**
- Items can only be inserted or voided while the bill is `draft`.
- Nothing on a `final` bill ever changes.
- Correcting a final bill means cancelling it (with a reason) and issuing a new one with `supersedes_bill_id`. Credit notes come later as an adjustment document, and bills never get rewritten.

### 4.6 Domain rules and service boundaries

**`lib/domain/` holds pure rules only: no DB, no React.**
- `patient-billing.ts`
  - `calculateBillItem({ quantity, unitPricePaise, taxRateBp, discountPaise }) → { subtotal, discount, tax, total }`. It uses integers only; tax is `Math.round(taxable × bp / 10000)`, half-up like `billing.ts`, applied after discount.
  - `sumBill(items)` and `balanceStatus(total, paid) → 'unpaid' | 'partial' | 'paid'`.
  - The UI only ever displays numbers the server computed.
- `prescription.ts`
  - draft/final/superseded transitions;
  - item validation;
  - frequency presets (`1-0-1`, `1-1-1`, `0-0-1`, `1-0-0`, `SOS`, …).
- `medicine.ts`: identity normalisation (trim, collapse spaces) and validation.
- `permissions.ts`: the matrix in section 7.

**`lib/services/` holds DB access and transactions. Every function runs in `withTenant`, validates the actor server-side, and re-reads every client-supplied id under RLS.**

| Service | Functions | Transaction boundary |
|---|---|---|
| `medicines.ts` | `createMedicine`, `updateMedicine` (audits price changes `{from, to}`), `setMedicineActive`, `searchMedicines({ q, limit, purpose })` | One row each. `purpose: 'prescribe'` returns **no price fields**, so price never reaches the doctor's browser. `purpose: 'bill'` includes the selling price. |
| `encounters.ts` | `openEncounterForAppointment` (lazy, idempotent via the unique index), `getPatientHistory(patientId)` | History is **derived**: encounters desc + diagnoses + final prescriptions with items + follow-up. There is no stored history text. |
| `prescriptions.ts` | `saveDraft({ encounterId, items[], advice, followUpOn })`, `finalize(id)`, `revise(id) → newDraftId`, `getForPrint(id)` | `saveDraft` upserts the draft and replaces its items in **one transaction** (all or nothing). `finalize` stamps it, supersedes the previous version and writes an audit row. |
| `patient-billing.ts` | `getOrCreateDraftBill(encounterId)`, `addMedicineItem({ billId, medicineId, quantity })`, `addConsultationItem`, `addOtherItem({ description, quantity, unitPricePaise })`, `overrideItemPrice({ itemId, unitPricePaise, reason })`, `voidBillItem`, `finalizeBill`, `cancelBill`, `recordPayment`, `voidPayment`, `setConsultationPaid` | `addMedicineItem` runs in one transaction: <br>1. `SELECT … FROM bills WHERE id = $1 FOR UPDATE` and check it is a draft. <br>2. Load the medicine under RLS; check it is active and priced. <br>3. Take the price **as read inside this transaction**. <br>4. `calculateBillItem`, then insert the snapshot. <br>**The request schema has no price field.** |

**The price race (spec section 54) is resolved by design.** The authoritative price is whatever is committed when step 3 reads it. After that, the item's snapshot never changes, and a later price edit only affects items created afterwards.

### 4.7 How Feature 1's paid toggle uses this

Tapping **Paid** runs one transaction:
1. `openEncounterForAppointment`
2. `getOrCreateDraftBill`
3. `addConsultationItem`, at the doctor's consultation `services` price. It is idempotent via `bill_items_consult_once`.
4. `recordPayment(balance, 'cash')`

Tapping **Unpaid** voids that payment. The badge is `balanceStatus`. Clinical completion of the appointment is untouched, and the bill stays open or unpaid independently (spec section 57).

### 4.8 Answers to the spec's senior-developer questions (section 67)

| Question | Answer |
|---|---|
| What identifies a medicine? | `(hospital, lower(name), strength, form)`, unique per hospital. Hospital A and Hospital B keep independent rows and prices. |
| What must never change after a prescription is issued? | Its items and snapshots. The trigger freezes `final` prescriptions; revisions are new rows. |
| What exact price was charged? | `bill_items.unit_price_paise`, beside `configured_unit_price_paise` and an override reason if they differ. |
| How does a medicine become billable? | Only by `addMedicineItem`: server-side price lookup and snapshot. A prescription never creates a bill item. |
| How is tenant isolation guaranteed? | FORCE RLS on every table, plus composite tenant FKs (FK checks bypass RLS). |
| Multiple IPD billing events? | Many items on one draft bill over many days. Interim bills are live drafts; a supplementary bill is a new draft after a final one. |
| How does a prescription connect to dispensing? | A future `dispensations.prescription_item_id`. No change to prescriptions. |
| How do lab tests become billable? | `ALTER TYPE bill_item_type ADD VALUE 'lab_test'`, `bill_items.lab_order_item_id` plus a "bill once" index, and one more branch in the source CHECK. |
| Who changed a price or prescription? | `audit_logs` (price `{from, to}`, prescription finalised/revised), and `created_by`/`finalized_by`/`voided_by` columns on the rows. |
| Do old records render after master changes? | Yes. Prescriptions render from item snapshots and bills from item descriptions and prices, never from the current master. |

### 4.9 Future modules: what each adds

| Module | Adds | Touches existing foundation tables? |
|---|---|---|
| Medication administration (Phase 3) | `medication_administrations(encounter_id, medicine_id, prescription_item_id?, dose_given, administered_at, by)` and `bill_items.medication_administration_id` | Only a new nullable column and CHECK branch on `bill_items` |
| Lab (Phase 4) | lab tables and `lab_test` item type | Same |
| Room / bed charges | `wards`, `beds`, `bed_assignments`, `services.kind` + `room`, `bill_items.bed_assignment_id` | Same |
| Procedures, nursing, consumables | `services.kind` values and `bill_item_type` values | Enum values only |
| Pharmacy / inventory | `medicine_batches`, `stock_movements`, `dispensations`, and optionally `medicines.mrp` | No meaning changes; `selling_price_paise` keeps its meaning |
| Insurance / TPA | `encounter_payers`, `claims`, `patient_payments.claim_id` | Nullable column only |

### 4.10 Tests (the spec's section 73 list, mapped to the repo's vitest layout)

- **Unit, `lib/domain/__tests__/`:**
  - `calculateBillItem`: quantity × price, discount, tax rounding, zero tax;
  - `sumBill`, `balanceStatus`;
  - prescription transitions;
  - medicine identity normalisation;
  - the permission matrix, including "doctor cannot edit medicine price" and "receptionist cannot modify a doctor's prescription".
- **Integration, `lib/services/__tests__/` and `lib/db/__tests__/`:**
  - Medicine create, deactivate, search (active only, tenant-scoped, prefix on name and generic).
  - Prescription create is atomic: a failing item leaves no half-written draft.
  - **Scenario 1 / 2:** ₹2 × 5 = ₹10 bill; price changed to ₹2.50; new bill ₹12.50; old bill still ₹10.
  - Renamed medicine: the old prescription still prints "Paracetamol 500 mg".
  - Deactivated medicine: old prescriptions and bills are visible; new prescriptions and bill items are refused.
  - Hospital A cannot read or reference Hospital B's medicines, prescriptions or bills. This includes the composite-FK case: inserting a child row that points at another tenant's encounter fails.
  - The browser can't set a price: `addMedicineItem` has no price input, and a bill item on a final bill is refused by the trigger.
  - Public `/q/[token]` and `/display` responses contain no clinical fields.

---

## 5. Feature 2: OPD → IPD → discharge (screens on top of the foundation)

**5.1 Consultation panel (doctor dashboard, under Now-serving).** It follows the layout in spec section 20:

```
Rahul Patil · 42M                              [Prior visits (2)]
Diagnosis  [ Viral fever                      ]
Notes      [                                  ]
Prescription                                   [Repeat last]
  Paracetamol 500 mg tablet   [1 tab] [1-0-1 ▾] [5d] [after food]   ✕
  [+ Add medicine: type to search]
  Frequent: [Paracetamol 500][Azithromycin 500][ORS][Pantoprazole 40]
Advice [          ]   Follow-up [ 30 Sep ▾ ]
[Send for tests] [Admit]        [Save & print] [Complete & Call Next]    Draft saved 10:42
```

- **Search.** A debounced server search (`purpose: 'prescribe'`, limit 10). Selecting a result fills medicine, strength and form; the doctor adds dose, frequency, duration and instructions.
- **Frequent and Recent chips** are *queries* over `prescription_items`, filtered to this doctor's last 90 days and ranked by count and recency, carrying the last-used dose, frequency and duration. There are no duplicate medicine records and no favourites table (spec section 22).
- **Medicine not in the catalogue?** "+ Add 'Levocet 5 mg' to catalogue" creates an **unpriced** medicine, which the owner can price later. The doctor is never blocked, and identity still comes from the master. This is decision D15.
- **No prices are shown anywhere** on the doctor's screen, and the doctor's search results contain none.
- **Autosave** writes the `draft` prescription (debounced, and a localStorage copy while offline). The panel initialises once and never re-reads server props, so the 10-second auto-refresh can't wipe typing.
- **Save & print** finalises and opens the print view. **Complete & Call Next** finalises any non-empty draft, then runs the existing queue action; that happens in the action layer, so the queue service is untouched. Editing a saved prescription means **Revise**, which creates a new version, and the history shows "revised 11:05".
- **Common case:** repeat patient, common drug = **2 taps**.

**5.2 Prescription print.** It shows:
- hospital header, doctor, patient, date;
- diagnosis;
- a table of medicine, strength, dose, frequency, duration and instructions;
- advice, follow-up and signature line.

It never shows prices. It uses print CSS, which is the first print support in the codebase. Viewing a print writes a `record_access_logs` row.

**5.3 Patient history ("Prior visits").** The derived timeline (spec section 66): date, doctor, diagnosis, the final prescription with items, and follow-up. It is staff-only. The `/q/[token]` page never exposes it; a patient-facing history would need its own authenticated flow.

**5.4 Admit.** A modal: admission reason (prefilled from the diagnosis) and a free-text ward/bed. The encounter's stage becomes `ipd`, and the queue entry completes exactly like Complete & Call Next.

**5.5 Admitted (`/ipd`).** The census list with a "No update 9h" cue. Each patient's record page has a timeline of progress notes, treatments and **Drug given**. Drug given is a `medication_administrations` row; if the hospital bills medicines per administration, it also adds a bill item in the same transaction.

**5.6 IPD billing (on the record, reception/owner).** It follows the spec's section 63 flow:

```
Bill (draft) · Rahul Patil · Day 3                          Total ₹1,724.00
  + Add item:  [Search medicine ▾ Paracetamol 500 mg tablet · ₹2.00/tablet]  Qty [10]  [Add]
  Consultation – Dr. Sharma        1 × 300.00    300.00
  Paracetamol 500 mg tablet       10 ×   2.00     20.00
  CBC                              1 × 250.00    250.00        (Phase 4)
  …                                              Deposits −1,000.00   Balance 724.00
[Record payment]  [Print interim bill]  [Finalise & print]
```

- Staff pick a medicine and a quantity, and the **server** prices it. There is no editable price cell.
- **Override** is owner-only: new price plus a required reason, audited, with the original price kept (D17).
- **"Other" lines** (description, quantity, price) cover genuine one-offs and are audited.

**5.7 Discharge.** The summary uses a structured 1:1 `discharge_summaries` table:
- final diagnosis;
- course;
- condition (recovered / referred / LAMA / death / other);
- advice and follow-up;
- take-home medicines as a `prescriptions` row with `kind = 'discharge'`.

These sections mirror ABDM's DischargeSummaryRecord. Then **Finalise bill**: a gap-free number per fiscal year from `document_sequences`, with totals and the patient snapshot written. Discharge with dues is allowed after one amber confirmation. Print bill and summary.

**5.8 Medicines catalogue (Settings → Medicines, owner).** Following spec section 64:
- search;
- + Add medicine (name, generic, strength, form, billing unit, selling price, tax %);
- an **Unpriced (12)** filter, so doctor-added entries get priced;
- Edit and Deactivate.

Inactive medicines disappear from both searches but stay on old records.

---

## 6. Feature 3: lab referral and notification (unchanged from v1, now billed via `bill_items`)

- **Tables:**
  - `lab_test_catalog` (with `selling_price_paise`);
  - `lab_orders`: one doctor request, which is also one notification unit;
  - `lab_order_items`: optional per-test reason; status ordered → collected → resulted, plus cancelled; doctor `acknowledged_at`;
  - `lab_results`: append-only, void and supersede.
- **Billing:** add `lab_test` to `bill_item_type`, `bill_items.lab_order_item_id` and a "bill once" index. The test is charged at order time and voided automatically if cancelled (D8).
- **Notifications are in-app:**
  - the `/lab` worklist refreshes every 15 s, plays a chime and shows a tab-title count;
  - the doctor gets a **🧪 Result ready** pill;
  - no staff WhatsApp in v1, because of the margin canary and to keep health data off personal phones.
- **UX:**
  - Order tests: a modal with quick-pick chips plus search, optional "Why" per test, Routine/Urgent, and "also hold patient 30 min". **3 taps.**
  - The worklist has tabs To collect / Collected / Result ready, is ordered urgent first then oldest first, and has inline result entry.
  - Lab staff see name, age and sex only.

---

## 7. Roles, permissions, privacy, gating

- Add `lab` to `staff_role`, and `nurse` if D7 is agreed.
- "Clinician" means a user linked to an active `doctors` row.

| Action | Owner | Reception | Doctor | Nurse | Lab |
|---|---|---|---|---|---|
| Queue, walk-in (unchanged) | ✓ | ✓ | ✓ | – | – |
| Paid toggle / record payment | ✓ | ✓ | view | – | – |
| View patient history / record (logged) | ✓ | ✓ | ✓ | ✓ | lab view only |
| Diagnosis, notes, prescribe, revise Rx | clinician | – | ✓ (see D16) | – | – |
| Add unpriced medicine to catalogue | ✓ | – | ✓ (D15) | – | – |
| **Medicine / service prices, activate / deactivate** | ✓ | – | – | – | – |
| Add medicine / consultation / other bill items | ✓ | ✓ | – | – | – |
| Override an item price | ✓ | – | – | – | – |
| Finalise / cancel bill | ✓ | finalise only | – | – | – |
| Admit / IPD notes / drug given | ✓ | ✓ | ✓ | ✓ | – |
| Order tests | clinician | – | ✓ | – | – |
| Lab collect / result | ✓ | – | view | – | ✓ |

**Privacy.** This makes us an EMR, and `docs/compliance.md` plus the privacy page currently say otherwise. Minimum measures:
1. Update the compliance doc, privacy notice and DPA.
2. `record_access_logs` on history views and prints.
3. A restrictive RLS policy gated on an `app.clinical_access` flag, never set for impersonated support sessions, so clinical rows are invisible to support, reports, exports and public pages by default.
4. No clinical text in WhatsApp payloads, PERF logs, `/display` or `/q/[token]`.
5. Erasure: hard-delete if the patient has no final bill. Otherwise anonymise the patient, delete clinical rows and keep the bill snapshot for tax law (D10).
6. The Singapore database region will be questioned. This is a sales flag.

**Gating.** `has_clinical_records` and `has_lab` go on `plan_tiers` and `subscriptions` (0021 pattern). A downgrade blocks writes, never reads. Feature 1 is ungated.

---

## 8. Migrations

New files only; nothing already applied is edited. Each gets a hand-added `_journal.json` entry.

| # | Contents | Existing tables touched |
|---|---|---|
| 0025 | `patients.address` + length CHECK | **`patients` (one nullable column)** |
| 0026 | Foundation: enums; `encounters`, `services`, `bills`, `bill_items` (consultation / other), `patient_payments`; lifecycle triggers; RLS | none |
| 0027 | `has_clinical_records`, `has_lab` on `plan_tiers` and `subscriptions` | **yes (0021 precedent)** |
| 0028 | Clinical OPD: `medicines`, `diagnoses`, `clinical_notes`, `prescriptions`, `prescription_items`, `record_access_logs`; `bill_items.medicine_id` + CHECK; prescription triggers; clinical-access RLS | none (`bill_items` is new) |
| 0029 | `staff_role` ADD VALUE `lab` (+ `nurse`). Separate file, because Postgres can't use a new enum value in the same transaction. | **enum** |
| 0030 | IPD: `admissions`, `discharge_summaries`, `medication_administrations`, `document_sequences`; `bill_items.medication_administration_id` | none |
| 0031a / 0031b | `bill_item_type` ADD VALUE `lab_test`, then the lab tables + `bill_items.lab_order_item_id` | enum |

**Never touched:** `appointments`, `queue_events`, `doctor_day_states`, `notification_outbox`, `doctors`.

---

## 9. Phased build order

| Phase | Ships | Est. | Migrations |
|---|---|---|---|
| **0: Prereqs** | Permission matrix, role-negation fixes, derived `StaffRole` | 2–3 d | none |
| **1: Walk-in + billing spine** | Address field; encounters, bills and payments; Paid pill; consultation fee capture; `calculateBillItem` + tests | 1.5–2 wk | 0025–0026 |
| **2: Medicines + OPD prescription** | Medicines catalogue (owner); consultation panel (diagnosis, notes, Rx, search, frequent, repeat-last, autosave); Save & print; patient history; revise flow; clinical RLS + access logs | 2.5 wk | 0027–0028 |
| **3: IPD + IPD billing + discharge** | Admit (from record, and emergency), `/ipd` census, timeline, drug given, IPD bill screen with server pricing, override, deposits, interim / final bill with numbering, discharge summary, print | 3 wk | 0029–0030 |
| **4: Lab** | Order modal, `/lab` worklist, results, acknowledgement, lab bill items | 2 wk | 0031 |
| **3b (optional)** | Wards / beds, automatic room charges | 1 wk | new |
| **F4 (parallel)** | Waiting-room translation (section 10) | 3–4 d | 1 small |

**Implementation staffing:**
- **Stronger model:** migrations, triggers and RLS; `patient-billing` / `prescription` domain logic and tests; the consultation panel; the IPD bill screen; the medicine search combobox.
- **Lighter models:**
  - the medicines catalogue CRUD screen;
  - role and nav plumbing;
  - the `/ipd` list;
  - the lab worklist shell;
  - the Admit and Order-tests modals.

---

## 10. Feature 4: waiting-room translation (unchanged from v1)

- **Names are never translated.** "Kamal Patil" → "Lotus Patil" is the failure mode. The options:
  - **A1:** as entered.
  - **A2 (recommended):** receptionist-confirmed transliteration. Azure `/transliterate` prefills an optional "Name in Marathi" at intake; staff accept or edit it; the TV shows confirmed forms only.
  - **A3:** fully automatic. AI4Bharat reports ~59% exact-match accuracy on English→Hindi names, which is too risky on a public screen.
  - Run a 200-name bake-off (Azure vs IndicXlit vs a small LLM) before choosing between A2 and A3.
- **Public-screen privacy:** first name + last initial is recommended. It matches the first-name-only rule `/q/[token]` already applies.
- **Pause reasons are a pick-list** of dictionary keys (In surgery / Emergency / Lunch / Rounds / Back at HH:MM / Other), not machine translation. That means zero cost, zero latency and no mistranslation. Machine translation would be cheap (~$10–20 per million characters, inside free tiers at our volume); quality is the reason to avoid it.
- **No i18n library.** Extend the existing dictionary: add the missing display strings and a Hindi toggle. Keep Latin digits on tokens.
- **Transliterate at write time, never at render time.**
  - Store the result in `patients.name_alt`.
  - Run it after both patient-insert paths: booking **and** the walk-in query.
  - Use a 1.5 s timeout and fall back to the as-entered name.
  - Add `name_local` on doctors and branches, typed once by staff.
  - Fix the display's missing `lang` attribute and `font-deva` class, so Devanagari renders in the right font.

---

## 11. What changed from v1, and why

| v1 | v2 | Reason |
|---|---|---|
| Nullable phone, "no phone" checkbox, walk-in idempotency key | **Removed.** Phone mandatory. | Your call. The existing uniqueness and upsert stay exactly as they are. |
| `charges` ledger + `invoices` / `invoice_lines` snapshot | **`bills` + `bill_items`** (draft → final), price snapshot on each item | The spec. It is one billing architecture with fewer tables, and the draft bill *is* the interim bill. |
| `drug_catalog` optional; free-text drug names allowed | **`medicines` required** on every prescription item; doctors can quick-add unpriced entries | The spec (section 30): identity must come from the master. Quick-add keeps the doctor unblocked. |
| `medication_orders` flat per encounter | **`prescriptions` + `prescription_items`** with draft → final → superseded | The spec (sections 13, 17, 56). It also replaces v1's separate `consultation_drafts` table. |
| Charges written by administrations | Bill items added **from the billing screen** (server-priced), optionally from "drug given" | The spec (sections 34, 63): a prescription never implies a bill. |
| `tariff_items` | **`services`** (consultation now) | Clearer name; the same role as `medicines` for non-drug chargeables. |
| `RESTRICT` FKs to master data | **`NO ACTION`** | Keeps hospital offboarding cascades working (section 2.5). |

---

## 12. Decisions needed from you

### The two you asked me to flag
- **D-Address.** Single free text, as you specified. Store it on the **patient** (latest wins; recommended) or per visit?
- **D-Names (Feature 4).** A1 / **A2 (recommended)** / A3. Separately: full name vs **first name + initial (recommended)** vs token only on the TV.

### Before Phase 1
| # | Decision | Recommendation |
|---|---|---|
| D2 | Paid toggle backed by bill + payment (section 4.7) rather than a boolean | **Yes.** About a week more, no rework later. |
| D3 | Paid chip default at intake | **Unpaid.** Make it a hospital setting if the pilot collects upfront. |
| D18 | Consultation fee: one per doctor, or also a separate "follow-up" fee? | One per doctor now. `services` already supports a second row per doctor later. |

### Before Phase 2
| # | Decision | Recommendation |
|---|---|---|
| D15 | Can doctors quick-add an **unpriced** medicine from the prescription screen? | **Yes.** The owner prices it later, and an "Unpriced" filter makes that easy. |
| D16 | Who may write or revise a prescription on an encounter? | The **attending doctor** (and an owner-clinician). Any doctor may *read* history, with access logging. |
| D19 | Seed each new hospital with a starter list of ~200 common Indian generics (unpriced)? | **Yes.** It makes search useful on day one. |
| D9 | Can receptionists read clinical history? | **Yes**, logged. The brief has them logging IPD care. |

### Before Phase 3+
| # | Decision | Recommendation |
|---|---|---|
| D1 | After OPD: IPD first or lab first? | IPD first if the pilot admits weekly |
| D17 | Price override on bill items | Columns ship now. Override UI is **owner-only**, with a required reason. |
| D20 | Are IPD medicines billed per "drug given" entry, or added separately at the billing desk? | **Billing desk** (spec section 63). "Drug given" optionally adds the item when the hospital turns that on. |
| D21 | When are OPD consultation bills finalised (numbered)? | When a receipt is printed. Otherwise they are finalised by the nightly encounter-close sweep, so numbering stays continuous. |
| D6 | Beds: free-text ward now, grid in 3b? | **Yes** |
| D7 | Add a `nurse` role? | **Yes.** It keeps "drug given" attribution honest. |
| D8 | Lab tests charged at order or at result? | **At order**, voided automatically if cancelled |
| D10 | Erasure when a final bill exists: anonymise and keep the bill snapshot? | **Yes.** Needs a line in the DPA. |
| D11–D14 | Lab worklist oldest-first; two plan flags; discharge condition wording; pause-reason pick-list | As in v1 |

### Questions for the pilot doctor
1. **Who types prescriptions:** the doctor, or staff copying from the paper slip?
2. How often do they admit patients and order tests?
3. Are they PM-JAY empanelled, and which state are they in?
4. Do they run an in-house pharmacy? Do they already have a price list for medicines?
5. Which printers do they use (A4 or thermal)? Do bills need a letterhead, registration number or GST line?
6. Do emergency patients ever go straight to a bed without an OPD token?
