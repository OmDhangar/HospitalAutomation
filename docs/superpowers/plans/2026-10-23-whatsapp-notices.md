# Hospital WhatsApp Notices & Priority-Based Bulk Messaging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a production-ready Hospital WhatsApp Notices system enabling authorized hospital administrators to send approved WhatsApp notices (starting with hospital closure notices) to up to 250 unique eligible patients, prioritized by hospital-scoped recent OPD activity and mandatory selections, with atomic account-capacity management, background queuing, delivery tracking, and full consent enforcement.

**Architecture:** A dedicated notice campaign subsystem layered cleanly alongside existing OPD operations. Notice campaigns, mandatory recipient lists, recipient snapshots, and capacity reservations are managed via transactional PostgreSQL tables. Recipient selection dynamically balances hospital-scoped OPD recency with explicit mandatory overrides, strictly obeying Meta account capacity and patient consent. Outbound message delivery is processed durably with exponential backoff and jitter, tracking real-time status transitions via webhook reconciliation.

**Tech Stack:** Next.js 16 (App Router), React 19, TypeScript 5, Drizzle ORM, PostgreSQL (pgcrypto / UUIDs), Meta WhatsApp Cloud API v23.0, Tailwind CSS v4, Vitest 5.

**Spec:** Defined in implementation task specification.

---

## Global Constraints

- Never send real bulk WhatsApp messages during testing; mock Meta API calls.
- Hard maximum campaign cap of 250 unique recipients (`campaignCapacity = min(250, availableAccountCapacity)`).
- Strict tenant isolation: recipient selection, activity recency, and mandatory lists must be strictly scoped to `session.hospitalId`.
- No global persistence of campaign-specific mandatory recipients across unrelated campaigns.
- No fabrication of patient consent: only recipients with positive `whatsappOptInAt != null` and without active opt-out/suppression are eligible.
- Dedicated notice queue/recipient snapshot tables so regular single-appointment queue nudges (`notification_outbox`) and the margin canary ratio are never polluted or skewed.
- Migration numbering starts at `0068_whatsapp_notices.sql` following project Drizzle conventions and passing `scripts/lint-migrations.ts`.
- All administrative actions require role authorization (`owner` or configured staff role) and audit logging.

---

## Review Focus

1. **Mandatory displacement math:** When mandatory recipients are added, they must replace the least-recently active non-mandatory recipients while keeping total count <= `campaignCapacity`.
2. **Account capacity concurrency:** Two simultaneous confirmations must not oversubscribe available capacity; atomic transactional reservation must prevent race conditions.
3. **Mid-flight opt-outs and cancellations:** An opt-out or campaign cancellation received after confirmation but before submission must immediately suppress pending messages.
4. **Idempotency & Webhook reconciliation:** Duplicate confirmations or repeated webhook status deliveries (`sent`, `delivered`, `read`, `failed`) must be processed idempotently without counter corruption.
5. **Phone number deduplication:** Multiple patient records sharing the same phone number must yield exactly one message per normalized phone number.

---

## Architecture and Reusable Services

### Existing Assets Reused
- `lib/notify/provider.ts`: `NotificationProvider`, `MetaCloudProvider`, `getProvider()`, `setProvider()`.
- `lib/notify/errors.ts`: `ProviderError`, `isRetryableMetaError()`.
- `lib/notify/templates.ts`: `TEMPLATES`, `renderTemplate()`, `templateBaseUrl()`.
- `lib/security/credentials.ts`: `openCredential()` for decrypting hospital-specific Meta access tokens.
- `lib/services/whatsapp-numbers.ts`: `getHospitalNumber()` for looking up hospital `phoneNumberId` and `messagingTier`.
- `lib/services/whatsapp-byo.ts`: `resolveAppSecret()`, `resolveVerifyToken()` for hospital-specific webhook signature verification.
- `lib/domain/phone.ts`: `normalizeIndianPhone()`, `isMockPhone()`.
- `lib/domain/permissions.ts`: `can()`, `STAFF_ROLES`.
- `components/ui.tsx`: `cn`, `Button`, `StatusPill`, `Stat`, `Field`, `Input`, `EmptyState`, `Alert`.
- `lib/db/admin.ts`: `getAdminDb()` for cross-tenant and worker operations.
- `lib/db/index.ts`: `withTenant()`, `getDb()`.

---

## Detailed Implementation Tasks

### Task 1: Schema Migration & Database Types (`0068_whatsapp_notices`)

**Files:**
- Create: `drizzle/0068_whatsapp_notices.sql`
- Modify: `drizzle/meta/_journal.json`
- Modify: `lib/db/schema.ts`
- Test: `lib/db/migrations/__tests__/lint.test.ts`

**Interfaces:**
- Produces tables:
  - `notice_campaigns`: campaign definitions, statuses, counters, audit fields.
  - `notice_campaign_mandatory_recipients`: campaign-scoped mandatory overrides.
  - `notice_campaign_recipients`: immutable snapshot of recipients, priority, dispatch state, provider message IDs.
  - `whatsapp_capacity_reservations`: atomic capacity accounting per `phoneNumberId`.
  - `whatsapp_opt_outs`: explicit suppression list per hospital & phone.
  - `webhook_event_dedup`: idempotency record for webhook deliveries.

- [ ] **Step 1: Write the failing test for migration linting**
  Ensure `lib/db/migrations/__tests__/lint.test.ts` validates the new migration format and rules.
- [ ] **Step 2: Create `drizzle/0068_whatsapp_notices.sql`**
  Use `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, proper foreign keys, `STATEMENT_BREAKPOINT`, and RLS policies.
- [ ] **Step 3: Update `drizzle/meta/_journal.json`**
  Add entry `idx: 53, tag: "0068_whatsapp_notices", when: 1792100000000`.
- [ ] **Step 4: Update `lib/db/schema.ts`**
  Export `noticeCampaigns`, `noticeCampaignMandatoryRecipients`, `noticeCampaignRecipients`, `whatsappCapacityReservations`, `whatsappOptOuts`, `webhookEventDedup` and their relation types.
- [ ] **Step 5: Run tests and migration linting**
  `npm test` must pass all tests including migration linter.

---

### Task 2: Domain Logic — Recipient Selection & Priority Displacement

**Files:**
- Create: `lib/domain/notice-selection.ts`
- Create: `lib/domain/__tests__/notice-selection.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type RecipientCandidate = {
    phoneE164: string;
    patientId: string | null;
    patientName: string;
    lastActivityAt: Date;
    activityType: 'appointment' | 'whatsapp_inbound' | 'check_in' | 'registration';
    hasConsent: boolean;
    isOptedOut: boolean;
    hasAffectedAppointment?: boolean;
  };

  export type MandatoryInput = {
    phoneE164: string;
    patientId?: string | null;
    patientName?: string;
  };

  export type SelectionResult = {
    campaignCapacity: number;
    accountAvailableCapacity: number;
    totalEligibleRecipients: number;
    totalSelectedRecipients: number;
    mandatoryIncludedCount: number;
    mandatoryAlreadyInDefaultCount: number;
    mandatoryAddedFromOutsideCount: number;
    displacedCount: number;
    ineligibleMandatoryCount: number;
    ineligibleRecipients: Array<{ phoneE164: string; reason: string }>;
    displacedRecipients: Array<{ phoneE164: string; patientName: string; lastActivityAt: Date }>;
    finalRecipients: Array<{
      phoneE164: string;
      patientId: string | null;
      patientName: string;
      priority: number;
      selectionReason: 'mandatory' | 'recent_activity' | 'affected_appointment';
      lastActivityAt: Date;
      activityType: string;
      isEligible: boolean;
    }>;
  };

  export function computeNoticeSelection(params: {
    candidates: RecipientCandidate[];
    mandatory: MandatoryInput[];
    availableAccountCapacity: number;
    maxCampaignCap?: number;
  }): SelectionResult;
  ```

- [ ] **Step 1: Write comprehensive unit tests in `lib/domain/__tests__/notice-selection.test.ts`**
  Cover:
  - 0 eligible candidates.
  - Less than 250 candidates.
  - Exactly 250 candidates.
  - More than 250 candidates.
  - Mandatory numbers already in top 250.
  - Mandatory numbers outside top 250 displacing least recent.
  - Duplicate phone numbers across patients.
  - Ineligible mandatory numbers (invalid format, no consent, opted out).
  - More than 250 distinct mandatory numbers (conflict error).
  - Account capacity less than 250 (effective cap = available capacity).
  - Tie-breaker determinism.
- [ ] **Step 2: Implement `computeNoticeSelection` in `lib/domain/notice-selection.ts`**
- [ ] **Step 3: Run unit tests to verify 100% pass**
  `npx vitest run lib/domain/__tests__/notice-selection.test.ts`

---

### Task 3: Domain Logic — WhatsApp Account Capacity Management & Atomic Reservations

**Files:**
- Create: `lib/domain/whatsapp-capacity.ts`
- Create: `lib/domain/__tests__/whatsapp-capacity.test.ts`
- Create: `lib/services/notice-capacity.ts`
- Create: `lib/services/__tests__/notice-capacity.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function resolveTierLimit(messagingTier: string | null | undefined): number;
  export function calculateAvailableAccountCapacity(params: {
    tierLimit: number;
    consumedLast24h: number;
    activeReservations: number;
    safetyBuffer?: number;
  }): { availableCapacity: number; effectiveCampaignCap: number };
  ```
  And database service functions:
  ```ts
  export async function getAccountAvailableCapacity(hospitalId: string): Promise<{
    tierLimit: number;
    consumedLast24h: number;
    activeReservations: number;
    safetyBuffer: number;
    availableCapacity: number;
    effectiveCampaignCap: number;
  }>;
  export async function reserveCampaignCapacity(tx: Tx, params: {
    hospitalId: string;
    campaignId: string;
    slots: number;
  }): Promise<{ reservationId: string }>;
  export async function releaseCampaignCapacity(campaignId: string): Promise<void>;
  ```

- [ ] **Step 1: Write unit tests for capacity calculation and limits**
  Test rolling 24h consumption, tier mappings (`TIER_250`, `TIER_1K`, `TIER_10K`, etc.), safety buffer, and reservations.
- [ ] **Step 2: Implement `lib/domain/whatsapp-capacity.ts`**
- [ ] **Step 3: Implement database capacity queries & atomic reservation in `lib/services/notice-capacity.ts`**
- [ ] **Step 4: Run tests to verify pass**

---

### Task 4: Notice Template Definition & Cloud API Integration

**Files:**
- Modify: `lib/notify/templates.ts`
- Modify: `lib/notify/__tests__/templates.test.ts`
- Modify: `scripts/whatsapp-templates.ts`

**Interfaces:**
- Adds `hospital_closure_notice` to `TemplateCode`:
  ```ts
  hospital_closure_notice: {
    name: 'opd_hospital_closure_notice',
    variables: ['hospitalName', 'closureDate', 'reason', 'contactPhone'],
    body: {
      mr: '{{1}} सूचना: रुग्णालय {{2}} रोजी बंद राहील (कारण: {{3}}). अधिक माहिती किंवा रीशेड्यूलसाठी कृपया {{4}} वर संपर्क साधा.',
      hi: '{{1}} सूचना: अस्पताल {{2}} को बंद रहेगा (कारण: {{3}})। अधिक जानकारी या पुनर्निर्धारण के लिए कृपया {{4}} पर संपर्क करें।',
      en: '{{1}} notice: The hospital will be closed on {{2}} due to {{3}}. For queries or rescheduling please contact {{4}}.',
    },
  }
  ```

- [ ] **Step 1: Add unit test in `lib/notify/__tests__/templates.test.ts`**
- [ ] **Step 2: Add `hospital_closure_notice` in `lib/notify/templates.ts`**
- [ ] **Step 3: Update `scripts/whatsapp-templates.ts` payload generator**
- [ ] **Step 4: Verify template tests pass**

---

### Task 5: Background Worker & Delivery Status Webhook Reconciliation

**Files:**
- Create: `lib/notify/notice-worker.ts`
- Create: `lib/notify/__tests__/notice-worker.test.ts`
- Modify: `app/api/whatsapp/webhook/route.ts`
- Modify: `app/api/whatsapp/webhook/[hospitalId]/route.ts`
- Modify: `scripts/worker-daemon.ts`
- Modify: `app/api/internal/tick/route.ts`

**Interfaces:**
- Produces:
  ```ts
  export async function drainNoticeCampaignOutbox(now?: Date): Promise<{
    processed: number;
    sent: number;
    failed: number;
    suppressed: number;
  }>;
  export async function processNoticeDeliveryStatus(status: StatusEvent): Promise<boolean>;
  export async function handleNoticeInboundOptOut(inbound: InboundEvent): Promise<boolean>;
  ```

- [ ] **Step 1: Write failing worker and webhook tests with mocked Meta provider**
  Test claiming rows with `SKIP LOCKED`, priority ordering, opt-out suppression check right before sending, retry backoff on transient errors, permanent error handling, and delivery/read/failed webhook handling.
- [ ] **Step 2: Implement `lib/notify/notice-worker.ts`**
- [ ] **Step 3: Integrate with webhooks in `app/api/whatsapp/webhook/route.ts` and `[hospitalId]/route.ts`**
  Ensure idempotency via `webhook_event_dedup`.
- [ ] **Step 4: Hook worker tick into `scripts/worker-daemon.ts` and `app/api/internal/tick/route.ts`**
- [ ] **Step 5: Run tests to verify pass**

---

### Task 6: Backend Service & API Endpoints

**Files:**
- Create: `lib/services/whatsapp-notices.ts`
- Create: `lib/services/__tests__/whatsapp-notices.test.ts`
- Create: `app/api/hospitals/[hospitalId]/whatsapp-notices/route.ts`
- Create: `app/api/hospitals/[hospitalId]/whatsapp-notices/preview/route.ts`
- Create: `app/api/whatsapp-notices/[campaignId]/recipients/mandatory/route.ts`
- Create: `app/api/whatsapp-notices/[campaignId]/confirm/route.ts`
- Create: `app/api/whatsapp-notices/[campaignId]/route.ts`
- Create: `app/api/whatsapp-notices/[campaignId]/recipients/route.ts`
- Create: `app/api/whatsapp-notices/[campaignId]/cancel/route.ts`

**Endpoints:**
- `POST /api/hospitals/:hospitalId/whatsapp-notices` (Create draft)
- `POST /api/hospitals/:hospitalId/whatsapp-notices/preview` (Calculate preview without side-effects)
- `PUT /api/whatsapp-notices/:campaignId/recipients/mandatory` (Save mandatory recipients)
- `POST /api/whatsapp-notices/:campaignId/confirm` (Atomically validate, reserve capacity, snapshot recipients, and enqueue)
- `GET /api/whatsapp-notices/:campaignId` (Get status & aggregate counts)
- `GET /api/whatsapp-notices/:campaignId/recipients` (Paginated list of recipients with status, priority, reason)
- `POST /api/whatsapp-notices/:campaignId/cancel` (Cancel unsent recipients)

- [ ] **Step 1: Write service and endpoint tests**
- [ ] **Step 2: Implement `lib/services/whatsapp-notices.ts` with full hospital-scoped querying and atomic transactions**
- [ ] **Step 3: Implement API routes with session validation and Zod input validation**
- [ ] **Step 4: Verify API tests pass**

---

### Task 7: Frontend UI — WhatsApp Notices Section

**Files:**
- Modify: `app/(app)/layout.tsx` (Add navigation item)
- Create: `app/(app)/whatsapp-notices/page.tsx` (Notices Landing Page)
- Create: `app/(app)/whatsapp-notices/new/page.tsx` (Creation Wizard Container)
- Create: `app/(app)/whatsapp-notices/[id]/page.tsx` (Campaign Progress & Details)
- Create: `components/whatsapp-notices/notice-type-step.tsx`
- Create: `components/whatsapp-notices/notice-details-step.tsx`
- Create: `components/whatsapp-notices/notice-recipients-step.tsx`
- Create: `components/whatsapp-notices/notice-preview-step.tsx`
- Create: `components/whatsapp-notices/campaign-progress-view.tsx`
- Create: `components/whatsapp-notices/template-preview-card.tsx`

**Features:**
- Step 1: Notice Type selection card (Hospital Closure, Doctor Schedule, Appointment Change).
- Step 2: Closure date picker, reason, contact info prefilled from hospital, live template preview with variable replacements.
- Step 3: Recipient selection with mode switch (Recent active patients, manual phone entry with country code validation, patient search by name/phone, duplicate prevention, live counter vs 250 cap and account capacity).
- Step 4: Preview breakdown (Mandatory count, displaced count with list of displaced names/phones, ineligible list with reasons, paginated table of planned recipients, confirmation button with explicit summary).
- Step 5: Campaign tracker (Status pills, progress bars, breakdown of Queued, Accepted, Delivered, Read, Failed, Suppressed, Pending Capacity, Cancel button).

- [ ] **Step 1: Add navigation link in `app/(app)/layout.tsx` for authorized users**
- [ ] **Step 2: Build notices landing dashboard with statistics, list, and create action**
- [ ] **Step 3: Implement wizard steps 1 through 4 with state persistence and back navigation**
- [ ] **Step 4: Implement campaign progress tracker with live polling / refresh**
- [ ] **Step 5: Verify responsive layout and keyboard accessibility**

---

### Task 8: Full Verification & Automated Tests

**Files:**
- Create: `lib/services/__tests__/whatsapp-notices-e2e.test.ts`
- Run: Full test suite `npm test` and `npx tsc --noEmit`

- [ ] **Step 1: Run all unit & integration tests**
- [ ] **Step 2: Run TypeScript typecheck to verify zero compile errors**
- [ ] **Step 3: Run migration linter**
- [ ] **Step 4: Document results and verification evidence**
