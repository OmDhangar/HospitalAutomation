# WhatsApp setup

## The account strategy, in one paragraph

**One Meta Business Manager — ours. One business verification, ever. One phone
number per hospital, all on our WhatsApp Business Account.**

The hospital never touches Meta, never verifies a business, never sees a message
count, and never gets a bill from anyone but us. They pay a subscription; we pay
Meta.

Why not give each hospital their own account: templates are approved per WABA,
so twelve approvals would become twelve *per hospital*, and each hospital would
need its own business verification with incorporation documents and a three-week
wait. That is where onboarding dies.

Why not put every hospital on one shared number: patients would see our name
rather than their hospital's, inbound messages could not be attributed to a
hospital at all, and one hospital's blocked messages would degrade delivery for
everyone.

| Meta's structure | What it buys us |
|---|---|
| Up to 20 numbers per WABA | 20 hospitals per WABA; add another under the same verified business |
| Templates shared across the WABA | 12 approvals total, not 12 per hospital |
| Display name is per number | Each hospital's patients see their own hospital's name |
| Quality rating is per number | One hospital's problems stay theirs |

**The catch worth knowing:** messaging *throughput* limits apply across the whole
business portfolio, not per number. Every hospital shares one sending-capacity
pool as it climbs Meta's tiers. Mostly this helps — aggregate volume lifts
everyone — but a hospital whose patients block messages can slow sending for the
rest. That is a second, independent reason the three-message budget and the
consent gate exist: they protect sender reputation, not just margin.

**Buy the SIMs yourself.** Around ₹200–300/month per hospital, folded into the
subscription. A hospital's existing number almost always has WhatsApp on it
already, which *blocks* API registration, so asking them to supply one stalls
onboarding. Owning the number also means a hospital leaving does not strand you
with their patients messaging a number nobody answers.

---

## Testing with no Meta account at all

The fastest path, and it needs nothing external:

```bash
npm run db:seed
npm run dev
```

Set `WHATSAPP_APP_SECRET` to any string in `.env` — the webhook refuses unsigned
requests, so it must be set even locally. Then find the demo hospital's phone
number id on `/settings/whatsapp`, and a doctor id from the dashboard URL:

```bash
npm run whatsapp:simulate -- --pn <phoneNumberId> --text "Hi"
npm run whatsapp:simulate -- --pn <phoneNumberId> --reply lang:mr
npm run whatsapp:simulate -- --pn <phoneNumberId> --reply doc:<doctorId>
npm run whatsapp:simulate -- --pn <phoneNumberId> --reply slot:now
```

That posts correctly signed, Meta-shaped webhooks at the local server. Everything
downstream is the real path — signature verification, tenant resolution, replay
protection, the booking state machine, consent, the outbox. Only the sender is
pretended. After the fourth command a real appointment exists, with a token, and
the queue link is sitting in the outbox. `npm run worker:tick` prints it.

---

## Meta's free test number

Meta gives every developer app a test number that needs **no business
verification** and costs nothing. Use it to prove the real API before committing
to the verification process.

1. **[developers.facebook.com](https://developers.facebook.com) → My Apps →
   Create App → Business.**
2. **Add the WhatsApp product.** Meta provisions a test number and a test WABA
   automatically. **WhatsApp → API Setup** now shows a **Phone number ID** and a
   temporary access token.
3. **Add your own mobile to the recipient list** on that same page. The test
   number may only message numbers on this list — up to five. This is the main
   limitation and the reason it cannot be used with real patients.
4. Put the phone number id and token into `.env`, or the phone number id into
   `/settings/whatsapp` for the demo hospital.
5. **Send a test** from `/settings/whatsapp` to your own number.

**The token on that page expires in 24 hours.** When it does, you have not broken
anything — generate a permanent one: **Business Settings → System Users → Add →
Admin → Generate token**, with `whatsapp_business_messaging` and
`whatsapp_business_management`.

**Templates on the test WABA** can be created and are usually approved in
minutes. Run `npm run whatsapp:templates -- --submit` with
`WHATSAPP_BUSINESS_ACCOUNT_ID` set, and you can exercise real template sends.

### Receiving messages needs a public URL

Meta will not deliver webhooks to localhost.

```bash
npx ngrok http 3000
```

Then **WhatsApp → Configuration → Webhook**: set the callback URL to
`https://<your-ngrok-host>/api/whatsapp/webhook`, the verify token to whatever
`WHATSAPP_WEBHOOK_VERIFY_TOKEN` is set to, and subscribe to **messages**.

Set `PUBLIC_BASE_URL` to the ngrok URL too, or the queue links you send will
point at localhost and be dead on the patient's phone.

---

## Going live

1. **Business verification** — Meta Business Settings → Business Info. Needs GST
   certificate or incorporation documents. One to three weeks. Start it first;
   everything waits on it.
2. **Buy a SIM per hospital.** It must have no WhatsApp account on it. If it does,
   delete that account from the phone first and wait a few minutes.
3. **Add the number** to the WABA and complete the SMS or voice verification.
4. **Set the display name** to the hospital's name. Meta reviews it separately
   from the number, and it is what patients see.
5. **Submit the 12 templates** — `npm run whatsapp:templates -- --submit`. All
   UTILITY, never MARKETING: utility is far cheaper and is the correct category
   since every message is triggered by an action, not a promotion.
6. **Record the number** under that hospital's `/settings/whatsapp`, including the
   display name, then mark it registered.
7. **Point the webhook** at the production URL and subscribe to `messages`.
8. **Send a test** to your own phone before letting a patient near it.

## Once it is running

- `/admin` → **Sender numbers** shows each hospital's number, status, quality
  rating and tier. A rating dropping to YELLOW is an early warning worth acting
  on before it becomes RED.
- Record Meta's monthly invoice in `provider_invoices`. The platform dashboard
  then reports real cost per message instead of the planning estimate — and
  since Meta's utility rate falls with volume, the estimate will understate your
  margin as you grow.
- Watch **messages per completed appointment**. Budget 3.0, alert 3.5, circuit
  breaker at 6.0.
