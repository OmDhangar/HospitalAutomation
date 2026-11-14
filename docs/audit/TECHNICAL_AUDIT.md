# Qurio HMS — Technical Foundation Audit

**Document Title:** Deep-Dive Technical Foundation, Security, Relational Integrity & Performance Audit  
**Audit Path:** `docs/audit/TECHNICAL_AUDIT.md`  
**Audit Date:** November 2026  
**Status:** Read-Only Baseline Architectural Audit  

---

## 1. Drizzle ORM Schema Architecture & Relational Integrity

The relational data model is centralized in [`lib/db/schema.ts`](file:///d:/Projects/HospitalAutomation/lib/db/schema.ts), declaring over 115 PostgreSQL tables using Drizzle ORM.

### 1.1 Core Relational Clusters
1. **Tenant & Organizational Core:**  
   `hospitals` $\to$ `branches` $\to$ `wards` $\to$ `beds`. Every operational table inherits `hospital_id` as a foreign key with cascade rules.
2. **Identity & Queue Hierarchy:**  
   `persons` (universal human identity) $\to$ `patients` (tenant-specific clinical record) $\to$ `appointments` $\to$ `queue_events`.
3. **Clinical Documentation Core:**  
   `encounters` $\to$ `consultations` $\to$ `diagnoses`, `clinical_notes`, `prescriptions` $\to$ `prescription_items`.
4. **Inpatient & Nursing Care Core:**  
   `admissions` $\to$ `bed_assignments`, `care_entries`, `ipd_medication_orders` $\to$ `ipd_medication_administrations`, `vitals_readings`, `intake_output`.
5. **Billing & Financial Core:**  
   `encounters` $\to$ `bills` $\to$ `bill_items`, `patient_payments`, `ipd_discharge_clearances`.
6. **Cryptographic Proofs & Audit:**  
   `acct_events` $\to$ `acct_digests` $\to$ `acct_verifications`.

### 1.2 Foreign Key Constraints & Cascades
- Foreign keys are explicitly configured across all relational boundaries using `references(() => table.id, { onDelete: 'cascade' / 'restrict' })`.
- **Relational Strength:** Deleting a patient or hospital is guarded by strict `restrict` constraints where financial ledgers (`bills`, `payments`, `acct_events`) exist, preventing orphaned financial records.
- **Identified Relational Risk:** Certain tables in the IPD medication suite (`ipd_medication_orders`, `treatment_orders`) maintain loose string IDs rather than foreign key constraints back to `consultations`, creating the OPD-to-IPD disconnect.

---

## 2. Tenant Isolation & Multi-Tenancy Architecture

Qurio implements a defense-in-depth tenant isolation model combining application-layer scoping and PostgreSQL Row-Level Security (RLS).

```
┌───────────────────────────────────────────────────────────────────────────┐
│                    QURIO DUAL-LAYER TENANT ISOLATION                      │
│                                                                           │
│   [Inbound HTTP Request]                                                  │
│             │                                                             │
│             ▼                                                             │
│   1. APPLICATION LAYER: lib/db/index.ts:withTenant(hospitalId, ...)       │
│      ► Scopes all queries inside a dedicated database transaction         │
│      ► Executes: SELECT set_config('app.hospital_id', $1, true);          │
│                                                                           │
│             ▼                                                             │
│   2. DATABASE LAYER: PostgreSQL Row-Level Security (RLS)                  │
│      ► Every table enforces policy: hospital_id = current_setting(...)    │
│      ► Forgetting a WHERE clause returns 0 rows; NEVER leaks other tenant │
│                                                                           │
│             ▼                                                             │
│   3. SUPERUSER GUARD: assertRestrictedRole()                              │
│      ► In production, aborts immediately if connecting as superuser/bypass│
└───────────────────────────────────────────────────────────────────────────┘
```

### 2.1 Code Implementation Details
- Located in [`lib/db/index.ts:withTenant`](file:///d:/Projects/HospitalAutomation/lib/db/index.ts).
- `set_config('app.hospital_id', hospitalId, true)`: The third parameter `true` is **critically load-bearing**—it scopes the variable to the lifetime of the transaction. Without it, the setting would linger on pooled connections and leak across subsequent requests from different hospital tenants.
- **Fail-Safe Verification:** [`lib/db/index.ts:assertRestrictedRole`](file:///d:/Projects/HospitalAutomation/lib/db/index.ts) executes on cold boot, verifying that `current_user` does not possess `rolsuper` or `rolbypassrls`. If RLS bypass is detected in production, the application terminates immediately with a fatal error.

---

## 3. Role Permissions & Enforcement Points

Defined centrally in [`lib/domain/permissions.ts`](file:///d:/Projects/HospitalAutomation/lib/domain/permissions.ts):
- Permissions are strictly structured as an **allow-list**:
  ```typescript
  export const STAFF_ROLES = ['owner', 'receptionist', 'doctor', 'nurse'] as const;
  ```
- Any unmapped role defaults to zero access.

### 3.1 Server Action & Route Enforcement Audit
- **Consultation Authoring:** [`app/(app)/dashboard/consultation-panel.tsx`](file:///d:/Projects/HospitalAutomation/app/(app)/dashboard/consultation-panel.tsx) checks `'clinical.write'`, requiring the user to be an `owner` or `doctor`. Crucially, backend service logic verifies that the active session matches `doctors.user_id`, preventing Doctor A from writing or modifying Doctor B's consultation drafts.
- **Billing & Money Collection:** Checked via `'billing.collect'`, granted strictly to `owner` and `receptionist`. Doctors cannot mark bills paid, preventing day-end cash till reconciliation disputes.
- **Bedside Medication Administration:** Checked via `'ipd.record'`, granted to `nurse`, `receptionist`, and `owner`. Doctors author medication orders via `'clinical.write'`, while nurses execute administration.
- **Identified Role Gaps:** The system currently lacks dedicated `pharmacist`, `lab_technician`, and `billing_staff` roles, forcing administrative and billing staff to operate under the broad `receptionist` or `owner` roles.

---

## 4. Transaction Boundaries & Concurrency Safety

### 4.1 Queue Token Calling Concurrency
- **File:** [`lib/services/queue.ts:callNextPatient`](file:///d:/Projects/HospitalAutomation/lib/services/queue.ts).
- **Implementation:** Executes `SELECT ... FOR UPDATE` on the doctor's queue state row.
- **Concurrency Verification:** Prevents two concurrent receptionist or doctor requests from calling the same token or advancing the queue simultaneously during high-volume OPD peak hours.

### 4.2 Inpatient Bed Transfer Concurrency
- **File:** [`lib/services/ipd-census.ts:transferBed`](file:///d:/Projects/HospitalAutomation/lib/services/ipd-census.ts).
- **Implementation:** Closes the current `bed_assignments` record (`released_at = NOW()`) and inserts the new bed assignment record within a single atomic database transaction.
- **Concurrency Verification:** Prevents a race condition where a bed could be assigned to two patients simultaneously or left in an orphaned transfer state if a network disconnect occurs mid-operation.

### 4.3 5-Department Discharge Clearance Concurrency
- **File:** [`lib/services/ipd-clearance.ts:generateGatePass`](file:///d:/Projects/HospitalAutomation/lib/services/ipd-clearance.ts).
- **Implementation:** Re-evaluates all 5 clearance flags inside a serializable transaction lock before issuing the cryptographic gate pass token. If a ward nurse adds an unconsumed medication or lab order mid-clearance, the transaction aborts and revokes the gate pass.

---

## 5. Audit Logging & Cryptographic Integrity

### 5.1 Standard Administrative Audit Logging
- **Table:** `audit_logs` in [`lib/db/schema.ts`](file:///d:/Projects/HospitalAutomation/lib/db/schema.ts).
- Logs administrative changes (user creation, doctor fee modifications, schedule overrides, branch edits) capturing `actor_id`, `action`, `entity_type`, `entity_id`, and `metadata` JSON.

### 5.2 Cryptographic Medico-Legal Audit Ledger (`acct_events`)
- **Table:** `acct_events` in [`lib/db/schema.ts`](file:///d:/Projects/HospitalAutomation/lib/db/schema.ts).
- **Service:** [`lib/services/evidence.ts`](file:///d:/Projects/HospitalAutomation/lib/services/evidence.ts).
- **Implementation:** Every clinical and financial mutation (vital charted, medication administered, bill line item added, gate pass issued) generates a cryptographic record:
  $$H_n = \text{HMAC-SHA256}(K_{\text{tenant}}, H_{n-1} \parallel \text{Payload})$$
- Hourly cron jobs compute tree root digests, signing them with the hospital's private HMAC secret.
- **Audit Finding:** The cryptographic ledger is mathematically sound and fully tested (`lib/domain/__tests__/evidence.test.ts`), but lacks an automated verification UI for hospital superintendents.

---

## 6. Query Performance & Indexing Analysis

An inspection of table indexes in [`lib/db/schema.ts`](file:///d:/Projects/HospitalAutomation/lib/db/schema.ts) reveals strong indexing on primary operational queries:

1. **Queue Lookups:** Indexed on `appointments(hospital_id, doctor_id, date, status)`. Fast index scans during live queue streaming.
2. **Bed Occupancy:** Indexed on `bed_assignments(hospital_id, bed_id, released_at)`.
3. **Patient Search:** Indexed on `patients(hospital_id, phone)` and `patients(hospital_id, uhid)`.
4. **Recommended Index Optimization:** Add a composite index on `care_entries(admission_id, entered_at DESC)` and `vitals_readings(admission_id, recorded_at DESC)` to optimize bedside nursing chart loading on budget Android tablets.

---

## 7. Error Handling, Validation & Test Suite Health

### 7.1 Server-Side Validation
- All public and internal API inputs are strictly validated using **Zod** schemas (`lib/domain/`, `lib/services/`).
- Invalid payloads return structured `{ success: false, error: string, code: string }` responses rather than raw database stack traces.

### 7.2 Vitest Suite Health Audit
- Test command: `npm test` (`vitest run lib/domain lib/notify lib/security lib/payments lib/db/migrations lib/modules`).
- **Results:**
  - Total Test Files: 78
  - Passing Test Files: **76**
  - Failed Test Files: **2** (`lib/db/migrations/__tests__/lint.test.ts` and `plan.test.ts`)
  - Total Tests: **956**
  - Passing Tests: **954**
  - Failing Tests: **2**
- **Root Cause of Failures:** Exclusively caused by trailing syntax corruption on line 405 of `drizzle/meta/_journal.json`. Zero domain logic, security, or payment test failures exist.
