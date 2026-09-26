# Driving the outbox drain from a hosted cron service

`POST /api/internal/tick` drains `notification_outbox`. Nothing calls it on a
schedule by default, and when nothing does, the symptom is silence: bookings
succeed, the dashboard looks healthy, and no patient ever receives a queue link
or a reminder.

This option needs no machine and no cloud account — a third party calls the
endpoint on a schedule, and that is the whole architecture.

```
cron-job.org  ──every minute, 06:00–23:00 IST──▶  POST /api/internal/tick
                                                            │
                                                   drains notification_outbox
```

## Why not Vercel cron

Hobby-plan cron runs **once per day**, and fires anywhere inside the scheduled
hour. Slot reminders are due fifteen minutes before an appointment, so they need
minute-level granularity. Pro-plan cron would work.

`infra/vps/` needs a machine to patch. `infra/aws/` needs an AWS account with a
card on file. This needs neither and costs nothing — and the price of that is
worth stating plainly rather than discovering later: **the secret now lives in
someone else's database, and nothing here has an SLA.**

## This is a bridge, not a destination

Vercel's fair-use terms restrict Hobby to **non-commercial personal use**. The
first hospital that pays for a subscription puts this project on Pro — and Pro
cron accepts minute-level expressions, which retires this entire option.

So: use this to get reminders working now. Plan on deleting it.

## What a scheduler has to support

The endpoint is deliberately narrow, which rules most free services out:

| Requirement | Why |
|---|---|
| `POST` | The route exports `POST` only; a `GET` gets 405 |
| A custom `Authorization` header | Anything else is a 401 before any work happens |
| One-minute granularity | Worst-case lateness equals the interval exactly |
| ~1,000 executions a day, free | Seventeen hours × 60 |
| Notification on failure | Otherwise a dead scheduler is invisible |

## Why cron-job.org

It is the only free service that meets all five. The others fail on the first or
second row:

| Service | Why not |
|---|---|
| EasyCron | Free tier is GET-only; request method and headers are paid |
| FastCron | Five-minute minimum on the free plan |
| GitHub Actions `schedule` | Five-minute minimum, and GitHub documents that scheduled runs may be delayed or dropped under load |
| Upstash QStash | Schedules work, but the free daily allowance is well below what this needs |
| UptimeRobot and other monitors | Five-minute free interval, and a monitor repurposed as a scheduler keeps no execution log worth reading |
| Cloudflare Workers Cron Triggers | **Genuinely the better option** — one-minute granularity free, the secret stays in your own account, real logs. Rejected only because it means writing and deploying a Worker, which is the thing this option exists to avoid. Move here first if you outgrow cron-job.org. |

Limits on a free plan are the provider's to change. Re-read them before assuming
this table still holds.

## Cost

At ~1,020 ticks a day the Vercel side is not close to a limit:

| Resource | Used | Hobby allowance | Used |
|---|---|---|---|
| Function invocations | ~31,000 / month | 1,000,000 / month | 3% |
| cron-job.org executions | ~1,020 / day | 60 / hour, unlimited jobs | — |

Function *duration* is what actually varies, and it tracks how many messages are
waiting, not how often the job runs.

## Prerequisites

- `INTERNAL_TICK_SECRET` set in Vercel's environment variables, **and the
  project redeployed** — Vercel does not pick up env changes without one

Confirm the endpoint works before automating it:

```bash
curl -i -X POST "https://YOUR-DOMAIN/api/internal/tick" \
  -H "Authorization: Bearer YOUR_SECRET"
```

| Response | Meaning |
|---|---|
| `200 {"sent":N,...,"sweeps":{...}}` | Ready to proceed |
| `401`, body `unauthorized` | The secret does not match the one on Vercel |
| `401` or `403`, body is **HTML** | Deployment Protection — the request never reached the route |
| `503` | `INTERNAL_TICK_SECRET` unset on Vercel, or set without redeploying |
| `405` | The request was a `GET` |
| no response | Wrong domain, or no route to the internet |

Do not continue until this returns 200. Automating a call that already fails
only makes it fail on a schedule.

## Deployment Protection

This one is worth its own section because it is invisible from the repository —
it is enforced at Vercel's edge, before any code here runs, and it answers with
an HTML challenge page that a cron service will faithfully record as a failure
every minute forever.

- **Use the production domain.** Never a generated `*.vercel.app` deployment
  URL. Under Standard Protection — the default — generated URLs are protected
  and the production domain is not, so pointing the job at a deployment URL is
  the most likely way to end up permanently failing.
- If the project is set to protect **all** deployments, patients cannot reach
  the app either, so the fix is to move to Standard Protection, not to work
  around it here.
- If it genuinely must stay protected, add a second header to the job:
  `x-vercel-protection-bypass: <secret>`, from Settings → Deployment Protection →
  Protection Bypass for Automation. Regenerating that secret invalidates
  existing deployments until you redeploy.

## Setup

1. Create an account at <https://cron-job.org> and verify the email — failure
   notifications are the only monitoring this option has, so the address matters.
2. **CREATE CRONJOB**. Title `queuecare tick`. URL
   `https://YOUR-DOMAIN/api/internal/tick` — the production domain, per above.
3. Schedule: **every minute, hours 06–22, every day**, timezone `Asia/Kolkata`.
   See below for why it is a window rather than the whole day.
4. Advanced → request method **POST**. Leave the body empty; the route ignores it.
5. Advanced → headers → `Authorization` = `Bearer YOUR_SECRET`. **In the header,
   not the query string.** A secret in a URL is written to their execution log
   and to Vercel's request log, and there is no reason to accept that when
   headers are supported.
6. Notifications: enable **on failure** and **on recovery**. Leave "on success"
   off unless you want a thousand emails a day.
7. Do not enable "treat redirects as success" — a redirect means the URL is wrong.
8. Save, then **TEST RUN**. Expect `200` and the JSON body in the execution log.
   Only then enable the job.

## Choosing the window

Every minute, but not around the clock. Outside OPD hours the outbox is empty by
construction, so an overnight tick is six SQL statements that find nothing and a
database that never gets to idle.

Pick the window from your own schedules rather than copying `06:00–23:00`:

> **Start at least an hour before the earliest `start_time` any doctor offers,
> and end at least an hour after the latest `end_time`.**

The hour of margin is not padding. A 06:10 appointment has its reminder due at
05:55, and with a window opening at 06:00 that reminder arrives ten minutes
ahead instead of fourteen. Opening at 05:00 removes the edge entirely.

Two consequences of the gap, both benign, both better known than discovered:

- The housekeeping sweeps — expiring yesterday's unresolved appointments, lapsed
  subscriptions, dead payment links — run on the **first tick of the day**
  rather than just after midnight. Nothing reads yesterday's queue at 3am.
- A message somehow scheduled overnight is delivered when the window opens.
  Nothing currently schedules one.

## Why one minute

`scheduled_for` is a strict "not before" gate, so nothing is ever sent early and
worst-case lateness is exactly the interval. What that costs as the interval
grows:

| Interval | 15-min slot reminder | 10-min queue nudge | Retry ladder | Backlog drain |
|---|---|---|---|---|
| 1 min | 14 min ahead | 9 min ahead | ~15 min, as documented | 1,500 / hour |
| 2 min | 13 min ahead | 8 min ahead | ~16 min | 750 / hour |
| 5 min | 10 min ahead | **5 min ahead** | ~25 min | 300 / hour |

Three of those columns come from constants in `lib/notify/worker.ts`. The retry
ladder is `min(3600, 30 · 2^attempts)` — 60s, then 120s, 240s, 480s — and the
comment claiming "five attempts over fifteen minutes" is only true at a
one-minute tick, because every backoff shorter than the interval silently
becomes the interval. `BATCH_SIZE = 25` per pass sets the drain rate, which is
what matters after a Meta outage. And `STUCK_AFTER_MINUTES = 5` needs a tick to
happen before a stranded row is released.

The queue nudge is the one to watch. It is enqueued when reception advances the
queue and is due immediately, so a five-minute interval can spend half of a
ten-minute warning before the message leaves.

## The secret, now that it lives elsewhere

Worth an honest assessment rather than a warning label.

The response body is counts only — no patient data, no tokens, no phone numbers.
Someone holding this secret can force a drain and force the sweeps. Both are
idempotent, the drain is bounded to 25 rows, `scheduled_for` means nothing can be
sent earlier than it was already scheduled, and `SKIP LOCKED` means nothing is
sent twice. They cannot read anything, and they cannot cause a message to exist
that did not already exist.

So keep the single `INTERNAL_TICK_SECRET`. A second, dedicated secret would be
one more thing to rotate and would protect nothing extra, because a leaked
`INTERNAL_TICK_SECRET` already grants exactly this and nothing more.

Two controls are worth taking, and no others:

1. Generate it as 32 random bytes and use it for nothing else.
2. Treat "it is stored at a third party" as a standing reason to rotate it on a
   schedule: set it in Vercel → redeploy → update the job's header.

Do **not** add HMAC signing or IP allowlisting. There is no stable egress range
worth pinning, and the asset being defended is a count of messages.

## Noticing when it stops

| Failure | Detected by |
|---|---|
| The endpoint starts returning 401, 503 or 5xx | Failure email |
| It starts working again | Recovery email |
| Many consecutive failures | The job is disabled automatically — and does not resume itself |
| **cron-job.org stops running the job** | **Nothing. A dead provider sends no email.** |

That last row is the honest limit of this option, and it is why `infra/aws/`
alarms on consecutive failures instead. Until there is a watchdog, check the
application side rather than trusting silence:

```bash
npm run whatsapp:diagnose
```

Section 6 prints `✓ no overdue messages — the outbox is being drained`. `/admin`
→ Delivery problems shows the same thing from the other direction.

If you are choosing fresh and want to be told when scheduling breaks, choose
`infra/aws/`.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `401` and the body is HTML | Deployment Protection, not the secret — the request never reached the route |
| `401` and the body is `unauthorized` | Header value does not match `INTERNAL_TICK_SECRET` on Vercel |
| `503` every minute | `INTERNAL_TICK_SECRET` removed from Vercel, or set without a redeploy |
| `405` | The job is sending `GET`; the route is `POST` only |
| Timed out after ~30s | The provider closed the connection at its own limit. The tick itself probably finished — read Vercel's function log before changing anything |
| The job is disabled and no email arrived | Consecutive failures disabled it. Fix the cause, then re-enable it by hand |
| Nothing fires before 06:00 | Working as configured. See *Choosing the window* |
| Every execution 200, reminders still missing | Not a scheduling problem. Run `npm run whatsapp:diagnose` |
| Response has no `sweeps` key | The deployed build predates the housekeeping change; redeploy |

## The alternatives

`infra/vps/` runs the same request from a systemd timer, if a machine already
exists and is already being maintained. `infra/aws/` runs it from EventBridge
and Lambda inside AWS's permanent free tier, and is the only one of the three
that will tell you when it breaks.
