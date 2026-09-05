# Hospital onboarding runbook

One pass through this takes about 90 minutes on site. Do it with the
receptionist present, not over the phone.

## Before the visit

- [ ] Hospital record created, `plan_tier_code` set, `owner_phone_e164` filled in
- [ ] Branch and every OPD doctor added under **Settings**, with a realistic
      `default_consult_minutes` per doctor (ask, do not guess — it seeds the ETA
      until real data accumulates)
- [ ] Owner account created with role `owner`; one `receptionist` account per
      person who will run the desk, never a shared login — the activity log is
      worthless if every action says "reception"
- [ ] WhatsApp number registered and all twelve templates approved
      (four kinds × mr/hi/en). Start this two weeks ahead.
- [ ] `whatsapp_phone_number_id` set on the hospital record

## On site

1. **Watch one OPD session before touching anything.** Count how tokens are
   issued today and how often reception is asked "how long?". These are the
   before-numbers you will be judged against.
2. Put the waiting-room display on a screen: `/display/<branchId>`. Sign in once
   on that device; the session lasts 14 days.
3. Run twenty real patients through together, with the receptionist driving and
   you watching. Do not take the keyboard.
4. Deliberately break it in front of them: skip someone, recall them, pause the
   doctor, unplug the internet for a minute. Staff who have seen it recover
   trust it; staff who have not will abandon it the first time it wobbles.
5. Print the paper fallback (below) and leave it at the desk.

## The one thing that decides whether this sticks

**The app must be the only place a token is issued.** If reception keeps the
paper register as well, they are doing double work, and double work is abandoned
within a fortnight. Every token comes out of the app, and the slip the patient
carries is printed from it.

If the hospital insists on keeping the register for a week, agree a date to stop
and hold them to it.

## Paper fallback for an internet outage

Leave this at the desk, in writing:

1. Keep issuing tokens on paper, continuing from the last number the app showed.
2. Do not restart numbering from 1.
3. When the connection returns, add each patient in the app in the same order.
   Token numbers will match because the app never reuses a number.
4. If the queue moved on paper, use **Priority** to place anyone who was already
   seen out of order.

## After a week

- Compare waiting-room dwell time against the before-numbers
- Check `/reports` with the owner: patients seen, median wait, no-shows
- Check `/admin` yourself: messages per appointment should be at or below 3.0
- Ask the receptionist what annoys them. Fix that before adding anything.
