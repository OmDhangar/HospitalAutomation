# Data protection notes

**This is engineering documentation, not legal advice.** Have a lawyer review
the agreement and the privacy notice before the first paying hospital.

## Where we sit under the DPDP Act

The hospital is the **Data Fiduciary** — it decides why patient data is
collected. We are a **Data Processor**, acting on its instructions. That
distinction sets most of the obligations, and it is a much lighter burden than
being the fiduciary.

What that means in practice:

| Obligation | Whose | What we must do |
|---|---|---|
| Notice and consent to patients | Hospital's | Give them wording that covers WhatsApp messaging; make sure it is on the registration form |
| Purpose limitation | Hospital's | Do not use patient data for anything but running the queue. No marketing, ever |
| Breach notification | Hospital's | Tell them promptly and in writing so they can discharge it |
| Security safeguards | **Ours** | Encryption in transit, tenant isolation, access control, audit logs |
| Erasure on request | **Ours** | Delete a patient's records when the hospital asks |
| Processing only on instruction | **Ours** | A signed agreement saying exactly this |

## Before the first paying customer

- [ ] **Data Processing Agreement** in every hospital contract. Non-negotiable —
      it is what makes the processor relationship real rather than assumed.
- [ ] Privacy notice published, in Marathi and Hindi as well as English
- [ ] WhatsApp opt-in wording added to the hospital's own registration form.
      Consent is theirs to collect; the *record* of it is ours to keep, and is
      now enforced in code — see below.
- [ ] Retention period agreed in writing and actually implemented
- [ ] Confirm the current commencement status of the DPDP Rules — they were
      notified in November 2025 with staged dates, so check what is in force on
      the day you launch rather than trusting this document

## Consent, as enforced

Nothing is sent to a patient who has not opted in. This is a code path, not a
policy document:

- Reception ticks **"Patient agreed to WhatsApp updates"** when adding a walk-in.
  Unticking it still issues a token and a printed QR code — the patient simply
  is not messaged.
- A patient who messages the hospital's WhatsApp number first has opted in by
  doing so, and that is recorded with a timestamp.
- `patients.whatsapp_opt_in_at` gates both the token link and every milestone.
- Consent is dated once and not silently refreshed on later visits, so the
  record reflects when it was actually given.

The checkbox defaults to ticked. That is a deliberate trade-off: the receptionist
is recording a consent already obtained at the desk, not obtaining it themselves,
and an unticked default would in practice be ticked reflexively or forgotten —
producing a worse record either way. If a hospital's counsel disagrees, changing
the default is one line in the walk-in form.

## Cross-border transfer

The database is currently in Singapore (Neon has no India region). The DPDP Act
works off a *negative* list: transfer is permitted except to countries the
government specifically restricts, and Singapore is not among them.

Two caveats worth carrying into a sales conversation:

- A hospital owner may simply prefer "India". That is a commercial objection,
  not a legal one, and it is a fair reason to move.
- ABDM integration, if it ever happens, pushes toward India storage.

Nothing in the codebase is Neon-specific — standard Postgres, standard
migrations — so moving to an India region is a dump and restore, not a rewrite.

## Data minimisation, as built

The strongest privacy control here is what the schema refuses to hold. A patient
row is a name, a phone number, and a language preference. There is no diagnosis
field, no prescription, no test result, no clinical note, and no place to put
one without a migration and a deliberate decision.

Keep it that way. Every clinical field added turns a queue product into a system
that needs an EMR's compliance posture.

## Security controls in place

- Tenant isolation enforced by Postgres row-level security, not application
  code, and proven by tests that run with the policies deliberately bypassed
- Application database role cannot bypass RLS; `db:bootstrap` refuses to
  complete if it can
- Passwords hashed with scrypt; session tokens stored only as SHA-256 hashes
- Patient queue links carry 128 bits of entropy and expire 18 hours after the
  appointment
- Queue and audit history are append-only, enforced by database triggers
- WhatsApp webhooks verified by HMAC over the raw body, with replay protection
- No patient names on the waiting-room display
