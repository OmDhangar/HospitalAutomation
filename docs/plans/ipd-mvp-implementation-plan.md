# IPD MVP: implementation plan for Claude Code

**Status:** Stages 1–3 built on `feat/ipd-mvp`. Written 2 Oct 2026.
**Superseded in part (10 Oct 2026):** [ipd-sheets-plan.md](ipd-sheets-plan.md) (owner-approved for its
pilot slice) lifts the out-of-scope items marked † below — nursing charts, MAR with due times,
pharmacy stock for risk-class drugs, bed QR codes — and reverses D-ID and D-DV (ADR-021 to ADR-030).
**Product plan this implements:** "Qurio HMS v2 — Field-Driven MVP and Stage Plan"
(https://claude.ai/code/artifact/5933d848-3336-4a04-9ef0-37bd7ade19fc).
**Product plan last reconciled:** 2 Oct 2026. The product plan is the source of truth for scope and
dates; this file is the source of truth for build detail. If they disagree, fix one of them.
**Supersedes:** Phases 3–4 of [hms-expansion-plan.md](hms-expansion-plan.md) (IPD and lab).
The data rules of that plan and of [../architecture/](../architecture/README.md) still apply.

---

## 0. How to use this plan with Claude Code

Work **one task per Claude Code session** (tasks are in §7–§10, each PR-sized).
Start every session with this prompt, changing only the task id:

```
Read AGENTS.md, docs/architecture/README.md, docs/architecture/migrations.md,
docs/architecture/security.md and docs/plans/ipd-mvp-implementation-plan.md
(sections 1–6 in full, then task T1.3).
Implement task T1.3 exactly as specified. Follow the guardrails in section 2.
Before writing code, list the files you will touch and any decision in
section 11 that blocks this task. Stop and ask me if one does.
When done: run npm run typecheck, npm test, and (if the task touches the
database) the rehearsal in docs/architecture/migrations.md §4 against the
scratch database only. Do NOT run npm run db:migrate.
Then summarise what changed and tick the task's acceptance list.
```

**Definition of done for every task**

- [ ] `npm run typecheck` and `npm test` pass; new pure rules have unit tests.
- [ ] Database tasks: migration rehearsed on the scratch database; `npm run test:integration` passes there; the RLS guard test passes.
- [ ] Every new screen meets the UI standard in §6, checked at 375 px and 1280 px.
- [ ] `docs/architecture/progress.md` and, for decisions, `decisions.md` updated.
- [ ] No production migration. The owner applies migrations after review.

---

## 1. What we are building, and what we are not

**Building (the MVP):**

1. A **separate IPD section** of the app: its own nav entry, routes under `/ipd`, its own home screen and header.
2. **Shift to IPD in one click** for the doctor, from the OPD dashboard. No form.
3. **Wards and beds**, an **Awaiting bed** list, and an **admission sheet** where reception assigns the
   bed, the payer and the deposit.
4. A **nurse role** and a **mobile nurse screen** (phone or tablet PWA, each nurse signed in with her
   own login, offline outbox): tap the bed on the ward grid → tap the item → save.
   Every saved entry becomes a server-priced bill line at once. This reverses decision D20 of
   hms-expansion-plan.md (IPD medicines billed at the desk).
5. **Starter catalogues** (§5.8): common medicines, consumables, procedures, room charges and tests
   are pre-loaded without prices. Staff pick from lists; the hospital only enters costs.
6. **Nightly bed-day charges.**
7. (Stage 2) **Discharge billing**: the admin verifies, applies insurance and deposits, corrects with a
   reason, finalises and prints a **day-wise itemised bill with times**. The family can follow a
   **running bill** via a WhatsApp link during the stay.
8. (Stage 3) A **doctor phone view** of admitted patients with Discharge ready and Tests.

**Decided and out of scope — do not build:**

- ABDM, ABHA, HFR/HPR, NHCX or any government integration (future roadmap, §13).
- Photographing or digitising handwritten prescriptions. Removed 2 Oct 2026; digital prescription
  capture will be discussed separately (future roadmap, §13). Doctors keep handwriting.
- Bed QR codes and wristbands. **Decided 2 Oct 2026: patients are identified by tapping the bed on the
  ward grid.** † Reversed 10 Oct 2026 for bed QR (ADR-022); tapping the bed still works.
- Mandatory typed prescriptions. The consultation panel's prescription features stay as they are; the
  only addition near it is the Shift to IPD button (§5.1).
- Nursing charts, MAR with due times, OT, pharmacy stock, packages, claims. † Nursing charts, MAR with
  due times and risk-class stock move to [ipd-sheets-plan.md](ipd-sheets-plan.md) (10 Oct 2026);
  OT, packages and claims remain out of this plan.

## 1a. Stages and dates

From the product plan. Each stage's gate is a field result at the pilot hospital, not a code milestone.

| Stage | Dates | Tasks | Gate |
|---|---|---|---|
| 0 Field groundwork | 5–16 Oct 2026 | Answers to §11; the pilot's ward and bed list; its price list as CSV (input to T1.3); device choice | §11 answered by 16 Oct. No code is blocked; T1.1 may start early |
| 1 IPD section, Shift to IPD, beds, nurse app | 19 Oct – 27 Nov 2026 | T1.1–T1.10 (§7) | **One ward recording at the bedside by 16 Nov.** Needs T1.1–T1.8; T1.10 can follow by 27 Nov |
| 2 Discharge billing, transparent bill | 30 Nov – 24 Dec 2026 | T2.1–T2.4 (§8) | Every pilot IPD discharge billed this way from 4 Jan 2027 |
| 3 Doctor phone view | 4 Jan – 5 Feb 2027 | T3.1 (§9) | — |
| 4 Lab-lite, reports, hardening | 8 Feb – 26 Mar 2027 | T4.1–T4.3 (§10) | MVP ready for more hospitals on 1 Apr 2027 |
| 5 Hospitals 2 and 3 | Apr – Jun 2027 | §13 | — |

---

## 2. Guardrails (non-negotiable)

1. **This is Next.js 16.** Read the relevant guide in `node_modules/next/dist/docs/` before using any
   Next.js API (AGENTS.md). Server components by default; server actions via the `*Dynamic` pattern in
   `app/(app)/dashboard/actions.ts`.
2. **Three layers, calls only go down:** `app/` → `lib/services/` → `lib/domain/`
   (docs/architecture/README.md §2). Rules and calculations live in `lib/domain/` with unit tests.
3. **Every query runs in `withTenant`.** Clinical tables (admissions, care entries) use
   `withTenant(…, { clinical: true })`. The hospital id always comes from the session.
4. **Money is integer paise.** Prices are read by the server inside the transaction that charges them;
   no request schema has a price field. Reuse `calculateBillItem` from `lib/domain/patient-billing.ts`.
5. **Correct by voiding, never editing.** Care entries and bill lines are voided with who, when, why.
   Reuse the guard trigger functions from migrations 0026 and 0028.
6. **Migrations are hand-written**, numbered from **0031**, mirrored in `lib/db/schema.ts`, added to
   `drizzle/meta/_journal.json`, rehearsed on the scratch DB. `ALTER TYPE … ADD VALUE` goes in its own file.
   Copy the RLS `DO $outer$ … FOREACH` block from `0026_billing_foundation.sql` and the clinical policy
   from `0028_clinical_opd.sql`. Composite tenant FKs `(hospital_id, …)` on every child table.
7. **Permissions only through `can(role, permission)`** in `lib/domain/permissions.ts`. Never `role !== 'x'`.
8. **Do not modify** `appointments`, `queue_events`, `doctor_day_states`, `notification_outbox`, or the
   queue state machine. Shift to IPD calls the existing `applyQueueAction`.
9. **No new runtime dependencies** without asking. Use the existing `components/ui.tsx`,
   `components/icons.tsx`, `components/toast.tsx`, Tailwind tokens in `app/globals.css`.
10. **Typeahead and high-frequency writes use route handlers**, not server actions (ADR-015: server
    actions run one at a time per page).

---

## 3. Data model

All new tables: `hospital_id NOT NULL … ON DELETE CASCADE`, ENABLE + FORCE RLS, `tenant_isolation`,
`read_only_write`, `read_only_delete`. Tables marked **clinical** also get the `clinical_access` policy.

### 3.1 Enum migration — `0031_ipd_enums.sql`

```sql
ALTER TYPE staff_role ADD VALUE IF NOT EXISTS 'nurse';
ALTER TYPE bill_item_type ADD VALUE IF NOT EXISTS 'consumable';
ALTER TYPE bill_item_type ADD VALUE IF NOT EXISTS 'procedure';
ALTER TYPE bill_item_type ADD VALUE IF NOT EXISTS 'service';
ALTER TYPE bill_item_type ADD VALUE IF NOT EXISTS 'room';
```

In TypeScript, add `'nurse'` to `STAFF_ROLES`; the compiler will then force decisions in
`PERMISSIONS` users and `DASHBOARD_VIEWS` (see §4).

### 3.2 Core IPD migration — `0032_ipd_core.sql` (sketch; finalise against 0026/0028 conventions)

```sql
CREATE TYPE admission_status AS ENUM
  ('awaiting_bed', 'admitted', 'discharge_ready', 'discharged', 'cancelled');
CREATE TYPE charge_item_kind AS ENUM ('consumable', 'procedure', 'service', 'room');

-- Non-medicine chargeables. Medicines stay in `medicines` (prescriptions reference them).
CREATE TABLE charge_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id uuid NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  kind charge_item_kind NOT NULL,
  name text NOT NULL,
  unit text NOT NULL DEFAULT 'unit',              -- syringe, pair, hour, day
  selling_price_paise integer CHECK (selling_price_paise >= 0),  -- null = not priced yet
  tax_rate_bp integer NOT NULL DEFAULT 0,
  is_test boolean NOT NULL DEFAULT false,          -- kind 'service' only; doctor's Tests chips (T3.1)
  active boolean NOT NULL DEFAULT true,
  created_by_user_id uuid,                        -- as in `medicines`; SET NULL on user delete
  created_at …, updated_at …,
  CHECK (NOT is_test OR kind = 'service'),
  UNIQUE (hospital_id, id)
);
CREATE UNIQUE INDEX charge_items_identity_key ON charge_items (hospital_id, kind, lower(name));

CREATE TABLE wards (
  id uuid PK, hospital_id …, branch_id uuid NOT NULL,      -- composite FK to branches
  name text NOT NULL, sort_order smallint NOT NULL DEFAULT 0,
  daily_charge_item_id uuid,                              -- composite FK to charge_items (kind 'room')
  active boolean NOT NULL DEFAULT true, created_at, updated_at,
  UNIQUE (hospital_id, id)
);
CREATE TABLE beds (
  id uuid PK, hospital_id …, ward_id uuid NOT NULL,       -- composite FK to wards
  label text NOT NULL,                                    -- "12", "ICU-3"
  sort_order smallint NOT NULL DEFAULT 0, active boolean NOT NULL DEFAULT true,
  UNIQUE (hospital_id, id)
);
CREATE UNIQUE INDEX beds_label_key ON beds (ward_id, lower(label));

-- clinical
CREATE TABLE admissions (
  id uuid PK, hospital_id …,
  encounter_id uuid NOT NULL, patient_id uuid NOT NULL,   -- composite FK to encounters(hospital_id,id,patient_id)
  branch_id uuid NOT NULL,
  admitting_doctor_id uuid NOT NULL,                      -- NO ACTION
  status admission_status NOT NULL DEFAULT 'awaiting_bed',
  reason text,                                            -- optional, one line
  requested_by_user_id uuid, requested_at timestamptz NOT NULL DEFAULT now(),
  admitted_at timestamptz, admitted_by_user_id uuid,      -- set when the first bed is assigned
  discharge_ready_at timestamptz, discharge_ready_by_user_id uuid,
  discharged_at timestamptz, discharged_by_user_id uuid,
  cancelled_at timestamptz, cancelled_by_user_id uuid, cancel_reason text,
  created_at, updated_at,
  UNIQUE (hospital_id, id),
  UNIQUE (hospital_id, id, patient_id)
);
CREATE UNIQUE INDEX admissions_one_live_per_encounter
  ON admissions (encounter_id) WHERE status <> 'cancelled';
CREATE INDEX admissions_census_idx ON admissions (hospital_id, branch_id, status)
  WHERE status IN ('awaiting_bed', 'admitted', 'discharge_ready');

CREATE TABLE bed_assignments (
  id uuid PK, hospital_id …, admission_id uuid NOT NULL, bed_id uuid NOT NULL,  -- composite FKs
  from_at timestamptz NOT NULL DEFAULT now(), to_at timestamptz,
  assigned_by_user_id uuid, created_at,
  CHECK (to_at IS NULL OR to_at >= from_at),
  UNIQUE (hospital_id, id)
);
CREATE UNIQUE INDEX bed_assignments_bed_occupied ON bed_assignments (bed_id) WHERE to_at IS NULL;
CREATE UNIQUE INDEX bed_assignments_admission_current ON bed_assignments (admission_id) WHERE to_at IS NULL;

-- clinical: what was given or used, recorded at the bedside
CREATE TABLE care_entries (
  id uuid PK, hospital_id …,
  admission_id uuid NOT NULL, encounter_id uuid NOT NULL, patient_id uuid NOT NULL,  -- composite FKs
  medicine_id uuid, charge_item_id uuid,                 -- exactly one; NO ACTION
  description text NOT NULL,                             -- snapshot: "Inj. Ceftriaxone 1 g"
  quantity integer NOT NULL CHECK (quantity > 0 AND quantity <= 999),
  occurred_at timestamptz NOT NULL,                      -- when it was given (may be a few minutes ago)
  recorded_at timestamptz NOT NULL DEFAULT now(),
  recorded_by_user_id uuid,
  client_id uuid NOT NULL,                               -- generated on the phone; makes retries safe
  voided_at timestamptz, voided_by_user_id uuid, void_reason text,
  created_at,
  CHECK (num_nonnulls(medicine_id, charge_item_id) = 1),
  CHECK (occurred_at <= recorded_at + interval '5 minutes'),
  UNIQUE (hospital_id, id)
);
CREATE UNIQUE INDEX care_entries_client_key ON care_entries (hospital_id, client_id);
CREATE INDEX care_entries_admission_idx ON care_entries (admission_id, occurred_at) WHERE voided_at IS NULL;
-- guard trigger: only the void columns may change, and a void is one-way (reuse 0026/0028 helpers)

-- Bill lines learn two new sources. Typed nullable FKs, one "bill once" index each (repo convention).
ALTER TABLE bill_items
  ADD COLUMN care_entry_id uuid, ADD COLUMN bed_assignment_id uuid, ADD COLUMN service_date date,
  ADD COLUMN charge_item_id uuid, ADD COLUMN medicine_id uuid;
-- composite FKs to care_entries, bed_assignments, charge_items, medicines
CREATE UNIQUE INDEX bill_items_care_entry_once ON bill_items (care_entry_id)
  WHERE care_entry_id IS NOT NULL AND voided_at IS NULL;
CREATE UNIQUE INDEX bill_items_bed_day_once ON bill_items (bed_assignment_id, service_date)
  WHERE bed_assignment_id IS NOT NULL AND voided_at IS NULL;
-- Recreate the bill_items source CHECK (read 0026 first) so each item_type has exactly its source.

-- Not clinical: billing data. Captured by reception on the admission sheet (§5.3); edited at
-- discharge (T2.2) by voiding and inserting, never by updating.
CREATE TYPE payer_kind AS ENUM ('self', 'insurer', 'tpa', 'corporate');
CREATE TABLE encounter_payers (
  id uuid PK, hospital_id …, encounter_id uuid NOT NULL, patient_id uuid NOT NULL,  -- composite FK
  kind payer_kind NOT NULL, payer_name text, policy_number text,
  preauth_amount_paise integer, approved_amount_paise integer,
  created_by_user_id uuid, created_at, voided_at …,
  CHECK (kind = 'self' OR payer_name IS NOT NULL),
  UNIQUE (hospital_id, id)
);
CREATE UNIQUE INDEX encounter_payers_one_active ON encounter_payers (encounter_id) WHERE voided_at IS NULL;
-- Deposits need no new table: `patient_payments` is per encounter with a nullable bill_id (0026).
```

**Before writing 0032, Claude Code must read 0026 and 0028** to confirm: the existing `bill_items`
CHECKs, any guard trigger on `encounters` (Shift to IPD updates `encounters.stage`), and the helper names.

### 3.3 Ward devices — dropped

Removed on 3 Oct 2026 (D-DV): no shared-device mode, no PINs. Each nurse signs in with her own
login. The discharge-billing migration below took the number 0033.

### 3.4 Stage 2 migration — `0033_discharge_billing.sql` (task T2.1)

Payers moved to 0032 (2 Oct 2026), because reception records the payer at admission.

```sql
ALTER TABLE admissions ADD COLUMN bill_link_token_hash text, ADD COLUMN bill_link_expires_at timestamptz;
-- `document_sequences` for gap-free IPD bill numbers, if not already present (check 0026).
```

---

## 4. Permissions (`lib/domain/permissions.ts`)

Add `'nurse'` to `STAFF_ROLES`. New entries:

| Permission | Roles | Used for |
|---|---|---|
| `ipd.view` | owner, receptionist, doctor, nurse | IPD nav entry, IPD home, patient IPD page |
| `ipd.shift` | owner, doctor | The one-click **Shift to IPD** on the OPD dashboard |
| `ipd.admit` | owner, receptionist | New admission (emergency), assign bed, payer, transfer, cancel an awaiting request |
| `ipd.record` | owner, receptionist, nurse | Record a care entry; undo own entry within 2 minutes |
| `ipd.correct` | owner, receptionist | Void any care entry or bill line after the undo window, with a reason |
| `ipd.dischargeReady` | owner, doctor | Mark Discharge ready (Stage 3 phone view; also on the IPD page) |
| `ipd.discharge` | owner, receptionist | Discharge billing, finalise, print (Stage 2) |
| `ipd.configure` | owner | Wards and beds |
| `billing.price` (existing) | owner | Prices of charge items |

Existing entries to extend: `clinical.read` adds `nurse` (nurses read the IPD record; reads stay logged).
`queue.mutate`, `billing.collect`, `reports.view`, `subscription.notice`: **nurse not added**.
Taking a deposit on the admission sheet also needs the existing `billing.collect`, so the deposit
field is hidden from any role without it.

`DASHBOARD_VIEWS.nurse`: give it `{ default: 'reception', canSwitch: false }` to satisfy the type, but nurses never see the OPD dashboard: In `app/(app)/dashboard/page.tsx`, if the
role is `nurse`, `redirect('/ipd/ward')`. Add unit tests for every new line in `permissions.test.ts`,
including "nurse cannot mutate the queue" and "nurse cannot change prices".

---
## 5. Routes and screens

The IPD section lives under `app/(app)/ipd/`. It shares the app shell (`app/(app)/layout.tsx`) and adds
an **IPD section header**: a full-width strip under the main header with a bed icon, the title "IPD",
the branch name and, on wide screens, the section tabs. Add `{ label: 'IPD', href: '/ipd' }` to
`navItems` when `can(role, 'ipd.view')`; for nurses it is the first and only work item.

| Route | Screen | Roles | Primary device |
|---|---|---|---|
| (OPD) `/dashboard` | **Shift to IPD** button on the doctor's Now-serving card and on Seen-today rows | `ipd.shift` | Doctor's phone or PC |
| `/ipd` | **IPD home**: Awaiting bed · Wards · Discharge ready | `ipd.view` | Tablet / PC; works on phone |
| `/ipd/new` | **New admission** (emergency, no OPD token) | `ipd.admit` | PC / tablet |
| `/ipd/admissions/[id]/assign` | **Admission sheet**: pick a bed on the grid, optional reason | `ipd.admit` | PC / tablet |
| `/ipd/admissions/[id]` | **Patient IPD page**: header, day-by-day timeline, running total, role actions | `ipd.view` | Any |
| `/ipd/ward` | **Nurse ward picker** → `/ipd/ward/[wardId]` **ward grid** | `ipd.record` | Phone |
| `/ipd/ward/[wardId]/bed/[bedId]` | **Record screen** (tap item, save) | `ipd.record` | Phone |
| `/settings/ipd` | Wards and beds; charge items (with CSV import) | `ipd.configure`, `billing.price` | PC |
| `/ipd/admissions/[id]/bill` | **Discharge billing** (Stage 2) | `ipd.discharge` | PC / tablet |
| `/print/ipd-bill/[billId]` | **Itemised bill print** (Stage 2), outside the app shell like `/print/prescription` | `ipd.discharge` | Printer |
| `/b/[token]` | **Running bill for the family** (Stage 2), public, like `/q/[token]` | public | Patient's phone |
| `/ipd/my-patients` | **Doctor phone view** (Stage 3) | doctor | Phone |

### 5.1 Shift to IPD (OPD dashboard)

The doctor shifts a patient from the OPD queue or during the consultation.

- A secondary button **"Shift to IPD"** with a bed icon, beside Pause / Skip in the Now-serving card's
  action row (`app/(app)/dashboard/page.tsx`, the grid that holds `PausePatientButton`). The
  `ConsultationPanel` renders directly under that card, so the button is in view during the whole
  consultation; the panel itself is not changed. Also a small action on each **Seen today** row (the
  doctor may decide after completing). Only rendered when `can(role, 'ipd.shift')`.
- **One click, no dialog.** On click: optimistic disabled state with a spinner; on success a toast:
  *"Rahul Patil shifted to IPD — awaiting bed."* with **Undo** (10 seconds).
- What the server does (task T1.4): open/lock the encounter for the appointment → create the admission
  (`awaiting_bed`, attending doctor, requested by the actor) → set `encounters.stage = 'ipd'` → if the
  token is CALLED or IN_CONSULTATION, run the existing `applyQueueAction(complete)`. Idempotent: a second
  click returns the same admission.
- **Undo** cancels the admission (status `cancelled`, reason "Undone by doctor") and sets the stage back
  to `opd` if nothing has been recorded against it. The OPD token stays completed.
- On the patient's row afterwards: a small **"IPD · awaiting bed"** badge replaces the button.

### 5.2 IPD home `/ipd`

- **Segmented control** at the top (phone: full width; desktop: tabs in the section header):
  **Awaiting bed (n)** · **Wards** · **Discharge ready (n)**. Default tab: Awaiting bed if n > 0, else Wards.
- **Awaiting bed**: cards with name, age/sex, doctor, time since request ("12 min ago"), and one primary
  button **Assign bed** → admission sheet. Empty state: "No one is waiting for a bed."
- **Wards**: one card per ward with occupied/total ("7 of 10 beds"), and a **bed grid**: square tiles
  (min 72 × 72 px) sorted by `sort_order` then label. Free tile: bed label, muted. Occupied tile: bed
  label large, patient first name + last initial, day of stay ("Day 3"). Tapping an occupied tile opens
  the patient IPD page; a free tile does nothing for nurses and offers "Assign a waiting patient" for
  `ipd.admit`.
- **Discharge ready**: patients flagged by the doctor, with **Start discharge bill** (Stage 2).
- Header button **New admission** (`ipd.admit`).
- Live: refresh via the existing SSE channel or `components/auto-refresh.tsx` every 15 s; never wipe a
  form the user is filling.

### 5.3 Admission sheet `/ipd/admissions/[id]/assign`

- Patient header (name, age/sex, phone, doctor) carried over from OPD; nothing to retype.
- **Ward tabs + bed grid** of free beds; tap one bed, it highlights; **Confirm bed** is the single
  primary action, fixed at the bottom on phones.
- Optional fields collapsed under "Add details" (the doctor never fills these; reception does):
  - **Reason** (one line).
  - **Payer**: segmented Self (default) / Insurer / TPA / Corporate. For anything but Self: payer name,
    policy no., pre-auth amount (₹). Stored in `encounter_payers`.
  - **Deposit** (₹ amount + method, cash default), shown only with `billing.collect`. Stored as a
    `patient_payments` row (`kind 'payment'`, `bill_id` null) and shown on the patient IPD page's
    running-total card.
- On confirm, in one transaction: create the bed assignment, set status `admitted`, `admitted_at`,
  write the payer and deposit if given; toast; go to the patient IPD page. Race: if the bed was just taken (unique index), show "Bed 12 was just taken —
  pick another" and refresh the grid.

### 5.4 New admission `/ipd/new`

Three steps on one page: **Patient** (search by phone; if not found, name + phone + age/sex + address,
reusing the walk-in patient upsert rules) → **Doctor** (select) → **Bed** (same grid and the same
optional "Add details" block as 5.3: reason, payer, deposit). Creates an encounter with `origin = 'emergency'`, `stage = 'ipd'`, no appointment.

### 5.5 Patient IPD page `/ipd/admissions/[id]`

- **Sticky patient header**: name (large), age/sex, ward · bed, "Day 3", doctor, status chip.
- **Actions row** by role: Record item (`ipd.record`) · Transfer bed (`ipd.admit`) ·
  Discharge ready (`ipd.dischargeReady`) · Discharge bill (`ipd.discharge`, Stage 2).
- **Timeline grouped by day**, newest day first: each line = time, item, quantity, recorded by, and
  amount (amount column only for roles with `billing.collect`). Voided lines shown struck through with
  the reason, collapsed by default. Day subtotal at the end of each day.
- **Running total** card: charges so far, deposits, balance (`billing.collect` roles only).
- Flags banner: "2 items have no price yet" (links to settings for owners).

### 5.6 Nurse screens (the most important UI in this plan)

**Ward picker `/ipd/ward`:** big buttons, one per ward, with occupied count. If the device or the
nurse has only one ward, skip straight to it (remember the last ward in `localStorage`).

**Ward grid `/ipd/ward/[wardId]`:** the same bed tiles as 5.2, larger (min 88 × 88 px, 2–3 columns on
a phone), occupied beds only highlighted, patient first name + bed label in 18 px+. Tap → record screen.

**Record screen `/ipd/ward/[wardId]/bed/[bedId]`:** the patient is identified by the bed tile the
nurse tapped, with no scanning (decision D-ID). The large name · age · sex header is the identity check.

```
┌──────────────────────────────────────┐
│ ← Ward A          Bed 12             │
│ RAHUL PATIL · 42 M · Day 3           │  ← big, confirms identity
├──────────────────────────────────────┤
│ Given recently                       │
│ [Inj. Ceftriaxone 1 g] [NS 500 ml]   │  ← this patient's last 48 h, 1 tap
│ [Syringe 5 ml]        [IV set]       │
│ Common in this ward                  │
│ [Paracetamol 500] [Gloves] [Cannula] │
│ [ Search all items...          ]      │
├──────────────────────────────────────┤
│ Today: 6 items recorded  ▸           │
└──────────────────────────────────────┘
```

- Tapping an item opens a **bottom sheet**: item name, quantity stepper (default 1, − / +, max 999),
  "Given at: now" (tap to choose 15 / 30 / 60 minutes ago), and one large **Save** button.
  Two taps total for the common case: item → Save.
- After Save: sheet closes, a green confirmation bar "Saved · Inj. Ceftriaxone 1 g × 1 · 10:42" with
  **Undo** for 2 minutes. The item moves to the front of "Given recently".
- **Duplicate guard:** same item for the same patient within 15 minutes → the Save button changes to
  "Add again? (given 6 min ago)"; a second tap confirms.
- **Unpriced items** save normally; nurses never see prices or price warnings.
- **Offline:** if the request fails or `navigator.onLine` is false, the entry is stored in an IndexedDB
  outbox with its `client_id` and shows "Saved on this phone — will sync" (amber). The outbox flushes
  on reconnect and on every page load. The server's unique `client_id` makes retries safe.
- **Today list** (expandable): today's entries for this patient, newest first, own entries undoable
  within 2 minutes.
- Search: route handler `/api/ipd/items/search?q=` returning medicines and charge items, **names only,
  no prices** (like ADR-014), max 10, prefix match.
- **Not in the list:** when search finds nothing, offer **"Add 'X' as a new item"** with three chips,
  Medicine / Consumable / Procedure, then the normal bottom sheet and Save. The item is created unpriced
  (`quickAddMedicine`, or `quickAddChargeItem` with the same rules) and the entry is recorded in the
  same flow. Owners see the new item under "No price yet" (§5.8).
- **"Common in this ward"** = the ward's top 12 items over 30 days. Until the ward has that history,
  it is filled with starter items (§5.8) in list order, so the screen is useful on day one.

**Nurse logins (D-DV, 3 Oct 2026):** each nurse has her own login (Settings → Staff → Nurse) and opens
the IPD section on any phone or tablet; it lands on the ward. There is no shared-device or PIN mode.

### 5.7 Settings `/settings/ipd`

- **Wards and beds:** add ward (name, room charge per day), add beds in bulk ("1–12" creates 12 beds),
  reorder, deactivate (never delete a bed with history).
- **Charge items:** table with search, kind filter, "No price yet" filter (like Medicines), add/edit,
  **CSV import** (name, kind, unit, price in rupees, tax %): preview with row-level errors before saving.
  "Add common items" button (§5.8).
- **Set prices** view for charge items (§5.8).

### 5.8 Starter catalogues: pick, don't type

Decided 2 Oct 2026 (D-SC). In normal use nurses and doctors never type an item name. Every hospital
starts with common items already loaded **without prices**, so the owner only enters costs. A missing
item is added in place by whoever needs it. It is created unpriced and appears under "No price yet".

- **Already built (reuse, don't rebuild):** `STARTER_MEDICINES` (64 generics, D19) in
  `lib/domain/starter-medicines.ts`; `addStarterMedicines` and the doctor's `quickAddMedicine` in
  `lib/services/medicines.ts`; "Add common medicines" and the "No price yet" filter in
  `app/(app)/settings/medicines/page.tsx`.
- **New `lib/domain/starter-charge-items.ts`**, the same style: pure data, no prices, ordered most
  common first. An indicative set, to check against the pilot's price list in Stage 0:
  - *Consumables:* syringe 2 / 5 / 10 ml, IV cannula 18G / 20G / 22G, IV set, gloves (pair), Foley
    catheter, urine bag, Ryle's tube, gauze / cotton, dressing set, micropore tape, O₂ mask,
    nebuliser mask, blood transfusion set, 3-way stopcock.
  - *Procedures:* dressing small / large, nebulisation, catheterisation, RT insertion, IV cannulation,
    suturing, injection charge, enema.
  - *Services:* oxygen per hour, monitor per day, nursing charge per day, doctor visit, specialist
    visit, ECG, GRBS.
  - *Tests* (`service`, `is_test`): CBC, LFT, KFT, blood sugar F / PP, HbA1c, urine routine,
    electrolytes, CRP, dengue NS1, malaria, Widal, X-ray chest, USG abdomen.
  - *Room* (`room`): general ward, semi-private, private, ICU, each per day.
- **Loaded automatically for new hospitals:** `createHospital` (`lib/services/platform.ts`) loads
  starter medicines and starter charge items in its transaction. This finally does what D19 asked for:
  the list is loaded for every new hospital, not offered as an opt-in. Existing hospitals (the pilot)
  get the same through the "Add common medicines" / "Add common items" buttons. Both are idempotent
  (`onConflictDoNothing`), so they can be run again to add items that are missing.
- **Set prices** (Medicines and Charge items): opens on "No price yet", one form with a ₹ input per
  row (50 per page, searchable) and a single **Save prices** button; a blank input means skip. Each
  change is audited `{from, to}` like medicine prices today. Pricing an item also posts bill lines
  for its unbilled entries (T1.7 rule), for bulk saves too.
- **Empty-history fallbacks:** the nurse's "Common in this ward" (§5.6) and the doctor's Tests chips
  (T3.1) fall back to starter order until there is usage history.

---

## 6. UI standard (applies to every screen above)

1. **Use the design system:** `Button`, `Card`, `CardHeader`, `Field`, `Input`, `Alert`, `EmptyState`,
   `Stat` from `components/ui.tsx`; icons from `components/icons.tsx` (add `BedIcon`, `UndoIcon`,
   `SyringeIcon` in the same style); brand teal and ink tokens from `app/globals.css`; Inter and Noto
   Sans Devanagari. No new colours except the IPD section strip, which uses existing brand tokens.
2. **One primary action per screen**, visually dominant; on phones it is fixed to the bottom within
   thumb reach (`pb-[env(safe-area-inset-bottom)]`).
3. **Touch targets ≥ 48 px**, body text ≥ 16 px on nurse screens, patient name ≥ 20 px.
4. **Patient identity header** on every patient screen: name, age/sex, ward · bed.
5. **Every state is designed:** loading skeleton (`loading.tsx`), empty state with a next step,
   error message in plain words with a retry, offline banner on nurse screens. Never a blank page or a
   raw error string.
6. **Responsive:** no horizontal scroll at 375 px; tested at 375, 768 and 1280 px.
7. **Accessible:** real headings, labelled inputs, visible focus rings, contrast ≥ 4.5:1, respects
   `prefers-reduced-motion`; colour is never the only signal (icons + text on status chips).
8. **Language:** labels go through the existing dictionary (`lib/i18n/`) with Marathi, Hindi and English;
   tokens and bed labels use Latin digits with the `.numeric` class.
9. **Speed:** server components for reads; nurse record screen interactive in under 2 s on a mid-range
   Android over 4G; optimistic UI for Save, Undo and Shift to IPD.
10. **No surprises:** destructive actions (void, cancel admission) need a reason and a confirmation;
    everything else is undoable instead of confirmed.

---
## 7. Stage 1 tasks: IPD section, Shift to IPD, beds, nurse app

Build in this order; each task is one Claude Code session and one PR.

### T1.1 Nurse role and IPD permissions
- **Files:** `drizzle/0031_ipd_enums.sql`, `drizzle/meta/_journal.json`, `lib/domain/permissions.ts`,
  `lib/domain/__tests__/permissions.test.ts`, `app/(app)/dashboard/page.tsx`, settings staff role labels.
- **Do:** §3.1 migration; add `nurse` and the §4 permissions; nurse redirect from `/dashboard` to `/ipd/ward`;
  "Nurse" option when adding staff in Settings.
- **Accept:** typecheck forces every role decision; tests cover each new permission; a nurse login sees
  only the IPD nav item.

### T1.2 IPD schema
- **Files:** `drizzle/0032_ipd_core.sql`, journal, `lib/db/schema.ts`, `lib/db/__tests__/rls.integration.test.ts`.
- **Do:** §3.2 in full: tables (including `encounter_payers` and `charge_items.is_test`), composite FKs,
  RLS + clinical policies, guard trigger on `care_entries`, `bill_items` columns, indexes and the
  recreated source CHECK. Read 0026 and 0028 first.
- **Accept:** rehearsal passes; RLS guard test passes; a cross-tenant insert into each child table fails
  (add integration tests); a second open bed assignment for the same bed fails; a second active payer
  for an encounter fails.

### T1.3 Wards, beds, charge items and starter catalogues in Settings
- **Files:** `lib/domain/ipd-config.ts` (+ tests: bed range "1-12" parsing, CSV row validation, rupees → paise),
  `lib/domain/starter-charge-items.ts` (+ test: no duplicate identity, valid kinds, `is_test` only on
  services), `lib/services/ipd-config.ts` (`addStarterChargeItemsInTx`, `quickAddChargeItem`, bulk
  `setPrices`), `lib/services/medicines.ts` (split `addStarterMedicines` into an `…InTx` helper + wrapper;
  bulk price save), `lib/services/platform.ts` (`createHospital` loads both starter lists),
  `app/(app)/settings/ipd/*`, a "Set prices" view in `app/(app)/settings/medicines/`, nav link in settings.
- **Do:** §5.7 and §5.8. CSV import with preview and per-row errors. Audit price
  changes `{from, to}` in `audit_logs`, as medicines do.
- **Accept:** owner creates 2 wards × 10 beds in under 2 minutes; imports a 100-row price list; a new
  hospital starts with both starter lists, all unpriced; the owner prices the 64 starter medicines on
  one screen in under 10 minutes; a receptionist cannot open price settings.

### T1.4 Shift to IPD (doctor, one click)
- **Files:** `lib/domain/admission.ts` (status transitions, undo rule) + tests,
  `lib/services/admissions.ts` (`shiftToIpd`, `undoShiftToIpd`), `app/(app)/dashboard/ipd-actions.ts`
  (`shiftToIpdDynamic`, `undoShiftToIpdDynamic`), a `ShiftToIpdButton` client component, dashboard wiring.
- **Do:** §5.1 exactly. Service runs in `withTenant(…, { clinical: true })`: `openEncounterForAppointmentInTx`
  (locks), insert admission on conflict do nothing (live-per-encounter index), set stage `ipd`, write an
  audit row. The action then calls `applyQueueAction(complete)` only if the token is active, then
  `notifyQueueMovement`. Undo allowed within 10 minutes while `awaiting_bed` and no care entries.
- **Accept:** one click from the doctor's phone shifts the patient and calls no dialog; double-click
  creates one admission; Undo restores stage `opd`; a receptionist does not see the button;
  integration test for idempotency and cross-tenant refusal.

### T1.5 IPD section shell and IPD home
- **Files:** `app/(app)/ipd/layout.tsx` (section header), `app/(app)/ipd/page.tsx`, `loading.tsx`,
  `components/ipd/bed-grid.tsx`, `lib/services/ipd-census.ts`, nav item in `app/(app)/layout.tsx`,
  icons in `components/icons.tsx`.
- **Do:** §5.2 with Awaiting bed and Wards tabs (Discharge ready tab can show "Coming soon" until T2).
- **Accept:** UI standard §6 checked at 375/768/1280 px; census query uses `admissions_census_idx`;
  empty states for a hospital with no wards ("Set up wards in Settings" for owners).

### T1.6 Admission sheet, new admission, bed transfer
- **Files:** `lib/services/admissions.ts` (`assignBed`, `transferBed`, `createDirectAdmission`,
  `cancelAdmission`), `lib/services/encounter-payers.ts` (`setPayerInTx`), `recordDepositInTx` in
  `lib/services/patient-billing.ts` (modelled on the `patient_payments` insert in `setConsultationPaid`),
  routes in §5.3–5.4, `components/ipd/patient-header.tsx`.
- **Do:** assign creates the bed assignment and sets `admitted`, and writes the optional payer and
  deposit in the same transaction (also on direct admission); transfer closes the open assignment
  (`to_at = now()`) and opens a new one in one transaction; direct admission creates an encounter with
  `origin = 'emergency'`.
- **Accept:** the bed-taken race shows a friendly retry; transfer keeps all entries on the same admission;
  the deposit appears in the running total; a role without `billing.collect` never sees the deposit
  field; a second active payer is refused.

### T1.7 Care entries: service, API and bill posting
- **Files:** `lib/domain/care-entry.ts` (validation, duplicate window 15 min, undo window 2 min,
  backdating limits) + tests, `lib/services/care-entries.ts` (`recordCareEntries` batch, `undoCareEntry`,
  `voidCareEntry`, `listForAdmission`), `app/api/ipd/care-entries/route.ts` (POST batch, GET today),
  `app/api/ipd/items/search/route.ts`.
- **Do:** in one transaction per entry: verify the admission is `admitted`/`discharge_ready` and the
  item is active; insert the care entry (`on conflict (hospital_id, client_id) do nothing` → return the
  existing row); if the item has a price, `getOrCreateDraftBillInTx` and insert the bill line with the
  server price via `calculateBillItem`; voiding the entry voids its line. Unpriced → entry only, flagged.
  When an owner later prices an item, post lines for its unbilled, unvoided entries (same transaction;
  this includes the bulk "Set prices" save from T1.3). The batch accepts a "new item" entry
  (name + kind) that creates the item unpriced first (§5.6 "Not in the list"), under `ipd.record`.
- **Accept:** posting the same `client_id` twice yields one entry and one bill line; a request with a
  price field is rejected by the schema; a discharged admission refuses entries; a nurse-added item is
  created once (identity index) and unpriced; integration tests for all.

### T1.8 Nurse mobile screens and offline outbox
- **Files:** `app/(app)/ipd/ward/**`, `components/ipd/record-sheet.tsx`, `components/ipd/outbox.ts`
  (IndexedDB queue, no library), `app/manifest.ts` (installable PWA: name, icons, `display: standalone`,
  `start_url: /ipd/ward`).
- **Do:** §5.6 in full. "Given recently" = this patient's last 48 h;
  "Common in this ward" = top 12 items in the ward over 30 days, starter order until then (§5.8);
  "Add 'X' as a new item" when search finds nothing.
- **Accept:** on a real Android phone: bed → item → Save in ≤ 3 taps and ≤ 10 s; airplane-mode entries
  sync once on reconnect; Undo works for 2 minutes; nothing shows a price; a new ward with no history
  still shows 12 common items.

### T1.9 Shared ward devices — dropped (3 Oct 2026, D-DV)
Nurses use their own login; the nurse role already sees only the IPD section. Built once, then
removed as harder to understand than it was worth.

### T1.10 Nightly bed-day charges
- **Files:** `lib/domain/bed-days.ts` (+ tests), `lib/services/bed-days.ts`, hook into `runSweeps`
  in `lib/services/sweeps.ts`.
- **Do:** for each open or closed-today bed assignment, compute chargeable service dates under the
  hospital's rule (decision D-BD in §11; default: each calendar day occupied, discharge day not charged
  unless admission and discharge are the same day) and insert one `room` line per date using the ward's
  daily charge item. The unique index makes reruns safe.
- **Accept:** running the sweep twice adds nothing; a transfer mid-day charges one ward for that date
  (the ward occupied at the start of the day).

**Stage 1 gate (19 Oct – 27 Nov 2026):** one pilot ward records every item at the bedside by
16 Nov 2026, then keeps doing so for a week.

---

## 8. Stage 2 tasks: discharge billing and the transparent bill

### T2.1 Bill numbering and running-bill token — migration 0033 (§3.4). Payers moved to T1.2 / T1.6.

### T2.2 Discharge billing screen `/ipd/admissions/[id]/bill`
- Day-wise draft bill (same grouping as the timeline) with **flags first**: unpriced entries, possible
  duplicates (same item within 15 min), entries recorded > 6 h after `occurred_at`.
- Actions per line: accept flag, price item (owner), void with reason (`ipd.correct`), discount with reason.
- Panels: payer, as captured at admission (self / insurer / TPA / corporate, policy, pre-auth). Here the
  admin adds the approved amount → patient share vs payer share. A change voids the payer row and
  inserts a new one. Deposits taken at admission and other payments (`patient_payments`); balance or refund.
- **Finalise**: refuses while unpriced entries remain; numbers the bill; freezes it; sets admission
  `discharged`, closes the bed assignment and the encounter. Then **Print** and **Send on WhatsApp**.
- **Accept:** a 5-day stay with 80 entries is reviewed and finalised in under 15 minutes in a test with
  the pilot's admin.

### T2.3 Itemised bill print `/print/ipd-bill/[billId]`
- A4, print CSS. Header (hospital, patient, IP number, admitted/discharged, doctor, ward/bed, payer).
  **Day by day**: date heading, then time · item · qty · unit price · amount; day subtotal.
  Then room charges, adjustments with reasons, payments, payer share, balance. Page numbers in the footer.
- **Accept:** the printed total equals the database total; voided lines never print; Marathi names render.

### T2.4 Running bill for the family `/b/[token]`
- Admin taps "Share running bill": creates a 128-bit token (reuse `lib/security/tokens.ts`), stores its
  hash, sends the link on WhatsApp to the opted-in number (outbox rules apply), expires 7 days after
  discharge. The page shows the same day-wise list **without** who recorded it, no clinical notes.
- **Accept:** link works without login on a phone; revoking it returns a friendly expired page.

**Stage 2 gate (30 Nov – 24 Dec 2026):** from 4 January 2027 every pilot IPD discharge is billed from
this screen.

---

## 9. Stage 3 tasks: doctor phone view

### T3.1 `/ipd/my-patients`
- For the signed-in doctor (linked via `doctors.user_id`): their admitted patients as cards
  (name, bed, day, last entry time). Two buttons per card: **Discharge ready** and **Tests**.
- **Tests**: chips of the hospital's 10 most-ordered tests (charge items of kind `service` flagged
  `is_test`; the column exists from 0032, and starter tests are loaded by T1.3). Until there is order
  history, the chips show the first 10 starter tests. Multi-select, Send. Each becomes a care entry
  recorded by the doctor (billed like any other item). No forms, no new migration.
- Reachable from the doctor's OPD dashboard with one tap ("Admitted (4)").
- **Accept:** a doctor marks discharge ready in one tap; nothing on the page requires typing.

---

## 10. Stage 4 tasks: lab-lite, reports, hardening

- **T4.1 Lab-lite:** tests appear on a lab worklist (`/ipd/lab`, also OPD later); lab staff upload the
  result PDF to the admission; patient gets it on WhatsApp if opted in. No result entry fields.
- **T4.2 Reports:** daily collections, dues, admitted count, items used per day, flagged entries, average
  time from discharge-ready to final bill.
- **T4.3 Hardening:** Playwright end-to-end tests for: walk-in → Shift to IPD → assign bed → nurse entry →
  bed-day → discharge bill → print; backups with a tested restore; an onboarding kit (ward set-up and
  price-list template CSV).

---

## 11. Stage 0 field questions (answer by 16 Oct 2026)

Confirm with the pilot during Stage 0. If a question is still open when its task starts, build the
default.

| Id | Question | Default if not answered | Blocks |
|---|---|---|---|
| D-PH | Are IPD medicines supplied by the hospital (billed per entry) or bought by the family (record only)? | Billed per entry | T1.7 |
| D-BD | Bed-day rule: calendar days, 24-hour cycles, or include discharge day? | Calendar days, discharge day not charged | T1.10 |
| D-UN | Who may void a nurse entry after the 2-minute undo: billing only, or also the ward in-charge? | Billing (owner, receptionist) | T1.7 |
| D-UD | Should Undo of Shift to IPD also re-open the OPD token? | No; token stays completed | T1.4 |
| D-RB | Show the running bill to families during the stay? | Yes, when the admin shares the link | T2.4 |
| D-IN | Which insurers/TPAs does the pilot handle, and what must the admin record? | Payer name, policy no., pre-auth, approved amount | T1.2, T1.6 |

**Resolved**

| Id | Question | Decision | Date |
|---|---|---|---|
| D-ID | Identify the patient by bed QR or wristband? | Neither: tap the bed on the ward grid. QR/wristband moves to the future roadmap | 2 Oct 2026 |
| D-AD | What does reception enter when assigning the bed? | Bed + payer + deposit (optional, under "Add details") | 2 Oct 2026 |
| D-DV | Shared ward tablets with PINs, or each nurse's own login? | Each nurse's own login. No ward-device module | 3 Oct 2026 |
| D-SC | How do items get into the catalogue? | Starter lists are loaded unpriced when a hospital is created; staff pick, and add a missing item in place; the owner prices in bulk (§5.8) | 2 Oct 2026 |

---

## 12. Explicitly out of scope

ABDM / ABHA / HFR / HPR / NHCX and all government integrations · prescription photo capture or OCR ·
QR codes and wristbands · nursing charts and medication schedules · pharmacy stock · package billing ·
insurance claim submission · OT and HR modules. Do not add tables or UI for these. Items that may come
later are listed in §13.

† **10 Oct 2026:** nursing charts, medication schedules (MAR), bed QR codes and pharmacy stock for
risk-class drugs are now planned in [ipd-sheets-plan.md](ipd-sheets-plan.md), which the owner approved
for its pilot slice. The rest of this list still stands for this plan.

---

## 13. Stage 5 and future roadmap

**Stage 5, hospitals 2 and 3 (Apr – Jun 2027):** onboard two more hospitals using the T4.3 onboarding
kit (ward set-up, starter catalogues, price-list CSV template). No new modules; fixes only.

**Future roadmap (not scheduled, needs its own plan):**
- ABDM / ABHA / HFR / HPR / NHCX and other government integrations.
- Digital prescription capture. Removed from the MVP on 2 Oct 2026; to be discussed separately.
- Bed QR / wristband scanning (D-ID). † Bed QR: now in ipd-sheets-plan.md (pilot slice).
- Nursing charts, MAR with due times; pharmacy stock; package billing; insurance claim submission.
  † Charts, MAR and risk-class stock: now in ipd-sheets-plan.md (pilot slice); the rest is its roadmap.
