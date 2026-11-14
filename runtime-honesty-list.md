# RUNTIME-HONESTY LIST
**Target:** Qurio Healthcare SaaS Platform — Pilot Hospital Deployment  
**Context:** Unobservables from Static Code Analysis Requiring Live Telemetry & Field Measurement  
**Author:** Staff Healthcare Systems & Reliability Engineer  

---

## Overview

Static analysis of a codebase can verify syntax, types, architectural boundaries, and SQL schema semantics. However, in mission-critical healthcare systems operating inside real hospital walls, the code is only half the reality. The other half is dictated by PostgreSQL query planners under high cardinality, connection multiplexers under burst loads, Meta API rate-limiting algorithms, low-cost Android hardware thermals, and concrete hospital walls that block radio frequencies.

This document lists the critical runtime metrics that cannot be known from code alone, along with the exact queries, configurations, and instrumentation required from the founder to answer each.

---

## 1. Actual Latency on the Top 5 Hot Queries at Production Cardinality

Under local development with 10–50 rows per table, every query finishes in under 2ms. At production cardinality (after 6 months: 50,000+ patients, 120,000+ queue tokens, 300,000+ eMAR dose events, and 1,000,000+ audit log rows), PostgreSQL query execution plans change dramatically.

### Hot Query 1: Multi-Tenant RLS Overhead on withTenant
- **The Question:** What is the true millisecond cost of executing `set_config('app.hospital_id', ..., true)` and evaluating RLS row-filter expressions on every query in a connection pool?
- **Risk:** If PostgreSQL cannot inline session variables or if RLS forces a sequential scan over large partitioned tables, transaction latency will spike.
- **How the Founder Measures It:**
  Enable `pg_stat_statements` on the production database and query:
  ```sql
  SELECT query, calls, total_exec_time / calls AS avg_exec_ms, min_exec_time, max_exec_time
  FROM pg_stat_statements
  WHERE query LIKE '%set_config%' OR query LIKE '%tenant_isolation%'
  ORDER BY total_exec_time DESC
  LIMIT 5;
  ```

### Hot Query 2: Active Doctor OPD Queue Retrieval (`getQueueForDoctor`)
- **The Question:** What is the p95 and p99 query latency of the main OPD queue view (`lib/services/queue.ts`) joining `patient_queue`, `appointments`, `patients`, and `encounters` filtered by `service_date` and `doctor_id`?
- **Risk:** High queue lock contention when doctors call next, hold, or complete tokens while reception simultaneously inserts new walk-ins.
- **How the Founder Measures It:**
  Run `EXPLAIN (ANALYZE, BUFFERS)` on the active queue query using production database parameters:
  ```sql
  EXPLAIN (ANALYZE, BUFFERS)
  SELECT pq.*, a.*, p.name, p.phone_e164
  FROM patient_queue pq
  JOIN appointments a ON a.id = pq.appointment_id
  JOIN patients p ON p.id = a.patient_id
  WHERE pq.hospital_id = '<PROD_HOSPITAL_ID>'
    AND pq.service_date = CURRENT_DATE
    AND pq.doctor_id = '<PROD_DOCTOR_ID>'
    AND pq.status IN ('waiting', 'called', 'on_hold')
  ORDER BY pq.priority DESC, pq.token_number ASC;
  ```

### Hot Query 3: Bedside eMAR Dosage Schedule (`getBedsideEmar`)
- **The Question:** Does the eMAR timeline join between `ipd_medication_orders` and `ipd_medication_administrations` scale linearly when an ICU patient has 20+ daily active medications across a 14-day stay?
- **Risk:** N+1 query execution inside the eMAR aggregator if sub-queries are not batched across order IDs.
- **How the Founder Measures It:**
  Inspect server-side timing headers or APM span logs on `GET /ipd/ward/[wardId]/bed/[bedId]`. Target: Server response time must remain under 120ms on p95.

### Hot Query 4: Background Outbox Claim (`drainOutbox` & `drainAllHospitalsIpdEmarOutbox`)
- **The Question:** How much row lock contention occurs on `notification_outbox` and `ipd_emar_outbox` during concurrent worker runs with `FOR UPDATE SKIP LOCKED`?
- **Risk:** Table bloat on outbox tables due to high-frequency updates and dead tuples, causing sequential scans on workers.
- **How the Founder Measures It:**
  Check bloat and scan stats on outbox tables:
  ```sql
  SELECT relname, n_dead_tup, n_live_tup, last_vacuum, last_autovacuum
  FROM pg_stat_user_tables
  WHERE relname IN ('notification_outbox', 'ipd_emar_outbox', 'notice_campaign_outbox');
  ```

### Hot Query 5: Patient Fuzzy Identity Match at Reception (`searchPatients`)
- **The Question:** What is the latency of trigram / phone suffix searches on the `patients` table when reception types a patient's name into the admission search bar?
- **Risk:** Missing `pg_trgm` GIN indexes on `patients.name_key` causing full table scans that freeze the reception browser input.
- **How the Founder Measures It:**
  ```sql
  EXPLAIN (ANALYZE, BUFFERS)
  SELECT id, name, phone_e164, mrn, qid
  FROM patients
  WHERE hospital_id = '<PROD_HOSPITAL_ID>'
    AND (name ILIKE '%Kavita%' OR phone_e164 LIKE '%98765%')
  LIMIT 10;
  ```

---

## 2. Actual CI Test Pass Rate Today

- **The Unknown:** Does the automated continuous integration pipeline (GitHub Actions, GitLab CI, or Vercel Build) execute integration tests (`npm run test:integration`) or only unit tests (`npm test`)?
- **Why It Matters:** As discovered in §2.2 of the Audit Report, `npm test` passes 100% (954 tests) because unit tests run against mocks. However, `npm run test:integration` fails 10 test suites because migrations 0047–0053 were orphaned. If CI only runs `npm test`, broken database queries are deployed directly to production.
- **How the Founder Measures It:**
  1. Open `.github/workflows/ci.yml` (or the equivalent CI configuration).
  2. Inspect the test step:
     - If it reads `run: npm test`, CI has been green while database integration is broken.
     - If it reads `run: npm run test:integration`, verify the last 10 CI run outputs in GitHub Actions to determine whether integration tests are skipped or failing silently.

---

## 3. Actual Production Error Rate & Exception Volume

- **The Unknown:** What is the daily unhandled exception count, and what percentage of user requests end in an HTTP 500 or React client error boundary?
- **Top Suspected Runtime Exceptions:**
  1. `relation "ipd_notes" does not exist` or `relation "treatment_orders" does not exist` when staff click secondary clinical tabs.
  2. `duplicate key value violates unique constraint "prescriptions_encounter_id_unique"` when a doctor double-clicks the "Save Prescription" button on slow mobile connections.
  3. `403 Forbidden` on `/api/ipd/care-entries` when doctors attempt to enter bedside notes.
- **How the Founder Measures It:**
  1. Log in to the production error tracking dashboard (Sentry / LogRocket / Datadog).
  2. Filter by:
     - Environment: `production`
     - Time Range: Last 7 days
     - Group By: `error.type` and `transaction`
  3. Verify that the daily unhandled error rate is strictly under 0.1% of total requests.

---

## 4. Actual WhatsApp Message Budget Consumption & Meta Cloud Health

- **The Unknown:** How many WhatsApp messages are delivered, failed, or suppressed daily, and how close is the pilot hospital to Meta's tier limits?
- **Operational Variables:**
  - **Meta Tier Limits:** New WhatsApp Business Accounts start at Tier 1 (1,000 business-initiated conversations in a rolling 24-hour window). If the pilot hospital issues 350 OPD tokens and runs a notice campaign on the same morning, Meta rejects additional messages with error code `131042: Business eligibility payment issue` or `131056: Rate limit hit`.
  - **Template Quality Rating:** If patients report WhatsApp messages as spam, Meta downgrades the phone number's quality rating from Green to Yellow or Red, throttling message throughput.
  - **Suppressed Margin Canary:** In `lib/notify/worker.ts:201`, slot reminders are suppressed if subscription limits are exceeded. How many patients missed reminders due to silent suppression?
- **How the Founder Measures It:**
  Run the daily message audit query against the production database:
  ```sql
  SELECT
    date_trunc('day', created_at) AS date,
    template_code,
    status,
    count(*),
    failed_reason
  FROM notification_outbox
  WHERE created_at >= NOW() - INTERVAL '14 days'
  GROUP BY 1, 2, 3, 5
  ORDER BY 1 DESC, 4 DESC;
  ```
  Additionally, log in to **Meta Business Manager -> WhatsApp Accounts -> Insights** and inspect:
  - Total Conversations by Category (Service vs. Utility vs. Marketing)
  - Phone Number Quality Rating (Green / Yellow / Red)
  - Messaging Limit Tier status (1K / 10K / 100K)

---

## 5. Actual Database Connection Pool & Disk Usage under Load

- **The Unknown:** How does PostgreSQL connection pooling behave when multiple ward tablets, reception desktops, and background workers connect simultaneously?
- **Key Risks:**
  - **Connection Exhaustion:** Postgres.js is configured in `lib/db/index.ts` with `max: 10`. In a serverless deployment (e.g. Vercel), every serverless lambda instance spins up its own pool of 10 connections. 20 concurrent lambdas can attempt 200 connections to PostgreSQL, exceeding standard database limits (`max_connections = 100`) and throwing `sorry, too many clients already`.
  - **Transaction Mode Pooling Compatibility:** If the founder places PgBouncer or Supabase Supavisor in front of PostgreSQL, does it run in **Transaction Mode** or **Session Mode**? RLS with `set_config(..., true)` requires transaction mode. If run in session mode, tenant variables leak across clients.
  - **Append-Only Table Growth:** Tables `record_access_logs`, `evidence_items`, and `claim_events` are append-only. How many gigabytes of disk and index space are they consuming per month?
- **How the Founder Measures It:**
  Run against PostgreSQL:
  ```sql
  -- Check active connections by database and user
  SELECT usename, state, count(*)
  FROM pg_stat_activity
  GROUP BY usename, state;

  -- Check size and monthly growth of audit tables
  SELECT
    relname,
    pg_size_pretty(pg_total_relation_size(relid)) AS total_size,
    pg_size_pretty(pg_relation_size(relid)) AS table_size,
    pg_size_pretty(pg_total_relation_size(relid) - pg_relation_size(relid)) AS index_size
  FROM pg_catalog.pg_statio_user_tables
  ORDER BY pg_total_relation_size(relid) DESC
  LIMIT 10;
  ```

---

## 6. Real-World Hardware & Network Telemetry on the Hospital Floor

- **The Unknown:** How does the Next.js React client perform on the physical ward devices deployed at Sunrise Multispeciality?
- **Field Realities:**
  - **Device Class:** Hospital ward tablets are typically budget Android devices ($100–$150, MediaTek processor, 2GB–3GB RAM). High DOM node counts in dense eMAR tables or complex SVG charts can cause touch latency (Interaction to Next Paint / INP > 500ms) or browser crashes due to memory pressure.
  - **Wi-Fi Blindspots:** Hospital construction frequently features thick concrete walls, lead-shielded X-ray suites, and ICU isolation rooms where Wi-Fi drops completely.
  - **Offline Outbox Queueing:** Does the browser's IndexedDB offline queue properly retain eMAR doses during a 45-minute Wi-Fi outage and reliably flush all pending administrations when reconnection occurs?
- **How the Founder Measures It:**
  1. Add Web Vitals logging to `app/layout.tsx` or `instrumentation.ts` reporting INP, FID, and LCP segmented by device user-agent.
  2. Inspect the client outbox telemetry in `record_access_logs`:
     ```sql
     SELECT channel, device_id, count(*)
     FROM sessions
     WHERE channel = 'ward_device'
     GROUP BY channel, device_id;
     ```
  3. Conduct an on-site physical walk-through: put a ward tablet into Airplane Mode, administer three dummy doses, walk across the ward for 10 minutes, turn Airplane Mode off, and verify that all three doses synchronize within 15 seconds.

---
*End of Runtime-Honesty List. Implement the telemetry and SQL scripts above to ensure total operational visibility into the pilot hospital.*
