# Plan Expiration & Clinical Safe-Harbor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate blanket hospital lockouts upon plan expiry by establishing a Clinical Safe Harbor (OPD, IPD, essential billing, patient records, and operational messaging remain 100% operational), adding an authoritative 4-state lifecycle, and enforcing granular server-side feature gating on paid growth capabilities.

**Architecture:**
1. **Domain Lifecycle (`lib/domain/subscription.ts`):** 4 authoritative states (`open`, `grace`, `soft_locked`, `revoked`), exact timing boundaries (`LAPSE_GRACE_DAYS = 7`), and explicit separation between scheduled cancellation vs immediate administrative suspension.
2. **Feature Policy Engine (`lib/domain/plan-policy.ts`):** Pure function `getFeatureDecision` evaluating Safe Harbor, lifecycle state, onboarding rules, and plan-tier entitlements.
3. **Session Decoupling (`lib/auth/session.ts`):** Remove the blanket `/plan-inactive` lockout while strictly preserving identity, device locks, screen locks, temporary-password enforcement, and compliance notices.
4. **App Shell & In-Page Experience (`app/(app)/layout.tsx`, `components/plan-status-banner.tsx`):** Role-targeted non-blocking banners and in-page notices for paused growth features (reports exports, campaigns).
5. **Backend Boundaries & Server Actions (`lib/services/web-booking.ts`, `lib/services/whatsapp-notices.ts`):** Server-side gating for public online bookings, bulk broadcast dispatchers, reminder suppression, and audited emergency clinical staff onboarding.
6. **Renewal & Verification (`lib/services/subscriptions.ts`):** Verified gateway cache invalidation and immediate feature restoration without re-login.

**Tech Stack:** Next.js 16 (App Router), TypeScript 5, React 19, Drizzle ORM, PostgreSQL, Vitest.

**Spec:** [`docs/superpowers/specs/2026-10-25-plan-expiration-and-clinical-safe-harbor-design.md`](file:///d:/Projects/HospitalAutomation/docs/superpowers/specs/2026-10-25-plan-expiration-and-clinical-safe-harbor-design.md)

---

## Global Constraints

- Never roll back a consultation, prescription, admission, or clinical transaction due to messaging or entitlement checks.
- Clinical safe harbor (`clinical.opd`, `clinical.ipd`, `clinical.records`, `operations.billing`, `account.self`, `subscription.view`, `reports.history_view`, `messaging.transactional`) is permanently allowed across all states.
- Normal cancellations scheduled for end of period (`endsAt > now`) remain in `open` until `endsAt`, then transition to `grace` (7 days) and `soft_locked`. They must not become `revoked`.
- Only explicit administrative suspensions (`status = 'suspended'` or administrative override) immediately transition to `revoked`.
- Unassigned onboarding hospitals retain Clinical Safe Harbor, but paid growth features (`public.web_booking`, `messaging.campaigns`, `reports.advanced`) are not silently granted.
- The App Shell banner is presentation-only; all paid operations enforce entitlements server-side.
- All date boundaries for grace and soft-lock must be evaluated in the hospital's configured timezone.

## Review Focus

1. **Scheduled Cancellation Past End-Date:** A subscription cancelled with effective date at term end must transition through `grace` (7 days) then `soft_locked`—it must not be marked `revoked` simply because `status === 'cancelled'`. (Tested in Task 1)
2. **Unassigned Hospital Entitlement Bleed:** A hospital without any subscription record must be able to run OPD/IPD queue without error, but must be rejected from creating WhatsApp campaigns or exporting advanced reports. (Tested in Task 2)
3. **Clinical Transaction Immunity on Notification Failure:** When `messaging.transactional` encounters an upstream WhatsApp gateway failure, doctor consultation and token moves must succeed cleanly without throwing. (Tested in Task 5)
4. **Stale Queued Reminders on Renewal:** Reminders queued prior to expiry must be marked `suppressed` (`PLAN_EXPIRED_SUPPRESSED`) and not bulk-dispatched to patients once a hospital renews. (Tested in Task 5)
5. **Security Gate Independence:** Removing the plan-lock redirect from `requireSession()` must not weaken temporary-password changes (`mustChangePassword`), compliance notices (`noticePending`), or screen locks (`locked`). (Tested in Task 3)

---

## Task Decomposition

### Task 1: Domain Subscription Lifecycle & Exact Timing Boundaries

**Files:**
- Modify: `lib/domain/subscription.ts`
- Test: `lib/domain/__tests__/subscription.test.ts`

**Interfaces:**
- Consumes: `SubscriptionStatus`, `addDays`, `LAPSE_GRACE_DAYS`
- Produces:
  ```ts
  export const LAPSE_GRACE_DAYS = 7;
  export type PlanAccessState = 'open' | 'grace' | 'soft_locked' | 'revoked';
  export type PlanAccess =
    | { state: 'open'; hasAssignedPlan: boolean; endsAt: Date | null }
    | { state: 'grace'; hasAssignedPlan: boolean; endedAt: Date; locksAt: Date }
    | { state: 'soft_locked'; hasAssignedPlan: boolean; reason: 'lapsed'; endedAt: Date; locksAt: Date }
    | { state: 'revoked'; hasAssignedPlan: boolean; reason: 'suspended' | 'revoked'; endedAt: Date | null };
  export function planAccess(args: {
    current: { status: SubscriptionStatus; startsAt: Date; endsAt: Date } | null;
    latest: { status: SubscriptionStatus; startsAt: Date; endsAt: Date } | null;
    now: Date;
    isAdministrativeSuspension?: boolean;
  }): PlanAccess;
  ```

- [ ] **Step 1: Write the failing tests in `lib/domain/__tests__/subscription.test.ts`**
  Cover:
  - Active term -> `open`
  - Term ending in 2 days -> `open`
  - Term expired 3 days ago -> `grace` (with `locksAt = endsAt + 7 days`)
  - Term expired 8 days ago -> `soft_locked` (`reason: 'lapsed'`)
  - Scheduled cancellation with `endsAt > now` -> `open`
  - Scheduled cancellation with `endsAt <= now - 8 days` -> `soft_locked` (not `revoked`)
  - Administrative suspension (`status = 'suspended'`) -> `revoked`
  - Unassigned hospital (no terms) -> `open` with `hasAssignedPlan: false`

- [ ] **Step 2: Run test to verify it fails**
  Run: `npx vitest run lib/domain/__tests__/subscription.test.ts`
  Expected: FAIL with missing properties/states (`soft_locked`, `hasAssignedPlan`).

- [ ] **Step 3: Implement `planAccess` and constants in `lib/domain/subscription.ts`**
  Update `LAPSE_GRACE_DAYS = 7`. Update `PlanAccess` type and `planAccess` function handling scheduled cancellations (`status === 'cancelled'` with `now < endsAt` remains `open`; after `endsAt` follows grace/soft_locked) vs administrative suspensions (`status === 'suspended'` or `isAdministrativeSuspension: true` immediately yields `revoked`).

- [ ] **Step 4: Run test to verify it passes**
  Run: `npx vitest run lib/domain/__tests__/subscription.test.ts`
  Expected: PASS.

- [ ] **Step 5: Commit**
  ```bash
  git add lib/domain/subscription.ts lib/domain/__tests__/subscription.test.ts
  git commit -m "feat(domain): implement 4-state plan access lifecycle with 7-day grace"
  ```

---

### Task 2: Pure Domain Feature Policy Engine

**Files:**
- Create: `lib/domain/plan-policy.ts`
- Create: `lib/domain/__tests__/plan-policy.test.ts`

**Interfaces:**
- Consumes: `PlanAccess` from `lib/domain/subscription.ts`
- Produces:
  ```ts
  export type FeatureDecision = 'allow' | 'read_only' | 'blocked';
  export type PlanFeature =
    | 'clinical.opd'
    | 'clinical.ipd'
    | 'clinical.records'
    | 'operations.billing'
    | 'account.self'
    | 'subscription.view'
    | 'reports.history_view'
    | 'messaging.transactional'
    | 'public.web_booking'
    | 'messaging.reminders'
    | 'messaging.campaigns'
    | 'reports.export'
    | 'reports.advanced'
    | 'hospital.staff_onboard'
    | 'subscription.renew';

  export function getFeatureDecision(args: {
    access: PlanAccess;
    tierEntitlements?: {
      hasAdvancedReports?: boolean;
      hasDataExport?: boolean;
      [key: string]: unknown;
    } | null;
    feature: PlanFeature;
  }): FeatureDecision;
  ```

- [ ] **Step 1: Write failing tests in `lib/domain/__tests__/plan-policy.test.ts`**
  Cover:
  - All 8 `SAFE_HARBOR_FEATURES` return `'allow'` across all states (`open`, `grace`, `soft_locked`, `revoked`).
  - `messaging.transactional` returns `'allow'` across all states.
  - `subscription.renew` returns `'allow'` in `open`, `grace`, `soft_locked`; returns `'blocked'` in `revoked`.
  - In `soft_locked`: `public.web_booking`, `messaging.reminders`, `messaging.campaigns`, `reports.export`, `reports.advanced`, `hospital.staff_onboard` return `'blocked'`.
  - In `open` with unassigned hospital (`hasAssignedPlan: false`): clinical safe-harbor allowed, but `messaging.campaigns` and `reports.advanced` return `'blocked'`.
  - In `open` with assigned plan missing `hasAdvancedReports`: `reports.advanced` returns `'blocked'`.

- [ ] **Step 2: Run test to verify it fails**
  Run: `npx vitest run lib/domain/__tests__/plan-policy.test.ts`
  Expected: FAIL (module not found).

- [ ] **Step 3: Implement `lib/domain/plan-policy.ts`**
  Implement `SAFE_HARBOR_FEATURES` explicit Set, `getFeatureDecision` layering Safe Harbor -> Renewal -> Lifecycle Lock -> Unassigned Onboarding -> Tier Entitlements.

- [ ] **Step 4: Run test to verify it passes**
  Run: `npx vitest run lib/domain/__tests__/plan-policy.test.ts`
  Expected: PASS.

- [ ] **Step 5: Commit**
  ```bash
  git add lib/domain/plan-policy.ts lib/domain/__tests__/plan-policy.test.ts
  git commit -m "feat(domain): add centralized feature policy decision engine"
  ```

---

### Task 3: Decouple Session Gating & Maintain Authentication Protections

**Files:**
- Modify: `lib/auth/session.ts`
- Modify: `lib/services/subscriptions.ts`
- Modify: `app/plan-inactive/page.tsx`
- Create: `lib/auth/__tests__/session-plan.test.ts`

**Interfaces:**
- Consumes: `isPlanLocked`, `getPlanAccess`
- Produces: Decoupled `requireSession()` that does not redirect clinical screens to `/plan-inactive`, while preserving `session.locked`, `session.mustChangePassword`, `session.noticePending`.

- [ ] **Step 1: Audit all usages of `isPlanLocked` and `allowInactivePlan`**
  Audit `lib/auth/session.ts`, `components/expiry-banner.tsx`, `app/plan-inactive/page.tsx`, `app/(app)/subscription/actions.ts`. Ensure non-breaking transition.

- [ ] **Step 2: Write tests in `lib/auth/__tests__/session-plan.test.ts`**
  Cover:
  - `requireSession()` allows authenticated session even when hospital's plan is `soft_locked` or `revoked`.
  - `requireSession()` still redirects to `/login` when unauthenticated.
  - `requireSession()` still redirects to `/unlock` when `session.locked`.
  - `requireSession()` still redirects to `/change-password` when `session.mustChangePassword`.
  - `requireSession()` still redirects to `/notice` when `session.noticePending`.

- [ ] **Step 3: Run test to verify it fails**
  Run: `npx vitest run lib/auth/__tests__/session-plan.test.ts`
  Expected: FAIL on soft-locked session redirecting to `/plan-inactive`.

- [ ] **Step 4: Update `lib/auth/session.ts` and `app/plan-inactive/page.tsx`**
  Remove the blanket `if (!options.allowInactivePlan && (await isPlanLocked(session))) redirect('/plan-inactive')` from `requireSession()`. Update `isPlanLocked` helper to return true only for legacy callers if needed, or deprecate gracefully. Ensure `/plan-inactive` renders standalone renewal options without infinite loops.

- [ ] **Step 5: Run test to verify it passes**
  Run: `npx vitest run lib/auth/__tests__/session-plan.test.ts`
  Expected: PASS.

- [ ] **Step 6: Commit**
  ```bash
  git add lib/auth/session.ts app/plan-inactive/page.tsx lib/auth/__tests__/session-plan.test.ts
  git commit -m "refactor(auth): decouple requireSession from global plan lockout"
  ```

---

### Task 4: App Shell Streaming Banners & In-Page Notices

**Files:**
- Create: `components/plan-status-banner.tsx`
- Modify: `app/(app)/layout.tsx`
- Modify: `components/expiry-banner.tsx`
- Modify: `components/plan-expiry-notice.tsx`
- Modify: `app/(app)/reports/page.tsx`
- Modify: `app/(app)/whatsapp-notices/page.tsx`
- Modify: `app/(app)/whatsapp-notices/new/page.tsx`

**Interfaces:**
- Consumes: `getPlanAccess` from `lib/services/subscriptions.ts`, `getFeatureDecision` from `lib/domain/plan-policy.ts`
- Produces: Role-aware non-blocking header banner and in-page restriction prompts.

- [ ] **Step 1: Create `components/plan-status-banner.tsx`**
  Async component rendering streaming header alert:
  - If `state === 'grace'`: For Owner & Doctor, informational countdown: *"Your plan expired on [date]. Full access continues until [date + 7d]. [Renew Plan]"*.
  - If `state === 'soft_locked'`: For Owner, prominent banner: *"Hospital plan overdue. Clinical care (OPD & IPD) remains active. Public online booking, WhatsApp campaigns, and analytics exports are paused. [Renew Plan]"*. For Doctor, quiet header badge *"Basic Plan Mode"*.
  - If `state === 'revoked'`: For Owner, support banner: *"Hospital plan paused by QuriioHQ. Patient care remains active. Contact your representative."*
  - For Receptionists/Nurses: renders `null`.

- [ ] **Step 2: Integrate `PlanStatusBanner` into `app/(app)/layout.tsx`**
  Place `PlanStatusBanner` inside `<Suspense fallback={null}>` directly below `AppHeader` and `SupportNotice`.

- [ ] **Step 3: Update `app/(app)/reports/page.tsx`**
  Wrap export controls in entitlement check:
  - Historical trends and doctor stats render normally (`reports.history_view` -> `allow`).
  - If `getFeatureDecision({ access, feature: 'reports.export' }) === 'blocked'`, replace export buttons with an inline notice: *"Analytics exports are paused while plan is overdue. [Renew to Export]"*.

- [ ] **Step 4: Update `app/(app)/whatsapp-notices` pages**
  In `app/(app)/whatsapp-notices/page.tsx`: Keep past notices table readable.
  In `app/(app)/whatsapp-notices/new/page.tsx`: If `messaging.campaigns` is blocked, render an entitlement message with renewal CTA instead of the broadcast composition form.

- [ ] **Step 5: Run typecheck and existing component tests**
  Run: `npm run typecheck`
  Expected: PASS.

- [ ] **Step 6: Commit**
  ```bash
  git add components/plan-status-banner.tsx app/\(app\)/layout.tsx components/expiry-banner.tsx components/plan-expiry-notice.tsx app/\(app\)/reports/page.tsx app/\(app\)/whatsapp-notices/
  git commit -m "feat(ui): add role-targeted plan status banner and in-page notices"
  ```

---

### Task 5: Backend Service Boundaries, Messaging Queues & Server Actions

**Files:**
- Modify: `lib/services/web-booking.ts`
- Modify: `lib/services/whatsapp-notices.ts`
- Modify: `lib/services/booking.ts`
- Modify: `app/(app)/whatsapp-notices/actions.ts`
- Modify: `lib/services/auth.ts`
- Test: `lib/services/__tests__/plan-boundary-guards.test.ts`

**Interfaces:**
- Consumes: `getPlanAccess`, `getFeatureDecision`
- Produces: Server-side rejections with typed error codes (`PLAN_SOFT_LOCKED`, `NOT_TAKING_BOOKINGS`), stale reminder suppression, and emergency clinical staff onboarding.

- [ ] **Step 1: Write boundary tests in `lib/services/__tests__/plan-boundary-guards.test.ts`**
  Cover:
  - `createWebBooking` throws `NOT_TAKING_BOOKINGS` when plan is `soft_locked` or `revoked`.
  - Walk-in appointments and queue token moves in `booking.ts` succeed when `soft_locked`.
  - `createNoticeBroadcast` action returns `{ ok: false, error: 'PLAN_SOFT_LOCKED' }` when `messaging.campaigns` is blocked.
  - Stale appointment reminders queued before expiry are marked `suppressed` (`PLAN_EXPIRED_SUPPRESSED`) rather than sending upon renewal.
  - Emergency clinical staff onboarding by Owner with reason succeeds when `soft_locked`, while non-clinical onboarding fails with `PLAN_SOFT_LOCKED`.

- [ ] **Step 2: Run test to verify it fails**
  Run: `npx vitest run lib/services/__tests__/plan-boundary-guards.test.ts`
  Expected: FAIL.

- [ ] **Step 3: Guard `createWebBooking` in `lib/services/web-booking.ts`**
  Check `getFeatureDecision({ access, feature: 'public.web_booking' })`. If blocked, throw `BookingError('NOT_TAKING_BOOKINGS', 'Online booking is temporarily offline for maintenance. Please visit the registration desk directly.')`.

- [ ] **Step 4: Guard broadcast campaigns and reminder dispatchers in `lib/services/whatsapp-notices.ts`**
  In `createNoticeBroadcast`, enforce `getFeatureDecision({ access, feature: 'messaging.campaigns' })`.
  In reminder dispatchers: check `getFeatureDecision({ access, feature: 'messaging.reminders' })`. When blocked, update pending reminder queue entries to `status = 'suppressed', failure_reason = 'PLAN_EXPIRED_SUPPRESSED'`. Ensure transactional messages never roll back clinical transactions.

- [ ] **Step 5: Implement emergency clinical onboarding in `lib/services/auth.ts`**
  In `createUser`: If plan is `soft_locked` or `revoked`, check if role is `doctor` or `nurse` and caller is `owner` with an explicit `clinicalEmergencyReason`. If satisfied, log to `auditLogs` and create; otherwise throw `PLAN_SOFT_LOCKED`.

- [ ] **Step 6: Run test to verify it passes**
  Run: `npx vitest run lib/services/__tests__/plan-boundary-guards.test.ts`
  Expected: PASS.

- [ ] **Step 7: Commit**
  ```bash
  git add lib/services/web-booking.ts lib/services/whatsapp-notices.ts lib/services/booking.ts app/\(app\)/whatsapp-notices/actions.ts lib/services/auth.ts lib/services/__tests__/plan-boundary-guards.test.ts
  git commit -m "feat(services): enforce server-side feature boundaries and reminder suppression"
  ```

---

### Task 6: End-to-End Verification & Instant Renewal Restoration

**Files:**
- Modify: `lib/services/__tests__/plan-access.integration.test.ts`
- Create: `app/(app)/__tests__/plan-safe-harbor.test.ts`

**Interfaces:**
- Consumes: All modules from Tasks 1–5
- Produces: Comprehensive test coverage verifying all 9 requirements from the spec.

- [ ] **Step 1: Update integration tests in `lib/services/__tests__/plan-access.integration.test.ts`**
  Update tests to verify:
  - Term ends: Day 0–7 evaluates to `grace`, Day 8+ evaluates to `soft_locked`.
  - Scheduled cancellation remains `open` until `endsAt`, then `grace`, then `soft_locked`.
  - Administrative suspension transitions to `revoked`.
  - Calling `renewSubscription` immediately clears `planAccess` cache and returns `open` on the next query without new login.

- [ ] **Step 2: Create `app/(app)/__tests__/plan-safe-harbor.test.ts`**
  Simulate request context for a soft-locked hospital:
  - `/dashboard` (OPD queue) loads and queue mutation succeeds.
  - `/ipd` loads and nurse bedside vitals recording succeeds.
  - Bill payment toggle (`billing.collect`) succeeds and receipt generation is permitted.
  - Direct call to export report or launch WhatsApp campaign fails with `PLAN_SOFT_LOCKED`.

- [ ] **Step 3: Run full test suite**
  Run: `npm test`
  Expected: All unit and domain tests pass.

- [ ] **Step 4: Run typecheck**
  Run: `npm run typecheck`
  Expected: Zero TypeScript errors.

- [ ] **Step 5: Commit**
  ```bash
  git add lib/services/__tests__/plan-access.integration.test.ts app/\(app\)/__tests__/plan-safe-harbor.test.ts
  git commit -m "test(integration): verify clinical safe harbor, boundaries and instant renewal"
  ```
