# Incident and recovery runbook

## Backups and restore

Neon (and any managed Postgres worth using) keeps point-in-time recovery. That
is not a backup until you have restored from it.

**Monthly restore drill — do not skip this:**

1. Create a branch/restore of the database as of last night.
2. Point `DATABASE_ADMIN_URL` at it in a scratch `.env`.
3. `npm run db:migrate` — should report no pending migrations.
4. `npm run dev` and sign in. Confirm a queue renders with real data.
5. Write down how long the whole thing took. That number is your real RTO.

A restore you have never rehearsed is a restore that will fail at 9am on a
Monday with a waiting room full of people.

## The queue is wrong / a patient was skipped

Queue history is append-only, so the answer always exists.

1. Open **Activity** (`/audit`) as the hospital owner.
2. Find the token. Every state change shows the action, the time, and who did it.
3. If a patient was skipped in error, use **Recall** on the dashboard — it puts
   them back in the waiting line and records the recall as its own event.

Never edit the database to "fix" a queue. The event log is the record of what
happened, and rewriting it destroys the only thing that can settle a dispute.

## Patients are not receiving WhatsApp messages

Work down this list in order:

1. `/admin` → **Delivery problems**. Failed and suppressed messages appear here
   with the provider's error.
2. If messages show as `suppressed`, the circuit breaker tripped: this hospital's
   messages-per-appointment went above 6.0. Milestones are being dropped on
   purpose; token links are not. Find out what is generating the extra messages
   before raising the threshold.
3. `npm run worker:tick` by hand and read the output.
4. If nothing is draining, check that whatever calls `POST /api/internal/tick`
   is still running, and that `INTERNAL_TICK_SECRET` matches.
5. Rows stuck in `sending` for over five minutes are reclaimed automatically on
   the next pass. If they are piling up, the worker is crashing mid-send — check
   the logs before restarting it.

## Meta changed something

Message pricing changed on 1 October 2026 and will change again.

- Nothing above `lib/notify/provider.ts` knows Meta exists. A BSP or a new API
  version is an adapter change, not a queue-engine change.
- The cost assumption lives in one place: `PAISE_PER_MESSAGE` in
  `lib/services/platform.ts`. Update it there and every projection follows.
- Template text lives in `lib/notify/templates.ts` and must match what Meta
  approved. If they diverge, sends fail with a template mismatch.

## Suspected data breach

1. Rotate `APP_DB_PASSWORD` and re-run `npm run db:bootstrap`.
2. Invalidate every session: `delete from sessions;` — everyone signs in again.
3. Pull the access record: `/audit` per hospital, plus `audit_logs` centrally.
4. Notify affected hospitals. Under the DPDP Act you are a Data Processor and
   the hospital is the Data Fiduciary — **they** carry the notification duty to
   patients and to the Board, but they cannot discharge it without you telling
   them promptly and in writing. Say what happened, what data, and when.

## What we do not store

Worth knowing before answering a hospital's security questionnaire: there is no
diagnosis, no prescription, no test result, and no clinical note anywhere in
this system. The patient record is a name, a phone number, and a language.

That is a deliberate design decision, and it is the single biggest reason a
breach here would be survivable.
