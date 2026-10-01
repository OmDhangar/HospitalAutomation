# Architecture guide

Start here if you are new to the codebase. This folder explains **how the system
is built and why**, so that new code fits the shape of the old.

| Read | When |
|---|---|
| **This page** | First. The layers, the request lifecycle, and the rules everything follows |
| [data-model.md](data-model.md) | Before touching the database: the encounter spine, clinical vs financial records |
| [security.md](security.md) | Before writing any query or server action: tenancy, roles, clinical access |
| [migrations.md](migrations.md) | Before writing a migration. It runs against a live hospital's data |
| [decisions.md](decisions.md) | When you wonder "why is it like this?". The decision log |
| [progress.md](progress.md) | What has been built, phase by phase, and what is next |

The product brief and the full roadmap are in
[../plans/hms-expansion-plan.md](../plans/hms-expansion-plan.md).

---

## 1. What the system is

A multi-tenant SaaS for small hospitals in India. It started as an OPD queue:
walk-ins, tokens, WhatsApp booking, a waiting-room TV. It is growing into a
hospital system: billing, then prescriptions, then admissions (IPD), then lab.

Every hospital is a **tenant**. They all share one database, and every
tenant-owned row carries a `hospital_id`.

**One Next.js app, one Postgres database, one deploy.** No Redis, no queues, no
microservices. That is deliberate: it is run by one person, at a scale where
Postgres does all of it comfortably.

## 2. The three layers

Every feature is built from the same three layers, and code only calls
*downwards*:

```
app/            UI and server actions        "who is asking, and what did they click?"
  │
  ▼
lib/services/   database + transactions      "do it, correctly, inside one transaction"
  │
  ▼
lib/domain/     pure business rules          "what are the rules?" — no database, no React
```

| Layer | Contains | Must not contain | Example |
|---|---|---|---|
| `lib/domain/` | Validation, calculations, state machines, the permission matrix | Database calls, React, `fetch` | `patient-billing.ts` computes a bill line in integer paise |
| `lib/services/` | `withTenant(...)` transactions, queries, locking, audit rows | UI concerns, session cookies | `consultations.ts` saves diagnosis + notes + prescription in one transaction |
| `app/` | Pages, server actions, route handlers, components | Business rules, raw SQL | `consultation-actions.ts` authenticates, calls the service, maps errors to messages |

**Why:** domain code can be unit-tested in milliseconds with no database
(`npm test`). Services are tested against a real Postgres (`npm run test:integration`).
The UI stays thin, so a rule never lives in a React component where a direct
POST could skip it.

## 3. Life of a request

Here is what happens when a doctor presses **Save** on a consultation:

```
Browser (consultation-panel.tsx)
  └─ calls server action saveConsultationDynamic(...)            app/(app)/dashboard/consultation-actions.ts
       ├─ requireWritableSession()   → who is this? may they write at all?
       └─ saveConsultation(...)                                  lib/services/consultations.ts
            ├─ parseConsultation(input)   → validate and tidy    lib/domain/consultation.ts
            └─ withTenant(hospitalId, tx => …, { clinical: true })   lib/db/index.ts
                 ├─ set_config('app.hospital_id', …)      ← row-level security now filters every query
                 ├─ set_config('app.clinical_access', …)  ← clinical tables now visible
                 ├─ lock the encounter row (SELECT … FOR UPDATE)
                 ├─ check this user is the visit's attending doctor
                 ├─ re-read every medicine from the catalogue (never trust names from the browser)
                 ├─ write diagnosis, notes, prescription, items, audit row
                 └─ COMMIT, or ROLLBACK everything on any error
```

Three things to notice:

1. **The session decides the hospital, never the request body.** `hospitalId`
   always comes from `session.hospitalId`.
2. **Every query runs inside `withTenant`.** Postgres row-level security then
   filters by hospital. Forgetting a `WHERE hospital_id = …` is a no-rows bug,
   not a data leak. See [security.md](security.md).
3. **One user action is one transaction.** Either the whole consultation is
   saved or none of it is.

## 4. The rules everything follows

These run through the whole codebase. New code should follow them too.

1. **The database enforces what must never be wrong.** Tenant isolation is
   row-level security. "A bill item is billed once" is a unique index. "A saved
   prescription never changes" is a trigger. Application code is the first line,
   never the only one.
2. **Records are corrected, not edited.** Money and clinical rows are voided
   (with who, when and why) and replaced. They are never updated in place. A
   printed prescription or bill can always be reproduced exactly.
3. **Copy what must not change.** A bill line copies the price it was charged
   at. A prescription line copies the medicine's name. Later edits to the
   catalogue never rewrite history.
4. **Extend, don't modify.** New modules point *at* existing tables and never
   change them. Billing and prescriptions reference an appointment. The queue
   code does not know they exist.
5. **Money is integer paise.** Never floats. `₹2.50` is `250`.
6. **Explain why, not what.** Comments in this codebase say why something is
   the way it is. That is what the next person needs.

## 5. Where things live

```
app/
  (app)/dashboard/        reception + doctor dashboard, queue actions, consultation panel
  (app)/settings/         hospital configuration (doctors, fees, medicines, WhatsApp)
  print/prescription/     printable prescription (outside the app shell on purpose)
  api/                    route handlers: WhatsApp webhook, medicine search, payments
  q/[token]/              patient's public queue page (no login)
  display/[branchId]/     waiting-room TV
components/               shared UI (ui.tsx primitives, paid-toggle, clinical/*)
lib/
  domain/                 pure rules: queue, booking, billing, permissions, consultation, medicine
  services/               transactions: queue, patient-billing, encounters, consultations, medicines
  db/                     schema.ts (Drizzle), withTenant(), request context
  notify/                 WhatsApp outbox worker
drizzle/                  SQL migrations (hand-written) + meta/_journal.json
scripts/                  migrate, bootstrap, seed, worker, verify-migrations
docs/                     this guide, runbooks, compliance, plans
```

## 6. Adding a feature: the recipe

Say you are adding IPD progress notes. The same steps work for any feature:

1. **Rules first.** Add the validation and any calculation to `lib/domain/`,
   with unit tests in `lib/domain/__tests__/`.
2. **Migration.** Add a table with `hospital_id`, RLS, and the read-only
   policies (plus `clinical_access` if it holds medical content). Follow the
   checklist in [migrations.md](migrations.md).
3. **Schema.** Mirror the table in `lib/db/schema.ts`.
4. **Service.** Add functions to `lib/services/` that run inside `withTenant`
   (`{ clinical: true }` for clinical data), lock what they change, and write an
   audit row.
5. **Permission.** Add an entry to the matrix in `lib/domain/permissions.ts`.
   Check it in the action with `can(role, …)`.
6. **Action + UI.** A thin server action in `app/`, a component that shows
   only what the server returned.
7. **Integration test.** Prove the guarantees against a real database:
   isolation, immutability, atomicity.
8. **Rehearse the migration** on a scratch database before it touches real data
   ([migrations.md](migrations.md)).

## 7. Commands

| Command | What it does |
|---|---|
| `npm run dev` | Local dev server |
| `npm test` | Unit tests (domain, no database) |
| `npm run test:integration` | Service + database tests (needs `DATABASE_URL`) |
| `npm run typecheck` | TypeScript |
| `npm run db:migrate` | Apply migrations (uses `DATABASE_ADMIN_URL`) |
| `npx tsx scripts/verify-migrations.mts create\|drop` | Throwaway database to rehearse migrations |
