# Security model

Four layers, from the outside in. Each assumes the one outside it might fail.

```
1. Session            who are you?                         lib/auth/session.ts
2. Permission         may your role do this?               lib/domain/permissions.ts  → can(role, …)
3. Tenant isolation   is this row your hospital's?         Postgres row-level security
4. Clinical key       may this transaction see medical records?   Postgres, 0028_clinical_opd.sql
```

## 1. Sessions

`requireSession()` resolves the cookie to a user, a hospital and a role.
`requireWritableSession()` also refuses read-only sessions. **Every server
action and route handler calls one of them first.** Server actions are
reachable by a direct POST, not only through the UI.

The hospital always comes from the session, never from the request.

## 2. Permissions: one matrix

`lib/domain/permissions.ts` answers every "may this role do X?" question:

```ts
can(session.role, 'billing.collect')   // → true for owner and receptionist
```

| Permission | Owner | Reception | Doctor |
|---|:-:|:-:|:-:|
| `queue.mutate` | ✓ | ✓ | ✓ |
| `hospital.configure` | ✓ | | |
| `reports.view` | ✓ | ✓ | |
| `billing.collect` (take payment) | ✓ | ✓ | |
| `billing.price` (set prices) | ✓ | | |
| `clinical.read` (logged) | ✓ | ✓ | ✓ |
| `clinical.write` | ✓* | | ✓* |
| `medicines.manage` | ✓ | | |
| `medicines.quickAdd` (unpriced) | ✓ | | ✓ |

\* Plus the attending-doctor rule below.

**Everything is an allow-list.** The older code had checks like
`role !== 'doctor'`, which quietly give a future "nurse" or "lab" role
everything the author forgot to exclude. The matrix is typed so that adding a
role to `STAFF_ROLES` does not compile until someone decides what it can see.

**Taking money is not setting prices.** Reception can mark a patient paid, but
only the owner decides what a consultation or a tablet costs.

### The attending-doctor rule

The `clinical.write` role check is necessary but not enough. A consultation can
only be written by **the login linked to that visit's doctor**
(`doctors.user_id`, set in Settings → Doctors). An owner can write their own
patients' records and nobody else's. This lives in
`lib/services/consultations.ts` (`writeRefusal`).

## 3. Tenant isolation: row-level security

Every table with a `hospital_id` has this policy (first in `0001_rls.sql`):

```sql
USING      (hospital_id = nullif(current_setting('app.hospital_id', true), '')::uuid)
WITH CHECK (hospital_id = nullif(current_setting('app.hospital_id', true), '')::uuid)
```

`withTenant(hospitalId, fn)` (in `lib/db/index.ts`) opens a transaction and sets
`app.hospital_id` for it. Every query inside only sees that hospital's rows.
Consequences:

- **Forgetting a filter returns nothing, not someone else's data.**
- No tenant set means no rows at all (fail closed).
- `FORCE ROW LEVEL SECURITY` makes the policy apply to the table owner too.
- The web app connects as a restricted role (`opd_app`) that cannot bypass RLS.
  Migrations and the worker use the admin role, which can bypass it. Never
  serve a web request with the admin role.

A test in `lib/db/__tests__/rls.integration.test.ts` asserts that **the set of
tenant tables without these policies is empty**. It found two real gaps
(`doctor_slot_overrides`, `doctor_interval_blocks`, fixed in 0027). A new table
that forgets its policy fails that test.

### Support sessions are read-only

A platform operator can open a support session into a hospital
(`lib/services/impersonation.ts`). It is always read-only: `app.read_only` is
set, and a restrictive policy on every table refuses every write. It expires in
30 minutes and is logged in the hospital's own audit log.

## 4. The clinical key

Diagnoses, notes, prescriptions and drafts carry one more restrictive policy:

```sql
CREATE POLICY clinical_access ON prescriptions AS RESTRICTIVE
  USING (public.app_clinical_access()) WITH CHECK (public.app_clinical_access());
```

`app.clinical_access` is true only when **both** of these hold:

1. The service asked for it: `withTenant(id, fn, { clinical: true })`.
2. The request is not read-only, which every support session is.

So clinical rows are **invisible by default**: to reports, exports, the public
queue page, the waiting-room TV, and support staff, whichever code path they
reach. Only `lib/services/consultations.ts` passes `{ clinical: true }`. If you
add a module that reads medical content, pass it there too. And ask whether that
code path should be able to read medical records at all.

## 5. What the browser is never trusted with

| The browser sends | The server does |
|---|---|
| A medicine id on a prescription | Re-reads the medicine under RLS; snapshots *its* name, not a name from the client |
| "Mark paid" | Reads the fee from `services` itself; the request carries no amount |
| Any id (appointment, encounter, bill) | Reads it under RLS, so another hospital's id is simply "not found" |
| A draft | Parses its shape and caps its size before storing |

The doctor's medicine search (`/api/medicines/search`) returns **no price
field**. Prices are left out of the response, not hidden in the UI.

## 6. Logs

| Log | Records | Used for |
|---|---|---|
| `audit_logs` | Logins, configuration, price changes (with old and new amounts), payments, prescriptions saved and revised | "Who changed this?" |
| `queue_events` | Every token movement | "Who moved this token, when?" |
| `record_access_logs` | Every view of a patient's history, and every prescription print | "Who looked at this patient's record?" (DPDP) |

Audit logs record **that** something happened and **to which record**. They never
record the clinical content itself.

## 7. Before you merge: a checklist

- [ ] Does the server action call `requireSession`/`requireWritableSession` and `can(...)`?
- [ ] Does every query run inside `withTenant`?
- [ ] Does a new table have `hospital_id`, RLS, FORCE, and the read-only policies?
- [ ] Does it hold medical content? Then add `clinical_access`, and use `{ clinical: true }` only where needed.
- [ ] Are ids from the client re-read under RLS, and prices read on the server?
- [ ] Is anything that must not change protected by a trigger, not just by code?
