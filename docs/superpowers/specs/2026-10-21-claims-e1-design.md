# Design Spec: Phase E1 — Claims Tracker & TPA Desk

**Date:** 2026-10-21  
**Status:** In Review (Phase E1 Architectural Specification)  
**Target Modules:** Claims Desk (`/ipd/claims`, `/ipd/claims/[id]`), IPD Intake & Admission (`/ipd/new`, `/ipd/admissions/[id]`), Module Registry (`lib/modules/registry.ts`), Sweeps Engine (`lib/services/sweeps.ts`), Security Subsystem (`lib/security/`)  
**Compliance & Standards:** IRDAI Health Insurance Guidelines, NABH Accreditation Standards, DPDP Act 2023 (Encrypted PII at rest), PM-JAY / State Scheme Operational Guidelines  

---

## 1. Executive Summary & Clinical/Administrative Flow

Inpatient admissions involving insurance, TPAs, or government schemes represent 10–30%+ of hospital revenue but are fraught with operational friction: missing pre-auths, untracked TPA query deadlines, uncollected co-pays, and chaotic physical paper files.

Phase E1 establishes the foundational tracking infrastructure for commercial and scheme claims, eliminating separate Excel sheets and sticky notes with a first-class **Claims Tracker & TPA Desk**:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       CLAIMS LIFECYCLE (PHASE E1 TRACKER)                   │
│                                                                             │
│  [ IPD ADMISSION ] ──────────────► [ AUTOMATIC CASE CREATION ]              │
│  Desk selects Payer (Insurer/TPA)   Triggered by setPayerInTx()             │
│  Captures Policy No & Pre-Auth      Status: DRAFT / PREAUTH_SUBMITTED       │
│                                                   │                         │
│                                                   ▼                         │
│  [ TPA DESK WORKFLOW: /ipd/claims ] ◄───── [ PIPELINE VIEW ]                │
│  Kanban & Filtered Tabular View     - Filter by Payer, Urgency, SLA         │
│  SLA Countdown Timers (6h preauth)  - Tracks Pre-Auth vs Final Status       │
│                                                   │                         │
│                     ┌─────────────────────────────┴──────────────────┐      │
│                     ▼                                                ▼      │
│  [ QUERIES & DEFICIENCIES ]                        [ PREAUTH APPROVAL ]     │
│  - Query received with SLA clock                   - Approved Amount Paise  │
│  - Structured query category & notes               - Pre-auth letter doc    │
│  - Reply draft & dispatch timestamp                - Discharge Gate sync    │
│                     │                                                │      │
│                     └─────────────────────────────┬──────────────────┘      │
│                                                   ▼                         │
│  [ DISCHARGE & FINAL CLAIM ] ◄────────────────────┘                         │
│  - Bill settlement & Payer Split reconciliation                             │
│  - Final Packet dispatch timestamp & AWB/Portal ref                         │
│  - Settlement / Shortfall / Rejection logging & Appeal clock                │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Core Architectural Pillars

### 2.1 Pillar 1: Global Payer Master vs Hospital-Scoped Claims
- **Global Payer Master (`payer_profiles`):**
  - Insurers (e.g., Star Health, Care Health, HDFC ERGO) and TPAs (e.g., Medi Assist, Vidal, Paramount) operate under standard IRDAI codes, portal URLs, and standard pre-auth formats.
  - A single platform-level table `payer_profiles` (`hospital_id IS NULL` or shared platform catalogue) maintains standardized insurer/TPA profiles, portal endpoints, toll-free desks, and default SLA windows.
  - Individual hospitals can link claims to global payer records, eliminating typos ("Star Health", "Star Health Ins", "StarHealth Ltd").
- **Tenant-Isolated Claims (`claim_cases`):**
  - Every claim belongs strictly to a single hospital (`hospital_id`) protected by PostgreSQL Row-Level Security (`withTenant`).
  - Linked 1-to-1 with an inpatient admission / encounter.

### 2.2 Pillar 2: Automatic Lifecycle Hooking from Admission
- When the receptionist records an admission with payer kind `insurer`, `tpa`, or `corporate` (via `lib/services/encounter-payers.ts`), a `claim_cases` record is automatically initialized in transaction (`setPayerInTx`).
- If an admission transitions from `self` to `insurer` mid-stay, a claim case is spawned dynamically.
- Zero extra clicks required at initial intake; the desk simply fills the payer section.

### 2.3 Pillar 3: Zero-Compromise Security & Encryption for Health Insurance PII
- Following DPDP Act 2023 and hospital security standards, policy numbers, member IDs, and insurance card identifiers are sensitive financial health identifiers.
- **AES-256-GCM Field Encryption:**
  - Encrypted at rest using the pattern established in `lib/security/credentials.ts`.
  - Storage columns: `policy_number_ciphertext`, `policy_number_iv`, `policy_number_tag`, and `key_version`.
  - Fast search & UI display column: `policy_number_masked` (e.g., `XXXX-XXXX-4921`), storing only the last 4 alphanumeric characters.
  - Plaintext policy numbers never leave the server or enter audit logs.

### 2.4 Pillar 4: Query Tracking & SLA Escalation Worker
- TPA queries often carry tight turnaround windows (e.g., 2 to 4 hours during active admission; 24 to 48 hours post-discharge). Missed deadlines result in automatic pre-auth denial.
- `claim_queries` tracks incoming queries, category (medical justification, bill discrepancy, identity proof, pre-existing disease), SLA deadline, and response timestamps.
- **Worker Sweep:**
  - Reuses the existing `lib/services/sweeps.ts` heartbeat engine.
  - Every 5 minutes, checks for claims with expiring query deadlines or overdue initial pre-authorizations.
  - Fires generic `clinical_alerts` notifications to the desk and administrator.

---

## 3. Database Schema Design (Migration `0055_claims_tracker_and_tpa_desk.sql`)

### 3.1 Global Payer Master (`payer_profiles`)
```ts
export const payerCategoryEnum = pgEnum('payer_category', [
  'tpa',
  'private_insurer',
  'public_insurer',
  'govt_scheme',
  'corporate'
]);

export const payerProfiles = pgTable(
  'payer_profiles',
  {
    id: id(),
    name: text('name').notNull(),
    code: text('code').notNull().unique(), // IRDAI registration code or slug
    category: payerCategoryEnum('category').notNull().default('private_insurer'),
    portalUrl: text('portal_url'),
    supportEmail: text('support_email'),
    supportPhone: text('support_phone'),
    tollFreeNumber: text('toll_free_number'),
    preauthSlaHours: smallint('preauth_sla_hours').notNull().default(6),
    querySlaHours: smallint('query_sla_hours').notNull().default(4),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  }
);
```

### 3.2 Claim Cases (`claim_cases`)
```ts
export const claimStatusEnum = pgEnum('claim_status', [
  'draft',
  'preauth_submitted',
  'query_raised',
  'preauth_approved',
  'preauth_rejected',
  'enhancement_requested',
  'final_submitted',
  'settled',
  'partially_settled',
  'claim_rejected',
  'closed_cancelled'
]);

export const claimTypeEnum = pgEnum('claim_type', [
  'cashless',
  'reimbursement'
]);

export const claimCases = pgTable(
  'claim_cases',
  {
    id: id(),
    hospitalId: uuid('hospital_id')
      .notNull()
      .references(() => hospitals.id, { onDelete: 'cascade' }),
    encounterId: uuid('encounter_id').notNull(),
    admissionId: uuid('admission_id').notNull(),
    patientId: uuid('patient_id').notNull(),
    
    payerProfileId: uuid('payer_profile_id')
      .references(() => payerProfiles.id, { onDelete: 'set null' }),
    payerName: text('payer_name').notNull(), // Fallback / display name
    payerKind: text('payer_kind').$type<'insurer' | 'tpa' | 'corporate'>().notNull(),
    claimType: claimTypeEnum('claim_type').notNull().default('cashless'),
    
    // Encrypted Policy / Member Identifiers
    policyNumberCiphertext: text('policy_number_ciphertext'),
    policyNumberIv: text('policy_number_iv'),
    policyNumberTag: text('policy_number_tag'),
    policyNumberKeyVersion: smallint('policy_number_key_version'),
    policyNumberMasked: text('policy_number_masked'), // e.g. "XXXX-XXXX-1234"
    
    memberId: text('member_id'),
    tpaClaimNumber: text('tpa_claim_number'),
    
    // Status & Financials
    status: claimStatusEnum('status').notNull().default('draft'),
    preauthAmountPaise: bigint('preauth_amount_paise', { mode: 'number' }).default(0),
    approvedAmountPaise: bigint('approved_amount_paise', { mode: 'number' }).default(0),
    claimedAmountPaise: bigint('claimed_amount_paise', { mode: 'number' }).default(0),
    settledAmountPaise: bigint('settled_amount_paise', { mode: 'number' }).default(0),
    coPayPercentage: smallint('co_pay_percentage').default(0),
    deductiblePaise: bigint('deductible_paise', { mode: 'number' }).default(0),

    // Deadlines & SLAs
    preauthSubmittedAt: timestamp('preauth_submitted_at', { withTimezone: true }),
    preauthApprovedAt: timestamp('preauth_approved_at', { withTimezone: true }),
    preauthSlaDeadline: timestamp('preauth_sla_deadline', { withTimezone: true }),
    finalSubmittedAt: timestamp('final_submitted_at', { withTimezone: true }),
    settledAt: timestamp('settled_at', { withTimezone: true }),

    assignedStaffUserId: uuid('assigned_staff_user_id')
      .references(() => users.id, { onDelete: 'set null' }),
    notes: text('notes'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    ...voidColumns(),
  },
  (t) => [
    index('claim_cases_hospital_status_idx').on(t.hospitalId, t.status),
    index('claim_cases_admission_idx').on(t.hospitalId, t.admissionId),
    index('claim_cases_patient_idx').on(t.hospitalId, t.patientId),
  ]
);
```

### 3.3 Claim Events Timeline (`claim_events`)
```ts
export const claimEvents = pgTable(
  'claim_events',
  {
    id: id(),
    hospitalId: uuid('hospital_id')
      .notNull()
      .references(() => hospitals.id, { onDelete: 'cascade' }),
    claimCaseId: uuid('claim_case_id')
      .notNull()
      .references(() => claimCases.id, { onDelete: 'cascade' }),
    eventType: text('event_type').notNull(), 
    // 'created' | 'preauth_sent' | 'preauth_approved' | 'query_received' | 'query_replied' | 'enhancement_sent' | 'final_bill_sent' | 'settled' | 'rejected' | 'appeal_filed'
    previousStatus: claimStatusEnum('previous_status'),
    newStatus: claimStatusEnum('new_status'),
    amountPaise: bigint('amount_paise', { mode: 'number' }),
    notes: text('notes'),
    metadata: jsonb('metadata').default({}),
    actorUserId: uuid('actor_user_id')
      .references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('claim_events_case_idx').on(t.hospitalId, t.claimCaseId, t.createdAt),
  ]
);
```

### 3.4 Claim Documents & Uploads (`claim_documents`)
```ts
export const claimDocTypeEnum = pgEnum('claim_doc_type', [
  'insurance_card',
  'govt_id',
  'preauth_form',
  'preauth_approval_letter',
  'investigation_report',
  'doctor_first_consultation',
  'indoor_case_sheet',
  'discharge_summary',
  'final_itemized_bill',
  'query_response_doc',
  'settlement_voucher',
  'rejection_letter',
  'other'
]);

export const claimDocuments = pgTable(
  'claim_documents',
  {
    id: id(),
    hospitalId: uuid('hospital_id')
      .notNull()
      .references(() => hospitals.id, { onDelete: 'cascade' }),
    claimCaseId: uuid('claim_case_id')
      .notNull()
      .references(() => claimCases.id, { onDelete: 'cascade' }),
    docType: claimDocTypeEnum('doc_type').notNull(),
    fileName: text('file_name').notNull(),
    fileSizeBytes: integer('file_size_bytes').notNull(),
    mimeType: text('mime_type').notNull(),
    storagePath: text('storage_path').notNull(), // S3/Object storage key or local uploads path
    sha256Hash: text('sha256_hash').notNull(),   // Tamper-evident checksum
    notes: text('notes'),
    uploadedByUserId: uuid('uploaded_by_user_id')
      .references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    ...voidColumns(),
  },
  (t) => [
    index('claim_docs_case_idx').on(t.hospitalId, t.claimCaseId),
  ]
);
```

### 3.5 Claim Queries (`claim_queries`)
```ts
export const claimQueryStatusEnum = pgEnum('claim_query_status', [
  'pending_hospital',
  'replied',
  'accepted_by_tpa',
  'disputed'
]);

export const claimQueries = pgTable(
  'claim_queries',
  {
    id: id(),
    hospitalId: uuid('hospital_id')
      .notNull()
      .references(() => hospitals.id, { onDelete: 'cascade' }),
    claimCaseId: uuid('claim_case_id')
      .notNull()
      .references(() => claimCases.id, { onDelete: 'cascade' }),
    queryCategory: text('query_category').notNull(), // 'medical_necessity' | 'bill_breakup' | 'past_history' | 'pharmacy_bills' | 'identity' | 'other'
    queryDescription: text('query_description').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    deadlineAt: timestamp('deadline_at', { withTimezone: true }).notNull(),
    status: claimQueryStatusEnum('status').notNull().default('pending_hospital'),
    
    responseNotes: text('response_notes'),
    repliedAt: timestamp('replied_at', { withTimezone: true }),
    repliedByUserId: uuid('replied_by_user_id')
      .references(() => users.id, { onDelete: 'set null' }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    ...voidColumns(),
  },
  (t) => [
    index('claim_queries_case_status_idx').on(t.hospitalId, t.claimCaseId, t.status),
    index('claim_queries_deadline_idx').on(t.hospitalId, t.deadlineAt),
  ]
);
```

### 3.6 Claim Rejections & Appeals (`claim_rejections`)
```ts
export const claimRejections = pgTable(
  'claim_rejections',
  {
    id: id(),
    hospitalId: uuid('hospital_id')
      .notNull()
      .references(() => hospitals.id, { onDelete: 'cascade' }),
    claimCaseId: uuid('claim_case_id')
      .notNull()
      .references(() => claimCases.id, { onDelete: 'cascade' }),
    stage: text('stage').$type<'preauth' | 'final_claim'>().notNull(),
    rejectionReasonCategory: text('rejection_reason_category').notNull(),
    // 'ped_clause' (Pre-existing disease) | 'exclusion_clause' | 'late_intimation' | 'not_medically_necessary' | 'investigation_only_no_active_treatment' | 'administrative_deficiency'
    rejectionLetterDocId: uuid('rejection_letter_doc_id')
      .references(() => claimDocuments.id, { onDelete: 'set null' }),
    rejectionRemarks: text('rejection_remarks'),
    rejectedAt: timestamp('rejected_at', { withTimezone: true }).notNull().defaultNow(),

    appealAllowed: boolean('appeal_allowed').notNull().default(true),
    appealDeadlineAt: timestamp('appeal_deadline_at', { withTimezone: true }),
    appealStatus: text('appeal_status').$type<'not_appealed' | 'in_preparation' | 'appeal_filed' | 'appeal_won' | 'appeal_lost'>().default('not_appealed'),
    appealRemarks: text('appeal_remarks'),
    appealFiledAt: timestamp('appeal_filed_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('claim_rejections_case_idx').on(t.hospitalId, t.claimCaseId),
  ]
);
```

---

## 4. Module Registry Integration

In `lib/modules/registry.ts`, add the `claims_tracker` definition:

```ts
{
  id: 'claims_tracker',
  title: 'Claims & TPA Desk',
  description: 'Pre-auth tracking, query deadlines, document checklists, and insurer settlement workflow.',
  tier: 'standard',
  core: false,
  dependsOn: ['core_ipd'],
  uses: ['consents'],
  routes: ['/ipd/claims', '/api/claims'],
  fileTabs: [
    { slug: 'claims', label: 'Insurance & Claims', permission: 'claims.view', order: 7 }
  ],
  printSheets: [
    { id: 'claim_dossier', label: 'Claim Dossier & Checklist', permission: 'claims.packet', order: 10 }
  ],
  hasStages: true, // observe (track only), warn (highlight overdue SLAs), enforce (block discharge without preauth match)
  defaultState: 'on',
}
```

---

## 5. Security & Encryption Specification

### 5.1 Symmetric Encryption for Policy Numbers
In `lib/security/claims-encryption.ts`:
- Reuses Node.js `crypto` with `aes-256-gcm`, 12-byte random IV, and 16-byte authentication tag.
- Reads `CLAIMS_ENCRYPTION_KEY` (with fallback to `WHATSAPP_ENCRYPTION_KEY` if unified key is configured).
- Encrypts policy number when saved:
  - Generates IV.
  - Computes ciphertext and authTag.
  - Derives `policyNumberMasked`: `"XXXX-XXXX-" + rawPolicyNumber.slice(-4)`.
- When displayed in lists or UI cards, only `policyNumberMasked` is delivered to the browser.
- Full decrypted policy number is only made available via explicit permission-gated action (`claims.edit` or when printing official pre-auth forms).

---

## 6. Business Logic & Service Architecture

### 6.1 Automatic Claim Initiation
In `lib/services/encounter-payers.ts`:
- Modify `setPayerInTx` to check `args.payer.kind`:
  - If `args.payer.kind !== 'self'`:
    - Lookup matching global `payerProfiles` by name or code (or default to raw name).
    - Check if active `claimCases` exists for this `admissionId`.
    - If none exists, insert new `claimCases` with status `'draft'` (or `'preauth_submitted'` if pre-auth amount already entered).
    - Insert initial `claimEvents` (`eventType: 'created'`).
    - If policy number is provided, encrypt and store masked version.
    - If pre-auth amount provided, set `preauthAmountPaise` and calculate initial SLA window (e.g. `now() + 6 hours`).

### 6.2 State Transition Machine
Strict state validation preventing invalid hops:
- `draft` ➔ `preauth_submitted`
- `preauth_submitted` ➔ `query_raised` | `preauth_approved` | `preauth_rejected`
- `query_raised` ➔ `preauth_submitted` (replied) | `preauth_rejected`
- `preauth_approved` ➔ `enhancement_requested` | `final_submitted`
- `enhancement_requested` ➔ `preauth_approved` | `query_raised`
- `final_submitted` ➔ `settled` | `partially_settled` | `claim_rejected`
- Any state ➔ `closed_cancelled` (voided/switched to self-pay with audit reason)

Every transition atomically records a row in `claim_events`.

### 6.3 SLA & Query Sweep Hook
In `lib/services/sweeps.ts`:
- Add `sweepClaimSlas(now: Date = new Date())`:
  - **Overdue Queries:** Checks `claimQueries` where `status = 'pending_hospital'` and `deadlineAt < now`.
    - Upserts a `clinical_alerts` warning: *"TPA Query Overdue for Bed [X], [Patient Name] (TPA: [Payer])"*.
  - **Expiring Queries (< 1 hour remaining):**
    - Triggers warning alert to desk.
  - **Overdue Initial Pre-auths:** Checks claims where `status = 'preauth_submitted'` and `preauthSlaDeadline < now`.
    - Highlights SLA breach on desk dashboard.

---

## 7. User Interface Specification

### 7.1 Claims Board (`/ipd/claims`)
Top-level navigation item under IPD:
- **Header KPI Summary Strip:**
  - Active Insured Admissions
  - Pending Pre-Auths (< 6h SLA countdown)
  - Open TPA Queries (Red alert badge if < 2h remaining)
  - Discharge Ready (Awaiting Final Settlement)
  - Total Authorized Amount vs Outstanding Claims
- **Interactive Views:**
  - **Kanban Board:** Columns for *Draft / Intake*, *Pre-Auth Submitted*, *Query Raised*, *Pre-Auth Approved*, *Enhancement / In-Stay*, *Discharge Ready*, *Settled*.
  - **Tabular View:** High-density table with sorting, search by Patient Name, Bed, Policy Number, Payer, and SLA Status.
- **Filter Bar:** Payer dropdown, SLA urgency (All, Warning, Breached), Ward/Bed filter.

### 7.2 Patient Chart Claims Tab (`/ipd/admissions/[id]?tab=claims`)
Dedicated tab within the IPD patient view:
- **Payer Card:** Payer name, TPA desk contact, Masked Policy Number, Pre-Auth Approved Paise.
- **Sub-Tab 1: Timeline & Status:** Visual vertical timeline of all claim events, pre-auth approvals, queries, and enhancement submissions.
- **Sub-Tab 2: Document Checklist:** Required document matrix with upload buttons and upload status (Insurance card, Aadhaar/ID, Admission advice, Reports, Doctor notes, Final bill).
- **Sub-Tab 3: Queries & Deficiencies:** Table of open and historical queries with countdown clocks, response text box, attachment upload, and "Mark Replied to TPA" action.

### 7.3 Bootstrap CSV Import (`/ipd/claims/import`)
For transitioning hospitals currently using Excel:
- Dedicated bulk-import modal supporting CSV upload.
- Required columns: `ipd_number_or_patient_phone`, `payer_name`, `policy_number`, `claim_type`, `preauth_amount`, `current_status`.
- Dry-run validation showing matched patients and any unlinked rows before final insertion.

---

## 8. Role-Based Permissions

In `lib/domain/permissions.ts`:
```ts
/** Claims & TPA Desk (Phase E1) */
'claims.view': ['owner', 'receptionist', 'doctor', 'nurse'],
'claims.edit': ['owner', 'receptionist'],
'claims.packet': ['owner', 'receptionist', 'doctor'],
'claims.admin': ['owner'],
```

- **`claims.view`:** Access claims board and patient claim tab.
- **`claims.edit`:** Move statuses, enter pre-auth amounts, record queries and replies, upload claim documents.
- **`claims.packet`:** Generate claim dossier printouts and export claim data.
- **`claims.admin`:** Configure global payer profiles, manage dispute overrides, bulk CSV import.

---

## 9. Verification & Test Plan

1. **Unit & Domain Tests (`lib/domain/__tests__/claims.test.ts`):**
   - Validates state machine transitions (allowed transitions pass, invalid hops throw typed errors).
   - Validates SLA deadline calculations given payer category defaults.
   - Validates masking and input sanitization.
2. **Security & Encryption Tests (`lib/security/__tests__/claims-encryption.test.ts`):**
   - Verifies AES-256-GCM encryption and decryption round-trip.
   - Verifies tamper detection (corrupted authTag or ciphertext fails decryption cleanly).
   - Verifies masked string generator produces exact 4-character suffix.
3. **Integration Tests (`lib/services/__tests__/claims.integration.test.ts`):**
   - Tests end-to-end admission with insurance payer: verifies automatic `claimCases` and `claimEvents` creation.
   - Tests TPA query creation, SLA countdown calculation, and status updating.
   - Tests multi-tenant isolation: hospital A cannot view or mutate hospital B's claims.
   - Tests `lib/services/sweeps.ts` SLA deadline detection and alert generation.
4. **Zero-Regression Verification:**
   - Existing cash/self-pay admissions in `/ipd/new` and `/ipd/admissions/[id]` behave identically with zero schema overhead.
   - Existing discharge billing (`discharge-billing.ts`) functions seamlessly with `encounterPayers` links.
