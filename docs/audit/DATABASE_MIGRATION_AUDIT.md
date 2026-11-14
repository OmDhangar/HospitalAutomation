# Qurio HMS — Database Migration & Schema Drift Audit

**Document Title:** Drizzle ORM Migration Journal, Schema Drift, Orphaned Tracks & Reconciliation Strategy  
**Audit Path:** `docs/audit/DATABASE_MIGRATION_AUDIT.md`  
**Audit Date:** November 2026  
**Status:** Read-Only Baseline Architectural Audit  

---

## 1. Migration History & Journal Integrity

The database evolution of Qurio is managed via **Drizzle ORM** with custom migration runners in `scripts/migrate.ts` and `scripts/migrate-v2.ts`.

### 1.1 The Journal Syntax Error (Critical Defect)
- **File:** [`drizzle/meta/_journal.json`](file:///d:/Projects/HospitalAutomation/drizzle/meta/_journal.json)
- **Nature of Defect:** At line 405, following the valid closing bracket `]` of the entries array and closing brace `}` of the journal JSON object, uncommitted manual edits appended raw JSON fragments:
  ```json
      {
        "idx": 56,
        "version": "7",
        "when": 1792250000000,
        "tag": "0071_blackout_periods",
        "breakpoints": true
      }
    ]
  }     "idx": 58,
  "version": "7",
  "when": 1792350000000,
  "tag": "0073_take_home_rx_columns",
  "breakpoints": true
  }
  ]
  }
  ```
- **Operational Impact:**
  - `npm run db:lint-migrations` crashes with `SyntaxError: Unexpected non-whitespace character after JSON at line 405 column 7`.
  - `npm test` fails 2 tests: `lib/db/migrations/__tests__/lint.test.ts` and `lib/db/migrations/__tests__/plan.test.ts`.
  - `drizzle-kit generate` and `drizzle-kit migrate` fail to parse migration history.

---

## 2. Dual Migration Tracks & Orphaned SQL Files

A forensic analysis of the SQL files in `drizzle/` reveals that during historical development, the migration sequence split into two conflicting parallel development tracks:

```
┌───────────────────────────────────────────────────────────────────────────┐
│                    HISTORICAL MIGRATION TRACK DIVERGENCE                  │
│                                                                           │
│   Common Ancestor: 0046_stock.sql                                         │
│         │                                                                 │
│         ├──────────────────────────────┬──────────────────────────────┐   │
│         ▼                              ▼                              │   │
│   [TRACK A: IN ACTIVE JOURNAL]   [TRACK B: ORPHANED SQL FILES]        │   │
│   • 0047_ipd_emar_foundation     • 0047_test_follow_up (orphaned)     │   │
│   • 0048_ipd_phase2_tasks_vitals • 0048_treatment_mar (orphaned)      │   │
│   • 0049_ipd_lifecycle_gates     • 0049_due_engine (orphaned)         │   │
│   • 0050_global_medicines        • 0050_mar_stock (orphaned)          │   │
│   • 0054_ipd_admission_consents  • 0051_allergy_medrec (orphaned)     │   │
│   • 0066_claims_tracker          • 0052_doctor_notes (orphaned)       │   │
│   • 0067_claims_corrections      • 0053_discharge_summary (orphaned)  │   │
│   • 0068_whatsapp_notices        (Never recorded in journal; tables   │   │
│   • 0069_emergency_booking        do NOT exist in active database)    │   │
│   • 0070_opd_stop                                                     │   │
│   • 0071_blackout_periods                                             │   │
│                                                                           │
└───────────────────────────────────────────────────────────────────────────┘
```

### 2.1 Track A (The Active, Applied Migration Branch)
Recorded in `_journal.json` and applied to the active database:
- `0047_ipd_emar_foundation.sql` (Creates `ipd_clinical_rounds`, `ipd_medication_orders`, `ipd_medication_administrations`, `ipd_allergy_assessments`, `ipd_order_sets`).
- `0048_ipd_phase2_tasks_vitals.sql` (Creates `ipd_clinical_tasks`, `draft_rounds`, `vitals_readings`, `intake_output`, `patient_measurements`).
- `0049_ipd_lifecycle_and_clinical_gates.sql` (Creates `ipd_admission_home_medications`, `ipd_discharge_summaries`, `ipd_take_home_prescriptions`).
- `0050_global_medicines.sql` (Creates `global_medicines`).
- `0054_ipd_admission_and_consents.sql` (Creates `patient_consents`, `consent_templates`).
- `0066_claims_tracker_and_tpa_desk.sql` (Creates `claim_cases`, `claim_events`, `payer_profiles`).
- `0067_claims_lifecycle_corrections.sql` (Refines claim status enums and validation).
- `0068_whatsapp_notices.sql` (Creates `notice_campaigns`, `notice_campaign_recipients`).
- `0069_emergency_booking.sql`
- `0070_opd_stop.sql`
- `0071_blackout_periods.sql`

### 2.2 Track B (The Orphaned Migration Branch)
Exist as physical SQL files in `drizzle/` but are **omitted from `_journal.json`**:
- `0047_test_follow_up.sql`: Defines `test_orders`, `test_follow_up_calls`.
- `0048_treatment_mar.sql`: Defines `treatment_orders`, `ipd_notes`.
- `0049_due_engine.sql`: Defines `due_snoozes`, `due_escalations`, `on_call_assignments`.
- `0050_mar_stock.sql`: Defines `mar_stock_movements`.
- `0051_allergy_medrec.sql`: Defines `patient_allergies`, `med_rec_items`.
- `0052_doctor_notes.sql`: Defines alternate doctor notes schema.
- `0053_discharge_summary.sql`: Defines alternate discharge summary schema.

**Status in Active Database:** None of the Track B tables exist in the active database catalog. Any runtime query attempting to query `treatment_orders` or `test_orders` will fail.

---

## 3. Schema Drift Analysis: Database vs. Schema vs. Migrations

A comparison between [`lib/db/schema.ts`](file:///d:/Projects/HospitalAutomation/lib/db/schema.ts), the physical migration files, and the active database reveals two distinct schema drift issues:

### Drift 3.1: Untracked Table `ipd_discharge_clearances`
- **In `lib/db/schema.ts`:** Fully defined with fields `id`, `admission_id`, `hospital_id`, `medical_cleared_at`, `pharmacy_cleared_at`, `nursing_cleared_at`, `lab_cleared_at`, `billing_cleared_at`, `gate_pass_issued_at`.
- **In Active Development Database:** Table exists (created manually during recent development sprints).
- **In `drizzle/` Migration Files:** **Missing.** No migration file creates `ipd_discharge_clearances`.
- **Severity:** **P0 Deployment Risk.** A fresh database installation (`npm run db:bootstrap` or CI runner) will succeed on migrations but crash when opening the discharge cockpit because `ipd_discharge_clearances` does not exist.

### Drift 3.2: Tag Duplication in Migration Prefixes
Multiple SQL files share identical numeric prefixes:
- `0015_active_appointment_choice.sql` vs `0015_special_barracuda.sql`
- `0047_ipd_emar_foundation.sql` vs `0047_test_follow_up.sql`
- `0048_ipd_phase2_tasks_vitals.sql` vs `0048_treatment_mar.sql`
- `0049_ipd_lifecycle_and_clinical_gates.sql` vs `0049_due_engine.sql`
- `0050_global_medicines.sql` vs `0050_mar_stock.sql`
- **In `drizzle/pending/`:** `0040_patient_identity_enforce.sql` resides unapplied in a `pending/` subfolder.

---

## 4. Migration Validation Test Results

### 4.1 Fresh Database Installation Test
- **Status:** **BLOCKED.**
- **Reason:** Running Drizzle migration runners against a clean database fails immediately at the journal parsing stage due to the line 405 syntax corruption in `_journal.json`.

### 4.2 Database Upgrade Test (Existing Application Data)
- **Status:** **FRAGILE.**
- **Reason:** Existing development databases function only because tables like `ipd_discharge_clearances` were injected out-of-band. Running an automated schema migration runner will attempt to re-apply or skip mismatched entries.

---

## 5. Non-Destructive Reconciliation Strategy

Per Section 3.3 of the Master Plan: *"Never casually edit an already-applied migration to make the migration history appear correct. Create a safe reconciliation strategy, use forward migrations where appropriate, and preserve existing data."*

### Step-by-Step Remediation Plan (Phase 1 Execution)

1. **Clean `_journal.json` Syntax (Non-Destructive Fix):**
   - Truncate the corrupt trailing text after line 405. Ensure the file closes cleanly with valid JSON array and object brackets after tag `0071_blackout_periods`.
   - **Verification:** `npm run db:lint-migrations` will immediately execute without JSON parse errors.

2. **Archive Orphaned Track B Files to `drizzle/orphaned/`:**
   - Move `0047_test_follow_up.sql`, `0048_treatment_mar.sql`, `0049_due_engine.sql`, `0050_mar_stock.sql`, `0051_allergy_medrec.sql`, `0052_doctor_notes.sql`, and `0053_discharge_summary.sql` into an archived directory `drizzle/archive/track-b/`.
   - This eliminates migration prefix collisions without deleting code history.

3. **Generate Forward Migration for `ipd_discharge_clearances`:**
   - Create a clean forward migration: `0072_ipd_discharge_clearances.sql`.
   - Include idempotent `CREATE TABLE IF NOT EXISTS ipd_discharge_clearances (...)` guards.
   - Register `0072_ipd_discharge_clearances` as `idx: 57` in `_journal.json`.

4. **Verify Fresh Database Setup in Isolated Container:**
   - Execute a fresh test database creation using `scripts/migrate-v2.ts`.
   - Verify that 100% of tables defined in `lib/db/schema.ts` exist and match the migration output.

5. **Re-run Vitest Migration Suites:**
   - Confirm that `lib/db/migrations/__tests__/lint.test.ts` and `plan.test.ts` pass cleanly with 0 errors.

---

## 6. Execution & Reconciliation Verification (November 2026)

The reconciliation strategy above was successfully executed and verified:
- **`_journal.json`:** Reconciled cleanly with valid entries for `0072_ipd_discharge_clearances` (idx: 57) and `0073_take_home_rx_columns` (idx: 58).
- **Track B Files:** Safely moved to [`drizzle/archive/track-b/`](file:///d:/Projects/HospitalAutomation/drizzle/archive/track-b/).
- **Migrations 0072 & 0073:** Generated with idempotent SQL and RLS policies.
- **Migration Checksum Sync:** Checksums in PostgreSQL `drizzle.__drizzle_migrations` reconciled with zero plan warnings.
- **Linter Results:** `npm run db:lint-migrations` -> 59 migrations checked, 0 errors.
- **Plan Results:** `npm run db:migrate:plan` -> 59 applied, 0 pending, 0 warnings.
- **Test Results:** `npm test` -> 78 test files, 956 tests passed (100%).
- **Full Report:** See [`docs/modules/01-technical-reliability/COMPLETION_REPORT.md`](file:///d:/Projects/HospitalAutomation/docs/modules/01-technical-reliability/COMPLETION_REPORT.md).
