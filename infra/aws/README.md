# Scheduling the outbox drain on AWS

`POST /api/internal/tick` drains `notification_outbox`. Nothing calls it on a
schedule by default, and when nothing does, the symptom is silence: bookings
succeed, the dashboard looks healthy, and no patient ever receives a queue link
or a reminder.

Vercel's Hobby plan cannot fill this gap — its cron runs **once per day** and
fires anywhere inside the scheduled hour. Slot reminders are due fifteen minutes
before the appointment, so they need minute-level granularity.

This stack runs it every minute for nothing.

```
EventBridge Scheduler  ──every minute──▶  Lambda  ──HTTPS──▶  /api/internal/tick
                                             │
                                    SSM Parameter Store
                                   (SecureString: the secret)
```

## Cost

At ~43,200 runs/month, everything here sits inside **permanent** free tiers —
not the twelve-month new-account kind:

| Service | Used | Free allowance | Used |
|---|---|---|---|
| EventBridge Scheduler | 43,200 invocations | 14,000,000 / month | 0.3% |
| Lambda requests | 43,200 | 1,000,000 / month | 4% |
| Lambda compute | ~5,530 GB-s | 400,000 GB-s / month | 1.4% |
| SSM Parameter Store | 1 standard parameter | Unlimited standard | — |
| CloudWatch Logs | a few MB | 5 GB / month | negligible |

Log retention is capped at 14 days in the template, because the default is
"never expire" and that is how a free log group quietly becomes a billed one.

## Prerequisites

- AWS CLI installed and configured (`aws configure`)
- `INTERNAL_TICK_SECRET` set in Vercel's environment variables, **and the
  project redeployed** — Vercel does not pick up env changes without one

Confirm the endpoint works before automating it:

```bash
curl -i -X POST "https://YOUR-APP.vercel.app/api/internal/tick" \
  -H "Authorization: Bearer YOUR_SECRET"
```

| Response | Meaning |
|---|---|
| `200 {"sent":N,...}` | Ready to proceed |
| `401 unauthorized` | Secret does not match |
| `503` | `INTERNAL_TICK_SECRET` is not set on Vercel |

Do not continue until this returns 200. Automating a broken call only makes it
fail on a schedule.

## 1. Store the secret

It goes into Parameter Store, not into the template — so it never appears in
CloudFormation events, the console, or this repository.

```bash
aws ssm put-parameter \
  --name /queuecare/tick-secret \
  --type SecureString \
  --value 'YOUR_INTERNAL_TICK_SECRET' \
  --description 'QueueCare outbox tick bearer token' \
  --region ap-south-1
```

Add `--overwrite` when rotating it later. The Lambda caches the value per
container and re-reads it after any 401, so a rotation takes effect within a
minute without a redeploy.

## 2. Deploy

```bash
aws cloudformation deploy \
  --template-file infra/aws/template.yaml \
  --stack-name queuecare-tick \
  --capabilities CAPABILITY_IAM \
  --region ap-south-1 \
  --parameter-overrides \
      TickUrl=https://YOUR-APP.vercel.app/api/internal/tick \
      AlertEmail=you@example.com
```

`AlertEmail` is optional but worth setting — it creates a CloudWatch alarm that
notifies you after five consecutive failures. Without it, a broken scheduler is
invisible until someone notices patients are not being messaged. AWS sends a
confirmation email you must click before alerts arrive.

Region is yours to choose; `ap-south-1` (Mumbai) or `ap-southeast-1` (Singapore,
nearest your Vercel `sin1` deployment) are both sensible. It barely matters for
a background job.

## 3. Verify

Run one drain by hand:

```bash
aws lambda invoke --function-name queuecare-tick-tick /dev/stdout --region ap-south-1
```

Watch it run on schedule:

```bash
aws logs tail /aws/lambda/queuecare-tick-tick --follow --region ap-south-1
```

You should see a `tick ok {"sent":0,"failed":0,"suppressed":0}` line each
minute. Then confirm from the application side:

```bash
npm run whatsapp:diagnose
```

Section 6 checks for overdue messages specifically and will print
`✓ no overdue messages — the outbox is being drained`.

## Changing the cadence

```bash
aws cloudformation deploy ... --parameter-overrides ScheduleExpression='rate(5 minutes)'
```

One minute is the default because it bounds worst-case lateness at 60 seconds
for both the immediate queue link and the 15-minute slot reminder. Five minutes
would make a "15 minutes before" reminder arrive as little as 10 minutes before,
which is still useful but noticeably less so.

## Pausing

```bash
aws scheduler update-schedule --name queuecare-tick-every-minute --state DISABLED \
  --schedule-expression 'rate(1 minute)' \
  --flexible-time-window Mode=OFF \
  --target "$(aws scheduler get-schedule --name queuecare-tick-every-minute --query Target --output json)"
```

Simpler in the console: **EventBridge → Schedules → queuecare-tick-every-minute
→ Disable.**

## Removing it

```bash
aws cloudformation delete-stack --stack-name queuecare-tick --region ap-south-1
```

The SSM parameter is created outside the stack and survives deletion; remove it
separately with `aws ssm delete-parameter --name /queuecare/tick-secret`.

## Troubleshooting

| Symptom | Cause |
|---|---|
| Lambda errors with `HTTP 401` | Secret in SSM differs from Vercel's |
| Lambda errors with `HTTP 503` | `INTERNAL_TICK_SECRET` unset on Vercel, or not redeployed since setting it |
| `ParameterNotFound` | Step 1 was skipped, or run in a different region than the stack |
| `AccessDeniedException` on `kms:Decrypt` | Parameter was created with a customer-managed KMS key; grant that key's ARN in `TickFunctionRole` |
| No logs at all | The schedule is disabled, or the stack deployed to a region you are not looking at |
| Tick returns 200 but nothing sends | Not a scheduling problem. Run `npm run whatsapp:diagnose` |
