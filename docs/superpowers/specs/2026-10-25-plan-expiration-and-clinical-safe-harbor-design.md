# Plan Expiration & Clinical Safe-Harbor Specification

**Date:** 2026-10-25  
**Topic:** Plan Expiration, Clinical Safe-Harbor Policy, and Tiered Backend Feature Gating  
**Author:** Antigravity (Pair Programming with HospitalAutomation)  
**Status:** Approved for Implementation Planning  

---

## 1. Problem Statement & Core Principles

### 1.1 The Issue
Under the prior implementation, when a hospital's subscription lapsed or was placed in an inactive state, `requireSession()` in `lib/auth/session.ts` executed a blanket redirect to `/plan-inactive`. This completely locked medical personnel out of the hospital application shell, preventing doctors, receptionists, and nurses from accessing the OPD queue, conducting consultations, reviewing patient histories, or documenting IPD care.

In a healthcare environment, blocking clinical access due to an expired subscription or accounting delay is unacceptable. Hospitals are critical infrastructure; abruptly halting patient intake and doctor workflows creates patient safety hazards, disrupts hospital revenue, and drives immediate platform churn.

### 1.2 Core Principles
1. **Patient Safety & Clinical Safe Harbor:** Medical care, queue management, consultations, prescriptions, IPD bed/vitals management, and patient record access must **never** be blocked or interrupted by billing or subscription expiration.
2. **Data Continuity:** Expiry pauses paid growth capabilities; it never takes away a hospital's access to its existing data, medical records, or historical invoices.
3. **Selective Server-Side Gating:** Paid features (e.g., new public online bookings, bulk WhatsApp marketing campaigns, advanced analytics exports, and net-new staff onboarding) are selectively paused at the backend service boundaries and server actions—not just hidden in the UI.
4. **Role-Targeted, Non-Blocking Communication:** Renewal alerts are communicated prominently to hospital decision-makers (Owners/Administrators) without disrupting clinical staff (Doctors, Nurses) during patient care.
5. **Defense in Depth:** Access allowed = Authenticated Session + Role Permission (`can(role, ...)`) + Plan Feature Entitlement (`getFeatureDecision(access, ...)`). A plan never grants permissions a role does not already possess.

---

## 2. Subscription States & Lifecycle Architecture

### 2.1 Authoritative States
We define four authoritative subscription states in `lib/domain/subscription.ts`:

| State | Rule | Clinical Safe Harbor | Paid Features | UI Banner Behavior |
| :--- | :--- | :--- | :--- | :--- |
| **`open`** | Active term: `startsAt <= now < endsAt`. Also applies to scheduled cancellations where `now < endsAt`. | Full Access | Full Access | No banner (unless within 15-day pre-expiry window). |
| **`grace`** | Lapsed term: `endsAt <= now < endsAt + 7 days`. | Full Access | Full Access | Informational reminder with exact grace deadline to Owner & Doctor. |
| **`soft_locked`** | Overdue term: `now >= endsAt + 7 days` (reason: `lapsed`). | Full Access | **Paused** | High-priority non-blocking renewal CTA for Owner; discreet status note for Doctor. |
| **`revoked`** | Explicit administrative suspension/revocation (`status = 'suspended'` or administrative override). | Full Access | **Paused** | Banner directing Owner to contact QuriioHQ support. |

### 2.2 Crucial Lifecycle Distinctions
1. **Normal Cancellation vs Administrative Suspension:**
   - A normal customer cancellation request scheduled for the end of the billing period retains `status = 'cancelled'` with `endsAt > now`. It remains in the **`open`** state until `endsAt` arrives.
   - An immediate administrative suspension or revocation occurs only via explicit administrative action (`status = 'suspended'` or administrative audit action). It transitions immediately to **`revoked`** while preserving the Clinical Safe Harbor.
2. **Unassigned / Onboarding Hospitals:**
   - An onboarding hospital that has not yet been assigned a paid subscription retains full access to the Clinical Safe Harbor so queue and patient intake can function immediately.
   - However, unassigned hospitals are **not** silently granted paid capabilities (e.g. bulk WhatsApp campaigns or advanced exports). They resolve paid features through an explicit onboarding entitlement.
3. **Exact Timing Boundaries:**
   - Grace period begins at `endsAt`.
   - Grace period ends at exactly `endsAt + 7 days` (computed in the hospital's configured timezone).
   - At `endsAt + 7 days`, the hospital transitions to `soft_locked`.

---

## 3. Centralized Feature Policy (`lib/domain/plan-policy.ts`)

### 3.1 Feature Taxonomy
We categorize all application capabilities into an explicit, typed domain policy:

```ts
export type FeatureDecision = 'allow' | 'read_only' | 'blocked';

export type PlanFeature =
  // Safe Harbor (always allowed regardless of plan state)
  | 'clinical.opd'              // Walk-ins, triage, queue tokens, doctor consultations, prescriptions
  | 'clinical.ipd'              // Admissions, bed management, vitals, MAR, nurse bedside records, discharge
  | 'clinical.records'          // Patient lookup, past clinical history, lab test reports
  | 'operations.billing'        // Collecting fees at desk, marking visits paid/unpaid, printing bills/receipts
  | 'account.self'              // Personal profile, PIN setup and self-service credential management
  | 'subscription.view'         // Viewing subscription tier, past invoices, and payment receipts
  | 'reports.history_view'      // Viewing historical trends and past reports in-app
  
  // Paid / Growth Capabilities (governed by plan state)
  | 'public.web_booking'        // External public patient booking portal
  | 'messaging.transactional'   // Critical 1:1 queue call alerts and bedside operational notices
  | 'messaging.reminders'       // Automated scheduled appointment reminders
  | 'messaging.campaigns'       // Broadcast marketing notices and bulk announcements
  | 'reports.export'            // Bulk CSV/Excel downloads and PDF analytics export
  | 'reports.advanced'          // Multi-branch comparative analytics and financial projections
  | 'hospital.manage_staff'     // Onboarding net-new staff members
  | 'subscription.renew';       // Initiating online payment/checkout to renew or extend plan
```

### 3.2 Decision Rules
Safe-harbor features are maintained in an explicit `Set` (avoiding prefix matching):

```ts
const SAFE_HARBOR_FEATURES = new Set<PlanFeature>([
  'clinical.opd',
  'clinical.ipd',
  'clinical.records',
  'operations.billing',
  'account.self',
  'subscription.view',
  'reports.history_view',
]);

export function getFeatureDecision(
  access: PlanAccess,
  feature: PlanFeature,
): FeatureDecision {
  // Safe harbor features are never blocked
  if (SAFE_HARBOR_FEATURES.has(feature)) {
    return 'allow';
  }

  // Self-service renewal is available in open, grace, and soft_locked
  if (feature === 'subscription.renew') {
    return access.state === 'revoked' ? 'blocked' : 'allow';
  }

  // Fully active or in grace period: all paid capabilities allowed
  if (access.state === 'open' || access.state === 'grace') {
    return 'allow';
  }

  // Soft-locked or Revoked: paid growth features are paused
  return 'blocked';
}
```

---

## 4. App Shell & Route Gating Architecture

### 4.1 Decoupling `requireSession()`
* Modify `lib/auth/session.ts`: Remove the blanket `if (!options.allowInactivePlan && (await isPlanLocked(session))) redirect('/plan-inactive')`.
* `requireSession()` continues to enforce:
  - Valid signed-in staff member.
  - Device/screen locks (`session.locked`).
  - Temporary password replacement (`session.mustChangePassword`).
  - Pending legal/compliance notices (`session.noticePending`).
* Clinical routes (`/dashboard`, `/ipd`, `/tests`, `/account`) always render for authenticated staff.
* `/plan-inactive` remains purely as a standalone direct-payment checkout landing page when accessed via external billing links.

### 4.2 Non-Blocking App Shell Banners (`app/(app)/layout.tsx`)
Rendered via a streaming server component in the header:
* **In `grace` (Days 1–7 post-expiry):**
  - **For Owner & Doctor:** Informational banner: *"Your hospital plan ended on [Date]. Full access continues until [Date + 7d]. [Renew Plan]"*.
* **In `soft_locked` (Day 8+ post-expiry):**
  - **For Owner:** Prominent header banner: *"Hospital plan overdue. Clinical care (OPD & IPD) remains active. Public online booking, WhatsApp campaigns, and analytics exports are paused. [Renew Plan]"*.
  - **For Doctor:** A quiet, non-obtrusive status chip in the header/menu (e.g. *"Basic Plan Mode"*), strictly avoiding intrusive modals or payment buttons during clinical consultations.
  - **For Receptionists & Nurses:** No commercial alerts displayed.
* **In `revoked` (Administrative pause):**
  - **For Owner:** Alert banner: *"Hospital plan paused by QuriioHQ. Patient care remains active. Please contact your representative to restore services."*

### 4.3 In-Page Non-Clinical Route Experience
* **Reports (`app/(app)/reports/page.tsx`):**
  - Historical dashboard trends and charts remain visible (`reports.history_view` → `allow`).
  - Bulk CSV/PDF export controls are disabled with an in-page notice: *"Analytics exports are paused while plan is overdue. [Renew to Export]"*.
* **WhatsApp Notices (`app/(app)/whatsapp-notices`):**
  - Past sent notice logs remain readable.
  - Campaign creation (`/whatsapp-notices/new`) renders an entitlement notice explaining that bulk campaigns are paused.
* **Settings & Staff (`app/(app)/settings`):**
  - Existing staff editing, PIN resets, and role assignments remain fully accessible.
  - Net-new staff onboarding displays a soft-lock notice with an owner override for essential clinical practitioners.

---

## 5. Service Boundaries & Backend Enforcement

Every protected operation enforces entitlements server-side at the service boundary:

### 5.1 Public Online Booking (`lib/services/web-booking.ts`)
* Before creating a new booking in `createWebBooking()`:
  - Evaluates `getFeatureDecision(access, 'public.web_booking')`.
  - If `'blocked'`, the request is rejected with a user-friendly response: *"Online booking is currently offline for maintenance. Please visit the registration desk directly or contact the hospital."*
* **Existing Bookings Protected:** All previously booked appointments remain in the queue and schedule. Reception and doctors can check in, move, or consult these patients without hindrance.

### 5.2 Messaging Service Boundaries (`lib/services/whatsapp-notices.ts`)
* `messaging.campaigns`: Creating broadcast notices (`createNoticeBroadcast`) checks `getFeatureDecision`. If blocked, throws a typed error `PLAN_SOFT_LOCKED`.
* `messaging.reminders`: Automated scheduled reminder dispatchers skip hospitals in `soft_locked` or `revoked` state.
* `messaging.transactional`: Essential operational messages (queue-call alerts, token calls) are permitted or fail silently; a message failure **must never roll back** a consultation, prescription, admission, or clinical transaction.

### 5.3 Operational Billing Protected (`operations.billing`)
* Receptionist till operations, taking payments, marking visits paid or unpaid (`components/paid-toggle.tsx`), creating IPD bill entries, and printing A4 case sheets/invoices remain fully operational.

### 5.4 Server Actions & APIs
* Server actions for paid operations (e.g. creating broadcast notices, exporting financial reports) verify `getFeatureDecision` before taking action and return `{ ok: false, error: 'PLAN_SOFT_LOCKED' }`.

---

## 6. Renewal & Administrative Restoration

1. **Authoritative State Updates:**
   - Administrative pause/restore updates the authoritative subscription status (`status = 'suspended'` or restored) and logs the event in `auditLogs`.
2. **Verified Renewal:**
   - Online renewal through Razorpay / payment gateway clears the access cache (`clearPlanAccessCache(hospitalId)`) **only after** the transaction commits in the database and payment signature verification succeeds.
3. **Immediate Restoration:**
   - The subsequent HTTP request immediately evaluates to `open`, restoring full paid capabilities without requiring staff to log out and log back in.

---

## 7. Verification & Automated Test Matrix

The implementation will be verified against the following comprehensive test cases:

1. **Clinical Continuity:** A `soft_locked` hospital can successfully load `/dashboard` (OPD queue) and `/ipd`, search existing patients, create walk-ins, write prescriptions, and record vitals.
2. **Public Booking Gating:** Public web booking rejects new appointments when `soft_locked`, while existing bookings and desk walk-ins remain fully manageable.
3. **Server Action Enforcement:** Direct server action calls for paused operations (e.g. creating WhatsApp campaigns or exporting reports) fail with `PLAN_SOFT_LOCKED`.
4. **Billing Continuity:** Desk payment collection, bill receipt printing, and case sheet generation remain operational while analytics exports are blocked.
5. **Message Resiliency:** Transactional messaging failures never abort clinical transactions; expired plan policies prevent unauthorized paid campaign dispatches.
6. **Cancellation vs Administrative Pause:** A normal cancellation remains `open` until its effective end date (`endsAt > now`); an administrative suspension takes effect immediately while keeping clinical safe harbor open.
7. **Unassigned Data Safety:** An unassigned hospital allows clinical queue functions but does not accidentally grant all paid entitlements.
8. **Instant Restoration:** Successful payment verification immediately restores access without requiring a re-login.
9. **Security Integrity:** Session locks, compliance notices, temporary password changes, and tenant isolation remain completely intact.
