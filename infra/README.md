# Running the outbox drain

`POST /api/internal/tick` drains `notification_outbox` and runs the scheduled
housekeeping. **Nothing calls it by default.** Until something does, bookings
succeed and no patient receives a queue link or a reminder — the failure is
silent from every angle except the patient's.

Vercel's Hobby cron cannot fill the gap: it runs once per day, anywhere inside
the scheduled hour, and slot reminders are due fifteen minutes before an
appointment. Pick one of these instead.

| Option | Pick it when |
|---|---|
| [`external-cron/`](external-cron/README.md) | You want nothing to operate. A free third party, no SLA, and the secret leaves your infrastructure. Right for a pilot, and explicitly a bridge until Vercel Pro. |
| [`vps/`](vps/README.md) | A VPS already exists and is already being patched. One systemd timer, no new surface. |
| [`aws/`](aws/README.md) | You want no machine *and* real alarms, inside AWS's permanent free tier. The only one that tells you when scheduling breaks. |

All three make the same request — `POST`, with `Authorization: Bearer
$INTERNAL_TICK_SECRET` — so moving between them is a matter of pointing
something else at the same URL and retiring the old caller.

The route caps itself at `maxDuration = 60` (`app/api/internal/tick/route.ts`),
which applies no matter which of these is calling it. Overlapping calls are safe:
the worker claims rows with `SKIP LOCKED`, so two schedulers running at once
cannot send the same message twice.

Whichever you choose, the interval is the message's worst-case lateness —
`scheduled_for` is a "not before" gate, so nothing is ever delivered early. Each
doc explains what widening it costs.
