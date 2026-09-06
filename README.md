# QueueCare — OPD queue and patient flow platform

A multi-tenant SaaS that turns a hospital's opaque physical outpatient queue into
a trackable digital one, so patients can leave the waiting room and come back
near their turn instead of standing in a corridor for three hours.

Built for small and medium hospitals in rural and semi-urban India: 150–200
outpatients a day, Marathi/Hindi/English, budget Android phones, unreliable
connections.

**Next.js 16 · React 19 · TypeScript · PostgreSQL · Drizzle · WhatsApp Cloud API
· Tailwind 4 · Vitest**

---

## The problem

The bottleneck in a high-volume Indian OPD is not booking. It is **uncertainty**.
A patient has no idea whether their turn is in twenty minutes or three hours, so
they do not dare leave the building. By 10am the corridor is full, reception is
answering "how much longer?" instead of registering patients, and consultations
are being interrupted by people putting their head round the door.

Nothing here is a scheduling problem. It is an information problem.

## What it does

Three surfaces, one codebase, one database.

| Route | Who uses it | What it does |
|---|---|---|
| `/dashboard` | Reception | One-button queue control: call next, skip, hold, recall, priority insert, walk-in registration |
| `/q/<token>` | Patient | Live position in the queue. No app, no login, three languages |
| `/display/<branch>` | Waiting room | Now-serving numbers on a TV, readable across the room |

Plus `/reports` (operational statistics for the hospital owner), `/audit`
(who moved which token, when), `/settings` (hospital, doctors, WhatsApp), and
`/admin` (platform operator view across all tenants).

A patient messages the hospital's WhatsApp number, picks a doctor and a time from
tappable menus, and receives a token with a link to a live queue page. Reception
presses *Call next*. When the patient is close to the front, they get one nudge
telling them to come back.

## Status

Pre-pilot. The platform is feature-complete for a first hospital and runs
end-to-end against Meta's live WhatsApp API — bookings placed from a real phone
create real appointments. It has **no production users yet**, and no outcome
metrics, because nothing has been measured in a real waiting room.

Everything below describes what is built and tested, not results it has produced.

---

## Architecture

One Next.js application, one Postgres database, one deploy unit. No Redis, no
websockets, no message broker, no Kubernetes. At the scale this product operates
at — roughly 40 requests/second across a hundred hospitals — each of those would
add a failure mode and buy nothing.

```
lib/domain/     Pure business rules. No I/O, no database, no framework.
                Queue state machine, ETA model, pricing, booking conversation,
                phone normalisation. Fully unit tested in ~1 second.

lib/services/   The same rules against Postgres, inside transactions.
                Tenant-scoped through withTenant().

lib/notify/     Provider-agnostic messaging. Outbox worker, template
                definitions, Meta adapter, error classification.
                Nothing above this layer knows Meta exists.

app/            Three UI surfaces, the WhatsApp webhook, the worker trigger.
```

The separation is load-bearing: every rule that would be expensive to get wrong
lives in `lib/domain` as a pure function, which is why the fast test suite can
prove queue invariants, message costs and billing arithmetic without a database.

---

## Engineering decisions worth reading

These are the parts of the codebase that took real thought.

### Tenant isolation is enforced by Postgres, not by application code

Every tenant table carries a row-level security policy keyed on a
`app.hospital_id` setting that `withTenant()` sets per transaction. Forgetting a
`where hospitalId = …` becomes a **no-rows bug rather than a cross-tenant leak**
— the difference between an annoyed user and a reportable data breach.

The application database role cannot bypass RLS, and `npm run db:bootstrap`
refuses to finish if it can. Tests run the isolation suite with the policies
deliberately bypassed to prove RLS is what is actually stopping the query, rather
than some accident of the `WHERE` clause.

Three `SECURITY DEFINER` functions exist to break the resulting bootstrap cycle:
opening a patient's queue link, resolving a login, and attributing an inbound
WhatsApp message all need a hospital id *before* RLS will return anything. Each
takes one identifier and returns exactly one hospital id, and nothing else.

### The queue serialises on a single row

Two receptionists pressing *Call next* at the same instant must not advance the
queue twice. Rather than application locks or optimistic retries, every mutation
takes `SELECT … FOR UPDATE` on that doctor's row in `doctor_day_states` first.
Concurrent writers queue behind one row lock.

An integration test fires three simultaneous `Call next` requests at a live
database and asserts the queue advanced exactly three positions and emitted
exactly three events.

### De-duplication is a database constraint, not a code path

A `UNIQUE (appointment_id, milestone)` index on the notification outbox means a
retry storm **physically cannot** send a patient two copies of the same nudge.
There is no "have we already sent this?" check to get wrong, and correctness
survives crashes, concurrency and redelivery.

The same idea appears in a partial unique index that permits one active token per
patient per doctor per day — which caught a real double-tap during live testing.

### Message cost is designed, not discovered

WhatsApp is the dominant variable cost. The strategy is that **the web app is the
continuous channel and WhatsApp is the event channel**: a patient can refresh
their queue page a hundred times for free.

The booking conversation is engineered to four messages for a first-time patient
and three for a returning one, because language is stored against the patient
rather than the conversation. A test replays real conversations and asserts those
counts, so adding a message to the flow fails CI.

Beyond that:

- **`messages_sent / completed_appointments`** is tracked per tenant as the
  margin canary. Budget 3.0, alert 3.5, circuit breaker at 6.0.
- The breaker drops milestone nudges only. A patient's token link is never
  suppressed — someone who does not know their token has been actively harmed.
- Repeated prompts are budgeted: five taps of "Hi" produce one menu, because
  WhatsApp keeps the previous list tappable and resending it costs money while
  adding nothing. A daily cap stops a malicious sender running up the bill.
- Actual Meta invoices are recorded and reconciled against the estimate, because
  the utility rate falls with volume and a flat assumption misstates margin.

### The ETA is deliberately imprecise

Wait time is a median of the last fifty consultations for that specific doctor,
never a mean — one forgotten *Complete* click would otherwise poison the model.
It is presented as a **range that widens when confidence is low** (±50% under
five samples, ±25% over twenty), and the page leads with *"N patients ahead of
you"*, the one number that is always literally true and that a patient can verify
by looking around the room.

A regression test asserts the window never begins in the past — an earlier
version rounded the start down to a five-minute boundary and told patients their
window had already opened.

### Provider abstraction that earned its keep

Nothing above `lib/notify/provider.ts` knows Meta exists. That paid off twice:
when Meta made service messages billable in October 2026, and when the queue link
had to move from message body to URL button after Meta's classifier rejected it
as `INCORRECT_CATEGORY` — links in a body read as marketing, which costs several
times more than utility.

Meta's error codes are classified into permanent and transient. A patient with no
WhatsApp account will still have no WhatsApp account on the fifth retry, so that
send fails immediately instead of occupying the queue for half an hour.

### Consent is a code path, not a policy document

`patients.whatsapp_opt_in_at` gates every outbound message. Reception records
what the patient agreed to; a patient who messages the hospital first has opted
in by doing so. Declining still issues a token and a printed QR code — they
simply are not messaged. Consent is dated once and never silently refreshed.

---

## Data model

22 tables across 13 migrations. Grouped by concern:

- **Tenancy** — `hospitals`, `branches`, `plan_tiers`
- **Identity** — `users`, `sessions`, `staff_memberships` (sessions are scoped to
  a hospital, which is also how a multi-hospital user will pick one at login)
- **Clinical operations** — `doctors`, `doctor_schedules`,
  `doctor_schedule_exceptions`, `patients`
- **Queue** — `appointments`, `queue_events` (append-only), `doctor_day_states`
- **Messaging** — `whatsapp_numbers`, `whatsapp_conversations`,
  `notification_outbox`
- **Commerce** — `usage_records`, `provider_invoices`, `demo_requests`
- **Infrastructure** — `jobs`, `idempotency_keys`, `audit_logs`

Queue and audit history are append-only, enforced by database triggers. `DELETE`
remains permitted — erasure on request is a data-protection obligation, and
blocking it would also break tenant offboarding.

**The patient record is a name, a phone number and a language.** There is no
diagnosis field, no prescription, no test result, and no place to put one without
a deliberate migration. That is the single largest privacy control in the system.

---

## Testing

97 unit tests run in about a second with no database. The rest run against a real
Postgres, because the things they prove cannot be mocked meaningfully.

| Suite | Proves |
|---|---|
| `lib/domain/` | Queue transitions and invariants, ETA behaviour, pricing and billing arithmetic, booking message counts, phone normalisation |
| `lib/db/rls.integration` | Tenant isolation, including with policies deliberately bypassed |
| `lib/services/queue.integration` | Concurrent `Call next`, token allocation under parallel registration, milestone de-duplication, consent gating |
| `lib/services/booking.integration` | Full WhatsApp booking, replay protection, prompt budgeting, cross-tenant doctor rejection |

Several tests encode business constraints rather than code behaviour — the
pricing suite fails if any plan tier drops below 55% contribution margin at the
message budget, which turns a spreadsheet assumption into something CI enforces.

```bash
npm test              # domain logic, no database, ~1s
npm run test:integration
npm run test:all
```

---

## Running it

```bash
npm install
cp .env.example .env      # fill in two database URLs
npm run db:bootstrap      # creates the restricted app role, verifies RLS
npm run db:migrate
npm run db:seed           # demo hospital with a live queue and history
npm run dev
```

Sign in as `owner@demo.hospital` / `demo-opd-queue`.

**Testing WhatsApp needs no Meta account.** Set `WHATSAPP_APP_SECRET` to any
string and post correctly signed, Meta-shaped webhooks at the local server:

```bash
npm run whatsapp:simulate -- --pn <phoneNumberId> --text "Hi"
npm run whatsapp:simulate -- --pn <phoneNumberId> --reply lang:mr
npm run whatsapp:simulate -- --pn <phoneNumberId> --reply doc:<doctorId>
npm run whatsapp:simulate -- --pn <phoneNumberId> --reply slot:now
```

Everything downstream of the HTTP request is the real path — signature
verification, tenant resolution, replay protection, the booking state machine,
consent, the outbox. Only the sender is pretended.

### Other scripts

```bash
npm run worker:tick               # drain the notification outbox once
npm run whatsapp:templates        # print / --submit / --status / --fix
npm run report:monthly            # owner summaries for the previous month
```

---

## Multi-tenant WhatsApp strategy

Worth its own note, because it is the decision that makes onboarding viable.

**One Meta Business Manager, one business verification, one phone number per
hospital.** Templates are approved per business account, so nine approvals cover
every hospital rather than nine each; display names are per number, so patients
see their own hospital's name rather than ours; quality ratings are per number,
so one hospital's problems stay theirs.

Giving each hospital its own account would require them to verify a business with
Meta and collect their own nine approvals — no semi-urban hospital will do that.
Putting every hospital behind one shared number would make inbound messages
unattributable and pool everyone's sender reputation.

Full reasoning in [`docs/runbooks/whatsapp-setup.md`](docs/runbooks/whatsapp-setup.md).

---

## Documentation

- [`docs/runbooks/whatsapp-setup.md`](docs/runbooks/whatsapp-setup.md) — account
  strategy, testing without Meta, what Meta's template review actually enforces
- [`docs/runbooks/onboarding.md`](docs/runbooks/onboarding.md) — putting this into
  a hospital, and the one thing that decides whether it sticks
- [`docs/runbooks/incidents.md`](docs/runbooks/incidents.md) — restore drills,
  disputed queues, undelivered messages, breach response
- [`docs/compliance.md`](docs/compliance.md) — data protection posture, and what
  the schema deliberately refuses to store

---

## What is not built yet

Stated plainly, because a README that only lists strengths is not useful:

- **The landing page is incomplete.** `app/(marketing)/` has the demo-request
  action and UI mockups but no page or layout, and `app/page.tsx` still redirects
  to `/login`. The `demo_requests` table is in the schema with no migration
  generated for it.
- **No automated overage billing.** Usage is metered; invoices are produced by
  hand, which is correct below roughly twenty customers.
- **No SMS fallback**, no HMS/EMR integration, no native app. All deliberate.
- **No production deployment.** Runs locally and against managed Postgres.
al/tick`
- Run one restore drill and write down how long it took
- Get the Data Processing Agreement reviewed
