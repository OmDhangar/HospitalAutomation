# Writing and shipping migrations

The production database holds a live pilot hospital's patients. A migration is
the one change that a redeploy cannot undo. So migrations here are
**hand-written, reviewed, and rehearsed** before they run for real.

## 1. Anatomy of a migration

Each migration is three edits:

1. **`drizzle/00NN_short_name.sql`**: the SQL. Hand-written, with comments that
   explain *why*. Separate statements with `--> statement-breakpoint`.
2. **`drizzle/meta/_journal.json`**: add an entry with the next `idx`, the same
   `tag` as the file name, and a `when` larger than the previous one.
3. **`lib/db/schema.ts`**: mirror the tables in Drizzle so queries are typed.

Migrations since 0016 are written by hand, not by `drizzle-kit generate`. The
generator doesn't know about row-level security, triggers, or composite
tenant keys. Migration 0015 was generated, and that is how two tables shipped
without tenant isolation (fixed in 0027).

**Never edit a migration that has already been applied.** Write a new one.

## 2. Checklist for a new table

```sql
CREATE TABLE things (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,   -- ① always
  encounter_id UUID NOT NULL,
  patient_id UUID NOT NULL,
  …,
  CONSTRAINT things_encounter_fk FOREIGN KEY (hospital_id, encounter_id, patient_id)
    REFERENCES encounters (hospital_id, id, patient_id) ON DELETE CASCADE  -- ② tenant-safe key
);
```

- [ ] ① `hospital_id NOT NULL … ON DELETE CASCADE`
- [ ] ② Children reference parents by `(hospital_id, …)`. See [data-model.md §7](data-model.md).
- [ ] ③ In the `DO $outer$ … FOREACH` block, the table gets ENABLE and FORCE RLS,
      `tenant_isolation`, `read_only_write`, and `read_only_delete`. Copy the
      block from `0026_billing_foundation.sql`.
- [ ] ④ Medical content? Also add the `clinical_access` policy (see `0028_clinical_opd.sql`).
- [ ] ⑤ Rows that must never change? Add a guard trigger. Reuse `void_only_guard()`
      and `only_user_refs_cleared()` / `is_one_way_void()` (defined in 0026 and 0028).
- [ ] ⑥ References to master data (medicines, doctors, services): leave the
      default `NO ACTION`, not `RESTRICT`. See [data-model.md §8](data-model.md).
- [ ] ⑦ Indexes for the queries you will actually run, including partial indexes
      (`WHERE voided_at IS NULL`) for the hot paths.
- [ ] ⑧ The RLS guard test in `lib/db/__tests__/rls.integration.test.ts` will fail
      if you miss ③. Run it.

## 3. Gotchas we have hit

| Gotcha | What happens | Do this |
|---|---|---|
| `ALTER TYPE … ADD VALUE` | Postgres can't *use* a new enum value in the transaction that added it | Put the `ADD VALUE` in its own migration file, before the one that uses it |
| A new SQL function called by a policy | `REVOKE … FROM PUBLIC` means the app role can't call it, so every query fails | Add it to the grant list in `scripts/migrate.ts` and `scripts/verify-migrations.mts` |
| New tables and the app role | The app role only gets access to new tables through **default privileges** | Already configured in production (`ALTER DEFAULT PRIVILEGES … TO opd_app`). Verify with `has_table_privilege` after migrating |
| `ON DELETE SET NULL` on a frozen table | The nulling is an UPDATE, so the freeze trigger refuses it | Guard triggers allow user-id columns to become NULL (`only_user_refs_cleared`); use `NO ACTION` for other references |

## 4. Rehearse, then apply

```bash
# 1. Build a throwaway database next to the real one and apply every migration from 0000
npx tsx scripts/verify-migrations.mts create

# 2. Point the integration suite at it (these commands swap only the database name)
ADMIN=$(grep ^DATABASE_ADMIN_URL= .env | cut -d= -f2- | sed 's#/neondb?#/qurio_scratch?#')
APP=$(grep ^DATABASE_URL= .env | cut -d= -f2- | sed 's#/neondb?#/qurio_scratch?#')
DATABASE_ADMIN_URL="$ADMIN" DATABASE_URL="$APP" npm run test:integration

# 3. Throw it away
npx tsx scripts/verify-migrations.mts drop

# 4. Only now, apply to the real database
npm run db:migrate
```

After step 4, check the new tables from the app role's point of view:

```sql
select has_table_privilege('opd_app', 'your_table', 'INSERT');   -- expect true
```

## 5. Numbering

| # | What |
|---|---|
| 0025 | `patients.address` |
| 0026 | Billing foundation: encounters, services, bills, bill_items, patient_payments |
| 0027 | RLS for `doctor_slot_overrides` and `doctor_interval_blocks` (security fix) |
| 0028 | OPD clinical records: medicines, diagnoses, notes, prescriptions, drafts, access log, clinical key |

The roadmap in `docs/plans/hms-expansion-plan.md` uses planned numbers. The
real numbers are the ones in `drizzle/meta/_journal.json`.

**Numbering rules from Oct 2026** (see [../plans/ipd-sheets-plan.md](../plans/ipd-sheets-plan.md) §9 and §11):

- **0040 is reserved** for `drizzle/pending/0040_patient_identity_enforce.sql`. New migrations
  start at **0041** and follow the build order in the IPD sheets plan.
- **Order is decided by the journal `when`, not by the file number.** Drizzle applies only entries
  whose `when` is newer than the last applied one, and skips older ones *silently*. Every new
  entry gets `when = max(existing when) + 50000000`. When 0040 is promoted it goes at the **end**
  of the journal with the largest `when`.
- **No new enum values** in new work: use `text` + `CHECK`. `ALTER TYPE … ADD VALUE` cannot be
  used in the transaction that adds it.
- The migration runner v2 (plan phase A1) applies **one migration per transaction**, so every new
  migration must be **idempotent** (`IF NOT EXISTS`, `CREATE OR REPLACE`, guarded `DO` blocks) and
  is run twice in CI.
