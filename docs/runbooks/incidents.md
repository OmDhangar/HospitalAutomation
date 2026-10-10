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

## A lab says nobody told them, or a test was "never called"

Test follow-up (module **Test follow-up**) keeps every order, call and step.

1. As the owner open **Tests → Today** for that day: the lab's row shows tasks raised and raised to
   the admin; **By person** shows who called; **Pending** lists every test still open with its last
   call.
2. For one test, **Accountability** → filter **Tests and follow-up**, or open its History: order,
   payment, task raised, escalation (by the system), each call with its outcome and caller, and each
   step with who did it.
3. No task raised at all? Check the test has a lab (Settings → Tests and labs → Which test is done
   where), the lab is open, and — for a "from payment" lab — that the visit was marked Paid. The
   worker logs `[sweeps] test follow-up failed` if the sweep itself is failing.
4. A test ordered by mistake: the ordering doctor or the owner cancels it (dashboard card or Today →
   Cancel test). Never edit `test_orders`; the database refuses it.

## A nurse cannot give a risk-class dose, or a dose shows a flag

The treatment card (module **Treatment card and MAR**) records why.

1. **Refused** only happens in the `enforce` stage (Settings → Modules). The message says what is
   missing: the doctor's countersign on a telephone order, the bed code (type the code on the bed
   label, or give it on the ward tablet), or a witness.
2. **No bed code on the label?** Owner: Settings → IPD → Print bed codes. Codes never change once
   given; a lost label is reprinted with the same code.
3. **Witness not coming:** the dose is already saved. The nurse taps "Ask witness" on it to name
   someone else, or uses the ward tablet. After 15 minutes the dose carries "Witness not there in
   15 min"; that flag stays even if witnessed later.
4. **Flags** (in observe or warn) are not errors: they are the record of what a rule found missing.
   Review them in Accountability → Treatment and MAR, or the dose's History.
5. Never edit `treatment_orders` or `mar_administrations`; strike out and record again (the database
   refuses edits).

## Time-critical alerts are not showing, or doses show as late or missed

1. **Stage** (Settings → Modules → Treatment card and MAR): in `observe` escalations are only counted
   (IPD → Dose timing shows "would"); `warn` shows the ward alert (L1); `enforce` also shows the
   doctor alert (L2) and asks for a reason on late or early doses.
2. **Signed list:** Settings → Treatment timing must say the time-critical list is signed. Any change
   to the list or its windows clears the sign-off; until a doctor signs again nothing is treated as
   time-critical (doses use the normal window, no alerts).
3. **Who gets them:** L1 goes to the ward's nurse in charge and anyone on that ward; L2 to the doctor
   on call (roster in Settings → Treatment timing) or else the ordering doctor. No in-charge set →
   the ward's staff still see it on the due board.
4. **Line has no timing:** a line written without clock times or an interval has no due times; the
   doctor stops it and writes it again with timing.
5. **"Late" that was on time:** the nurse picked the wrong due time, or the dose was recorded after the
   fact. Strike out the dose with a reason and record it against the right due time.
6. **Sweep not running:** escalations and the hourly roll-ups come from the sweep (`/api/internal/tick`);
   check its last run in the logs before anything else.
7. **Tablet board stale:** the "last synced" chip turns amber after 5 minutes and red after 15; the
   board still computes from its cache. Reconnect, then reload. Use the printed round list meanwhile.

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
   is still running, and that `INTERNAL_TICK_SECRET` matches. Whichever
   scheduler this deployment uses is documented in
   [`infra/`](../../infra/README.md); note that a hosted cron service which has
   stopped running the job reports nothing at all.
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
