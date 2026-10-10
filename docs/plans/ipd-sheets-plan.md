# Qurio IPD: production plan (Patient file, platform hardening, accountability)

> **Status: Revision 5 approved by the owner on 10 Oct 2026 for the pilot slice only (§11.1).**
> Phases after it (§11.2) are a **roadmap, not a commitment**; each needs its own approval after
> the go/no-go review (§11.4).
> Sections changed in Rev 4 are marked **[Rev 4]**; sections changed in Rev 5 are marked **[Rev 5]**;
> **Rev 5.1 (10 Oct 2026, owner decision)** adds the record History view and phase **C4a** to the
> pilot slice, marked **[Rev 5.1]**.
>
> This plan **supersedes** the scope limits of [ipd-mvp-implementation-plan.md](ipd-mvp-implementation-plan.md)
> §1, §12 and §13 (nursing charts, MAR, bed QR, PIN login), and the decisions D-ID and D-DV there.
> The decisions are recorded in [../architecture/decisions.md](../architecture/decisions.md)
> ADR-021 to ADR-030. Production migrations are still applied only by the owner, after review.

## Change log, Rev 5 → Rev 5.1 (owner decisions, 10 Oct 2026)
Requested by the pilot hospital's admin: when a doctor sends a patient for a test and the patient
has not reached the lab in time, the lab's own staff call the patient and guide them (floor,
section); at the end of the day the admin sees pending tests per lab and who followed up.
1. **Record History view** (part of A6-min, migration 0045): for any record, who made or changed it,
   how (ward tablet or own device, which device) and when, from the evidence log; owner only.
2. **New phase C4a — test orders and follow-up** (§11.1, after B4a, migration 0047): the doctor
   orders tests in OPD and IPD; each test belongs to a **service point** (lab or room, with floor
   and section in en/mr/hi) and its **assigned staff**; a worklist with a "waiting since" clock and a
   Call button; call outcomes (no answer, coming now, told the way, will come later, went home,
   refused: cost / fear / other); a not-arrived task for that lab's staff after the hospital's set
   time, raised to the admin if nobody calls within 15 minutes; an admin **Today** screen per lab and
   per person, with the day-end pending list. Every step is in the evidence log. ≈ 3 weeks.
3. Roadmap **C4** becomes **C4b** (typed results, lab detectors).
4. Pilot slice ends ≈ 3 weeks later; go/no-go ≈ 5–16 Apr 2027.
5. Migration numbers in §11.1: 0045 History index, 0046 B4a, 0047 C4a, 0048 B3-min, 0049 B3b;
   roadmap numbers (§11.2) start at 0050 and are assigned when each phase is approved.
6. Decisions **D-LABCLOCK**, **D-LABFU**, **D-LABMSG** added (§17).

## Change log, Rev 4 → Rev 5
1. **New S0 infrastructure stage** (§9.2): an India VPS + the smallest managed DB (or Postgres on
   the VPS with WAL archiving), encrypted backups to S3 Mumbai, with a cost estimate and the
   triggers to move to S1. The pilot slice runs on S0, not S1; A3 becomes the lighter "S0 India
   move".
2. **Pilot-slice infra cost against one hospital's revenue** (§2.3a), including how many hospitals
   it takes to reach the ≤ 12% target.
3. **Stock counts for risk-class drugs moved earlier**: B4 is split into **B4a count-first
   stock** (live about 7 weeks earlier) and **B4b MAR linking**. Extra cost ≈ 0.5 week, under the
   2-week limit (§11.1).
4. **Go/no-go review after the pilot slice** (§11.4), with §12 metrics, thresholds, attendees and
   outcomes.
5. **Legal-review checklist with owners and dates** (§17.1).
6. §11.2 is relabelled a **roadmap**.

## Change log, Rev 3 → Rev 4

1. **§1** adds the 7.10 time-critical alerts and the final-bill message, plus an "if only one
   engineer" priority order.
2. **§2** adds an infrastructure cost budget (₹ per hospital and per 100 beds against a 30–40%
   gross margin), plus load tests for the due board and detector runs.
3. **§3** adds two gap rows: timed medication and task scheduling, and bill/summary delivery.
4. **§4**:
   - adds a shared **due engine** module and `time_critical` in the toggle matrix;
   - adds the branch-RLS index strategy, a 100 M-row benchmark and a fallback;
   - adds the gate for removing the `can(role, perm)` shim.
5. **§5**:
   - Mode A: the **ward device stays enrolled** and is never signed out for being unused (owner
     comment). Only the person's PIN session locks.
   - Mode B: clinical roles get a **15-min idle lock**, and the PIN is asked again after **5 min in
     the background**. On by default and enforced on the server.
   - Risk-class Given from a personal device needs a **bed/wristband scan** (or a ward device).
   - **Witness redesigned**: an approval request goes to the witness's own session, or the witness
     uses the shared ward device. A witness PIN is never typed on someone else's phone.
6. **§7**:
   - 7.2 witness redesign
   - 7.3 registers with **official citations** (unverified points marked)
   - 7.5: D3 is report-only; D5 is normalised by acuity; new **D15** (late/missed time-critical
     doses, a quality signal routed to the nursing superintendent) and **D16** (batch charting)
   - 7.8 sources
   - **new 7.10: time-critical medications and timed tasks**
7. **§8** adds MAR due-time engine details and a core **timed tasks** row.
8. **§9**:
   - a **staged cost model** (single-AZ start, with triggers to Multi-AZ, replica, WAF and a
     separate-account anchor)
   - **residency migration early**
   - the runner v2 requires idempotent SQL and a dry run on a production-sized snapshot
9. **§10** gives an **SLO per infrastructure stage** and keeps the due board working offline with
   "last synced".
10. **§11** is re-sequenced:
    - a **pilot slice**, with **TPR first** (owner decision 10 Oct) and drug accountability right
      after
    - new **B3b due engine**
    - **week estimates and a critical path**
    - the final-bill message in **C5**
11. **§12** adds a one-week observe period for time-critical alerts, then warn, with a nurse rating
    of alert volume.
12. **§13** designs the due board like the paper medication round / MAR time grid.
13. **§14** gets official source citations.
14. **§15** adds due-time tests, final-bill message tests, and witness approval-flow tests.
15. **§16** adds the **final-bill WhatsApp message**.
16. **§17** adds **D-DRUG, D-TIMECRIT, D-ESCAL, D-BILLMSG, D-COST**; D-ORD is updated.
17. **§19 Sources (new)**: every external claim is linked; unverified ones are marked.

## Contents
1. Context
2. Scale, performance and cost budgets
3. Gap analysis
4. Architecture: modules, toggles, due engine, org hierarchy, roles and scopes
5. Staff access: Mode A and Mode B
6. Security
7. Accountability and observability (incl. 7.10 time-critical medications)
8. Clinical scope
9. Data residency, cost model and production-safe migrations
10. Reliability and operations
11. Phases, pilot slice, weeks and critical path
12. Rollout strategy
13. Adoption: paper to digital
14. Compliance, interoperability, onboarding, support
15. Verification and test packs
16. WhatsApp cost and messages
17. Open decisions with recommendations
18. Files to reuse
19. Sources
Appendix A: carried-over table designs

---

## 1. Context [Rev 4]

**Pilot facts.** Guruved Hospital (Shirpur) runs IPD on paper: TPR chart, treatment & diet card,
doctor case sheet, Marathi and high-risk consents, billing sheet, admission form. The final bill is
retyped into HealthPlix. The pilot doctor reports two problems:
- **fake medication entries used to divert drugs**;
- **time-critical injections** (e.g. a cardiac injection every 12 hours) that must be given on time.

**Owner answers so far:**

| Area | Answer |
|---|---|
| Notes and orders | Typed by the doctor, or transcribed by a nurse/RMO and countersigned by the doctor |
| Consent | Finger signature, or print and sign |
| Letterhead | Text letterhead |
| Procedures | Minor procedures only |
| Schemes | MJPJAY/PM-JAY and TPA possible |
| Lab | Own in-house lab |
| Bed QR and PIN | Reversal of D-ID and D-DV is deliberate |
| Build order | **TPR first** (10 Oct) |

**Rev 3 added:**
- production scale, staged rollout, India residency, expand/contract migrations
- operations, clinical depth, configurable roles and scopes, specialty templates
- NABH, ABDM and FHIR, onboarding, quality gates
- both access modes, and the Accountability module family

**Rev 4 adds:**
- **time-critical medication and timed-task alerts** (§7.10) built on a shared due engine
- the **final-bill WhatsApp message** (§16)
- cost budgets
- the personal-device hardening and witness redesign

**Kept throughout:**
- paper-like sheets, enter once, offline outbox, TPR first
- 0040 reserved
- text + CHECK instead of enums
- the 0032 RLS block, void-only guards
- new code in new files; only small append-only edits to the uncommitted identity files
- 48 px phone-first UI, module toggles, the security baseline

### If only one engineer: priority order [Rev 4]

1. **Protect live customers:** migration runner v2, backups with a tested restore, and the Mumbai
   move (§9). Do it now while the data is small.
2. **Pilot slice** (§11.1):
   - minimal toggles
   - PIN login and Mode B lock
   - **TPR**
   - evidence log
   - risk-class and time-critical MAR with the **due board**
   - stock counts in observe mode
3. **High value, low effort:** allergy banner, discharge summary, final-bill message.
4. Basic detectors + cases.
5. Billing sheet.
6. Consents and doctor notes.
7. Lab.
8. **Full roles and scopes** (needed when the first multi-department customer signs).

**Can wait until a customer needs it:** specialty packs (ICU/NICU/labour), ABDM, order sets,
procedure notes, care plans, group dashboards, enterprise detectors, cells, SSO.

**People, not code:** 24×7 on-call (§10) and legal review (§7.8) need outside help.

---

## 2. Scale, performance and cost budgets [Rev 4]

### 2.1 Scale assumptions (D-SCALE)

| Item | Design target | Load-test at |
|---|---|---|
| Hospitals | 1,000 in 3 years (50 in year 1) | 2,000 |
| Largest hospital | 500 beds, 5 branches, 20 departments, 40 wards | 1,000 beds |
| Concurrent staff | 300 per large hospital; 25,000 platform | 2× |
| Shift-change peak (one 500-bed hospital) | 500 TPR + 1,500 doses in 20 min (bursts of 10 writes/s) | 5× |
| Hot-table growth | ≈ 2.5 M clinical rows/day; ≈ 1.8 B rows in 2 years | 2 years of synthetic data |
| Due board viewers | 2 ward devices + 5 personal sessions per ward, refreshing every 60 s | 2× |
| Family viewers | 3 per admitted patient, every 60 s | 5 |

### 2.2 Performance budgets

| Measure | Budget |
|---|---|
| Nurse screen first load (mid Android, 4G) | LCP ≤ 2.5 s p75; interactive ≤ 3 s; ≤ 150 KB JS per route |
| Server page data | p95 ≤ 400 ms; p99 ≤ 1 s |
| Write API | p95 ≤ 250 ms; p99 ≤ 600 ms server; ≤ 1 s end-to-end on 4G |
| Offline sync | 50 entries in ≤ 10 s after reconnect; 0 lost or duplicated |
| Polled endpoints (census, due board, worklists) | DB time p95 ≤ 30 ms; index-only, no scans |
| **Due board** | Ward of 40 beds and 300 active orders: server compute p95 ≤ 150 ms; on-device recompute ≤ 50 ms |
| **Escalation sweep** (every minute, all hospitals) | ≤ 5 s per run at design load; partial index on active time-critical orders |
| **Detector runs** (every 15 min, incremental) | ≤ 2 min per run at design load, on the read replica; never above 20% replica CPU |
| Dashboards | p95 ≤ 2 s from rollups; refresh ≥ 5 min |
| Whole-file print (10-day stay) | ≤ 5 s |

### 2.3 Infrastructure cost budget

Target: **infra ≤ 12% of revenue**, so gross margin stays within the 30–40% target after
WhatsApp, support and payment fees. Estimates per stage (stages defined in §9.2; ₹88/US$
assumed):

| Stage | Infra/month (estimate) | Example load | ₹ per hospital/month | ₹ per 100 beds/month |
|---|---|---|---|---|
| S1 Starter | US$230–330 ≈ ₹20–29k | 30 hospitals, 1,500 beds | ₹670–970 | ₹1,330–1,930 (₹13–19/bed) |
| S2 Standard | US$1,000–1,300 ≈ ₹88k–1.15 L | 150 hospitals, 7,500 beds | ₹590–770 | ₹1,170–1,530 |
| S3 Scale | US$3,500–6,000 ≈ ₹3.1–5.3 L | 1,000 hospitals, 50,000 beds | ₹310–530 | ₹620–1,060 |

**Finding.** At S1, infra per hospital (₹670–970) is **45–65% of the ₹1,499 Clinic plan**. The OPD
Clinic tier is fine only because clinics without IPD use a fraction of the load. IPD must be priced
**per bed**: ≥ ₹120 per licensed bed per month keeps infra ≤ 12% at S1 and ≤ 8% from S2 (D-COST).
These are estimates and need to be checked in the AWS Pricing Calculator (§19).

### 2.3a Pilot slice: monthly infra cost against one hospital's revenue [Rev 5]

**Pilot-slice infra (S0, §9.2):**

| Item | Option 1: VPS app + smallest managed DB (recommended) | Option 2: everything on the VPS |
|---|---|---|
| App + worker on the existing India VPS | ₹0 extra (already paid); a new 2 vCPU/4 GB India VPS would be ≈ ₹1,200–2,000 | same |
| Database | RDS PostgreSQL db.t4g.small, single-AZ, Mumbai, 20 GB gp3, 7-day PITR ≈ US$30–35 ≈ **₹2,600–3,100** | Postgres on the VPS ≈ ₹0 extra |
| Backups to S3 Mumbai (encrypted, SSE-KMS) | RDS snapshots + nightly `pg_dump` to S3 ≈ US$2 ≈ ₹180 | WAL archiving (`wal-g`, infra tool, not an app dependency) + nightly base backup to S3 ≈ US$2–4 ≈ ₹180–350 |
| Cross-region copy to Hyderabad | ≈ US$1–2 ≈ ₹90–180 | ≈ ₹90–180 |
| KMS keys (backups, evidence) + Object Lock bucket for digests | ≈ US$2–3 ≈ ₹180–260 | same |
| Staging DB | Docker Postgres on the VPS ≈ ₹0 | same |
| Monitoring: uptime check, status page, alerts | Free tiers (Better Stack/UptimeRobot) ≈ ₹0 | same |
| **Total extra per month** | **≈ US$35–45 ≈ ₹3,100–4,000** | **≈ US$5–10 ≈ ₹450–900** |

All prices are estimates. The db.t4g.small Mumbai rate was not found in a source and must be
checked in the AWS calculator (D-COST). ₹88/US$.

**Against one hospital's revenue** (the pilot alone; in reality S0 is shared by every current
customer):

| One hospital pays (per month) | OPD ₹1,499 + IPD 25 beds × ₹120 = **₹4,499** | OPD ₹4,999 (mid band, assumed) + IPD ₹3,000 = **₹7,999** | OPD ₹10,999 + IPD ₹3,000 = **₹13,999** |
|---|---|---|---|
| Option 1 infra ₹3,100–4,000 as % of revenue | 69–89% | 39–50% | 22–29% |
| Option 2 infra ₹450–900 as % of revenue | 10–20% | 6–11% | 3–6% |
| IPD WhatsApp (≈ 150 admissions × 2 messages × ₹0.16 ≈ ₹50) | 1% | 0.6% | 0.4% |

**Reading it:**
- No single small hospital can carry Option 1 alone, but S0 is a **shared** stack.
- At an average of ₹6,000 revenue per hospital, Option 1 reaches the **≤ 12% infra target at about
  5–6 hospitals** on S0, and Option 2 at 1–2.
- **Recommendation:** use **Option 1** if there are ≥ 4 paying hospitals on the platform at the
  cutover. Use **Option 2** (VPS DB + WAL archiving, with a monthly restore drill) only if there
  are fewer, and move to Option 1 at the first S0 → S1 trigger or the 4th hospital.
- The pilot's real bed count and OPD band replace these assumptions (D-PILOTREV).

### 2.4 Load testing
- k6 scripts in `loadtest/` (dev tool). Synthetic generator `scripts/synth/` with 1,000 tenants, 2
  years of data, real skew.
- **Scenarios:**
  - shift-change spike
  - discharge rush
  - family polling
  - offline burst (100 phones reconnecting)
  - **due board**: all wards refreshing + an 8 am dose wave
  - **escalation sweep** under peak writes
  - **detector batch** alongside peak writes on the replica
  - migration rehearsal under load
- **Gate:** every phase meets §2.2 before rollout. Query plans are saved in `docs/perf/`.

---

## 3. Gap analysis [Rev 4: two rows added]

| Area | Large-hospital expectation | Qurio today | After this plan | Remaining gap |
|---|---|---|---|---|
| ADT and beds | Admission, transfers, bed board, housekeeping | Admission, transfer, grid | + departments, scopes, readiness | Housekeeping status: later |
| Nursing documentation | Assessments, flowsheets, care plans, handover | Item entry | Template charts, scores, I/O per shift, handover | Full NANDA plans: later |
| CPOE + eMAR | Orders, due times, states, barcode | — | Orders + MAR + scans + checks | Interaction database: later |
| **Timed medication and task scheduling** | Due list, overdue escalation, on-time metrics | — | **Planned: due engine, due board, two-sided windows, escalation, on-time dashboard (§7.10)** | Device/pump integration: later |
| Pharmacy / stock | Indents, issues, GRN, batches, NDPS registers | — | Ledger, sub-stores, batches, counts, registers | PO/vendor management: later |
| Lab (LIS) | Worklist, samples, results, analysers | Tests as bill items | Orders → collection → results | Analyser interface: later |
| Radiology | Orders, reports, PACS | — | Orders/results | PACS: out of scope |
| OT | Scheduling, anaesthesia | — | Procedure notes | Full OT: later |
| Critical care | ICU/NICU charts, infusions | — | Template packs, infusion records | Device integration: later |
| Billing | Tariffs per payer, packages, interim bills | Itemised, deposits | + category bill, alerts, leakage | Payer tariffs and packages: later |
| **Patient bill and summary delivery** | Bill and discharge summary to the family digitally | Manual wa.me share of `/b` (no PIN) | **Planned: one final-bill message, link + PIN, 30-day link, delivery status on the desk (§16); summary behind the same PIN** | — |
| Insurance / schemes | Pre-auth, claims, NHCX | Payer captured | Claim packet, date checks, ABHA | NHCX/TMS APIs: later |
| MRD | Coding, retrieval, retention | — | Retrieval, retention, export | ICD-10 coding UI: later |
| Quality (NABH) | Indicators, incidents | — | Indicator reports, med-error/ADR log, on-time administration | Incident management: later |
| Interop | ABDM M1–M3, FHIR, HL7 | — | FHIR export, ABDM M1/M2 | M3: later |
| Security / audit | RBAC, audit, SSO | 4 roles, audit | Roles + scopes, break-glass, MFA, tamper evidence | SSO: later |
| Operations | Uptime, DR, support SLAs | PITR | Staged SLOs, India DR, status page | 24×7 people |
| Kitchen, CSSD, HR/payroll | Present in big suites | — | Diet orders; roster for accountability | Out of scope |

---

## 4. Architecture [Rev 4: 4.1, 4.2, 4.3 and 4.4 changed]

### 4.1 Module registry and toggles

- **`lib/modules/registry.ts`** is pure and tested. Each module declares:
  - `id`, `title`, `tier`, `core`, `dependsOn`, `uses`
  - `permissions`, `routes`, `apiRoutes`, `fileTabs`, `printSheets`, `navEntries`, `settingsPages`
  - `migrations`
  - `readinessChecks`, `leakageChecks`, `handoverSections`, `detectors`
  - **`dueSources`** (new)
  - `defaultState(plan)`, `settingsSchema`
- **`hospital_features`**: `state` on/read_only/off; `rollout_scope` (all, or branch and ward ids);
  `stage` observe/warn/enforce; `settings` jsonb; audited.
- **Server guard chain:** session → tenant → permission → scope → module state and rollout scope →
  plan gate. A registry coverage test fails if any module route skips it. Off = 404 with data kept;
  read-only = 403 on writes.
- **Generated from the registry:** tabs, print selector, nav, settings, checklists, reports, due
  sources.
- **Ports and in-transaction events:** `dose.administered`, `dose.voided`, `dose.omitted`,
  `stock.moved`, `chart.recorded`, `task.completed`, `order.created`, `order.stopped`,
  `lab.resulted`, `admission.discharged`, `session.switched`. ESLint blocks cross-module service
  imports.
- **Shared `due_engine` module (core of the medication family):**
  - **Domain** (`lib/domain/due.ts`): pure and isomorphic, so the same code runs on the server and
    on the phone.
  - **Input:** an order's schedule (clock times or interval), its window settings and its event
    history (given, omitted, held).
  - **Output:** due instances with status (§7.10).
  - **Consumers** register a `DueSource`:
    - MAR: medication orders
    - charts: vitals frequency, BSL checks, I/O totals due
    - procedures and nursing tasks: dressing, repositioning, transfusion checks, post-op
      observations
  - **One due board** renders all of them. Escalation, handover and on-time dashboards read the
    same engine.

### 4.2 Toggle matrix

| Module family | Modules | Tier | Default (pilot) | Hard deps | When off |
|---|---|---|---|---|---|
| Core (cannot be off) | core_ipd, letterhead, patient_file, security_baseline, access modes (at least one on), acct_core, **due_engine** | all | on | — | — |
| Charts | charts (TPR + template engine), nursing_scores, io_balance | basic | on | core | Tabs gone; chart due tasks vanish |
| Specialty packs | icu_pack, nicu_pack, labour_pack, paeds_pack | enterprise | off | charts | Templates hidden; old entries read-only |
| Medication | orders_mar, allergy, med_reconciliation, dose_guard, order_sets | basic (order_sets standard) | on | core, due_engine | Falls back to simple item entry |
| **Time-critical** | **time_critical** (flags, windows, alerts, escalation, on-time dashboard) | basic (escalation levels: standard) | **on, stage `observe` for 1 week, then `warn`** | orders_mar, due_engine | Due board shows plain due times only; no chime, banner or escalation |
| Timed tasks | timed_tasks (task orders: dressing, repositioning, checks) | standard | on | due_engine | Task orders hidden |
| Safety | ews, handover, readiness | standard | ews off until confirmed | charts / orders_mar | Badges and checklists gone |
| Documents | discharge_summary, consent, doctor_notes, admission_form, procedure_notes | basic (procedure_notes standard) | on (procedure_notes off) | core | Tabs gone |
| Billing | billing_sheet, deposit_alert, leakage_report, **bill_message** | basic | on | core | Sheets, alerts and message gone |
| Lab | lab, lab_radiology | standard | lab on | core | Tests chips post plain care entries |
| Family | family_view | standard | off until approved | consent | Links stop |
| Claims / interop | claims, abha_capture, abdm_hip, fhir_export, mrd_retrieval | standard/enterprise | claims on; abdm off | admission_form, discharge_summary | Pages gone |
| Accountability | §7.1 | basic → enterprise | acct_core on; stock on; detectors observe | acct_core | Detectors stop; the evidence log never stops |
| Training | training_mode | all | on | — | — |

### 4.3 Org hierarchy, branch isolation and the RLS index strategy

```
hospital (tenant/group) → branch → department → unit (ward | lab | store | desk)
```

- Tables `departments` and `org_units` (with a materialised `path`). Clinical tables carry
  `branch_id` and `org_unit_id`, denormalised from the admission and enforced by a composite FK.
- **Branch policy:** a restrictive RLS policy
  `branch_id = ANY(app_branch_ids())`, where `app_branch_ids()` is a `STABLE` SQL function reading
  `app.branch_ids`.
- **Index strategy** (every clinical and accountability table):

| Access pattern | Index (leading columns first) |
|---|---|
| Patient file (most reads) | `(hospital_id, admission_id, observed_at)`; RLS quals are cheap filters on a few rows |
| Ward lists, due board, census | `(hospital_id, branch_id, org_unit_id, due_at / observed_at)`, partial `WHERE voided_at IS NULL` (and `status = 'active'` for orders) |
| Detectors and dashboards | `(hospital_id, branch_id, occurred_at)` per monthly partition, plus BRIN on `occurred_at` for large partitions |
| Accountability by person | `(hospital_id, actor_user_id, occurred_at)` |

- **Benchmark (part of A4):**
  - 100 M-row synthetic `chart_entries` and `mar_administrations`, plus 300 M `acct_events`.
  - Compare the 15 hottest queries with RLS on vs a bypass role.
  - **Target: overhead ≤ 10% p95** and identical plans (index scans, no seq scans).
- **Fallback if slow, in order:**
  1. Single-branch sessions (most staff) set `app.branch_id` and the policy uses equality; only
     multi-branch roles use `ANY`.
  2. Hash-partition the hottest tables by `hospital_id` (16 partitions), so RLS and index work stay
     per partition.
  3. Keep the tenant RLS, but move the branch check into a query-layer filter, guarded by a lint
     rule and the scope test matrix (§15). Last resort, and needs an ADR.

### 4.4 Roles and scopes

- **Expand/contract** away from the 4-value enum:
  - `role_templates` (code)
  - `hospital_roles` (per hospital)
  - `staff_role_assignments` (role + scope + validity)
- **Built-in roles:** owner/group admin, branch admin, HOD, ward in-charge, doctor, RMO, nurse,
  receptionist, billing/TPA desk, pharmacist/stock in-charge, lab tech, lab in-charge, radiology,
  MRO, quality/audit officer (read-only), training user.
- **`can(principal, permission, target)`** is scope-aware. Break-glass is a 60-min, reasoned,
  reviewed grant. Access reviews run every 90 days, and dormant accounts auto-disable. Separation-of-duty
  guardrails are built into role templates.
- **Gate before removing the old `can(role, perm)` shim:**
  1. **Shadow mode in production for ≥ 2 weeks:** both checks run, the old one decides, and any
     difference is logged (no PHI) to a review list.
  2. **Zero unexplained differences**, plus a passing **role × permission × scope matrix test** in
     CI for 2 consecutive releases.
  3. **Documented rollback:** the flag `authz_v2` switches decisions back to the shim within one
     deploy. The shim code is kept for one more release after the switch, then removed in a
     contract release.

### 4.5 Specialty configuration

As in Rev 3:
- `chart_templates`, `chart_template_versions` (immutable fields with en/mr/hi labels, units,
  ranges, paper order and score rules), and `template_assignments`.
- `chart_entries` keeps typed hot vitals columns plus `values jsonb` validated per version.
- **Template fields can declare a frequency**, e.g. "BSL QID" or "vitals q4h". The chart registers
  it as a `DueSource`, so these checks appear on the due board.

---

## 5. Staff access: both modes always work [Rev 4]

| | Mode A: shared ward device | Mode B: personal device / any browser |
|---|---|---|
| Device / browser sign-in | **The device is enrolled once by the owner. It stays enrolled and is never signed out for being unused**, e.g. a tablet left in a drawer for a day or a week. The enrolment renews silently on use; it ends only on revoke, or after **90 days with no use at all** (setting). | Email/phone + password; TOTP MFA required for owner, group/branch admin, quality officer and doctors with admin rights |
| Person session | PIN per person. **10-min idle → back to the PIN pad** (not a sign-out of the device). No fixed absolute limit, because the idle lock covers it; the person's PIN session is capped at **24 h** as a safety net. **Switch user** always visible. IPD scope only. | **Clinical roles (nurse, doctor, RMO, lab, pharmacist): 15-min idle lock** → enter the personal PIN to continue. **PIN asked again after 5 min in the background.** On by default; owner can shorten, not lengthen beyond 30 min. The underlying sign-in lasts 14 days (owners 8 h idle, 7 days), so staff are not asked for the password every day |
| Server enforcement | Locked state lives on the server (`sessions.locked_at`, set when `last_seen_at` passes the idle limit or the client reports background > 5 min). A locked session gets **401 locked** on every PHI route until a PIN unlock, so a stolen cookie cannot bypass the lock | Same |
| Risk-class drug Given | Allowed (the device is in the ward) | **Needs a bed QR or wristband scan** at the bedside (camera via `BarcodeDetector`, or the 6-character bed code printed under the QR), **or** do it on the ward device. On by default |
| Witness | Witness takes the shared device: "Witness" → their own PIN pad (§7.2) | Witness **approves from their own signed-in session**; never by typing their PIN on the actor's phone |
| Attribution | `recorded_by` (the PIN-verified person), `channel='ward_device'`, `device_id`, `session_id` | `channel='personal'`, `device_id`, `session_id` |
| Owner controls | Enable or disable each mode per hospital and **per role** (`access_modes` settings, enforced at login and on every session resolve) | Same |
| Recovery | PIN reset by ward in-charge or owner; device revoke kills its sessions in ≤ 10 s | Lost phone → sign out everywhere (self/in-charge/owner); password and MFA reset by owner, audited |
| Fallback | Print blank or pre-filled sheets; back-entry later, marked "late entry" | Same |

**Personal-device threats:**

| Threat | Controls |
|---|---|
| Lost phone | 15-min lock + 5-min background PIN; sign out everywhere; outbox and due-board cache hold **ids and short labels only**, are cleared on sign-out, and expire after 24 h |
| Shared family phone | Server-side lock; no "remember me" for PHI; `no-store` |
| Staff who leave | Deactivation deletes sessions and the PIN at once (revocation version, no cache window) |
| Faked entries from home | Channel recorded; **scan required for risk-class**; D12 (channel mix) and D4 (not in ward) |
| Screenshots | Not preventable; deterred by logging and the monitoring notice |

**Header change:** `Permissions-Policy` becomes `camera=(self)` (today `camera=()`), for QR
scanning only.

---

## 6. Security (no change from Rev 3)

### 6.1 Threat model

| # | Actor | Threat | Controls |
|---|---|---|---|
| T1 | Internet attacker | Unauthenticated access, credential stuffing | Auth on every surface; login throttle (exists); MFA for admins; registry coverage test |
| T2 | Other tenant | IDOR / cross-tenant | Tenant from session only; RLS; composite FKs; per-table tests |
| T3 | Other branch / department | Out-of-scope reads | Branch RLS policy; scope checks in `can()`; break-glass only with a reason |
| T4 | Staff beyond role | Unauthorised writes | Configurable roles with guardrails; server checks; SoD rules |
| T5 | Relative with link | Guess or forward a link; brute-force the PIN | 128-bit hashed token + PIN; lock-out; curated fields; expiry; revoke |
| T6 | Lost ward device or phone | Use of an open session | Idle locks; revoke; PIN lock-outs; scope limits |
| T7 | Shared tablet | Wrong actor recorded | Switch user = new session; PIN per person; detector D11 |
| T8 | Insider fraud | Fake Given, fake results, stock theft | §7: prevention, reconciliation, detectors, evidence log |
| T9 | Insider / DBA / our staff | Silent edit or deletion of records or logs | Void-only guards; append-only event log with Merkle digests anchored in WORM storage (§7.6); no support access to clinical or accountability data |
| T10 | Logs and errors | PHI leakage | Structured logger with field allow-list; ConsoleProvider guard; no PHI in URLs or filenames |
| T11 | WhatsApp / BSP | PHI in bodies | Link-only templates; PIN never sent |
| T12 | Uploads | Malware, script | Type allowlist; magic bytes; size cap; sandboxed serving; India-region private bucket |
| T13 | Session theft | Reuse after leaving | Revocation version; idle timeout; device binding of ward sessions |
| T14 | Regional outage, breach | Downtime; late breach notice | India DR (§10); DPDP breach runbook (72 h) |
| T15 | Supply chain | Malicious dependency | Lockfile, `npm audit` in CI, minimal deps, Renovate with review |

### 6.2 Controls

1. **Authorization:** one guard chain per surface (§4.1), deny by default, scope-aware. A matrix
   test covers role × permission × scope. UI hiding is never the control.
2. **Tenant and branch isolation:** RLS + `clinical_access` on every clinical table; the branch
   policy (§4.3); composite `(hospital_id, …)` FKs; cross-tenant and cross-branch tests per table.
3. **Audit:**
   - Every write emits an accountability event (§7.6) with actor, device, channel, session and
     hashed IP.
   - Reads of clinical and accountability data go to `record_access_logs` (new `device_id`,
     `session_id`): 10-min dedupe for patient-file views; no dedupe for staff-timeline and ledger
     views.
   - Fill `audit_logs.ip_address`.
   - Add the missing audit rows: logout, failed login, password change, staff deactivation, PIN
     set/reset, device enrol/revoke.
   - Logs are append-only and partitioned monthly.
4. **Data minimisation:**
   - Ids only in URLs; curated family view; no PHI in push or WhatsApp bodies or file names.
   - Fix existing leaks:
     - ConsoleProvider refuses to run in production (or redacts);
     - `logError()` replaces raw `console.error(err)`;
     - the `/b` token leaves the query string.
   - `noindex` on `/q` and `/book`.
5. **Files:**
   - S3 Mumbai, private, SSE-KMS, random keys.
   - Upload by presigned POST, ≤ 10 MB, PDF/JPEG/PNG only, magic-byte check.
   - Async ClamAV scan with quarantine until clean.
   - Download only through an authorising route: logged, 60 s URL, `Content-Disposition:
     attachment`, `CSP: sandbox`, `nosniff`.
   - Signatures are SVG paths in the DB, not files.
6. **Secrets:**
   - Staff PINs: 4 digits, scrypt, obvious PINs refused. 5 wrong tries locks the user's PIN for
     15 min; 20 per device per hour locks the device and alerts the owner.
   - Family PINs: 6 digits, 5 tries.
   - TOTP secrets: AES-256-GCM with the key in KMS.
   - ABHA and card numbers: field-encrypted, with the last 4 kept for display.
   - Secrets Manager; keys rotated yearly.
7. **Public links:**
   - 128-bit hashed token + PIN; expiry; revoke.
   - Rate limits: 30/hour per IP, 10 PIN tries/hour per token.
   - `noindex`, `no-store`; unlocks and views logged.
   - Read model without clinical access.
   - `/b` is retired into `/f`.
8. **Sessions:**
   - Columns: `device_id`, `ward_device_id`, `channel`, `via_pin`, `last_seen_at` (written at most
     every 5 min), `locked_at`, `user_agent_hash`.
   - A revocation version replaces the 30 s cache risk.
   - Lifetimes as in §5.
   - Deactivation, role change and PIN reset kill sessions. "Sign out everywhere".
9. **DPDP:**
   - The hospital is the Fiduciary; we are the Processor, with a DPA.
   - Purpose and retention are set for patients and staff (§7.8).
   - Family sharing requires a signed family-sharing consent; withdrawing it revokes the link.
   - Breach runbook; DPDP Rules 7 and 8 apply from about 13 May 2027 [S9].
10. **Headers:** `no-store` on clinical pages; `noindex` on public pages; a full CSP with
    `script-src` nonces; `Permissions-Policy: camera=(self)` (§5).

---

## 7. Accountability and observability

### 7.1 Module family, tiers and plan gates

**Principles:**
- Three layers: **prevent, detect, investigate**.
- **Signals, not verdicts:** no automatic discipline. Every flag reads *"This is a lead for review,
  not a finding."*
- Fairness through baselines, and staff can see their own flags.
- Tamper-evident for everyone, including owners and us.

| Module | What it does | Tier | Default |
|---|---|---|---|
| `acct_core` (core) | Evidence log, digests, flags/cases framework, scoped admin roles, "Accountability" page | basic | on (cannot be off) |
| `stock` | Medicine ledger, locations, batches, counts, reconciliation, adjustments with SoD | basic | **on** |
| `acct_risk_classes` | Per-hospital risk-class lists and rules | basic | on (observe) |
| `acct_witness` | Witness at give and waste (§7.2 design) | standard | observe → enforce |
| `acct_presence` | Bed QR / wristband scan | standard | on for personal-device risk-class gives (§5); else off |
| `acct_order_link` | Risk-class Given must link to a signed order | basic | warn → enforce |
| `acct_det_*` | One module per detector (§7.5) | basic: D1, D2, D8, D13, D14, D15, D16; standard: + D4, D6, D9, D11, D12; enterprise: D5, D7, D10; D3 report (standard) | observe |
| `acct_dash_ward`, `acct_dash_dept`, `acct_dash_group` | Scoped dashboards | basic / standard / enterprise | per tier |
| `acct_cases` | Case management | basic | on |
| `acct_reports` | Summaries, exports, NDPS/H1 registers | standard | on |
| `acct_device_view` | Device and channel analytics | standard | on |
| `acct_lab` | Lab detectors and reagent use | enterprise | off |

**Tiers:**
- Small hospitals get one **Accountability** page with the basic detectors.
- Enterprise adds department and group dashboards, all detectors, a separate-account anchor and
  scheduled exports.
- All through the registry and plan gates; no code forks.

### 7.2 Prevention [Rev 4: witness redesign]

| Control | Rule |
|---|---|
| Proof of presence | Bed QR or wristband scan within 5 min before saving configured actions. **Default on for risk-class Given from personal devices** (§5). Offline scans are recorded locally and synced |
| **Dual control (witness)** | Two ways only: **(a) shared ward device:** after the actor saves, the device shows "Witness needed" and the witness taps **Witness** and enters **their own PIN on the shared device**; **(b) approval request:** the actor picks a witness from in-scope staff on duty, and the request appears **in the witness's own signed-in session** (ward device or personal phone). The witness reviews patient, drug, dose and waste amount, and approves with their own session (PIN unlock if locked) within 10 min, optionally scanning the bed QR. **Typing a witness PIN on another user's personal device is impossible**: the witness PIN pad exists only in `channel='ward_device'` sessions. Witness ≠ actor (DB CHECK). The witness must hold a clinical role in scope. For **give**, the dose is saved as "given — awaiting witness" (never delays care), and a missing witness after 15 min raises a flag. For **waste**, nothing is decremented until it is witnessed |
| Order-linked only | Risk-class Given must reference an active signed or countersigned order; free-text risk-class items are blocked (enforce) or flagged (observe) |
| Sanity rules | Discharged → block. Not in this ward → block unless in scope and reasoned. Future → block. Backdate > 2 h → reason; > 48 h → desk only. Offline entries are never dropped: saved and flagged |
| Wastage, breakage, returns | Reason + witness; always a ledger entry |
| Separation of duties | Requester ≠ approver (DB CHECK); counter ≠ issuer in the window; quality and audit roles run read-only sessions (`app.read_only`) |

### 7.3 Stock reconciliation [Rev 4: sources]

- **Expected stock** = opening + received − issued − given − wasted ± approved adjustments, per
  location × item × batch.
- **Locations:** main store, ward sub-stores, lab store, crash carts. Transfers are two-sided.
- **Batches:** stock-in against purchase documents with batch and expiry; FEFO.
- **Counts:** blind counts by a non-issuer, variance calculated automatically, a reason, and an
  approver ≠ counter.

**Registers generated from the ledger.** Every item below needs **legal and state-FDA confirmation
(D-DRUG)**:

| Register | What we found | Source | Status |
|---|---|---|---|
| NDPS ENDs (morphine, fentanyl, methadone, codeine, oxycodone and others notified) | Chapter VA (rules 52A–52M) inserted by **G.S.R. 359(E), 5 May 2015**; drug list by S.O. 1181(E) of the same date | CBN Acts & Rules page [S1]; NDPS Rules 1985 on India Code [S2] | Notification number confirmed on the CBN site; **rule text not yet read in the gazette** |
| Form 3D (ward sub-store daily account), Form 3E (patient-wise), Form 3H (main store) | Described in NHSRC and NCG/Pallium guides; sources differ on Form 3H's rule reference | NHSRC attachment [S3]; NCG guidelines [S4] | **Unverified against the gazette. Needs legal confirmation** |
| NDPS record retention | "At least 2 years from the last entry" | NHSRC/NCG guides [S3][S4] | **Needs legal confirmation** |
| Recognised Medical Institution (RMI) certificate via the State Drug Controller (Form 3F) | Required to stock ENDs | NCG guidelines [S4] | **Needs confirmation for Maharashtra** |
| Schedule H1 register | Rule 65 clause inserted by the Drugs & Cosmetics (Fourth Amendment) Rules, 2013 (**G.S.R. 588(E), 30 Aug 2013**): separate register with prescriber name and address, patient name, drug, quantity; **kept 3 years** | NHSRC attachment reproducing the rule [S3]; Goa FDA alert cites "G.S.R. 558(E)" (likely a typo) [S5] | Wording consistent across sources; **gazette text not read. Needs legal confirmation** |
| Draft CCTV amendment to Rule 65 | Proposed Aug/Sep 2026; **not in force** | Secondary report [S6] | **Unverified** |

### 7.4 Hierarchy and scoped admin roles

| Role | Scope |
|---|---|
| Group/owner | All |
| Branch admin | One branch |
| Department admin / HOD | Department units |
| Ward in-charge | One ward |
| Lab in-charge | Lab units |
| Pharmacy/stock in-charge | Stores |
| Billing/TPA admin | Billing desk |
| **Internal audit / quality officer** | Read-only across their scope |

- Every query is filtered on the server by the viewer's org-unit path, plus branch RLS.
- **Name masking:** staff names on flags are shown only with `acct.view_subjects` in that scope;
  others see "Staff member #a1b2".

### 7.5 Detectors [Rev 4]

All detectors start in **observe** with a 21-day learning period (or 200 events per ward).
Baselines are per ward × role × shift, and **D5 also adjusts for patient mix and acuity**.

| Id | Detector | Default rule | Output |
|---|---|---|---|
| D1 | Over-frequency / over max daily dose | Gives in 24 h > ordered frequency; total > `max_daily_dose` | Flag: high for risk class |
| D2 | Given without an active signed order | Any, once order-link is on | Flag: high for risk class |
| **D3** | No supporting indication | Opioid with no pain score ≥ 4 in the prior 4 h, etc. | **Report-only, never an alert.** It second-guesses clinical decisions; shown in a monthly review report for the quality officer |
| D4 | Off-shift / not assigned / unusual hours | Outside roster ± 30 min; ward outside assignment; 01:00–05:00 risk-class above p95 | Flag: medium |
| **D5** | Peer comparison, **acuity-adjusted** | Expected gives per patient-day are computed from the user's own patient mix: department, acuity band (EWS level, ventilated, post-op day 0–2, oncology/palliative flag, documented pain ≥ 7), and the drug's order frequency. Uses the observed/expected ratio with a Poisson test; flag when O/E > 2.0 and p < 0.01, with ≥ 20 gives in 14 days. ICU and oncology are therefore compared with like patients | Flag: medium → high if repeated |
| D6 | Corrections, late and offline volume | > baseline p95 per user | Flag: low |
| D7 | Activity near a variance | Entries by users with access within ±2 h of an unexplained variance | Evidence bundle, medium |
| D8 | Given-not-billed / billed-not-given | Mismatch > 24 h | Flag: low (money) |
| D9 | Wastage pattern | Per user > p95; > 2 wastes per patient per day | Flag: medium |
| D10 | Lab anomalies | Result without sample or order; ≥ 2 amendments; billed but not resulted > 48 h; reagent mismatch > 15% | Flag: medium |
| D11 | Shared / switched-user patterns | > 6 switches per 10 min; ≥ 5 failed PINs per day; two devices in different wards within 5 min; a fixed actor–witness pair above baseline | Flag: medium |
| D12 | Channel mix | Risk-class from a personal device while a ward device was available; personal share > p95 | Flag: low |
| D13 | Count variance recurrence | Any risk-class variance; ≥ 2 in 7 days on the same location, shift or person | Flag: high |
| D14 | Sanity overrides | Offline entries that broke a rule | Flag: medium |
| **D15** | **Late or missed time-critical doses above ward baseline** | Per ward and shift: late (outside window) + omitted-without-valid-reason rate > ward baseline p90 for 3 shifts in 7 days. Per user: only as context, never named in alerts | **Quality and staffing signal, NOT fraud.** Routed to the **nursing superintendent's quality list**, never into the diversion case flow, and never shown in the staff accountability timeline |
| **D16** | **Batch charting** | ≥ 6 doses for ≥ 3 different patients recorded within 5 min by one user; or `recorded_at − given_at` > 60 min for ≥ 30% of a user's doses in a shift (above ward p95) | Flag: low → medium. Points to retrospective charting; can be both a quality and an integrity signal |

**How detectors run:** in the worker every 15 min, incrementally (event-log cursor), on the read
replica; baselines nightly. Flags dedupe. The precision gate is ≥ 30% at ≤ 5 alerts per ward per
week. The roster comes from `staff_shifts`, with PIN check-in as the fallback.

### 7.6 Evidence log and tamper evidence

**`acct_events`** (append-only, monthly partitions):
- `seq`, `hospital_id`, `branch_id`, `org_unit_id`, `occurred_at`
- `actor_user_id`, `witness_user_id`, `channel`, `device_id`, `session_id`, `ip_hash`
- `action`, `object_type`, `object_id`
- `payload` (ids and numbers only)
- `row_hash`

**Guards:**
- The trigger blocks UPDATE and DELETE; the app DB role has **INSERT and SELECT only**.
- Old partitions are detached only by an admin job that writes its own signed record.

**Digests and anchoring:**
- **Hourly Merkle digests** per hospital (`acct_digests`: period, seq range, count, root,
  prev-digest hash), signed with an Ed25519 key in KMS.
- Anchored to **S3 Object Lock (compliance mode)**: a same-account bucket at S1; a **separate AWS
  account from S2** (§9.2).
- Enterprise: weekly digest email to the owner and quality officer.

**Verification:** `verify-evidence` (in-app for the quality officer, and a CLI) recomputes the roots;
a mismatch raises a **critical alert** to us and the hospital.

**Coverage:**
- Logged: every clinical, stock and due-outcome write and void; logins, PIN failures, switch-user,
  break-glass, witness requests and approvals, escalations, flag and case actions, **and every
  observability read**.
- Owner and support reads are visible to the quality officer. No hidden access; support
  impersonation sees no clinical or accountability data.

**Case attachments** follow the file rules (§6.2.5). The evidence export carries hashes and digest
proofs to support an electronic-records certificate (BSA s.63, [S11]).

### 7.7 Flags, cases and dashboards

**Data model:**
- `acct_flags`: detector + version, severity, scope, subject (nullable), evidence (event seqs,
  numbers, baseline), dedupe key, status `open|in_case|explained|dismissed`, explanation.
- `acct_cases`: scope, status `new|reviewing|explained|escalated|closed`, assignee (≠ subject),
  closed reason.
- `acct_case_events`: append-only notes, status changes, attachments.
- **D15 quality list** (`quality_signals`): separate from flags and cases; seen only by the nursing
  superintendent and the quality officer.

**Views:**
- Live overview per scope: open flags by severity, pending counts, unsigned orders, overdue
  time-critical doses, ward × shift heat map.
- Staff timeline (excludes D15).
- Medicine ledger.
- Device view.
- Cases.
- **On-time administration panel** (§7.10).
- Reports and exports (internal audit, insurers, regulators, NDPS/H1 registers marked "draft
  format" until D-DRUG).

**Performance:** dashboards read `acct_daily_rollups` and `due_rollups_daily`; manual refresh,
auto-refresh at most every 5 min; p95 ≤ 2 s.

### 7.8 Privacy, labour and legal safeguards [Rev 4: sources]

| Claim | Source | Status |
|---|---|---|
| DPDP Act 2023 s.7(i) lists processing "for the purposes of employment or … safeguarding the employer from loss or liability" as a legitimate use | MeitY gazette PDF [S7]; commentary [S8] | **Wording seen only in commentary. Counsel to confirm against the gazette** |
| DPDP Rules notified 13/14 Nov 2025; Rules 7 (breach) and 8 (retention) and Act ss.3–17 apply from about **13 May 2027** | AZB timeline [S9]; KPMG [S10] | Secondary; check the gazette |
| Breach: notify the Board without delay, details within 72 h | KPMG/EY commentary [S10] | Secondary |
| Electronic evidence: **Bharatiya Sakshya Adhiniyam 2023, s.63**, with a certificate in the Schedule (Parts A and B) including a hash value; in force 1 July 2024 | India Code record and PDF [S11]; JSA note [S12] | Act text on India Code; **Schedule details from commentary — counsel to confirm** |
| NDPS / H1 / state FDA | §7.3 | See §7.3 statuses |

- **Monitoring notice:** acknowledged at first login (`policy_acknowledgements`), in en/mr/hi,
  reviewed by counsel.
- Flags are leads for a human inquiry; this wording is on every flag.
- **Retention:** flags and cases 3 years after closure; baselines 1 year; evidence log = clinical
  retention.

### 7.9 Accountability rollout per hospital
Observe (21 days) → alerts (precision gate) → enforce, per risk class and ward. Each step is a
module `stage` change: audited and reversible.

### 7.10 Time-critical medications and timed procedures (new) [Rev 4]

**Medicine master (per hospital):**
- `time_critical` (bool)
- `tc_window_before_min`, `tc_window_after_min` — a two-sided window around the due time
- `due_soon_lead_min`
- `escalate_l1_after_min`, `escalate_l2_after_min` — measured from the end of the window
- **Who sets them:** the hospital's doctor and pharmacist. Each change of list or windows is
  recorded in `time_critical_signoffs` (who, role, when, version).
- **We hard-code no clinical timings.** We ship a **starter list for review**, informed by ISMP's
  guidance on timely administration (to be verified, [S13]):
  - IV antibiotics
  - anticoagulants including LMWH q12h (likely the doctor's "cardiac injection")
  - insulin with meals
  - anti-epileptics
  - Parkinson's medicines
  - immunosuppressants
  - first-dose antibiotics in suspected sepsis
  - vasoactive infusions
  - Proposed defaults: **±30 min** for time-critical and **±60 min** for others. **Not active until
    signed off (D-TIMECRIT).**

**Order timing modes (the doctor picks per order):**
- **(a) Fixed clock times**, e.g. 08:00 / 20:00. **After a late dose:** keep the schedule (default).
  The next dose stays at its clock time; if the gap would be under 50% of the interval, the board
  shows "next dose close — check with doctor".
- **(b) Interval from the last given dose**, e.g. every 12 h. **After a late dose:** shift the
  schedule (default). The next due time = actual given time + interval.
- The doctor can override the late-dose policy per order: keep or shift.

**Statuses of each due instance** (computed by `lib/domain/due.ts`):

| Status | Meaning |
|---|---|
| due soon | Within the lead time before the window |
| due now | Inside the window |
| overdue | Past the window end |
| given on time | Given inside the window |
| given late | Given after the window; reason needed |
| given early | **Warned** before saving; reason needed |
| omitted | Reason code: **refused, NPO, at procedure/away, not available/stock-out, held by doctor, other (text)** |

- Stock-out omissions feed the stock reorder list. "Held by doctor" needs a linked doctor or a
  countersign.

**Alerts are in-app only.** No WhatsApp cost, and **no PHI in any notification**:
- **Ward due board:** sorted by time; colour **and** text ("OVERDUE 25 min").
- **Badge on bed tiles:** "1 due", "1 overdue".
- **Optional chime on ward tablets** (Web Audio; setting; quiet hours).
- **Banner on personal devices**, only for staff on duty in that ward. Text is generic: "2
  time-critical doses overdue in Ward A". Patient and drug are shown only after opening the
  authenticated page.

**Escalation** (levels and delays are settings; defaults for the doctor to confirm, D-ESCAL):
- **L1** at window end + 15 min → the ward in-charge's list (and the bed badge turns red).
- **L2** at window end + 45 min → the **doctor on call** for that department and branch. This needs
  an `on_call` roster grid; if there is none, the ordering doctor.
- Each escalation is a row in `due_escalations` (instance key `order_id + due_at`, level, raised_at,
  acknowledged_by/at), so it is idempotent and auditable.

**Alert-fatigue controls:**
- Only `time_critical` items alert; everything else shows on the board only.
- No blocking popups.
- **Snooze needs a reason**, and is limited to 30 min and 2 per dose.
- A per-ward alert-volume metric and an in-app **nurse rating of alert volume** ("Too many / About
  right / Too few", once per shift).

**Offline:**
- The device caches the ward's active orders and last events (ids, short labels) at each sync.
- The same `due.ts` computes due times locally.
- The board header always shows **"Last synced 10:42"**; it turns amber after 5 min and red after
  15 min, with text.
- **Printed paper round list** (the MAR time grid) as backup, printable for any ward and shift.

**Timed tasks (same engine):** task orders for vitals frequency, dressings, repositioning
(q2h), BSL checks (QID / pre-meal), transfusion checks (start, 15 min, 1 h, end), and post-op
observations (q15 min × 4, q30 min × 2, hourly). They are completed by the matching chart entry or
a task tick.

**Handover (L)** lists overdue and upcoming (next 4 h) time-critical doses and tasks.

**Dashboard (quality metric):**
- **on-time administration rate** per ward, drug and shift
- median delay
- omitted-dose rate by reason
- from daily rollups; never polled faster than every 5 min

**Stages:** **observe** (board and statuses visible, **no chime, banner or escalation**; we count the
alerts that would have fired) → **warn** (alerts and L1) → **enforce** (L2 escalation; reasons
mandatory for late, early and omitted). Pilot ward first, with nurse feedback on alert volume
before widening (§12).

**Data model (migration 0047, B3b, §11.1):**
- `medicines` gains `time_critical` + window columns
- `treatment_orders` gains `timing_mode ('clock'|'interval')`, `clock_times smallint[]` (minutes of
  day), `interval_min`, `late_policy ('keep'|'shift')`, `task_kind` (for timed tasks)
- `mar_administrations` gains `due_at`, `timing_status`, `delay_min`, `reason_code`,
  `reason_text`
- new `due_escalations`, `time_critical_signoffs`, `on_call_assignments`, `due_rollups_daily`
- **No table of future due instances.** Instances are computed; only outcomes and escalations are
  stored. This keeps writes low (owner preference: no per-day copies; settings apply live).

---

## 8. Clinical scope [Rev 4: MAR row and timed tasks]

| Item | Decision | Why |
|---|---|---|
| **MAR**: due times; administered / held / refused / not available / omitted; **due-time engine with two-sided windows, time-critical alerts, escalation and reason codes (§7.10)** | **Core** | NABH MOM; base of diversion control and time-critical safety |
| **Timed tasks** (vitals frequency, dressings, repositioning, BSL checks, transfusion checks, post-op observations) on the shared due engine | **Core** (module `timed_tasks`, on by default) | Same engine; nurses need one list |
| Orders (CPOE) with allergy, dose range, max daily dose | Core | Safety; D1 |
| Drug–drug interactions | Later | Licensed data |
| Medication reconciliation | Core | NABH |
| TPR flowsheet, I/O per shift and 24 h | Core | Pilot; EWS |
| Pain, fall (Morse), Braden scores | Core (templates) | NABH indicators; D3 report |
| Initial nursing and doctor assessment | Core | NABH AAC |
| Diet orders | Core | Paper card |
| Kitchen list | Later | Out of scope |
| Nursing care plans | Optional (simple templates) | Big hospitals |
| ICU, NICU, labour (WHO Labour Care Guide), paeds packs | Optional | Specialty |
| Wound care with photos | Optional after files | Uploads |
| Blood transfusion record | Core | Pilot paper; transfusion checks are timed tasks |
| EWS | Optional, off until confirmed | Governance |
| Restraint, critical-result alerts | Later | Lower frequency |

---

## 9. Data residency, cost model and production-safe migrations [Rev 4]

### 9.1 Recommendation: AWS Mumbai, and do it early

- **Today:** Neon Singapore + Vercel `sin1`. Neon's region list has no India region [S14].
- **Recommendation:** move to **AWS ap-south-1 (Mumbai) now, in the pilot slice (§11)**, while data
  volume is small and the cutover is quick.
- **Target:** RDS for PostgreSQL 17, app and worker on ECS Fargate (Docker path exists), S3, KMS,
  Secrets Manager; DR copies to **ap-south-2 (Hyderabad)** so data stays in India.
- **Migration path (no planned downtime):**
  1. Build the Mumbai stack.
  2. **Logical replication** Neon → RDS; hourly checksum and row-count comparisons for a week.
  3. Move read-only traffic first.
  4. **Cutover at 2–4 am IST:**
     - 60–120 s write pause; IPD phones queue in the outbox, OPD shows "saving…".
     - Wait for lag 0, **set sequences**, switch `DATABASE_URL`, flush.
  5. Reverse-replication standby on Neon for 7 days, then decommission with a deletion certificate.
- **Legal review:** DPAs, NHA/PM-JAY data rules, customer notice.

### 9.2 Staged infrastructure and cost model (new)

The prices below are **estimates** from third-party summaries of AWS's public price list (RDS
db.m7g.large in Mumbai ≈ US$0.240/h; gp3 in Mumbai ≈ US$0.131/GB-month [S15]). Fargate, ALB, WAF
and S3 prices are approximate. **All must be confirmed in the AWS Pricing Calculator for ap-south-1
before budgeting (D-COST).** ₹88/US$ assumed.

| Stage | Trigger to enter | Components | Est. US$/month | SLO it can support |
|---|---|---|---|---|
| **S0 Pilot** [Rev 5] | **Now: the pilot slice.** Replaces Neon Singapore | App + worker on the **existing India VPS** (Docker, `deploy.sh`; confirm its region, D-VPS). **DB:** Option 1 = **smallest managed DB** (RDS db.t4g.small, single-AZ, Mumbai, 7-day PITR), or Option 2 = Postgres on the VPS with WAL archiving (RPO ≤ 5 min). **Encrypted backups to S3 Mumbai** (SSE-KMS) + cross-region copy to Hyderabad; Object Lock bucket for evidence digests (same account); monthly restore drill; free-tier uptime and status page | **35–45** (Option 1) or **5–10** (Option 2), extra to the VPS (§2.3a) | **99.0%** (single VPS); offline-first keeps bedside entry working through outages (§10) |
| **S1 Starter** | **Any S0 → S1 trigger:** > 5 hospitals **or** > 300 IPD beds on the platform; DB CPU > 50% at peak for a week; storage > 50 GB; VPS memory > 75% sustained; the first contract asking for ≥ 99.5%; or a restore drill that misses RTO ≤ 2 h | **Single-AZ** RDS db.t4g.large (100 GB gp3, 14-day PITR); **one app node** (Fargate 1 vCPU/2 GB) + a small worker task; ALB; **automated backups + daily cross-region snapshot copy to Hyderabad**; S3 (files) + an **Object Lock bucket in the same account** for digests; CloudWatch basic; external uptime check | **230–330** | **99.5%** |
| **S2 Standard** | **Any of:** > 30 hospitals; > 2,000 beds; any single hospital > 200 beds; **first contract with an SLA ≥ 99.9%** | **Multi-AZ** RDS db.m7g.large; **read replica** (detectors, reports); 2+ app nodes; **WAF**; **separate-account Object Lock anchor**; paging service; status page | **1,000–1,300** | **99.9%** |
| **S3 Scale** | > 200 hospitals; > 15,000 beds; DB CPU > 60% at peak for 2 weeks; storage > 1 TB | db.r7g.xlarge–2xlarge Multi-AZ; 2 replicas; 4–8 app nodes; second **cell** ready; dedicated cell option for enterprise groups | **3,500–6,000** | **99.9%** (99.95% for a dedicated enterprise cell) |

Per-hospital and per-bed figures are in §2.3. **A move between stages needs no downtime:**
Multi-AZ conversion and adding a replica are online RDS operations; verify the brief failover blip.

### 9.3 Migration runner v2 [Rev 4]

- **One transaction per migration.** `-- qurio:no-transaction` for `CREATE INDEX CONCURRENTLY` and
  `ALTER TYPE … ADD VALUE`. `lock_timeout = 3s` and `statement_timeout`, retry with backoff.
  Compatible with `drizzle.__drizzle_migrations` and the `when` rule.
- **Idempotent SQL is required**, because a migration can fail half-way across files and be re-run:
  - `CREATE TABLE/INDEX … IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `CREATE OR REPLACE FUNCTION`
  - `DROP … IF EXISTS` before re-creating triggers and policies, inside the same transaction
  - `DO $$ … IF NOT EXISTS (SELECT FROM pg_constraint …)` for constraints and policies
  - A **lint script** rejects new files with non-idempotent statements, and CI re-runs every new
    migration twice on the scratch DB.
- **First use requires a dry run against a production-sized snapshot:** an anonymised restore or
  the 2-year synthetic set, under k6 load. Record duration, lock waits and replication lag; owner
  approval follows.

### 9.4 Expand/contract rules

1. **Expand only** in a release: nullable columns, new tables, indexes `CONCURRENTLY`. Never rename
   or drop in the same release.
2. **Backfill** in batches of 5,000 rows with sleep, from resumable jobs (`scripts/backfill/*`),
   never inside a migration.
3. **Constraints:** `ADD CONSTRAINT … NOT VALID`, then `VALIDATE` in a later migration.
   `SET NOT NULL` only after a validated CHECK.
4. **Contract** at least one release after nothing reads the old shape (code search + `pg_stat`
   window).
5. **Code is compatible with N−1 and N+1 schemas.** Order: migrate (expand) → deploy → backfill →
   contract later.
6. **Rehearsal:** every migration runs on production-sized data under load; lock waits and duration
   go in the PR.
7. **Rollback:** a written `down` note per migration; expand steps stay; code rollback = previous
   image; destructive steps only in contract releases after a fresh backup.
8. **Big tables:** monthly partitions from the start for `acct_events`, `audit_logs`,
   `record_access_logs`, `chart_entries`, `mar_administrations` (no inbound FKs). `care_entries` and
   `bill_items` stay unpartitioned with tenant/time indexes; revisit at 500 M rows.

### 9.5 Cells
- A cell is one app + DB stack. The control-plane table `tenant_cells` maps hospitals to cells.
- Routing is built in A4-full. A second cell is created at the S3 trigger. Enterprise groups can
  get a dedicated cell.

---

## 10. Reliability and operations [Rev 4]

| Area | Plan |
|---|---|
| **SLO by stage** | **S0 [Rev 5]: 99.0%** (one VPS, ≈ 7 h/month error budget); RPO ≤ 5 min (PITR or WAL archive), RTO ≤ 4 h (restore to a new VPS/instance from S3). **S1: 99.5%** for clinical writes (single-AZ RDS cannot honestly promise 99.9%; AWS's RDS SLA is lower for Single-AZ than Multi-AZ [S16]). **S2: 99.9%**. **S3: 99.9%**, or 99.95% for a dedicated enterprise cell. Contracts never promise more than the current stage supports |
| Offline-first clinical continuity | During an outage, **TPR entry, Given/omit recording and the due board keep working on the device** from the last sync, showing "Last synced …". Entries queue and sync later. The printed round list is the final fallback. This is why S1's 99.5% is acceptable for the pilot |
| Error budget | When the budget is burnt, rollouts freeze until it recovers |
| Backups / PITR | S1: 14-day PITR + daily Hyderabad snapshot copy. S2+: 35-day PITR + monthly encrypted logical dump |
| Tested restores | Monthly automated restore to staging with checks (counts, latest timestamps, evidence digests), logged |
| DR | S1: AZ or instance failure → restore or PITR, RPO ≤ 5 min, **RTO ≤ 2 h**. S2+: AZ failure RPO 0, RTO ≤ 5 min. Region loss: RPO ≤ 24 h at S1 (daily snapshot) and ≤ 15 min from S2 (cross-region automated backups), RTO ≤ 4 h. Drills twice a year |
| Monitoring | Structured logs (allow-listed fields, no PHI); metrics including **escalation sweep duration, due-board compute time, detector run time**, outbox depth, replication lag |
| Alerting | SLO burn rate, DB health, backup failure, digest mismatch (critical), **escalation sweep stalled > 3 min (critical, because time-critical alerts depend on it)** |
| On-call | Managed paging + contract night cover; published P1 ≤ 30 min (D-ONCALL) |
| Health | `/api/health`, `/api/ready` |
| Status page | Hosted; in-app incident banner; postmortems within 5 working days |
| Change management | Staging → canary → all; automatic rollback on error increase |
| Runbooks | Restore, failover, breach, digest mismatch, PIN lock storm, outbox backlog, **escalation sweep failure (switch wards to the printed round list)**, Neon → RDS cutover |

---

## 11. Phases, pilot slice, weeks and critical path [Rev 4]

**Estimates.** Weeks are engineering weeks for **one** engineer, including tests and docs. A
contractor can take the infra work (A3, part of A2).

### 11.1 Pilot slice (APPROVED scope, subject to Rev 5) [Rev 5]

TPR first, then counts, then drug accountability. Week 1 is assumed to start **Mon 19 Oct 2026**.

| # | Phase | Content | Migration | Weeks | Planned window |
|---|---|---|---|---|---|
| 1 | A1 | Migration runner v2, idempotency lint, synthetic data + k6 basics | — | 2 | wk 1–2 (19 Oct – 30 Oct) |
| 2 | **A3 → S0 India move** (parallel) | S0 stack (§9.2): managed DB or VPS DB in India, encrypted S3 Mumbai backups, logical replication from Neon, cutover, first restore drill; minimal A2 (health, uptime alert, status page) | — | **2** (lighter than the S1 stack) | wk 3–6, interleaved; **cutover by wk 6 (27 Nov)** |
| 3 | A4-min | Registry + `hospital_features` (ward rollout, stages), letterhead, IPD No., patient-file shell, log columns, `policy_acknowledgements` | 0041 | 2 | wk 3–4 |
| 4 | A5-min | Ward devices, PIN, switch user, Mode B 15/5-min lock, channel and device on rows, monitoring-notice acknowledgement at first login, `camera=(self)` | 0042 | 2.5 | wk 5–7 |
| 5 | **B1** | **Charts engine (General TPR template) + TPR + I/O per shift + paper print** | 0043 | 3 | wk 8–10; **TPR shadow on the pilot ward ≈ wk 11 (28 Dec)** |
| 6 | A6-min | Evidence log + hourly digests (S0: Object Lock bucket, same account) | 0044 | 1.5 | wk 11–12 |
| 6a | **A6 History** [Rev 5.1] | Record History view: per record, who made or changed it, how and when, from the evidence log; links from readings, bedside entries, admissions and the Accountability list; owner only | 0045 | 0.3 | wk 12 |
| 7 | **B4a Count-first stock** (moved earlier) | Risk-class drugs only: main store + ward sub-stores, receipts against invoices (batch, expiry), issues/transfers, **daily blind counts by a non-issuer**, variance with reason and approver, simple Accountability page (observe). Until MAR exists, "expected" uses issues minus a **"used since last count" figure entered at count time** (from the paper drug register), marked "manual" | 0046 | 1.5 | wk 12–13; **counts live ≈ wk 14 (18 Jan 2027)** |
| 7a | **C4a Test orders and follow-up** [Rev 5.1] | Doctor orders tests (OPD consultation and IPD); service points (lab/room, floor, section, en/mr/hi) with assigned staff; worklist with waiting clock and Call button; call outcomes and patient feedback; not-arrived task after the hospital's set time (from order or from payment, per service point), raised to the admin after 15 more minutes; arrived / done / report added; admin **Today** screen per lab and per person, day-end pending list; all steps in the evidence log. Calls only, no WhatsApp | 0047 | 3 | wk 14–16 |
| 8 | B3-min | Orders + MAR for **risk-class and time-critical drugs**; countersign; witness (ward device + approval request); bed-scan rule | 0048 | 3 | wk 17–19 |
| 9 | **B3b** | Due engine + due board + time-critical windows, alerts, escalation, offline board, round-list print | 0049 | 2.5 | wk 20–22 |
| 10 | **B4b MAR linking** | Gives and wastes from MAR post to the ledger automatically (idempotent); the manual "used" figure retired; full reconciliation; D13 in observe | (0046 expand) | 1.5 | wk 22–23 |
| — | **Go/no-go review** (§11.4) | | — | — | **wk 25–26 (≈ 5–16 Apr 2027)** [Rev 5.1], after ≥ 4 weeks of B1 primary, ≥ 2 weeks of B3b warn and ≥ 3 weeks of C4a in use |

**Moving the counts earlier:** splitting B4 into B4a and B4b costs **≈ 0.5 week** (the manual
"used" field and its retirement), under the 2-week limit. Risk-class counts and variance start
about 7 weeks earlier than in Rev 4.

**Critical path (solo, S0 interleaved):**
```
A1 (2) → A4-min (2) → A5-min (2.5) → B1 (3)  ⇒ TPR shadow ≈ wk 11
   └─ S0 India move (2, interleaved wk 3–6) must finish before B1 goes live
→ A6-min (1.5) + History (0.3) → B4a (1.5)   ⇒ risk-class counts live ≈ wk 14
→ C4a (3)                                     ⇒ test follow-up live ≈ wk 17
→ B3-min (3) → B3b (2.5) → B4b (1.5)          ⇒ slice complete ≈ wk 23 (≈ 26 Mar 2027) [Rev 5.1]
```

Calendar risk: Diwali (early Nov) and year-end leave at the hospital may push the TPR shadow
start to the first week of January. The go/no-go date moves with it.

Migration numbers changed from Rev 4 (nothing has been written yet): 0045 is now B4a stock and
0046/0047 are MAR and the due engine; the roadmap numbers in §11.2 shift by +0 (they start at
0048). 0040 stays reserved.

### 11.2 After the pilot slice: ROADMAP, not a commitment [Rev 5]

Each item below needs its own approval after the go/no-go review. Order, scope and estimates may
change with what the pilot teaches.

| Phase | Content | Migration | Weeks |
|---|---|---|---|
| A4-full | Roles/scopes, branch RLS + benchmark (§4.3), break-glass, access reviews, `authz_v2` shadow (§4.4) | 0048 | 5 |
| A7 | File storage + scanner | 0049 | 2 |
| B2 | Allergy, medication reconciliation, deposit alerts | 0050 | 2.5 |
| B3-full | MAR for all drugs, timed tasks, dose guard everywhere | (0045/0046 expand) | 3 |
| B4-full | Stock for all tracked items, NDPS/H1 register reports | (0047 expand) | 2 |
| B5 | Discharge summary | 0051 | 3 |
| B6 | Detectors v1 (basic tier incl. D15, D16) + rollups + cases | 0052 | 4 |
| C1 | Billing sheet + category bill | 0053 | 3 |
| C2 | Consents | 0054 | 3 |
| C3 | Doctor notes + initial assessments | 0055 | 3 |
| C4b [Rev 5.1] | Typed lab and radiology results, report files, lab detectors (C4a is in the pilot slice) | — | 3 |
| **C5** | **Family page `/f` + final-bill WhatsApp message (§16)** | 0057 | 3 |
| C6 | Readiness, leakage, handover, EWS | 0058 | 4 |
| C7 | Detectors standard/enterprise, department and group dashboards, device view | 0059 | 4 |
| D1 | Admission form, whole-file print, claims, ABHA, MRD retrieval, export | 0060 | 4 |
| D2 | Specialty packs | 0061 | 4 |
| D3 | Order sets | 0062 | 1.5 |
| D4 | Procedure notes | 0063 | 1.5 |
| D5 | Care plan templates, wound care | 0064 | 3 |
| D6 | ABDM HIP + FHIR export | 0065 | 6 |

**Totals:** pilot slice ≈ 20–23 weeks. Everything after ≈ 70 weeks. **Full plan ≈ 21–22 months for
one engineer.** This is why §1 has a priority order. Rev 3's migration numbers are replaced; 0040
stays reserved.

### 11.4 Go/no-go review after the pilot slice [Rev 5]

- **When:** wk 25–26 (≈ 5–16 Apr 2027) [Rev 5.1], after ≥ 4 weeks of TPR as primary record on the pilot
  ward and ≥ 2 weeks of the due board in `warn`.
- **Who:** founder (decides); Dr Vinod Pawara (clinical); nursing in-charge of the pilot ward;
  hospital administrator; the contract SRE, if engaged.
- **Input:** the rollout dashboard (§12) exported for the review period, the infra cost report, the
  incident log, and staff feedback.

| Area | Metric (from §12 unless noted) | Go threshold | Source |
|---|---|---|---|
| Adoption | Paper-only fallback rate on the pilot ward | < 5% | Daily comparison sheet + app |
| Speed | Median time per TPR reading vs paper baseline | ≤ paper (target ≤ 20 s) | Client timers |
| Speed | Median time per Given (risk-class, with witness) | ≤ 20 s | Client timers |
| Quality | Voids + corrections per 100 entries | < 3 | DB |
| Reliability | Sync failures; entries lost | < 0.1%; **0 lost** | Outbox metrics |
| Reliability | P1 incidents caused by releases; S0 uptime | 0; ≥ 99.0% | Incident log, uptime monitor |
| Time-critical | On-time rate for time-critical doses vs the shadow-period paper baseline | Better than baseline, never worse | `due_rollups_daily` |
| Time-critical | Nurse rating "About right"; would-be alerts per nurse per shift | ≥ 70%; ≤ 10 | In-app rating |
| Accountability | Daily risk-class counts done on time; unexplained variances investigated within 48 h | ≥ 95%; 100% | Stock counts |
| Accountability | Evidence verification runs | 100% pass | `verify-evidence` |
| Staff | Feedback score | ≥ 4.0 / 5 | In-app |
| Cost | S0 infra vs budget (§2.3a) | Within the estimate +20% | Bills |
| Legal | §17.1 items due by the review | All closed or with a dated plan | Checklist |

**Outcomes:**
- **Go:** widen to the rest of the pilot hospital and pick the next roadmap items (§11.2) for
  approval.
- **Fix and re-review:** 2–4 weeks of fixes on named metrics, then review again.
- **No-go:** modules set to `read_only` on the ward, paper resumes, and data is kept. Write a short
  post-mortem before any further build.

### 11.3 Definition of done (every phase)
1. Reviewed; typecheck, lint, unit, and integration tests (scratch + production-sized) pass.
2. The phase's security pack (§15.2) and the registry coverage test pass.
3. Playwright E2E for the phase's critical flows pass on staging; axe-core finds no serious or
   critical issues; manual checks at 375, 768 and 1280 px.
4. §2.2 budgets met in k6; query plans saved.
5. Migration idempotent, rehearsed under load, rollback note written, expand-only.
6. Print output checked against the paper; Marathi and Hindi render.
7. Docs: progress, ADR, runbook, role cheat sheet.
8. Module defaults to off or `observe` outside its rollout scope.
9. Dashboards and alerts exist for new paths.
10. **[Rev 4]** Due-time tests (§15.5) where relevant; escalation sweep within budget.

---

## 12. Rollout strategy [Rev 4]

**Stages per module** (via `rollout_scope` and `stage`):
1. Internal: staging demo hospital.
2. **Shadow**, one pilot ward, 1–2 weeks: paper is the legal record; staff also enter digitally;
   daily comparison.
3. **Primary**, one ward: digital is the record; paper sheets printed from the app each morning as
   backup.
4. Whole pilot hospital.
5. Cohort of 3–5 hospitals (one large, one multi-branch).
6. GA: default on for new hospitals.

**Parallel paper:** any sheet prints in paper layout, blank or filled. The per-ward "primary" date
(when digital becomes the legal record) is stored and printed (D-RECORD).

**Rollback per phase:**
- Module → `read_only` or `off` for that ward; data kept; printed sheets resume.
- Code → previous image (expand-only schema).
- Rehearsed once per phase on staging.

**Success metrics to advance a stage:**

| Metric | Target |
|---|---|
| Paper fallback rate | < 5% primary, < 1% GA |
| Time per TPR reading | ≤ paper baseline; target ≤ 20 s |
| Time per Given | ≤ 10 s (≤ 20 s with witness) |
| Voids + corrections | < 3 per 100 entries |
| Sync failures | < 0.1%, 0 lost |
| Staff feedback | ≥ 4.0 / 5 |
| P1 incidents from the release | 0 |

**Added in Rev 4:**

- **Time-critical alerts on the pilot ward:**
  - **Week 1 observe:** the board is visible, no chime, banner or escalation; we log the alerts that
    *would* have fired.
  - **Week 2 onward warn:** chime, banner and L1 on.
  - **Nurse rating** of alert volume once per shift.
  - Move to `enforce` (L2 and mandatory reasons) only when "About right" ≥ 70%, would-be alerts are
    ≤ 10 per nurse per shift, and the on-time rate has not dropped.
  - Then the next ward.
- **Extra metrics:** time-critical on-time rate (target: improve on the paper baseline measured in
  shadow), omitted-dose rate, alerts per nurse per shift, snoozes per shift.

---

## 13. Adoption: paper to digital [Rev 4]

- **Same layout:** each sheet keeps the paper's column order, terms (C/O, O/E, Adv, TPR, I/O) and
  grouping. Labels have en/mr/hi variants; each user picks their staff label language (English
  default).
- **Fewest taps:**
  - defaults: time = now; last-value hints; carry forward the oxygen flag
  - targets ≥ 48 px, numeric keypad, one primary button
  - 2-minute undo
  - "Same as yesterday" where safe
- **First week:**
  - dismissable guided hints per sheet (no dependency)
  - a demo patient in training mode
  - a one-page cheat sheet per role in en/mr/hi
- **Measured ease:** client timers "sheet opened → saved" per entry type (no PHI, aggregated per
  ward and role), compared with the paper baseline from the shadow period.
- **In-app feedback:** a button on every sheet (1–5 + short text). Context (sheet, build, device
  class) is attached automatically; never patient data.

**Added in Rev 4:**

**The due board looks like the paper medication round (MAR time grid):**
- **Rows:** bed → patient → each drug line, in the treatment card's order.
- **Columns:** the time slots the ward uses (e.g. 6, 8, 10, 12 … 22, 24, 2, 4), like the paper
  chart.
- Each cell shows the dose state with a mark nurses already use: **✓ given, ✗ omitted (with code
  letter), H held, R refused**. Late doses add the time.
- The current time column is highlighted; time-critical lines have a clock icon + "TC" text.
- **Phone view:** one column at a time ("Now: 08:00 round") with big rows; swipe to the next round.
- The printed round list is the same grid, so a paper fallback looks identical.

---

## 14. Compliance, interoperability, onboarding, support [Rev 4: sources]

**NABH 6th edition (Jan 2025):**
- 10 chapters: AAC, COP, MOM, PRE, HIC, PSQ, ROM, FMS, HRM, IMS. Map features to their objective
  elements **from the official standard PDF** before claiming support [S17]. The chapter list here
  comes from NABH course material; the PDF has not been read yet.
- NABH's MOM training description covers the whole medication cycle, high-risk/LASA drugs and
  narcotics safeguards [S18].
- The on-time administration and omitted-dose metrics feed the indicator reports.

**ABDM:**
- NRCeS FHIR R4 IG profiles, e.g. DischargeSummaryRecord [S19]. Confirm the active IG version on
  nrces.in at build time.
- The **NMC Office Memorandum of 17 July 2026** reminds **medical colleges** that HMIS and ABDM
  integration is mandatory [S20]. For other private hospitals it is voluntary, with ABHA uptake
  driven by PM-JAY [S21].
- NHCX is developed under ABDM. One 2026 analysis finds no mandate for hospitals [S22] (third-party;
  check the IRDAI circular).

**Schemes:**
- MJPJAY adjudication guidelines [S23] and a PM-JAY hospital process flow [S24].
- CAG audit rejection reasons used for the date checks [S25].

**Records retention:** the MCI-era 3-year rule and the NMC 2022 draft [S26]; CAHO guidance [S27].
No single settled period, so D-RET.

**NEWS2:** RCP chart [S28]. **WHO Labour Care Guide:** WHO [S29] (to verify the link at build).

**Export and MRD retrieval:**
- **Full hospital export** on request: CSV + FHIR NDJSON, encrypted, logged, 60 s link.
- **MRD retrieval flow:**
  1. Request logged: requester, purpose (patient, court, insurer, police), ID proof.
  2. MRO approval.
  3. Certified copy: "Certified copy" footer, page numbers, hash.
  4. Delivery log and fee.
  - The patient's own request is answered within the NMC timeline (to be confirmed with D-RET).
- Retention jobs follow D-RET, with legal hold for MLC and court cases.

**Onboarding importers** (CSV, preview, per-row errors):
- patients (keep the old MRN or IPD No.), doctors, staff with roles and scopes
- departments, wards, beds
- charge items and prices
- medicines (risk class, max daily dose, **time-critical flag and windows**)
- stock opening balances by batch
- open admissions at go-live

**Training mode:** a per-hospital training tenant cloned from the hospital's masters, with demo
patients. Marked `is_training`, so it is excluded from billing, usage, WhatsApp, accountability and
escalation. Reset nightly.

**Quick-start guides:** one page per role (nurse, ward in-charge, doctor, RMO, desk, lab,
pharmacist, owner) in en/mr/hi.

**Support toolkit:**
- Impersonation stays read-only, with a reason, no clinical or accountability data, time-limited,
  audited, and visible in the hospital's access log.
- Owner-approved, time-boxed support clinical access per incident.
- "Report a problem" in-app: page, build, browser, request ids. No PHI unless the user ticks
  "attach this patient's id".

---

## 15. Verification and test packs [Rev 4]

### 15.1 Every phase
- Typecheck, lint, unit, integration (scratch + production-sized).
- Playwright E2E on staging; axe-core (dev dependencies, D-DEVDEPS); k6 budgets; print checks.
- Browser preview at 375, 768 and 1280 px with screenshots.
- **Never `npm run db:migrate` without owner approval.**

### 15.2 Security pack

| Area | Tests |
|---|---|
| Auth bypass | Every module route and action without a session → 401/redirect; read-only (support) session → 403 on writes, no clinical rows |
| Role / scope | Matrix role × permission × scope; a ward-scoped nurse cannot read another ward; a branch-A admin sees nothing of branch B (RLS returns 0) |
| Module | Off → 404; read_only → 403 on writes; PIN session → 403 outside IPD |
| IDOR / tenant | Foreign hospital's ids (admission, order, consent, file, link, witness request) → 404, nothing written; RLS test per table |
| Clinical key | New clinical tables return 0 rows without `clinical: true` |
| Immutability | UPDATE of value columns refused by the guards; void once |
| Break-glass | Only with a reason; 60-min expiry; review item; banner |
| Access modes | Mode A/B parity (same rows except `channel`); a disabled mode refuses login for that role; **Mode B lock: a locked session gets 401 on PHI routes until PIN; background > 5 min forces PIN** |
| MFA | Owner without TOTP cannot reach admin pages |
| Revocation | A deactivated user's next request fails within 1 s across instances |
| Token / PIN | 1,000 random family/bill tokens → 404 + throttle; PIN lock-outs (staff 5, device 20/h, family 5) audited |
| Rate limits | TPR/Given 120/min per user; family 30/h per IP; callback 1/15 min |
| PHI leakage | Snapshots of `logError`, WhatsApp bodies, app URLs, file keys, notifications and family payloads contain no name, phone or clinical value |
| Headers | `no-store` on clinical routes and `/f`; `noindex` on `/f`, `/q`, `/book`; `camera=(self)` only |
| Support | An impersonated session sees no clinical or accountability rows |
| Files | Wrong type or oversize refused; download without permission 403; URL expires in 60 s |

### 15.3 Accountability scenario pack

| Scenario | Expected |
|---|---|
| Fake Given, no order, risk-class | Enforce: blocked. Observe: saved + D2 flag + evidence |
| Same dose repeated within the interval | D1 flag; online warn with reason; offline saved and flagged |
| **Witness bypass** | Witness PIN on the actor's personal phone → impossible (no witness PIN pad in personal sessions; API refuses witness PIN fields from `channel='personal'`). Witness approves from their own session → allowed only if in scope and on duty. Same person → DB CHECK refuses |
| Risk-class Given from a personal phone without a bed scan | Refused (default on); allowed on the ward device |
| Stock edited after the count | Impossible (append-only ledger); adjustment needs approver ≠ requester; D13 flags |
| Deleted lab result | No delete path; amendments versioned; D10 flags ≥ 2 amendments |
| PIN shared between two nurses | D11 flags with an evidence bundle |
| Off-shift entry | D4 flag |
| Batch charting (8 doses, 4 patients, 3 min) | D16 flag |
| Ward with repeated late time-critical doses | D15 entry on the nursing superintendent's quality list; **no** case and no staff-timeline entry |
| Highest observability role tries to edit or delete clinical, stock or log rows (UI, API, crafted request) | 403; read-only session blocks at the DB; digest verification would catch a DB-level change |
| Department admin requests another department's flags, timeline or ledger | 404; attempt logged |
| Direct DB tamper of `acct_events` (admin harness) | Next verification fails → critical alert |

### 15.4 False-positive measurement
- Replay 90 days of synthetic ward activity with injected diversion patterns.
- Report precision and recall per detector and threshold. D5 is evaluated on mixed ICU, oncology
  and general wards to prove the acuity adjustment.
- Go-live thresholds are set per ward baseline; the report is attached to the B6 and C7 PRs.

### 15.5 Due-time tests (new)

| Test | Expected |
|---|---|
| Fixed clock 08:00/20:00, dose at 08:10 (window ±30) | given on time; next 20:00 |
| Fixed clock, dose at 09:05 | given late (reason required); **keep** → next 20:00; if the gap is < 50% of the interval, "next dose close" warning |
| Interval q12h, dose at 09:05 for a due of 08:00 | given late; **shift** → next 21:05 |
| Interval with a per-order override to keep | next stays 20:00 |
| Early dose at 07:15 (window −30) | warned before save; reason required |
| Omitted with each reason code | status omitted; stock-out feeds the reorder list; held-by-doctor needs a doctor link |
| Window edges | 07:30:00 = on time; 08:30:00 = on time; 08:30:01 = late (inclusive/exclusive rules unit-tested) |
| Escalation timing | L1 at window end + 15 min, L2 at + 45 min; one row per level (idempotent across sweeps); acknowledging stops further levels |
| Stage behaviour | observe: no chime, banner or escalation, but "would-fire" counted; warn: L1 only; enforce: L1 + L2 + mandatory reasons |
| Offline due times | Device clock + cached orders give the same statuses as the server for the same inputs (property test across 10k random schedules); "last synced" turns amber at 5 min and red at 15 min |
| Daylight / timezone | Hospital timezone used; midnight-crossing intervals correct |
| No PHI in notifications | Banner and chime payloads hold only ward name and counts (snapshot test); no OS push payloads |
| Load | Due board and escalation sweep within the §2.2 budgets |

### 15.6 Final-bill message tests (new)

| Test | Expected |
|---|---|
| Sent exactly once | Finalising twice or re-running the worker gives one `admission_messages` row (unique `(admission_id, kind)`) and one outbox row |
| Reopened then re-finalised bill | No second message unless staff explicitly tap "Send again" (audited, counted) |
| No PHI in the body | Template snapshot: hospital name + link only; no patient name, amount, diagnosis or bed |
| Opt-in / consent | Not sent without WhatsApp opt-in on the number; the desk sees "not sent: no opt-in" |
| Failed delivery | A provider failure appears on the **desk "Bill messages" list** with the reason and a "Retry" button |
| Link + PIN | Link opens only with the PIN; 30-day expiry; revocable |

### 15.7 Witness approval flow tests (new)

- No witness PIN entry is possible in a personal session (UI and API).
- An approval request is visible only to the chosen witness and is refused for anyone else (IDOR).
- An expired request (> 10 min) cannot be approved.
- Approving from another ward without scope is refused.
- Waste is not decremented before approval.
- A give without a witness after 15 min raises a flag.

---

## 16. WhatsApp cost and messages [Rev 4]

| Message | When | Count | Cost (approx.) |
|---|---|---|---|
| Family status link (C5) | At admission, only with family-sharing consent + opt-in | ≤ 1 per admission | ₹0.115 utility + 18% GST + BSP ≈ ₹0.15–0.17 |
| **Final bill (C5, new)** | When the final bill is finalised, to the opted-in number | **1 per discharge** | ≈ ₹0.15–0.17 |
| Everything else (summary, lab ready, due/overdue doses, flags, counts) | In-app only | 0 | — |

**Final-bill message design:**
- **Template** (utility, en/mr/hi): "Your final bill from {Hospital} is ready: {link}. Open it with
  the PIN on your discharge slip."
  - **No name, amount, diagnosis or bed in the body** (D-BILLMSG).
- **Link:**
  - If a family link exists, the same `/f` page opens on its "Bill and summary" tab.
  - Otherwise, a bill-only link: 128-bit token, hashed, PIN printed on the discharge slip, **valid
    30 days**, revocable.
  - Shows the final bill and, when signed, the discharge summary.
- **Exactly once:** an `admission_messages` row (unique `admission_id, kind`) is inserted in the
  finalise transaction, together with the `notification_outbox` row.
  - `notification_outbox.appointment_id` is already nullable, so **the outbox schema does not
    change** (keeps the MVP guardrail).
- **Delivery status** comes from provider webhooks, already handled, and shows on the desk's **Bill
  messages** list with Retry.
- **Budget:** IPD messages per admission budget **2.0** (link + bill), alert at 3.0, tracked
  separately from the OPD canary.

---

## 17. Open decisions, each with a recommendation [Rev 4: new and updated rows marked ★]

| Id | Decision | Recommendation |
|---|---|---|
| D-SCALE | Scale targets | As §2.1; load-test at 2× |
| D-RES | Residency | **AWS Mumbai, now, in the pilot slice** (§9.1); legal review |
| D-RES2 | Compute | ECS Fargate Mumbai |
| ★ D-COST | Stage triggers and monthly budget | S1 ≈ US$230–330/month until any S2 trigger (> 30 hospitals, > 2,000 beds, a hospital > 200 beds, or an SLA ≥ 99.9%); S2 ≈ US$1,000–1,300; S3 ≈ US$3,500–6,000 (§9.2). Keep infra ≤ 12% of revenue; **price IPD per bed (≥ ₹120 per licensed bed per month)**. Confirm prices in the AWS calculator |
| D-STO | Files | S3 Mumbai + AWS SDK (approve the dependency); ClamAV Lambda |
| D-QR | QR | `qrcode` package; scanning via the browser's `BarcodeDetector` + a typed 6-character fallback (no dependency) |
| D-DEVDEPS | Dev tools | Playwright, axe-core, k6 |
| D-OTEL | Tracing | Later |
| D-ONCALL | On-call | Managed paging + contract night cover |
| ★ D-ORD | Order model | MAR with schedules; **doctor picks clock or interval per order; defaults: clock → keep schedule, interval → shift** (§7.10) |
| ★ D-TIMECRIT | Time-critical list and windows | Ship the starter list (§7.10) **inactive**. Dr Pawara + the pharmacist (or the doctor alone if there is no pharmacist) review it in Settings and sign off; ±30 min for time-critical, ±60 min for others; review every 6 months or on formulary change |
| ★ D-ESCAL | Who gets escalations | L1 (window end + 15 min) → ward in-charge on duty, else the senior nurse on shift; L2 (+ 45 min) → doctor on call for that department and branch, else the ordering doctor; acknowledgement stops further levels. The doctor confirms the delays |
| ★ D-BILLMSG | Final-bill message | Link valid **30 days**; **PIN printed on the discharge slip** (reuse the family PIN if a family link exists); **no amounts in the message body**; send only to the opted-in number; staff "Send again" allowed once, audited |
| ★ D-DRUG | Drug-register rules | Before B4-full: counsel or a pharmacy-law consultant confirms from **official gazette text** (G.S.R. 359(E) 2015 and S.O. 1181(E) for NDPS ENDs; G.S.R. 588(E) 2013 for H1) and the **Maharashtra FDA**: register formats (Forms 3D/3E/3H), retention (2 years NDPS / 3 years H1 as reported), RMI status of the pilot. Until confirmed, reports are labelled "draft format" |
| D-RECORD | Legal record in the parallel run | Paper in shadow; digital from the per-ward "primary" date |
| D-RET | Retention | Clinical ≥ 5 years after discharge (minors to 21, MLC until closed); NDPS 2 years / H1 3 years (per D-DRUG); logs 1 year; evidence log = clinical; staff flags 3 years after closure |
| D-FAM / D-PIN / D-FAMW | Family page | 7 days after discharge; PIN on the slip; curated labels; drug names off by default |
| D-BL | `/b` | Retire into `/f` |
| D-NEWS | NEWS2 | RCP bands unchanged; doctor sign-off |
| D-SCH | Schemes | Collect the pilot desk's document list before D1 |
| D-LAB | Lab | Typed results now; PDFs after A7 |
| D-DEP | Deposit alert | 80% + "balance > ₹5,000" |
| D-SHIFT / D-ROSTER | Shifts | 8–2–8; roster grid; PIN check-in fallback; **on-call grid per department** (needed for L2) |
| D-LANG | Languages | Staff labels selectable; family text mr/hi/en |
| D-RISK | Risk-class list | NDPS ENDs held + psychotropics in stock + 5–10 high-value items; hospital finalises |
| ★ D-WITNESS | Witness rules | Witness at give for ENDs and IV opioids/benzodiazepines, at waste for all risk-class; **only via the shared ward device or an approval request in the witness's own session**; enforce after 21 days observe |
| D-COUNT | Counts | Risk class daily at the morning shift change; others weekly; full monthly |
| D-CASE | Case review | Nursing → nursing superintendent; stock → pharmacy in-charge + owner; lab → lab in-charge; **D15 quality list → nursing superintendent only** |
| D-SELF | Own flags | Shown once a case opens or an explanation is asked for |
| ★ D-PRES | Presence | **Default on for risk-class Given from personal devices**; elsewhere start with bed QR in one ward |
| ★ D-MODEB | Mode B idle | 15-min lock + 5-min background PIN for clinical roles (default on; owner may shorten); 14-day sign-in |
| ★ D-MODEA | Ward device lifetime | Enrolment never expires from a day or week of non-use; ends on revoke or after 90 days unused; person PIN session 10-min idle, 24 h cap |
| D-MOD | Module states | on / read_only / off |
| D-NABH | NABH | Map from the official PDF first |
| D-ADR | Reversals | D-ID, D-DV, ADR-018, ADR-017 as in Rev 3 |
| D-LEGAL | Legal review | All items in §7.8 and §7.3, plus consent wording, e-sign, DPA, residency |

**New decisions in Rev 5:**

| Id | Decision | Recommendation |
|---|---|---|
| D-VPS | Is the existing VPS (`deploy.sh` → quriiohq.com) in India, and what are its specs? | Confirm. If it is not in India, rent a 2 vCPU/4 GB VPS in Mumbai (≈ ₹1,200–2,000/month) for S0 |
| D-S0DB | Managed DB or VPS DB at S0 | **Option 1 (RDS db.t4g.small, Mumbai)** if ≥ 4 paying hospitals at cutover; else Option 2 with WAL archiving and a monthly restore drill (§2.3a) |
| D-PILOTREV | The pilot's real OPD band and bed count | Replace the §2.3a assumptions before the review |
| D-LABCLOCK [Rev 5.1] | When the "not arrived" clock starts | **Decided:** per service point — from the doctor's order (default) or from payment; time default 30 min, set by the hospital |
| D-LABFU [Rev 5.1] | Who owns a lab's follow-up | **Decided:** the staff assigned to that service point and on duty; whoever calls is recorded; raised to the admin after 15 more minutes |
| D-LABMSG [Rev 5.1] | WhatsApp directions to late patients | **Decided:** calls only; no message |

### 17.1 Legal-review checklist [Rev 5]

**Owners:**
- **F** = founder (accountable for every item)
- **C** = external counsel (healthcare + data protection), **to be appointed by 30 Oct 2026**
- **P** = pharmacy-law consultant, or a written query to the Maharashtra FDA (assistant
  commissioner, Dhule/Nandurbar office)
- **D** = Dr Vinod Pawara (clinical sign-off)
- **A** = hospital administrator

Due dates come from the §11.1 windows. An item must be **closed** before the build step it gates
goes live.

| # | Item | Gates | Owner | Due |
|---|---|---|---|---|
| L1 | **DPA** (data processing agreement) with Guruved and each existing customer; processor duties, sub-processors (AWS, BSP), breach notice, retention, return/deletion at exit | S0 cutover | C, F | **20 Nov 2026** |
| L2 | **Data residency** and cross-border check: Neon Singapore → India move; customer notice; any NHA/PM-JAY data rule | S0 cutover | C | **20 Nov 2026** |
| L3 | **Staff monitoring policy** (en/mr/hi): purpose, what is logged, who sees it, retention, the "signals, not verdicts" wording, how staff explain or complain; DPDP s.7(i) basis; HR/labour aspects; first-login acknowledgement text | A5-min acknowledgement screen; evidence log live | C, A, F | **11 Dec 2026** (before A5-min ships) |
| L4 | **Drug registers** (D-DRUG): read the official gazette text for NDPS ENDs (G.S.R. 359(E) 2015, S.O. 1181(E)), Forms 3D/3E/3H and retention; Schedule H1 (G.S.R. 588(E) 2013, 3 years); **Guruved's RMI status**; Maharashtra FDA practice | B4a counts live (reports labelled "draft format" until closed) | P, D, F | **8 Jan 2027** |
| L5 | **E-signature validity** of PIN-based countersign and witness approvals under the IT Act (and whether hospitals must keep paper counter-signatures meanwhile) | B3-min live | C | **29 Jan 2027** |
| L6 | **Evidence admissibility**: export format and hashes for a BSA 2023 s.63 certificate; who signs Part A/B; chain of custody | Accountability moves from observe to alerts (after the review) | C | **26 Feb 2027** |
| L7 | **Retention schedule** (D-RET): clinical, NDPS/H1, staff flags/cases, logs; legal hold | Go/no-go review | C, D | **12 Mar 2027** |
| L8 | **Time-critical list and windows** (D-TIMECRIT) — a clinical sign-off, tracked here | B3b `warn` stage | D (+ pharmacist if any) | **12 Feb 2027** |
| L9 | **Consent wording** (admission, high-risk, family-sharing, procedure) in mr/hi/en; e-sign on screen vs paper | Roadmap C2 (not in the pilot slice) | C, D | Before C2 is approved; target **30 Apr 2027** |
| L10 | **Privacy notice and patient-facing terms** for the family page and bill link | Roadmap C5 | C | Before C5 is approved |

**Tracking:** each item gets a row in `docs/legal/review-log.md` (status, date, reference to the
written advice). Advice documents are stored outside the repo. Any "not closed by due date" item
blocks the gated release and is raised at the next weekly check-in.

**ADRs on sign-off:** module registry; roles and scopes; break-glass; access modes (incl.
lifetimes); India residency and staged infra; migration runner v2; evidence log; MAR + due engine
+ time-critical policy; witness design; reversals.

---

## 18. Files to reuse
- **RLS, guards, FKs:** `drizzle/0032_ipd_core.sql:410-471`; `0026` (`only_user_refs_cleared`,
  `is_one_way_void`); `0028` (`void_only_guard`, `app_clinical_access`).
- **Tenancy:** `lib/db/index.ts` (`withTenant`; add `app.branch_ids`); `lib/db/request-context.ts`.
- **Care entries and billing:** `lib/services/care-entries.ts` (`recordOne`, `isClientKeyRace`),
  `lib/services/ipd-billing.ts` (`postCareEntryLineInTx`).
- **Numbering and client ids:** `nextNumberInTx` (`discharge-billing.ts:513`), `testClientId`
  (`doctor-ipd.ts:146`).
- **Security helpers:** `lib/security/throttle.ts`, `password.ts` (scrypt), `tokens.ts`,
  `credentials.ts` (AES-GCM).
- **Auth:** `lib/auth/session.ts`, `lib/services/auth.ts` (session cache → revocation version),
  `lib/services/impersonation.ts`.
- **Plumbing:** `runSweeps` and `scripts/worker-daemon.ts` (escalation sweep, detectors, rollups,
  digests); `lib/domain/entitlements.ts` (plan gates).
- **Offline outbox:** `components/ipd/outbox.ts` (keep v1; new outboxes and the due-board cache get
  their own IndexedDB databases).
- **UI:** `PatientHeader`, `PrintControls`, `SavedNotice`, `SaveForm`, the record-screen bottom
  sheet.
- **Ops:** `Dockerfile`, `deploy.sh`, `infra/aws`.
- **Also:**
- the nullable `notification_outbox.appointment_id` (no outbox schema change for the bill message)
- `lib/domain/time.ts` (`zonedTimeToUtc`, `serviceDateIn`) for the due engine's timezone handling

---

## Appendix A: carried-over table designs (from Rev 2, mapped to the new phase ids)

These designs are kept and refined at the start of each phase. All clinical tables follow the
standard pattern:
- RLS + `clinical_access`
- composite FK to `admissions (hospital_id, id, encounter_id, patient_id)`
- `branch_id` and `org_unit_id` (Rev 3)
- `UNIQUE (hospital_id, client_id)`
- `recorded_*`, `channel`, `device_id`, `session_id`, void columns
- partial `(…, time) WHERE voided_at IS NULL` indexes

The shared guard `ipd_record_guard()` allows only one-way void, countersign, stop or "paper filed"
changes; it is built from `only_user_refs_cleared` and `is_one_way_void` (0026). No new enum values.

### A4-min (0041)
- `hospitals`: `registration_no`, `letterhead_phones`.
- `doctors`: `qualification`, `registration_no`, `on_letterhead`.
- `admissions.ipd_number`: unique per hospital, assigned through the `document_sequences` pattern
  (`nextNumberInTx`), never resets.
- `record_access_logs`: CHECK recreated (all old values + `print_ipd_file`, `view_file_upload`,
  `family_unlock`) plus `device_id`, `session_id`.

### B1 TPR (0043)
- **`chart_entries`** (typed hot columns):
  - `observed_at`, pulse, `bp_systolic`/`bp_diastolic` (pair CHECK), spo2, `temp_f_tenths`
    (900–1100), `bsl_mg_dl`, `resp_rate`, `abd_girth_cm`, `on_oxygen`, `consciousness`
    (A/C/V/P/U)
  - urine / drain / rt_aspirate / oral / iv `_ml`, note
  - `source` (`chart` | `doctor_note`), `template_version_id`, `values jsonb`
  - CHECK at least one value
- **Domain** (tests): °F/°C parse, BP parse, flags as text, 8 am–8 am chart day, paper slots
  (front 8 am–10 pm, back 11 pm–7 am), I/O per shift and 24 h.
- **API:** `/api/ipd/tpr` (batch ≤ 50, idempotent like `recordOne`), `/undo` (2 min).
- **Offline:** own IndexedDB database (`qurio-ward-tpr`); `qurio-ward` v1 untouched.
- **Print:** A4 landscape, front and back.

### B3-min orders / MAR (0046; timing columns in 0047)
- **`treatment_orders`:**
  - kind `medicine|diet|blood|instruction|task`, medicine / charge item, description snapshot
  - dose, route, frequency, instructions
  - `details` jsonb (blood: bag no., collection/expiry, tested-on, HIV/HBsAg/HCV/VDRL/MP/atypical
    antibodies, group & Rh, blood bank; expired bag or reactive result refused)
  - `ordered_at`, `ordering_doctor_id`, `entered_by`, `transcribed`, `countersigned_*`, `stopped_*`
  - `allergy_override_reason`
  - timing columns (0047)
- **`mar_administrations`** (partitioned): order, `state`
  (given/held/refused/not_available/omitted), qty, batch, `due_at`, `timing_status`, `delay_min`,
  `reason_code` / `reason_text`, `witness_request_id`, `presence_proof_id`, `queued_offline`.
  Given also posts the bill line through the core care-entry path.
- **`witness_requests`:** actor, witness, action, status, expires_at, approved_session_id; CHECK
  witness ≠ actor.
- `presence_proofs`; `risk_classes`; `medicine_risk_class`.
- **Countersign service:** only the named doctor's linked user.

### B4a/B4b stock (0045; B4b expands it)
B4a adds `manual_used_since_last` on count lines (retired in B4b).
- `stock_locations`, `stock_batches`, `purchase_receipts`.
- `stock_ledger` (append-only; kinds receive / transfer_out / transfer_in / give / waste / return /
  adjust / count_variance / reversal; unique `care/mar` reference for an idempotent decrement).
- `stock_balances` (counter under a row lock).
- `stock_counts`, `stock_count_lines` (blind).
- `stock_adjustment_requests` (CHECK requester ≠ approver).

### B2 allergy (0050)
- `patient_allergies` is **patient-level**: substance, reaction, severity, voids.
- `patient_allergy_reviews` (NKDA).
- Matching = name + class map (penicillins, cephalosporins, sulfa, NSAIDs, aspirin), labelled
  decision support. Override needs a reason, which is audited.

### B5 discharge summary (0051)
- `discharge_summary_drafts` (outside the record).
- `discharge_summaries`: versioned; signed via countersign; `supersedes_id`.
- **Deterministic auto-draft** (no AI) from reason/Case of, C/O, findings, investigations,
  treatment given, medicines to continue, follow-up, diet and warning signs.
- Unsigned prints as DRAFT and cannot be shared.

### C1 billing sheet (0053)
- `charge_items.billing_sheet_order`; `care_entries.entry_mode` (`bedside` | `sheet`).
- Ticks through `recordOne` with derived client ids (`testClientId` pattern); "Same as yesterday";
  room rows read-only from bed-days.
- Missing paper rows added to the starter items, unpriced.
- Category bill (Room / Investigations / Medicines / Hospital charges) + day-wise annexure; category
  total = day total = DB total.

### C2 consents (0054)
- `consents`:
  - kind `admission|high_risk|family_sharing|procedure`, locale
  - title/body snapshot, `patient_snapshot` (village/taluka/district)
  - `signers` jsonb (1–2: name, relation, phone, SVG signature path)
  - method `on_screen|paper`, `explained_by_doctor_id`, countersign, `paper_filed_*`, voids
    (= revoke)
- Our own mr/hi/en wording as code constants, for legal review.
- A blank relation, name or doctor is refused in the UI, the action and the DB.

### C3 doctor notes (0055)
- `ipd_notes`: kind `admission|progress`; sections (Case of, C/O [{text, duration}], H/O, P/H, O/E,
  S/E CNS/RS/PA/CVS, Adv); `seen_by_doctor_id`; `chart_entry_id`; transcribed + countersign.
- O/E is prefilled from a reading ≤ 2 h old; a changed value writes one chart row
  (`source 'doctor_note'`).

### C4 lab (0056)
- `lab_orders`: test, **reason required**, priority, status `ordered|collected|resulted|cancelled`,
  bills once through `order:<id>` client id.
- `lab_results`: text, abnormal, amendments via `supersedes_id`, `file_id`.
- Worklist from a partial index.
- Lab roles see only the order fields, never notes or charts.

### C5 family + bill message (0057)
- `family_links`: consent required; hashed token + PIN; expiry; revoke; lock-out.
- `family_link_views` (append-only, 10-min dedupe).
- `patient_status_updates`; `family_callback_requests`.
- **`admission_messages`** (unique `admission_id, kind`).
- In-process 45 s page cache.

### C6 (0058)
- `ews_latest`: upserted in the chart write.
- `handovers`: snapshot jsonb, generated/acknowledged.
- Readiness providers; leakage report (owner only, on demand, ≤ 90 days).

### D1 (0060)
- Admission-form columns: brought-by name/relation/phone, `referred_by`, `discharge_status`.
- `claim_details`: scheme, pre-auth no. and date, packages, encrypted card/ABHA no., TPA/policy.
- Date checks; claim packet print.

### D3 / D4 / D5 (0062–0064)
- `order_sets` (review before save).
- `procedure_notes` (minor procedures).
- Care-plan templates; wound care with photos.

## 19. Sources [Rev 4]

Status key: ✔ official or primary; ◐ secondary, wording to be confirmed; ✖ not verified / low
confidence.

| # | Source | Used for | Status |
|---|---|---|---|
| S1 | [CBN — Acts & Rules](http://cbn.nic.in/html/Acts.htm) | G.S.R. 359(E) 5 May 2015 | ✔ (listing) |
| S2 | [NDPS Rules 1985 — India Code](https://www.indiacode.nic.in/ViewFileUploaded?path=AC_CG_61_1073_00014_00014_1563259383370%2Frulesindividualfile%2F&file=the_narcotic_drugs_and_psychotropic_substances_rules%2C_1985_date_14.11.1985.pdf) | NDPS rules text | ✔ (to read) |
| S3 | [NHSRC — Schedule H1 register and NDPS forms](https://qps.nhsrcindia.org/sites/default/files/2022-01/Attachment%20A,%20Schedule%20H1%20register%20and%20NDPS%20Forms.pdf) | Forms 3D/3E/3H, H1 register, retention | ◐ |
| S4 | [NCG — Guidelines for stocking and dispensing ENDs](https://palliumindia.org/wp-content/uploads/2023/09/RMI-Guidelines-by-NCG-1.pdf) | RMI, forms, retention | ◐ |
| S5 | [Goa FDA alert](https://dfda.goa.gov.in/?p=5144) | H1 notification (cites 558(E)) | ◐ |
| S6 | [GKToday — proposed Schedule H/H1/X amendments](https://www.gktoday.in/health-ministry-proposes-amendments-to-drugs-rules-1945-for-schedule-h-h1-and-x-drugs/) | Draft CCTV rule | ✖ |
| S7 | [MeitY — DPDP Act 2023 gazette PDF](https://www.meity.gov.in/static/uploads/2024/06/2bf1f0e9f04e6fb4f8fef35e82c42aa5.pdf) | s.7(i) | ✔ (to read) |
| S8 | [Bar & Bench — legitimate use for employee data](https://www.barandbench.com/law-firms/view-point/navigating-legitimate-use-exemption-employee-data-digital-personal-data-protection-act-2023) | s.7(i) meaning | ◐ |
| S9 | [AZB — DPDP phased rollout](https://www.azbpartners.com/bank/indias-digital-personal-data-protection-act-phased-rollout-and-key-compliance-milestones/) | Commencement dates | ◐ |
| S10 | [KPMG — DPDP Rules 2025 guidance](https://assets.kpmg.com/content/dam/kpmgsites/in/pdf/2025/11/dpdp-rules-2025-guidance-to-dpdp-act-implementation.pdf) | Breach 72 h, retention | ◐ |
| S11 | [India Code — Bharatiya Sakshya Adhiniyam 2023](https://www.indiacode.nic.in/bitstream/123456789/20063/1/aa202347.pdf) | s.63 and Schedule | ✔ (to read) |
| S12 | [JSA — electronic evidence, June 2026](https://www.jsalaw.com/wp-content/uploads/2026/06/JSA-Prism-Dispute-Resolution-June-2026-Electronic-Evidence.Final_.pdf) | Hash in certificate | ◐ |
| S13 | ISMP — Guidelines for timely administration of scheduled medications (acute care) | Time-critical concept and windows | ✖ (link to be confirmed) |
| S14 | [Neon — regions](https://neon.tech/docs/introduction/regions) | No India region | ✔ |
| S15 | [InfraTally — RDS PostgreSQL pricing 2026](https://infratally.com/articles/aws-rds-pricing-explained-2026/); [selfhost.dev — RDS cost 2026](https://selfhost.dev/blog/aws-rds-cost-breakdown-2026/) | Mumbai RDS and gp3 prices | ◐ (confirm in the calculator) |
| S16 | AWS RDS SLA (aws.amazon.com/rds/sla) | Single-AZ vs Multi-AZ SLA | ✖ (to confirm the figures) |
| S17 | [NABH Hospital Standards 6th edition (official PDF)](https://portal.nabh.co/images/Standards/NABH%20Hospital%20Accreditation%20Standard%206th%20Edition%20January%202025.pdf) | Chapters and objective elements | ✔ (to read) |
| S18 | [NABH — MOM masterclass](https://nabh.co/training/hco-full-accreditation-masterclass-6th-edition-chapter-3-management-of-medication-mom/) | MOM scope | ✔ |
| S19 | [NRCeS — DischargeSummaryRecord](https://nrces.in/ndhm/fhir/r4/StructureDefinition-DischargeSummaryRecord.html) | FHIR profile | ✔ |
| S20 | [Medical Dialogues — NMC on ABDM HMIS integration](https://medicaldialogues.in/health-news/nmc/nmc-flags-non-compliant-medical-colleges-over-mandatory-abdm-hmis-integration-warns-of-action-175264); [NMC notice](https://nmc.org.in/whats-new/download/950) | Medical-college mandate | ◐ / ✔ |
| S21 | [HMPI — operationalising ABDM](https://hmpi.org/2026/07/09/from-infrastructure-to-impact-operationalizing-indias-ayushman-bharat-digital-mission/) | ABHA uptake | ◐ |
| S22 | [Nirmitee — is NHCX mandatory in 2026](https://nirmitee.io/blog/is-nhcx-mandatory-hospitals-hmis-2026/) | NHCX status | ✖ (vendor analysis) |
| S23 | [MJPJAY adjudication guidelines](https://www.jeevandayee.gov.in/MJPJAY/RGJAYDocuments/Adjudication%20guidelines%20from%20MOU.pdf) | Claims | ✔ |
| S24 | [PM-JAY process flow (SHA Uttarakhand)](https://sha.uk.gov.in/ScannedDocs/WebSite/Uploads/CLAIM_ADJ/pm-jay-process-flow-at-empanelled-hospitals-6-5-19.pdf) | Pre-auth flow | ✔ (other state, 2019) |
| S25 | [CAG — PM-JAY audit chapter](https://cag.gov.in/uploads/download_audit_report/2023/09_Chapter-V-064d22bab412c53.02505839.pdf) | Rejection reasons | ✔ |
| S26 | [Medical Dialogues — NMC draft 3-year retention](https://medicaldialogues.in/health-news/nmc/doctors-need-to-maintain-patient-record-for-3-years-nmc-draft-94681) | Retention | ◐ |
| S27 | [CAHO — retention and destruction of records](https://caho.in/files/Retention%20&%20Destruction%20of%20Hospital%20Records.pdf) | Retention practice | ◐ |
| S28 | [RCP — NEWS2 thresholds chart](https://www.rcp.ac.uk/media/2acdezkd/news2-chart-2_news-thresholds-and-triggers_0.pdf) | NEWS2 | ✔ |
| S29 | WHO Labour Care Guide (who.int) | Labour pack | ✖ (link to be confirmed) |
| S30 | [Baat.ai — WhatsApp API pricing India 2026](https://baat.ai/blog/whatsapp-api-pricing-india); [Monty Mobile](https://montymobile.com/blogs/whatsapp-business-api-pricing-in-india-inr-rates-gst-and-the-2026-currency-migration-deadline) | Utility ≈ ₹0.115 | ◐ (confirm in Meta Business Manager) |
