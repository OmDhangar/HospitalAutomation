# Draining the outbox from a VPS

The app stays on Vercel. This machine only makes one outbound HTTPS request a
minute — it binds no port, serves no traffic, and touches no web-server
configuration, so anything already running on the box is unaffected.

```
VPS systemd timer  ──every minute──▶  POST /api/internal/tick  (on Vercel)
                                              │
                                     drains notification_outbox
```

## Why not Vercel cron

Hobby-plan cron runs **once per day**, and fires anywhere inside the scheduled
hour. Slot reminders are due fifteen minutes before an appointment and
web-booking queue links are scheduled for immediately, so neither can be
delivered on that cadence. Pro-plan cron would work; so does this, for nothing.

## Install

```bash
sudo ./install-tick.sh https://your-app.vercel.app
```

It prompts for `INTERNAL_TICK_SECRET` with the input hidden — deliberately not
an argument, because a command-line secret shows up in `ps` output and in shell
history.

Before writing anything it calls the endpoint once and refuses to continue if
that call fails, naming which failure it was:

| Response | Meaning |
|---|---|
| `200` | Working — installation proceeds |
| `401` | The secret here does not match the one on the server |
| `503` | `INTERNAL_TICK_SECRET` unset on the server, or set without redeploying |
| no response | Wrong URL, or this machine cannot reach the internet |

Automating a call that already fails only makes it fail on a schedule.

## What it installs

| Path | Purpose |
|---|---|
| `/etc/queuecare/tick.env` | URL and secret, `0600`, root-owned |
| `/usr/local/bin/queuecare-tick.sh` | The curl itself |
| `/etc/systemd/system/queuecare-tick.service` | Runs it as `nobody`, no filesystem access |
| `/etc/systemd/system/queuecare-tick.timer` | Every minute |

`OnUnitActiveSec=1min` counts from when the last run *finished*, and systemd
refuses to start a `oneshot` that is still running — so a slow tick can never
stack up behind itself. `crontab` gives you neither.

`AccuracySec=5s` matters: systemd defaults to one-minute accuracy, which makes
a one-minute timer fire erratically.

## Operating it

```bash
sudo journalctl -u queuecare-tick.service -f
```

A healthy minute prints `{"sent":0,"failed":0,"suppressed":0}`. Then confirm
from the application side, which checks for overdue messages specifically:

```bash
npm run whatsapp:diagnose
```

| Task | Command |
|---|---|
| Check schedule | `systemctl list-timers queuecare-tick.timer` |
| Pause | `sudo systemctl disable --now queuecare-tick.timer` |
| Resume | `sudo systemctl enable --now queuecare-tick.timer` |
| Rotate the secret | edit `/etc/queuecare/tick.env`, then `sudo systemctl restart queuecare-tick.timer` |
| Remove | `sudo systemctl disable --now queuecare-tick.timer && sudo rm /etc/systemd/system/queuecare-tick.{service,timer} /usr/local/bin/queuecare-tick.sh && sudo rm -rf /etc/queuecare && sudo systemctl daemon-reload` |

## Without systemd

```bash
* * * * * /usr/local/bin/queuecare-tick.sh >> /var/log/queuecare-tick.log 2>&1
```

Works, but you lose overlap protection and `journalctl`, and you will need
logrotate. Prefer the timer where systemd is available.

## Troubleshooting

| Symptom | Cause |
|---|---|
| Timer active, nothing in the journal | Looking at the `.timer` unit — logs are on the `.service` |
| `401` every minute | Secret changed on Vercel without updating `/etc/queuecare/tick.env` |
| `503` every minute | `INTERNAL_TICK_SECRET` removed from Vercel, or set without a redeploy |
| Ticks succeed, reminders still missing | Not a scheduling problem. Run `npm run whatsapp:diagnose` |
| Response has no `sweeps` key | The deployed build predates the housekeeping change; redeploy |

## The alternative

`infra/aws/` does the same job with EventBridge Scheduler and Lambda, inside
AWS's permanent free tier. Use that if you would rather not have a machine to
patch; use this if the VPS is already there and already being maintained.
