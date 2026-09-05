# OPD Queue

Turns an opaque physical OPD queue into a trackable digital one, so patients can
leave the waiting room and come back near their turn.

Built for small and medium hospitals in rural and semi-urban India: 150–200 OPD
patients a day, Marathi/Hindi/English, cheap Android phones, unreliable
connections.

## The three surfaces

| Route | Who | What |
|---|---|---|
| `/dashboard` | Reception | Call next, skip, hold, recall, add walk-ins |
| `/q/<token>` | Patient | Position in line, ETA range, no login, three languages |
| `/display/<branchId>` | Waiting room | Now-serving numbers on a TV |

## Running it

```bash
npm install
cp .env.example .env      # then fill in the two database URLs
npm run db:bootstrap      # creates the restricted app role, verifies RLS
npm run db:migrate
npm run db:seed           # a demo hospital with a live queue
npm run dev
```

Seeded sign-in: `owner@demo.hospital` / `demo-opd-queue`.

```bash
npm test              # domain logic, no database, ~0.5s
npm run test:integration   # against a real Postgres
npm run test:all
npm run worker:tick        # drain the notification outbox once
```

Testing WhatsApp needs no Meta account. Set `WHATSAPP_APP_SECRET` to any string,
then post correctly signed, Meta-shaped webhooks at the local server:

```bash
npm run whatsapp:simulate -- --pn <phoneNumberId> --text "Hi"
```

## How it is put together

One Next.js app, one Postgres database, one deploy unit. No Redis, no
websockets, no message broker, no Kubernetes — none of them are needed at the
scale this product operates at, and each would add a failure mode.

- **`lib/domain/`** — queue state machine, ETA, pricing, booking conversation.
  Pure functions, no I/O, fully unit tested. All the rules that matter live here.
- **`lib/services/`** — the same rules against the database, inside transactions.
- **`lib/notify/`** — provider-agnostic messaging. Nothing above this knows Meta
  exists.
- **`app/`** — the three surfaces plus the WhatsApp webhook.

### Things worth knowing before you change something

**Tenant isolation is enforced by Postgres, not by us.** Every tenant table has
a row-level security policy keyed on `app.hospital_id`, which `withTenant()`
sets per transaction. Forgetting a `where hospitalId = …` is a no-rows bug
rather than a cross-tenant leak. Three `SECURITY DEFINER` functions exist solely
to break the bootstrap cycle — resolving a patient link, a login, and an inbound
WhatsApp number each need a hospital before RLS will return anything. Each takes
one identifier and returns one hospital id. Do not add a fourth without a reason.

**The queue serialises on one row.** Every mutation takes `select … for update`
on `doctor_day_states` first. Two receptionists pressing Next at the same instant
is safe because they queue behind that lock, not because of anything in
application code.

**De-duplication is a database constraint.** `UNIQUE (appointment_id, milestone)`
on the outbox means a retry storm physically cannot send a patient two copies of
the same nudge. There is no "have we sent this?" check to get wrong.

**Token numbers are identifiers, not ranks.** Cancelling never renumbers.
Position in line is derived from queue state every time it is asked for.

**Messages per completed appointment is the number that governs the business.**
Budget 3.0, alert at 3.5, circuit breaker at 6.0. It is on `/admin`. The breaker
only ever drops milestone nudges — a patient's token link is never suppressed.

**Prices live in the database.** `plan_tiers` is data, so repricing does not
need a deploy.

**One WhatsApp number per hospital, all on our account.** The hospital never
touches Meta and never sees a message count. Templates are approved per business
account, so twelve approvals cover every hospital rather than twelve each, while
per-number display names mean patients still see their own hospital's name. See
the WhatsApp runbook for why the alternatives fail.

## Documentation

- [`docs/runbooks/whatsapp-setup.md`](docs/runbooks/whatsapp-setup.md) — the
  multi-tenant account strategy, testing with no Meta account, and going live
- [`docs/runbooks/onboarding.md`](docs/runbooks/onboarding.md) — putting this
  into a hospital, and the one thing that decides whether it sticks
- [`docs/runbooks/incidents.md`](docs/runbooks/incidents.md) — restore drills,
  wrong queues, undelivered messages, breaches
- [`docs/compliance.md`](docs/compliance.md) — DPDP posture, what we deliberately
  do not store

## Before production

- Meta business verification and twelve template approvals (four kinds ×
  three languages) — start two weeks ahead, it gates everything
- Re-check Meta's India rate card and update `PAISE_PER_MESSAGE`
- Point a scheduler at `POST /api/internal/tick`
- Run one restore drill and write down how long it took
- Get the Data Processing Agreement reviewed
