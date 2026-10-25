# Plan Expiration & Clinical Safe-Harbor Specification

**Date:** 2026-10-25  
**Topic:** Plan Expiration, Clinical Safe-Harbor Policy, and Tiered Backend Feature Gating  
**Author:** Antigravity (Pair Programming with HospitalAutomation)  
**Status:** Approved for Implementation Planning (incorporating all 5 architectural corrections)  

---

## 1. Problem Statement & Core Principles

### 1.1 The Issue
Under the prior implementation, when a hospital's subscription lapsed or was placed in an inactive state, `requireSession()` in `lib/auth/session.ts` executed a blanket redirect to `/plan-inactive`. This completely locked medical personnel out of the hospital application shell, preventing doctors, receptionists, and nurses from accessing the OPD queue, conducting consultations, reviewing patient histories, or documenting IPD care.

In a healthcare environment, blocking clinical access due to an expired subscription or accounting delay is unacceptable. Hospitals are critical infrastructure; abruptly halting patient intake and doctor workflows creates patient safety hazards, disrupts hospital revenue, and drives immediate platform churn.

### 1.2 Core Principles
1. **Patient Safety & Clinical Safe Harbor:** Medical care, queue management, consultations, prescriptions, IPD bed/vitals management, patient record access, and essential desk billing must **never** be blocked or interrupted by billing or subscription expiration.
2. **Data Continuity:** Expiry pauses paid growth capabilities; it never takes away a hospital's access to its existing data, medical records, or historical invoices.
3. **Decoupled Architecture:** Access allowed = Authenticated Session + Role Permission (`can(role, ...)`) + Plan Feature Entitlement (`getFeatureDecision(...)`). A plan never grants permissions a role does not already possess.
4. **Three Distinct Layers:**
   - **Lifecycle:** Is the hospital's subscription active, in grace, soft-locked, or administratively suspended?
   - **Entitlements:** Which capabilities does this hospital's assigned plan tier permit?
   - **Role Permissions:** Is this specific staff member authorized to perform this operation?
5. **Selective Server-Side Gating:** Paid features (e.g., new public online bookings, bulk WhatsApp marketing campaigns, advanced analytics exports, and net-new staff onboarding) are selectively paused at the backend service boundaries and server actions—not just hidden in the UI.
6. **Role-Targeted, Non-Blocking Communication:** Renewal alerts are communicated prominently to hospital decision-makers (Owners/Administrators) without disrupting clinical staff (Doctors, Nurses) during patient care.

---

## 2. Subscription States & Lifecycle Architecture

### 2.1 Authoritative States
We define four authoritative subscription states in `lib/domain/subscription.ts`:

| State | Rule | Clinical Safe Harbor | Paid Features | UI Banner Behavior |
| :--- | :--- | :--- | :--- | :--- |
| **`open`** | Active term: `startsAt <= now < endsAt`. Also applies to scheduled cancellations where `now < endsAt`. | Full Access | Subject to Plan Tier Entitlements | No banner (unless within 15-day pre-expiry window). |
| **`grace`** | Lapsed term: `endsAt <= now < endsAt + 7 days`. | Full Access | Subject to Plan Tier Entitlements | Informational reminder with exact grace deadline to Owner & Doctor. |
| **`soft_locked`** | Overdue term: `now >= endsAt + 7 days` (reason: `lapsed`). | Full Access | **Paused** (Paid growth features blocked) | High-priority non-blocking renewal CTA for Owner; discreet status note for Doctor. |
| **`revoked`** | Explicit administrative suspension (`status = 'suspended'` or administrative override). | Full Access | **Paused** (Paid growth features blocked) | Banner directing Owner to contact QuriioHQ support. |

### 2.2 Crucial Lifecycle Distinctions
1. **Authoritative Source of Truth:**
   - The authoritative status stored in the `subscriptions` table (`status = 'active' | 'suspended' | 'cancelled' | 'expired' | 'trial'`) and hospital record determines the lifecycle state.
   - `auditLogs` is strictly used for provenance and tracking *who* changed the status, *when*, and *why*—never as an ad-hoc runtime query for current access.
2. **Normal Cancellation vs Administrative Suspension:**
   - A normal customer cancellation request scheduled for the end of the billing period retains `status = 'cancelled'` with `endsAt > now`. It remains in the **`open`** state until `endsAt` arrives.
   - Once a normally cancelled term expires (`now >= endsAt`), it enters the ordinary **`grace`** (7 days) and then **`soft_locked`** lifecycle. It does **not** become administratively `revoked` simply because its status was marked cancelled.
   - An immediate administrative suspension occurs only via explicit administrative action (`status = 'suspended'` or authoritative administrative override). It takes effect immediately as **`revoked`** while preserving the Clinical Safe Harbor.
3. **Unassigned / Onboarding Hospitals:**
   - An onboarding hospital that has not yet been assigned a paid subscription retains full access to the Clinical Safe Harbor so queue and patient intake can function immediately.
   - However, unassigned hospitals are **not** silently granted paid capabilities (e.g. bulk WhatsApp campaigns or advanced exports). They resolve paid features through an explicit onboarding entitlement.
4. **Exact Timing Boundaries:**
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
  | 'messaging.transactional'   // Essential operational events (e.g. active queue-call notification)
  
  // Paid / Growth Capabilities (governed by plan state and tier entitlements)
  | 'public.web_booking'        // External public patient booking portal
  | 'messaging.reminders'       // Automated scheduled appointment reminders
  | 'messaging.campaigns'       // Broadcast marketing notices and bulk announcements
  | 'reports.export'            // Bulk CSV/Excel downloads and PDF analytics export
  | 'reports.advanced'          // Multi-branch comparative analytics and financial projections
  | 'hospital.staff_onboard'    // Onboarding net-new staff accounts
  | 'subscription.renew';       // Initiating online payment/checkout to renew or extend plan
```

### 3.2 Feature Evaluation Engine
The decision engine evaluates features in an explicit, strict order that decouples lifecycle from plan-tier entitlements:

```ts
const SAFE_HARBOR_FEATURES = new Set<PlanFeature>([
  'clinical.opd',
  'clinical.ipd',
  'clinical.records',
  'operations.billing',
  'account.self',
  'subscription.view',
  'reports.history_view',
  'messaging.transactional',
]);

export function getFeatureDecision(args: {
  access: PlanAccess;
  tierEntitlements?: {
    hasAdvancedReports?: boolean;
    hasDataExport?: boolean;
    [key: string]: unknown;
  } | null;
  feature: PlanFeature;
}): FeatureDecision {
  const { access, tierEntitlements, feature } = args;

  // 1. Safe Harbor: essential clinical, billing, and operational messaging are ALWAYS allowed
  if (SAFE_HARBOR_FEATURES.has(feature)) {
    return 'allow';
  }

  // 2. Subscription renewal: available during grace & soft_locked, blocked if administratively suspended
  if (feature === 'subscription.renew') {
    return access.state === 'revoked' ? 'blocked' : 'allow';
  }

  // 3. Lifecycle lock: if soft-locked or revoked, paid growth features are paused
  if (access.state === 'soft_locked' || access.state === 'revoked') {
    return 'blocked';
  }

  // 4. Unassigned onboarding hospital: only explicitly allowed onboarding capabilities
  if (!access.hasAssignedPlan) {
    return isExplicitlyAllowedForOnboarding(feature) ? 'allow' : 'blocked';
  }

  // 5. Tier Entitlements: active subscriptions only receive features included in their plan tier
  return planIncludesFeature(tierEntitlements, feature) ? 'allow' : 'blocked';
}

function isExplicitlyAllowedForOnboarding(feature: PlanFeature): boolean {
  // Unassigned onboarding hospitals have clinical safe harbor, but external/advanced features are paused
  return false;
}

function planIncludesFeature(
  entitlements: Record<string, unknown> | null | undefined,
  feature: PlanFeature,
): boolean {
  if (!entitlements) return false;
  if (feature === 'reports.advanced') return Boolean(entitlements.hasAdvancedReports);
  if (feature === 'reports.export') return Boolean(entitlements.hasDataExport);
  return true;
}
```

---

## 4. App Shell & Route Gating Architecture

### 4.1 Decoupling `requireSession()` with Security Safeguards
* Modify `lib/auth/session.ts`: Remove the blanket `if (!options.allowInactivePlan && (await isPlanLocked(session))) redirect('/plan-inactive')`.
* `requireSession()` strictly preserves all authentication and session safety guards:
  - Valid signed-in staff member (`if (!session) redirect('/login')`).
  - Screen and device idle locks (`session.locked`).
  - Temporary password replacement requirement (`session.mustChangePassword`).
  - Pending legal and compliance notices (`session.noticePending`).
  - Support/impersonation read-only restrictions.
* Audit all existing consumers of `isPlanLocked()` and `allowInactivePlan` across the codebase to ensure no dependent safety checks are bypassed.
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
* **In `revoked` (Administrative suspension):**
  - **For Owner:** Alert banner: *"Hospital plan paused by QuriioHQ. Patient care remains active. Please contact your representative to restore services."*

### 4.3 In-Page Non-Clinical Route Experience
* **Reports (`app/(app)/reports/page.tsx`):**
  - Historical dashboard trends and charts remain visible (`reports.history_view` → `allow`).
  - Bulk CSV/PDF export controls are disabled with an in-page notice: *"Analytics exports are paused while plan is overdue. [Renew to Export]"*.
* **WhatsApp Notices (`app/(app)/whatsapp-notices`):**
  - Past sent notice logs remain readable.
  - Campaign creation (`/whatsapp-notices/new`) renders an entitlement notice explaining that bulk campaigns are paused.
* **Settings & Staff (`app/(app)/settings`):**
  - Existing staff profiles, PIN resets, and role assignments remain fully accessible.
  - Ordinary staff onboarding (`hospital.staff_onboard`) is paused.
  - **Emergency Clinical Staffing Exception:** An explicit, audited server-side operation available to Owners to onboard essential doctors or nurses needed for clinical care continuity during soft-lock, requiring a mandatory recorded audit reason.

---

## 5. Service Boundaries & Backend Enforcement

Every protected operation enforces entitlements server-side at the service boundary:

### 5.1 Public Online Booking (`lib/services/web-booking.ts`)
* Before creating a new booking in `createWebBooking()`:
  - Evaluates `getFeatureDecision({ access, feature: 'public.web_booking' })`.
  - If `'blocked'`, the request is rejected with a user-friendly response: *"Online booking is currently offline for maintenance. Please visit the registration desk directly or contact the hospital."*
* **Existing Bookings Protected:** All previously booked appointments remain in the queue and schedule. Reception and doctors can check in, move, or consult these patients without hindrance.

### 5.2 Messaging Service Boundaries & Queue Management (`lib/services/whatsapp-notices.ts`)
* **`messaging.transactional`:** Essential operational messages (queue-call alerts, token calls) remain available subject to operational cost controls. A WhatsApp delivery failure **must never roll back** a consultation, prescription, admission, or clinical transaction.
* **`messaging.campaigns`:** Creating broadcast notices (`createNoticeBroadcast`) checks `getFeatureDecision`. If blocked, throws a typed error `PLAN_SOFT_LOCKED`.
* **`messaging.reminders`:** Automated scheduled reminder dispatchers skip hospitals in `soft_locked` or `revoked` state.
* **Suppressed Reminders Handling:** Reminders that were queued before expiry must not remain indefinitely queued and suddenly fire in bulk upon renewal. The dispatcher marks suppressed reminders with `status = 'suppressed', reason = 'PLAN_EXPIRED_SUPPRESSED'` and discards stale appointment reminders.

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
5. **Message Resiliency & Suppression:** Transactional messaging failures never abort clinical transactions; expired-plan reminder dispatchers cleanly suppress and discard stale queued reminders rather than bulk-firing upon renewal.
6. **Cancellation vs Administrative Pause:** A normal cancellation remains `open` until its effective end date (`endsAt > now`); an administrative suspension takes effect immediately while keeping clinical safe harbor open.
7. **Unassigned Data Safety:** An unassigned onboarding hospital allows clinical queue functions but does not accidentally grant all paid entitlements.
8. **Instant Restoration:** Successful payment verification immediately restores access without requiring a re-login.
9. **Security Integrity:** Session locks, compliance notices, temporary password changes, and tenant isolation remain completely intact.

---

## 8. Implementation Sequence

The implementation will proceed in the following strict order:
1. **Domain Lifecycle (`lib/domain/subscription.ts`):** Implement the four authoritative lifecycle states (`open`, `grace`, `soft_locked`, `revoked`), exact timing boundaries (`LAPSE_GRACE_DAYS = 7`), and distinction between scheduled cancellation vs immediate administrative suspension. Unit tests for timing and state transitions.
2. **Feature Policy Engine (`lib/domain/plan-policy.ts`):** Implement `getFeatureDecision` with the explicit safe-harbor allowlist, plan-tier entitlements, and unassigned hospital rules. Unit tests covering all feature/state combinations.
3. **Session Decoupling (`lib/auth/session.ts`):** Remove the blanket plan-lock redirect from `requireSession()` while rigorously preserving identity, device locks, screen locks, temporary password changes, and compliance notices.
4. **App Shell & In-Page Notices (`app/(app)/layout.tsx`, `components/expiry-banner.tsx`, `/reports`, `/whatsapp-notices`):** Add role-targeted non-blocking banners and in-page restriction prompts for paused growth features.
5. **Service Boundaries & Backend Enforcement (`web-booking.ts`, `whatsapp-notices.ts`, server actions):** Enforce feature entitlement checks at direct service boundaries, reminder dispatchers, and server actions. PostgreSQL integration tests for service boundaries and instant renewal restoration.
