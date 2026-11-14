# Qurio HMS — Role & Permission Matrix Audit

**Document Title:** Operational Perspectives, Access Control Evaluation & Role Expansion Strategy  
**Audit Path:** `docs/audit/ROLE_PERMISSION_MATRIX.md`  
**Audit Date:** November 2026  
**Status:** Read-Only Baseline Architectural Audit  

---

## 1. Executive Summary: Current Role Model vs. Hospital Reality

The current access control architecture defined in [`lib/domain/permissions.ts`](file:///d:/Projects/HospitalAutomation/lib/domain/permissions.ts) supports only **four distinct staff roles**:
```typescript
export const STAFF_ROLES = ['owner', 'receptionist', 'doctor', 'nurse'] as const;
```

While sufficient for a small outpatient clinic, a multi-specialty hospital requires role specialization across 10 operational perspectives. Currently, specialized responsibilities (pharmacy dispensing, lab result entry, billing cashiering, IPD bed coordination) are forced into the overloaded `receptionist` or `owner` roles:

```
┌───────────────────────────────────────────────────────────────────────────┐
│                    HOSPITAL OPERATIONAL ROLES vs QURIO                    │
│                                                                           │
│   REQUIRED HOSPITAL ROLES (10)        CURRENT QURIO STATUS                │
│   1. Receptionist              ──►   Mapped to 'receptionist'             │
│   2. Doctor                    ──►   Mapped to 'doctor'                   │
│   3. Nurse                     ──►   Mapped to 'nurse'                    │
│   4. Pharmacist                ──►   MISSING (Overloaded onto 'owner')    │
│   5. Lab Technician            ──►   MISSING (No LIS role in codebase)    │
│   6. Lab Approver              ──►   MISSING (No LIS role in codebase)    │
│   7. Billing Staff             ──►   MISSING (Overloaded on 'receptionist')│
│   8. IPD Staff / Admission     ──►   MISSING (Overloaded on 'receptionist')│
│   9. Hospital Administrator    ──►   Mapped to 'owner'                    │
│   10. System Administrator     ──►   Mapped to 'platform_account' (separate│
└───────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Evaluation Across the 10 Operational Perspectives

### 2.1 Receptionist
- **Core Responsibilities:** Walk-in registration, queue calling, OPD appointments, initial deposit collection.
- **Current Qurio Permissions:** `'queue.mutate'`, `'reports.view'`, `'billing.collect'`, `'clinical.read'`, `'ipd.view'`, `'ipd.admit'`, `'ipd.record'`, `'ipd.correct'`.
- **Audit Assessment:** **Appropriately Configured for OPD, Over-Permissioned for Clinical Care.** Receptionists can read all clinical histories (`'clinical.read'`) and log bedside nursing care (`'ipd.record'`). In a hospital, desk clerks should not record bedside clinical entries.

---

### 2.2 Doctor
- **Core Responsibilities:** Outpatient consultations, specialty examinations, prescription authoring, diagnostic test ordering, IPD clinical rounds, discharge summary sign-off.
- **Current Qurio Permissions:** `'queue.mutate'`, `'opd.reopen'`, `'subscription.notice'`, `'clinical.read'`, `'clinical.write'`, `'medicines.quickAdd'`, `'ipd.view'`, `'ipd.shift'`, `'ipd.dischargeReady'`, `'ipd.orderTests'`.
- **Audit Assessment:** **Exemplary Access Control.** Doctors can write clinical records, but the service verifies that the logged-in user matches `doctors.user_id`. Doctors cannot mark bills as paid (`'billing.collect'`), eliminating end-of-day till reconciliation conflicts.

---

### 2.3 Nurse
- **Core Responsibilities:** Bedside vitals recording (NEWS2), medication administration from eMAR, fluid intake/output tracking, patient care logging, bedside mistake retraction.
- **Current Qurio Permissions:** `'clinical.read'`, `'ipd.view'`, `'ipd.record'`.
- **Audit Assessment:** **Ergonomically Sound.** Nurse tablets operate via shared ward device credentials paired with individual 4-digit nurse PINs (`lib/services/staff-access.ts`). Nurses record bedside care without seeing billing rates or financial balances.

---

### 2.4 Pharmacist
- **Core Responsibilities:** Reviewing doctor e-prescriptions, checking batch stock, dispensing medications, managing returns, generating pharmacy retail GST bills.
- **Current Qurio Status:** **MISSING ROLE.**
- **Current Workaround:** Pharmacist functions do not exist in the UI. If a pharmacist is hired, they must be provisioned as `owner` or `receptionist`, granting them unwarranted access to IPD bed boards and administrative settings.
- **Remediation Priority:** **P0.** Add `'pharmacist'` to `STAFF_ROLES`.

---

### 2.5 Laboratory Technician
- **Core Responsibilities:** Viewing diagnostic test worklists, specimen sample collection, recording numeric analyte values, logging machine equipment IDs.
- **Current Qurio Status:** **MISSING ROLE.**
- **Remediation Priority:** **P1.** Add `'lab_technician'` to `STAFF_ROLES`.

---

### 2.6 Laboratory Approver (Pathologist / Biochemist)
- **Core Responsibilities:** Verifying abnormal analyte results, approving diagnostic reports, applying digital signatures before report release.
- **Current Qurio Status:** **MISSING ROLE.**
- **Remediation Priority:** **P1.** Add `'lab_approver'` to `STAFF_ROLES`.

---

### 2.7 Billing Staff (Cashier / Accounts)
- **Core Responsibilities:** Inpatient interim bill compilation, rate plan adjustments, advance deposit receipts, TPA claim pre-auth coordination, final bill settlement.
- **Current Qurio Status:** **MERGED INTO RECEPTIONIST.**
- **Remediation Priority:** **P2.** Split billing cashiering into a dedicated `'billing'` role to separate front-desk token queuing from financial cash handling.

---

### 2.8 IPD Staff / Admission Coordinator
- **Core Responsibilities:** Bed occupancy tracking, patient ward allocation, bed transfers, admission consent documentation.
- **Current Qurio Status:** **MERGED INTO RECEPTIONIST.**
- **Remediation Priority:** **P2.** Supported under `receptionist` for small hospitals; optional dedicated `'admissions'` role for 100+ bed hospitals.

---

### 2.9 Hospital Administrator (Medical Director / Owner)
- **Core Responsibilities:** Tariff configuration, doctor consultation fee setup, staff provisioning, revenue leakage auditing, MIS reporting.
- **Current Qurio Permissions:** Possesses all 19 system permissions (`'owner'`).
- **Audit Assessment:** **Fully Implemented.** Controls tenant-wide configuration cleanly.

---

### 2.10 System Administrator (Platform Super-Admin)
- **Core Responsibilities:** Tenant provisioning, SaaS subscription overrides, global database migrations, platform audit logs.
- **Current Qurio Implementation:** **Separated via Platform Architecture.** System administrators do not hold `staffMemberships` in individual hospitals. Instead, they authenticate against the separate `platform_accounts` table (`lib/db/schema.ts:platformAccounts`) and operate via the `/admin` console (`app/(app)/admin/`), preventing accidental cross-tenant data pollution.

---

## 3. Comprehensive Permission Matrix (Current State vs. Target State)

| Permission Key | Description | Current Allowed Roles | Target Allowed Roles (Post-Expansion) |
|---|---|---|---|
| `queue.mutate` | Call next token, advance OPD queue, stop OPD | `owner`, `receptionist`, `doctor` | `owner`, `receptionist`, `doctor` |
| `opd.reopen` | Reopen stopped OPD chamber session | `owner`, `doctor` | `owner`, `doctor` |
| `capacity.manage` | Issue emergency extra tokens past quota | `owner` | `owner` |
| `hospital.configure`| Staff, branches, fees, WhatsApp, billing rules | `owner` | `owner` |
| `reports.view` | View operational and financial MIS reports | `owner`, `receptionist` | `owner`, `billing` |
| `billing.collect` | Collect cash/card/UPI at counter, issue receipts | `owner`, `receptionist` | `owner`, `receptionist`, `billing`, `pharmacist` |
| `billing.price` | Configure tariff rate sheets and charge items | `owner` | `owner` |
| `clinical.read` | View patient clinical history, notes, lab reports | `owner`, `receptionist`, `doctor`, `nurse` | `owner`, `doctor`, `nurse`, `lab_approver` |
| `clinical.write` | Author or revise consultations and prescriptions | `owner`, `doctor` | `owner`, `doctor` |
| `medicines.manage` | Add, price, edit pharmacy catalogue & batches | `owner` | `owner`, `pharmacist` |
| `medicines.quickAdd`| Add missing medicine on-the-fly during consultation | `owner`, `doctor` | `owner`, `doctor` |
| `ipd.view` | View ward bed board and patient admission files | `owner`, `receptionist`, `doctor`, `nurse` | `owner`, `receptionist`, `doctor`, `nurse`, `admissions` |
| `ipd.shift` | Recommend inpatient admission from OPD consultation | `owner`, `doctor` | `owner`, `doctor` |
| `ipd.admit` | Assign bed, payer profile, record admission deposit | `owner`, `receptionist` | `owner`, `receptionist`, `admissions` |
| `ipd.record` | Record bedside care entry and vitals | `owner`, `receptionist`, `nurse` | `owner`, `nurse` |
| `ipd.correct` | Void or correct bedside entry after 2-minute window | `owner`, `receptionist` | `owner`, `nurse` (Head Nurse only) |
| `ipd.dischargeReady`| Sign clinical discharge order and home medications | `owner`, `doctor` | `owner`, `doctor` |
| `pharmacy.dispense`| **NEW:** Dispense prescription items & deduct batch stock | *None (Missing)* | `owner`, `pharmacist` |
| `pharmacy.return` | **NEW:** Authorize medicine returns & stock reversal | *None (Missing)* | `owner`, `pharmacist` |
| `lab.record` | **NEW:** Record numeric analyte values on test worklist | *None (Missing)* | `owner`, `lab_technician`, `lab_approver` |
| `lab.approve` | **NEW:** Authorize and publish diagnostic lab report | *None (Missing)* | `owner`, `lab_approver` |

---

## 4. Role Expansion Execution Plan

1. **Phase 1 Preparation:**
   - Update `STAFF_ROLES` in [`lib/domain/permissions.ts`](file:///d:/Projects/HospitalAutomation/lib/domain/permissions.ts) to include `'pharmacist'`, `'lab_technician'`, and `'lab_approver'`.
   - Update the database enum `staff_role` via forward migration `0073_staff_roles_expansion.sql`.
2. **Phase 2 Implementation:**
   - Wire `'pharmacist'` to the `/pharmacy` dispensing workspace.
   - Wire `'lab_technician'` and `'lab_approver'` to the `/laboratory` result entry and approval workflows.
   - Restrict `'ipd.record'` strictly to nurses and doctors, removing receptionists from bedside charting.
