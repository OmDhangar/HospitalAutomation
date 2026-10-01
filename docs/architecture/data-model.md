# Data model

How the tables fit together, and the reasoning that keeps them from turning into
one giant "patient" table as modules are added.

## 1. The shape in one picture

```
hospitals ── branches ── doctors ── (doctors.user_id → users: which login is this doctor)
    │
    ├── patients                          identity only: name, phone, age, address
    │     │
    │     ├── appointments ── queue_events       THE QUEUE (existing, unchanged)
    │     │         ▲
    │     │         │ appointment_id (nullable)   ← the only link, and it points one way
    │     │         │
    │     └── encounters                  ONE EPISODE OF CARE — the spine
    │             │
    │             ├── CLINICAL ─────────────────────────────────────────
    │             │     diagnoses            what the doctor concluded
    │             │     clinical_notes       what the doctor observed
    │             │     prescriptions        what the doctor ordered
    │             │       └── prescription_items ──► medicines (+ name snapshot)
    │             │     consultation_drafts  unsaved work, not part of the record
    │             │
    │             └── FINANCIAL ────────────────────────────────────────
    │                   bills                what the hospital charges
    │                     └── bill_items ──► services | medicines (+ price snapshot)
    │                   patient_payments     what the patient paid
    │
    └── CONFIGURATION ──────────────────────────────────────────────────
          services     consultation fees (later: procedures, room, nursing)
          medicines    the medicine catalogue, with selling prices
```

## 2. The encounter is the spine

An **encounter** is one episode of care: one OPD visit today, later one
admission from arrival to discharge. Everything clinical or financial about that
episode hangs off it.

- **It points at the appointment. The appointment never points back.** That
  one-way link is why billing and prescriptions could be added with zero changes
  to the queue, its state machine, or WhatsApp notifications.
- **`appointment_id` is nullable**, because an emergency admission has no token.
- **Created lazily.** The first time anyone taps Paid or opens the consultation
  panel, `openEncounterForAppointmentInTx` (in `lib/services/encounters.ts`)
  creates it. A unique index on `appointment_id` means two people opening the
  same visit at once get the same encounter.
- **`stage`** is `opd` today. It becomes `ipd` on admission (Phase 3). One row
  per episode, not one OPD row plus one IPD row, so there is never a question of
  which row the bill belongs to.

## 3. Keep these separate

This is the most important idea in the model. Four different questions, four
different tables. They are **linked but never merged**:

| Question | Table | Changes when | Example |
|---|---|---|---|
| What does the hospital offer, at what price? | `medicines`, `services` | The owner edits the catalogue | Paracetamol 500 mg, ₹2.00 per tablet |
| What did the doctor order? | `prescriptions` + `prescription_items` | Never. Revised by a new version | 1 tab, 1-0-1, 5 days, after food |
| What was actually given? | `medication_administrations` (Phase 3) | Never. Voided if wrong | 1 tab given at 10:40 by Sister Anita |
| What was charged? | `bills` + `bill_items` | Never once final | 10 tablets × ₹2.00 = ₹20.00 |

Why not one `patient_medications` table with a price column? Because the
answers differ:

- A doctor prescribes 15 tablets. The hospital dispenses 10. The patient buys the
  rest outside.
- The price changes next week. Last week's bill must not.

**A prescription carries no price, and never creates a bill.** Billing reads
the catalogue at billing time.

## 4. Snapshots: copy what must not change

| Row | Copies | Because |
|---|---|---|
| `bill_items` | `description`, `configured_unit_price_paise`, `unit_price_paise`, tax | A price change must never rewrite an issued bill |
| `prescription_items` | `medicine_name`, `strength`, `form` | Renaming a medicine must never change an old prescription |
| `prescriptions` | `prescriber_name` | The printed slip keeps the name that was on it |
| `bills` (at finalisation) | patient name, phone, address, totals | The bill is reproducible years later |

Each snapshot sits **beside** the canonical foreign key (`medicine_id`,
`service_id`), not instead of it. You can still ask "every prescription of this
medicine".

## 5. Records that cannot be edited

Enforced by triggers in the migrations, not by convention:

| Table | Allowed changes | Correction is |
|---|---|---|
| `bill_items` | Insert or void, only while the bill is `draft` | Void + new item |
| `bills` | Anything while `draft`; `final` → `cancelled` only | Cancel + new bill |
| `patient_payments` | Void only | Void + new payment |
| `diagnoses`, `clinical_notes` | Void only | Void (reason "Revised") + new row |
| `prescriptions` | `final` → `superseded` only | New prescription with `supersedes_prescription_id` |
| `prescription_items` | Insert only, in the transaction that created the prescription | Revise the prescription |
| `queue_events`, `record_access_logs` | Nothing: append-only | — |

**DELETE is still allowed**, on purpose. Erasure on request is a legal duty under
India's DPDP Act, and offboarding a hospital cascades through every table.

The prescription-items trigger uses a neat property of Postgres. `now()` returns
the **start time of the current transaction**, and `prescriptions.created_at`
defaults to `now()`. So `created_at = now()` is true only inside the
transaction that created the prescription. Once that transaction commits, no
item can ever be added.

## 6. Drafts are not records

The consultation panel autosaves every 1.5 s. Those saves go to
`consultation_drafts`: one mutable row per encounter, versioned, deleted at
Save. Putting them in the clinical tables would fill the record with every
half-typed word, and the clinical tables are append-only anyway.

The `version` column refuses a stale write. If the doctor has the visit open on
a laptop and a tablet, the second device is told "changed on another screen"
instead of silently overwriting.

## 7. Foreign keys that carry the tenant

Foreign-key checks **ignore row-level security**. With a plain
`encounter_id REFERENCES encounters(id)`, a row in hospital A could point at
hospital B's encounter if someone had the id. So child tables reference their
parent by the pair:

```sql
FOREIGN KEY (hospital_id, encounter_id, patient_id)
  REFERENCES encounters (hospital_id, id, patient_id)
```

One constraint guarantees the same hospital **and** the same patient. The
unique indexes named `*_tenant_key` exist to be the targets of these keys.

## 8. NO ACTION, not RESTRICT

Keys that protect history, like a prescription item pointing at a medicine or a
bill item pointing at a service, use the default `NO ACTION`. Both `NO ACTION`
and `RESTRICT` refuse to delete a referenced row. The difference is when they
check:

- `RESTRICT` checks immediately, in the middle of a statement.
- `NO ACTION` checks at the end of the statement.

Deleting a hospital cascades through every table in no guaranteed order.
`RESTRICT` would fail halfway through that cascade. `NO ACTION` lets it complete.
Medicines and doctors are **deactivated** (`active = false`), never deleted.

## 9. Money

Integer paise everywhere (`selling_price_paise`, `total_paise`). Tax rates are
basis points (`1800` = 18%). All arithmetic lives in
`lib/domain/patient-billing.ts#calculateBillItem`, rounds half-up, and is
stored. A `CHECK` constraint re-verifies `total = subtotal − discount + tax`
on every row, so no code path can store arithmetic that doesn't add up.

## 10. Adding a module later

The model was designed so these slot in without restructuring:

| Module | Adds | Touches existing tables |
|---|---|---|
| IPD (Phase 3) | `admissions`, `medication_administrations`, `discharge_summaries` | New nullable column on `bill_items` |
| Lab (Phase 4) | `lab_orders`, `lab_order_items`, `lab_results` | New enum value + column on `bill_items` |
| Pharmacy | `medicine_batches`, `stock_movements`, `dispensations` | None; dispensations point at prescription items |
| Room charges | `wards`, `beds`, `bed_assignments` | New enum values |
| Insurance | `encounter_payers`, `claims` | Nullable column on `patient_payments` |
