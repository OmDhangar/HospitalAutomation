# Qurio HMS — Repository & Application Inventory

**Document Title:** Comprehensive Repository, Routing, Architecture & Functional Inventory  
**Audit Path:** `docs/audit/REPOSITORY_INVENTORY.md`  
**Audit Date:** November 2026  
**Status:** Read-Only Baseline Architectural Audit  
**System Identity:** Qurio HMS (Internal repository: `opd-queue` / `QueueCare`)  

---

## 1. Architectural Overview & Technology Stack

Qurio is architected as a high-performance, tablet-friendly, multi-tenant healthcare operating system built with the Next.js App Router and PostgreSQL.

- **Frontend Tier:** Next.js 16.3.8 (React 19.2.8), Tailwind CSS v4, Lucide React icons.
- **Backend / API Tier:** Next.js App Router Server Actions and Edge/Node Route Handlers (`app/api/`).
- **Database / ORM Tier:** PostgreSQL 16+ via `postgres.js` (v3.4.9) and Drizzle ORM (v0.45.2) with Drizzle-Kit (v0.31.10).
- **Security & Cryptography:** Row-Level Security (RLS) with transaction-scoped `app.hospital_id`, Web Crypto API for SHA-256 HMAC chained event ledgers (`acct_events`), and PBKDF2/bcrypt credential hashing.
- **External Integrations:** Native Meta WhatsApp Cloud API (Graph API v21.0), Razorpay payment webhooks, and QR code generation.
- **Testing & Quality:** Vitest 5.0.0 (956 test cases across domain logic, migrations, security, and payments).

---

## 2. Comprehensive Route & Page Directory

### 2.1 Authenticated Hospital Workspace (`app/(app)/`)
Routes protected by session authentication and tenant membership:

| Route Path | Module / Purpose | Primary Role Access | Implementation Status |
|---|---|---|---|
| `app/(app)/dashboard/page.tsx` | Main OPD Consultation, Active Queue & Chamber View | `doctor`, `receptionist`, `owner` | **Functional** (autosaves consultation drafts every 1.5s) |
| `app/(app)/dashboard/consultation-panel.tsx` | OPD Doctor Workspace (vitals, diagnosis, Rx, advice) | `doctor`, `owner` | **Functional** (single generic card for all specialties) |
| `app/(app)/ipd/page.tsx` | Inpatient Ward Bed Grid & Real-time Census Board | `nurse`, `receptionist`, `doctor`, `owner` | **Functional** (visual occupancy, bed status filters) |
| `app/(app)/ipd/admissions/page.tsx` | Active & Past Inpatient Admissions List | `receptionist`, `owner`, `nurse` | **Functional** (search by IPD ID, patient, ward) |
| `app/(app)/ipd/admissions/[id]/page.tsx` | Inpatient File Overview & Admission Face-Sheet | `doctor`, `nurse`, `receptionist`, `owner` | **Functional** (diagnoses, assigned bed, admitting doctor) |
| `app/(app)/ipd/admissions/[id]/(file)/medicines/page.tsx`| Inpatient Treatment Sheet & Medication Orders | `doctor`, `nurse`, `owner` | **Functional** (order authoring & eMAR linking) |
| `app/(app)/ipd/patients/[id]/discharge/page.tsx` | 5-Department Discharge Clearance Cockpit | `doctor`, `nurse`, `receptionist`, `owner` | **Functional** (Medical, Pharmacy, Nursing, Lab, Billing) |
| `app/(app)/ipd/lookup/page.tsx` | Inpatient Bed Lookup & Ward Device Scanner | `nurse`, `receptionist` | **Functional** (bed QR lookup for ward tablets) |
| `app/(app)/ipd/new/page.tsx` | Direct / Emergency Inpatient Admission Desk | `receptionist`, `owner` | **Functional** (bed selection, deposit, rate plan) |
| `app/(app)/ipd/claims/page.tsx` | Cashless Insurance & TPA Claims Desk | `receptionist`, `owner` | **Partially Implemented** (pre-auth tracking, query logs) |
| `app/(app)/ipd/deposits/page.tsx` | IPD Patient Advance Deposits & Receipts | `receptionist`, `owner` | **Functional** (receipts, refund logging, ledger linkage) |
| `app/(app)/reports/page.tsx` | Operational Volume, Queue & Gross Revenue Reports | `owner`, `receptionist` | **Basic** (daily consultation counts, revenue summaries) |
| `app/(app)/settings/page.tsx` | Hospital Configuration, Doctors, Branches & Staff | `owner` | **Functional** (shifts, consultation fees, staff roles) |
| `app/(app)/accountability/record/[type]/[id]/page.tsx` | Tamper-Evident SHA-256 HMAC Event Audit Ledger | `owner` | **Functional** (displays chained cryptographic proofs) |
| `app/(app)/whatsapp-notices/page.tsx` | Mass WhatsApp Broadcast Notice Campaigns | `owner` | **Functional** (emergency notices, campaign dispatch) |
| `app/(app)/subscription/page.tsx` | Hospital SaaS Plan, Quotas & Renewal | `owner`, `doctor` | **Functional** (Razorpay subscription integration) |

### 2.2 Public & Patient-Facing Surfaces
Routes accessible without staff login:

| Route Path | Purpose & Target User | Key Components & Files | Status |
|---|---|---|---|
| `app/q/[token]/page.tsx` | Live Mobile Corridor Queue Tracker | `app/q/[token]/page.tsx`, `lib/services/queue.ts` | **Industry-Leading** (Real-time SSE wait-time stream) |
| `app/book/page.tsx` | Public Online Appointment Booking | `lib/services/web-booking.ts` | **Functional** (select doctor, shift, token generation) |
| `app/display/[branchId]/page.tsx` | Waiting Room Corridor TV Token Display | `app/api/display/[branchId]/events/route.ts` | **Functional** (SSE real-time token calling screen) |
| `app/ward-device/page.tsx` | Bedside Nursing Tablet Pairing Console | `lib/services/staff-access.ts` | **Functional** (PIN-based tablet staff authentication) |
| `app/b/[token]/page.tsx` | Public Booking Confirmation Card | `lib/services/booking.ts` | **Functional** (view token, status, directions) |

### 2.3 Official Print Layouts (`app/print/`)
Standardized documents optimized for physical printing:

| Route Path | Document Type | Dimensions / Layout | Key Files |
|---|---|---|---|
| `app/print/prescription/[id]/page.tsx` | Outpatient Clinical Prescription | A4 Letterhead / Thermal | `PrescriptionPrintView` (English-only directions) |
| `app/print/ipd-admission/[admissionId]/page.tsx` | Inpatient Admission Face-Sheet & Consent | A4 Institutional Document | `AdmissionPrintView` (demographics, bed, payer) |
| `app/print/ipd-bill/[billId]/page.tsx` | Final Inpatient Itemized Bill & Tax Invoice | A4 Itemized Summary | `IpdBillPrintView` (daily room rent, care entries) |
| `app/print/receipt/[paymentId]/page.tsx` | Financial Payment Receipt | Thermal / A4 Receipt | `PaymentReceiptPrintView` (deposits, OPD fees) |
| `app/print/round-list/page.tsx` | Doctor Morning Clinical Rounding Worklist | A4 Daily Census Sheet | `RoundListPrintView` (ward, bed, diagnosis, notes) |
| `app/print/bed-codes/page.tsx` | Bed QR Codes for Bedside Nursing Tablets | Thermal Barcode / Sticker | `BedCodesPrintView` (bed QR tokens for scanning) |

### 2.4 API Endpoints & Webhooks (`app/api/`)

| Endpoint Path | Method | Purpose & Consumers | Authentication / Security |
|---|---|---|---|
| `/api/webhooks/whatsapp` | `POST`, `GET` | Meta WhatsApp Cloud API Inbound Webhook | SHA-256 HMAC signature verification (`X-Hub-Signature-256`) |
| `/api/payments/razorpay/webhook` | `POST` | Razorpay Subscription Payment Webhook | Webhook signature validation via Razorpay secret |
| `/api/display/[branchId]/events` | `GET` | Corridor Waiting Room TV SSE Stream | Public branch-scoped Server-Sent Events stream |
| `/api/internal/tick` | `POST` | Background Outbox & Job Execution Cron | Shared bearer secret (`CRON_SECRET`) |
| `/api/ipd/care-entries` | `POST`, `DELETE` | Record Bedside Treatment / Nursing Entry | Staff session + `withTenant` RLS enforcement |
| `/api/ipd/care-entries/undo` | `POST` | 2-Minute Nurse Mistake Undo Window | Staff session + 120-second timestamp guard |
| `/api/ipd/tpr` | `POST` | Record Bedside Nursing Vitals (NEWS2) | Staff session + `vitalsReadings` persistence |
| `/api/medicines/search` | `GET` | Doctor Prescription Autocomplete | Staff session + tenant medicine catalogue |
| `/api/hospitals/[hospitalId]/patients/search`| `GET` | Reception Fuzzy Patient Lookup | Staff session + phone/name search |

---

## 3. Major Module & Submodule Architecture

```
┌───────────────────────────────────────────────────────────────────────────┐
│                      QURIO HMS FUNCTIONAL TOPOLOGY                        │
│                                                                           │
│  [Reception / Front Desk] ────► [Queue Engine & WhatsApp Bot]             │
│           │                                   │                           │
│           ▼                                   ▼                           │
│  [OPD Consultation EMR] ──────► [Live Waiting Tracker (/q/[token])]       │
│           │                                                               │
│           ▼ (shiftToIpdAction)                                            │
│  [IPD Admission & Bed Board] ──► [Bedside Nursing eMAR & NEWS2 Vitals]   │
│           │                                   │                           │
│           ▼                                   ▼                           │
│  [Discharge Clearance Cockpit] ◄── [Interim Inpatient Billing Ledger]     │
│           │                                                               │
│           ▼                                                               │
│  [Cryptographic Gate Pass] ──► [SHA-256 HMAC Chained Event Ledger]       │
└───────────────────────────────────────────────────────────────────────────┘
```

### 3.1 Patient Registration & Queue Engine
- **Files:** [`lib/services/queue.ts`](file:///d:/Projects/HospitalAutomation/lib/services/queue.ts), [`lib/domain/queue.ts`](file:///d:/Projects/HospitalAutomation/lib/domain/queue.ts), [`lib/services/patient-identity.ts`](file:///d:/Projects/HospitalAutomation/lib/services/patient-identity.ts).
- **Capabilities:** Fast 5-second walk-in token allocation, row-level locks on doctor chambers (`SELECT ... FOR UPDATE`), doctor pause/resume, quota capacity tracking, and SSE broadcasting.
- **Limitation:** Captures only patient name and phone number; lacks national ABHA integration, address, and insurance sponsor fields upfront.

### 3.2 Doctor Consultation & Outpatient EMR
- **Files:** [`app/(app)/dashboard/consultation-panel.tsx`](file:///d:/Projects/HospitalAutomation/app/(app)/dashboard/consultation-panel.tsx), [`lib/services/consultations.ts`](file:///d:/Projects/HospitalAutomation/lib/services/consultations.ts).
- **Capabilities:** 1.5s draft autosaving, ICD-10 provisional diagnosis, medicine autocomplete with frequency presets, investigation orders, and digital prescription generation.
- **Limitation:** Single generic medical card for all specialties; lacks pre-bundled Rx-Groups; line-by-line prescribing only.

### 3.3 Inpatient Department (IPD) & Bed Management
- **Files:** [`app/(app)/ipd/page.tsx`](file:///d:/Projects/HospitalAutomation/app/(app)/ipd/page.tsx), [`components/ipd/bed-grid.tsx`](file:///d:/Projects/HospitalAutomation/components/ipd/bed-grid.tsx), [`lib/services/ipd-census.ts`](file:///d:/Projects/HospitalAutomation/lib/services/ipd-census.ts), [`lib/services/ipd-admissions.ts`](file:///d:/Projects/HospitalAutomation/lib/services/ipd-admissions.ts).
- **Capabilities:** Real-time visual bed board, bed status tracking (Occupied, Vacant, Cleaning), atomic bed transfers, admission deposits, and clinical face-sheets.
- **Limitation:** OPD-to-IPD shift drops active prescription continuity; no automated mid-day room tariff prorating during transfers.

### 3.4 Bedside Nursing & eMAR Treatment Chart
- **Files:** [`components/ipd/bedside/bedside-treatment-chart.tsx`](file:///d:/Projects/HospitalAutomation/components/ipd/bedside/bedside-treatment-chart.tsx), [`lib/domain/vitals-news2.ts`](file:///d:/Projects/HospitalAutomation/lib/domain/vitals-news2.ts), [`lib/services/tpr.ts`](file:///d:/Projects/HospitalAutomation/lib/services/tpr.ts).
- **Capabilities:** High-contrast 48px touch targets for Android tablets, medication administration logging, automated **NEWS2 clinical deterioration scoring**, and 2-minute nurse undo window.
- **Limitation:** Fluid balance (Intake/Output) charting is basic; eMAR administration does not connect to automated pharmacy inventory deduction.

### 3.5 5-Department Discharge Clearance Cockpit
- **Files:** [`app/(app)/ipd/patients/[id]/discharge/page.tsx`](file:///d:/Projects/HospitalAutomation/app/(app)/ipd/patients/[id]/discharge/page.tsx), [`lib/services/ipd-clearance.ts`](file:///d:/Projects/HospitalAutomation/lib/services/ipd-clearance.ts), [`lib/domain/discharge-clearance.ts`](file:///d:/Projects/HospitalAutomation/lib/domain/discharge-clearance.ts).
- **Capabilities:** Mandatory 5-department clearance matrix (Medical, Pharmacy returns, Nursing, Lab, Billing) enforcing atomic sign-offs before generating a cryptographically verified Gate Pass.
- **Limitation:** Operational friction if responsible doctors or pharmacists are away from terminals; requires manual sign-offs.

### 3.6 Cryptographic Audit Ledger (`acct_events`)
- **Files:** [`lib/services/evidence.ts`](file:///d:/Projects/HospitalAutomation/lib/services/evidence.ts), [`lib/db/schema.ts:acctEvents`](file:///d:/Projects/HospitalAutomation/lib/db/schema.ts).
- **Capabilities:** SHA-256 HMAC forward-chained event ledger storing previous hash digests, with hourly private-key signed root digests for tamper detection.
- **Limitation:** Advanced backend capability that lacks a simple, intuitive visual verification interface for hospital legal administrators.

### 3.7 Inpatient Billing & Deposits
- **Files:** [`lib/services/ipd-billing.ts`](file:///d:/Projects/HospitalAutomation/lib/services/ipd-billing.ts), [`lib/services/ipd-config.ts`](file:///d:/Projects/HospitalAutomation/lib/services/ipd-config.ts).
- **Capabilities:** Real-time interim bill compilation, daily midnight room rent accrual, bedside care entry pricing, advance deposit tracking, and receipt printing.
- **Limitation:** Flat single-price model per charge item; cannot bill different tariffs for Cash vs Star Health TPA vs Corporate Panels.

### 3.8 Missing Modules (Zero Implementation in Codebase)
- **Outpatient Retail Pharmacy POS:** Zero dispensing queue, retail billing, or batch-level stock registers.
- **Laboratory Result Entry (LIS):** Zero numeric analyte entry screens, reference range checking, or official pathology report generation.
- **ABDM / ABHA Interoperability:** Zero ABHA creation, Scan & Share QR check-in, HIP care-context linking, or FHIR R4 exports.
- **Consultant Doctor Payouts:** Zero commission calculation or procedure split rules engine.

---

## 4. Authentication, Authorization & Tenant Isolation

### 4.1 Authentication Stack
- Handled via HTTP-only, secure session cookies containing a signed session token.
- User passwords hashed using PBKDF2/bcrypt.
- Bedside nursing tablets authenticate via a shared ward device paired with individual nurse 4-digit PINs (`lib/services/staff-access.ts`).

### 4.2 Role-Based Permissions Model
Defined centrally in [`lib/domain/permissions.ts`](file:///d:/Projects/HospitalAutomation/lib/domain/permissions.ts):
- Only **four roles** currently exist in the DB enum and application:
  `export const STAFF_ROLES = ['owner', 'receptionist', 'doctor', 'nurse'] as const;`
- Every permission is an explicit allow-list (e.g., `'queue.mutate': ['owner', 'receptionist', 'doctor']`, `'billing.collect': ['owner', 'receptionist']`, `'clinical.write': ['owner', 'doctor']`).

### 4.3 Tenant Isolation (`withTenant`)
Implemented in [`lib/db/index.ts:withTenant`](file:///d:/Projects/HospitalAutomation/lib/db/index.ts):
- Scopes all queries inside a transaction executing:
  `SELECT set_config('app.hospital_id', $1, true);`
- PostgreSQL Row-Level Security (RLS) policies filter every table by `hospital_id = current_setting('app.hospital_id')`.
- Connecting with a superuser that bypasses RLS is detected and blocked in production (`assertRestrictedRole`).

---

## 5. Background Jobs, Cron & Outbox Automation

1. **Notification Outbox Worker:**
   - Table: `notification_outbox` in [`lib/db/schema.ts`](file:///d:/Projects/HospitalAutomation/lib/db/schema.ts).
   - Script: `scripts/worker-daemon.ts` and `app/api/internal/tick/route.ts`.
   - Polls unconsumed outbox messages and dispatches WhatsApp messages via Meta Graph API with exponential backoff and idempotency keys.
2. **IPD Midnight Bed-Day Accrual Cron:**
   - Script: `lib/services/bed-days.ts:accrueMidnightBedDays`.
   - Runs nightly to calculate room rent charges for occupied beds across all active hospital tenants.
3. **Hourly Cryptographic Evidence Sealer:**
   - Script: `lib/services/evidence.ts:sealHourlyDigest`.
   - Chains pending `acct_events` and signs root hashes with the tenant's private HMAC secret.
