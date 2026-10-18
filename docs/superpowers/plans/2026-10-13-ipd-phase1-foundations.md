# IPD Phase 1: Foundations & Shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish clinical constants, the `formatDoctor` title cleaner, standard 480px Drawer, StatusBadge, canonical `/ipd/patients/:admissionId` routing with the sticky `PatientBanner`, 8-tab shell, non-regressive minimal Orders and Discharge tabs, and explicit UHID/Patient lookup redirect.

**Architecture:** A unified patient chart layout (`/ipd/patients/[admissionId]/layout.tsx`) renders the single sticky `PatientBanner` and 8 canonical navigation tabs once. It consumes tenant-isolated clinical data, formats consultant titles without `"Dr. Dr."`, and delegates child pages to the 8 tabs. Legacy `/ipd/admissions/:id/*` routes 307-redirect to the canonical admission URL, and an explicit `/ipd/lookup` route handles UHID lookups safely without PII in history.

**Tech Stack:** Next.js 16 (App Router), React 19, TypeScript 5, Tailwind CSS, Drizzle ORM, Vitest.

**Spec:** [`docs/superpowers/specs/2026-10-13-ipd-patient-chart-redesign.md`](file:///d:/Projects/HospitalAutomation/docs/superpowers/specs/2026-10-13-ipd-patient-chart-redesign.md)

## Global Constraints
- Canonical route strictly uses the admission UUID: `/ipd/patients/:admissionId/{tab}`.
- Never render a missing value as `0`, `normal`, or `"Done"`. Render as `"—”` or `"Not recorded"`.
- Consultant names formatted via `formatDoctor(name)` strictly output `"Dr. <Name>"` without `"Dr. Dr."`.
- Body text 14px, table cells 13px, metadata 12px. Font weights 400 and 600 only. No monospace in chrome.
- Nurse touch targets minimum 44px.
- Audit fields (`created_by`, `created_at`, `updated_by`, `updated_at`) on every clinical record.
- Four standard screen states on every view: loading (skeleton), empty, error (retry), no-permission.

## Review Focus
1. **Double Title Trap:** Input `"Dr. Dr. Anand Sharma"` or `"Dr Anand Sharma"` must output `"Dr. Anand Sharma"`, never `"Dr. Dr. Anand Sharma"`.
2. **Missing Room Charge Trap:** Day 8 admission with ₹0 room rate must trigger missing room rate attention item, not silent zero.
3. **Discharge Regression Trap:** Accessing `/ipd/patients/:admissionId/discharge` must allow toggling discharge readiness and reviewing discharge bill without loss of existing features.
4. **Orders Regression Trap:** Accessing `/ipd/patients/:admissionId/orders` must display active orders with Stop (requiring reason) and Modify actions.
5. **PII in History Trap:** Searching by UHID must go to `/ipd/lookup?uhid=...` and immediately 307-redirect to `/ipd/patients/:admissionId/summary`.

---

### Task 1: Clinical Constants & Status Colors

**Files:**
- Create: `constants/clinical.ts`
- Test: `constants/__tests__/clinical.test.ts`

**Interfaces:**
- Consumes: None
- Produces: `OrderType`, `OrderStatus`, `PriorityTag`, `TaskStatus`, `HoldReasons`, `RefusedReasons`, `NotAvailableReasons`, `LateReasons`, `StopReasons`, `OverrideReasons`, `AdmissionStatus`, `BadgeColors`

- [ ] **Step 1: Write the failing test for clinical constants**

```typescript
// constants/__tests__/clinical.test.ts
import { describe, expect, it } from 'vitest';
import {
  OrderType,
  OrderStatus,
  PriorityTag,
  TaskStatus,
  HoldReasons,
  RefusedReasons,
  NotAvailableReasons,
  LateReasons,
  StopReasons,
  OverrideReasons,
  AdmissionStatus,
  BadgeColors,
} from '../clinical';

describe('Clinical Constants', () => {
  it('defines all clinical order types, statuses, and reasons verbatim', () => {
    expect(OrderType.MEDICATION).toBe('MEDICATION');
    expect(OrderStatus.ACTIVE).toBe('ACTIVE');
    expect(PriorityTag.EMERGENCY).toBe('EMERGENCY');
    expect(TaskStatus.OVERDUE).toBe('OVERDUE');
    expect(HoldReasons).toContain('NPO');
    expect(RefusedReasons).toContain('Patient refused');
    expect(NotAvailableReasons).toContain('Out of stock');
    expect(LateReasons).toContain('Patient away from ward');
    expect(StopReasons).toContain('Course complete');
    expect(OverrideReasons).toContain('Benefit outweighs risk');
    expect(AdmissionStatus.ADMITTED).toBe('Admitted');
    expect(BadgeColors.green).toContain('emerald');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run constants/__tests__/clinical.test.ts`  
Expected: FAIL with module not found `../clinical`.

- [ ] **Step 3: Implement `constants/clinical.ts`**

Export the complete enumeration and reason arrays matching §2.2 of the specification.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run constants/__tests__/clinical.test.ts`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add constants/clinical.ts constants/__tests__/clinical.test.ts
git commit -m "feat(clinical): define clinical constants, reason codes, and badge styles"
```

---

### Task 2: Doctor Title Formatter (`formatDoctor`)

**Files:**
- Create: `lib/domain/doctor.ts`
- Test: `lib/domain/__tests__/doctor.test.ts`

**Interfaces:**
- Consumes: None
- Produces: `formatDoctor(name: string | null | undefined): string`

- [ ] **Step 1: Write the failing test for `formatDoctor`**

```typescript
// lib/domain/__tests__/doctor.test.ts
import { describe, expect, it } from 'vitest';
import { formatDoctor } from '../doctor';

describe('formatDoctor Formatter', () => {
  it('normalizes various consultant title inputs to Dr. exactly once', () => {
    expect(formatDoctor('Anand Sharma')).toBe('Dr. Anand Sharma');
    expect(formatDoctor('Dr. Anand Sharma')).toBe('Dr. Anand Sharma');
    expect(formatDoctor('Dr Anand Sharma')).toBe('Dr. Anand Sharma');
    expect(formatDoctor('Dr. Dr. Anand Sharma')).toBe('Dr. Anand Sharma');
    expect(formatDoctor('Doctor Anand Sharma')).toBe('Dr. Anand Sharma');
    expect(formatDoctor('dr. anand sharma')).toBe('Dr. Anand Sharma');
    expect(formatDoctor('  Dr.  Anand Sharma  ')).toBe('Dr. Anand Sharma');
  });

  it('handles null, undefined, or empty names safely', () => {
    expect(formatDoctor('')).toBe('—');
    expect(formatDoctor(null)).toBe('—');
    expect(formatDoctor(undefined)).toBe('—');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/domain/__tests__/doctor.test.ts`  
Expected: FAIL with module not found `../doctor`.

- [ ] **Step 3: Implement `formatDoctor` in `lib/domain/doctor.ts`**

Strip any leading `"Dr."`, `"Dr"`, `"Doctor"`, `"Dr. Dr."`, or whitespace case-insensitively, title-case the remaining name, and prepend `"Dr. "`. Return `"—”` if empty.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/domain/__tests__/doctor.test.ts`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/domain/doctor.ts lib/domain/__tests__/doctor.test.ts
git commit -m "feat(domain): implement formatDoctor with double-title elimination"
```

---

### Task 3: Standard Drawer & StatusBadge Components

**Files:**
- Create: `components/ipd/drawer.tsx`
- Create: `components/ipd/status-badge.tsx`
- Test: `components/ipd/__tests__/drawer-and-badge.test.tsx`

**Interfaces:**
- Consumes: `BadgeColors` from `@/constants/clinical`
- Produces: `Drawer`, `StatusBadge`

- [ ] **Step 1: Write the failing test**

```typescript
// components/ipd/__tests__/drawer-and-badge.test.tsx
import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { StatusBadge } from '../status-badge';
import { Drawer } from '../drawer';

describe('Drawer and StatusBadge Components', () => {
  it('renders StatusBadge with clinical color tokens', () => {
    const html = renderToString(<StatusBadge status="Ready for discharge" variant="green" />);
    expect(html).toContain('Ready for discharge');
    expect(html).toContain('emerald');
  });

  it('renders Drawer with patient context header (Name + UHID + Bed)', () => {
    const html = renderToString(
      <Drawer
        isOpen={true}
        onClose={() => {}}
        title="Assess Allergies"
        patient={{ name: 'Raj Patil', uhid: 'UHID-1042', bedLabel: 'Bed 2' }}
      >
        <p>Drawer Body</p>
      </Drawer>,
    );
    expect(html).toContain('Assess Allergies');
    expect(html).toContain('Raj Patil');
    expect(html).toContain('UHID-1042');
    expect(html).toContain('Bed 2');
    expect(html).toContain('Drawer Body');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run components/ipd/__tests__/drawer-and-badge.test.tsx`  
Expected: FAIL with module not found.

- [ ] **Step 3: Implement `components/ipd/status-badge.tsx` and `components/ipd/drawer.tsx`**

- `status-badge.tsx`: Renders status chip with 12px text, 600 weight, and `BadgeColors` styling.
- `drawer.tsx`: 480px slide-over with sticky patient header, backdrop, Escape key listener, and footer buttons.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run components/ipd/__tests__/drawer-and-badge.test.tsx`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add components/ipd/drawer.tsx components/ipd/status-badge.tsx components/ipd/__tests__/drawer-and-badge.test.tsx
git commit -m "feat(ui): add clinical Drawer and StatusBadge components"
```

---

### Task 4: Sticky PatientBanner Component

**Files:**
- Create: `components/ipd/shell/patient-banner.tsx`
- Test: `components/ipd/shell/__tests__/patient-banner.test.tsx`

**Interfaces:**
- Consumes: `formatDoctor` from `@/lib/domain/doctor`, `StatusBadge` from `@/components/ipd/status-badge`
- Produces: `PatientBanner`

- [ ] **Step 1: Write the failing test for `PatientBanner`**

```typescript
// components/ipd/shell/__tests__/patient-banner.test.tsx
import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { PatientBanner } from '../patient-banner';

describe('PatientBanner Component', () => {
  it('renders title-cased patient name, age/sex, UHID, IPD no, bed, consultant and allergy chip', () => {
    const html = renderToString(
      <PatientBanner
        admissionId="adm-101"
        patient={{
          name: 'RAJ PATIL',
          age: 45,
          gender: 'Male',
          uhid: 'UHID-2024-0012',
          ipdNumber: 1042,
          wardName: 'General Ward A',
          bedLabel: '12',
          dayOfStay: 4,
          doctorName: 'Dr. Anand Sharma',
          diagnosis: 'Acute Gastroenteritis',
          allergyStatus: 'allergies_documented',
          allergies: ['Penicillin', 'Sulfa'],
          status: 'Admitted',
        }}
      />,
    );

    expect(html).toContain('Raj Patil');
    expect(html).toContain('45 yrs · Male');
    expect(html).toContain('UHID-2024-0012');
    expect(html).toContain('IPD #1042');
    expect(html).toContain('General Ward A · Bed 12');
    expect(html).toContain('Day 4');
    expect(html).toContain('Dr. Anand Sharma');
    expect(html).not.toContain('Dr. Dr.');
    expect(html).toContain('Allergies: Penicillin, Sulfa');
    expect(html).toContain('Acute Gastroenteritis');
    expect(html).toContain('Admitted');
    expect(html).toContain('History');
    expect(html).toContain('Print file');
  });

  it('renders clickable amber chips when allergies or diagnosis are not recorded', () => {
    const html = renderToString(
      <PatientBanner
        admissionId="adm-102"
        patient={{
          name: 'Sunita Roy',
          age: 32,
          gender: 'Female',
          uhid: 'UHID-2024-0015',
          ipdNumber: 1045,
          wardName: 'ICU',
          bedLabel: '3',
          dayOfStay: 1,
          doctorName: 'Ramesh Kulkarni',
          diagnosis: null,
          allergyStatus: 'unreviewed',
          allergies: [],
          status: 'Admitted',
        }}
      />,
    );

    expect(html).toContain('Diagnosis not recorded');
    expect(html).toContain('Allergies not recorded');
    expect(html).toContain('Dr. Ramesh Kulkarni');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run components/ipd/shell/__tests__/patient-banner.test.tsx`  
Expected: FAIL with module not found.

- [ ] **Step 3: Implement `PatientBanner` in `components/ipd/shell/patient-banner.tsx`**

Sticky top banner with title-cased name, UHID, IPD no, Ward · Bed, Day N, clean consultant, interactive chips opening drawer state, status badge, History and Print file buttons.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run components/ipd/shell/__tests__/patient-banner.test.tsx`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add components/ipd/shell/patient-banner.tsx components/ipd/shell/__tests__/patient-banner.test.tsx
git commit -m "feat(ipd): implement single sticky PatientBanner with diagnosis and allergy drawer gates"
```

---

### Task 5: Canonical Layout & 8-Tab Navigation Shell

**Files:**
- Create: `app/(app)/ipd/patients/[id]/layout.tsx`
- Create: `components/ipd/shell/tab-navigation.tsx`
- Test: `app/(app)/ipd/patients/__tests__/tab-navigation.test.tsx`

**Interfaces:**
- Consumes: `PatientBanner` from `@/components/ipd/shell/patient-banner`
- Produces: Canonical layout and 8-tab sequence (`Summary | Orders | eMAR | Vitals & I/O | Notes | Investigations | Consumables & Billing | Discharge`)

- [ ] **Step 1: Write the failing test for Tab Navigation**

```typescript
// app/(app)/ipd/patients/__tests__/tab-navigation.test.tsx
import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { TabNavigation } from '@/components/ipd/shell/tab-navigation';

describe('TabNavigation Component', () => {
  it('renders all 8 canonical tabs in fixed sequence with active indicators', () => {
    const html = renderToString(
      <TabNavigation admissionId="adm-101" currentTab="summary" />,
    );

    expect(html).toContain('Summary');
    expect(html).toContain('Orders');
    expect(html).toContain('eMAR');
    expect(html).toContain('Vitals &amp; I/O');
    expect(html).toContain('Notes');
    expect(html).toContain('Investigations');
    expect(html).toContain('Consumables &amp; Billing');
    expect(html).toContain('Discharge');
    expect(html).toContain('/ipd/patients/adm-101/summary');
    expect(html).toContain('/ipd/patients/adm-101/orders');
    expect(html).toContain('/ipd/patients/adm-101/discharge');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/(app)/ipd/patients/__tests__/tab-navigation.test.tsx`  
Expected: FAIL with module not found.

- [ ] **Step 3: Implement `TabNavigation` and `app/(app)/ipd/patients/[id]/layout.tsx`**

- `components/ipd/shell/tab-navigation.tsx`: Renders the 8 fixed tabs, highlighting active route.
- `app/(app)/ipd/patients/[id]/layout.tsx`: Loads admission, logs record access, renders sticky `PatientBanner` and `TabNavigation`, then renders children.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/(app)/ipd/patients/__tests__/tab-navigation.test.tsx`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/(app)/ipd/patients/[id]/layout.tsx components/ipd/shell/tab-navigation.tsx app/(app)/ipd/patients/__tests__/tab-navigation.test.tsx
git commit -m "feat(ipd): implement canonical patient chart layout and 8-tab navigation"
```

---

### Task 6: Minimal Working Orders and Discharge Tabs (No Regression)

**Files:**
- Create: `app/(app)/ipd/patients/[id]/orders/page.tsx`
- Create: `app/(app)/ipd/patients/[id]/discharge/page.tsx`
- Create: `components/ipd/orders/minimal-orders-tab.tsx`
- Create: `components/ipd/discharge/discharge-tab.tsx`
- Test: `app/(app)/ipd/patients/__tests__/orders-and-discharge-tabs.test.tsx`

**Interfaces:**
- Consumes: `listActiveOrders` from `@/lib/services/ipd-medication-orders`, `setDischargeReady` from `@/lib/services/admissions`
- Produces: Minimal functioning Orders view and Discharge view

- [ ] **Step 1: Write the failing test**

```typescript
// app/(app)/ipd/patients/__tests__/orders-and-discharge-tabs.test.tsx
import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { MinimalOrdersTab } from '@/components/ipd/orders/minimal-orders-tab';
import { DischargeTab } from '@/components/ipd/discharge/discharge-tab';

describe('Minimal Orders and Discharge Tabs', () => {
  it('renders active orders with Stop and Modify action triggers', () => {
    const html = renderToString(
      <MinimalOrdersTab
        admissionId="adm-101"
        orders={[
          {
            id: 'ord-1',
            medicineName: 'Ceftriaxone 1g',
            doseAmount: '1',
            doseUnit: 'g',
            route: 'iv_push',
            status: 'active',
            frequencyCode: 'BD',
            scheduleTimes: ['08:00', '20:00'],
          } as any,
        ]}
      />,
    );

    expect(html).toContain('Ceftriaxone 1g');
    expect(html).toContain('BD');
    expect(html).toContain('Stop Order');
    expect(html).toContain('Modify');
  });

  it('renders discharge actions: discharge readiness toggle and discharge bill action', () => {
    const html = renderToString(
      <DischargeTab
        admissionId="adm-101"
        status="admitted"
        canDischarge={true}
      />,
    );

    expect(html).toContain('Discharge Workflow');
    expect(html).toContain('Mark Ready for Discharge');
    expect(html).toContain('Finalize Discharge Bill');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/(app)/ipd/patients/__tests__/orders-and-discharge-tabs.test.tsx`  
Expected: FAIL with module not found.

- [ ] **Step 3: Implement `MinimalOrdersTab` and `DischargeTab`**

- `MinimalOrdersTab`: Table displaying active medication orders with working `Stop` (prompting `StopReasons`) and `Modify`.
- `DischargeTab`: Preserves working `setDischargeReady` toggle and discharge billing link so no clinical capabilities vanish.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/(app)/ipd/patients/__tests__/orders-and-discharge-tabs.test.tsx`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/(app)/ipd/patients/[id]/orders/page.tsx app/(app)/ipd/patients/[id]/discharge/page.tsx components/ipd/orders/minimal-orders-tab.tsx components/ipd/discharge/discharge-tab.tsx app/(app)/ipd/patients/__tests__/orders-and-discharge-tabs.test.tsx
git commit -m "feat(ipd): implement non-regressive minimal Orders and Discharge tabs"
```

---

### Task 7: Safe Lookup Route & Legacy Redirects

**Files:**
- Create: `app/(app)/ipd/lookup/route.ts`
- Modify: `app/(app)/ipd/admissions/[id]/page.tsx`
- Modify: `app/(app)/ipd/admissions/[id]/(file)/layout.tsx`
- Test: `app/(app)/ipd/lookup/__tests__/lookup.test.ts`

**Interfaces:**
- Consumes: UHID or PatientId query params
- Produces: 307 redirect to `/ipd/patients/:admissionId/summary`

- [ ] **Step 1: Write the failing test for lookup**

```typescript
// app/(app)/ipd/lookup/__tests__/lookup.test.ts
import { describe, expect, it } from 'vitest';
import { resolveLookupRedirect } from '../lookup-service';

describe('IPD Lookup Service', () => {
  it('resolves active admission for a given UHID and returns canonical redirect path', async () => {
    const path = await resolveLookupRedirect({
      uhid: 'UHID-2024-0012',
      hospitalId: 'hosp-1',
    });
    expect(path).toMatch(/^\/ipd\/patients\/[a-zA-Z0-9-]+\/summary$/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/(app)/ipd/lookup/__tests__/lookup.test.ts`  
Expected: FAIL with module not found.

- [ ] **Step 3: Implement `resolveLookupRedirect` and `route.ts`**

- Checks `patients` by UHID or patient UUID.
- Fetches active admission for that patient.
- Returns `/ipd/patients/${admission.id}/summary`.
- If no active admission found, redirects to patient file with clear notice.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/(app)/ipd/lookup/__tests__/lookup.test.ts`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/(app)/ipd/lookup/route.ts app/(app)/ipd/lookup/lookup-service.ts app/(app)/ipd/lookup/__tests__/lookup.test.ts
git commit -m "feat(ipd): add safe UHID lookup redirect and legacy admission route aliases"
```

---

### Task 8: Verification & Responsive Visual Proof (Phase 1 Gate)

**Files:**
- Test: Run full test suite across `components/ipd/`, `lib/domain/`, `app/`

- [ ] **Step 1: Run type checking and unit tests**

```bash
npx tsc --noEmit
npx vitest run components/ipd/ lib/domain/ constants/
```
Expected: 0 TypeScript errors, 100% tests passing.

- [ ] **Step 2: Capture 1440px and 390px responsive screenshots**

Navigate to `/ipd/patients/<admissionId>/summary` using browser subagent or script:
- Desktop view (1440x900px): Verify sticky `PatientBanner`, 8 tabs, no `"Dr. Dr."`, minimal Orders tab, working Discharge tab.
- Mobile view (390x844px): Verify responsive banner wrapping, touch targets ≥ 44px, horizontal scrollable tabs.

- [ ] **Step 3: Commit Phase 1 deliverable**

```bash
git commit -am "chore(ipd): complete Phase 1 foundations and shell verification"
```
