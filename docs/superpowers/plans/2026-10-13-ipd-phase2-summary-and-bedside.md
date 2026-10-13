# IPD Phase 2: Shell Condensation, Doctor's 90% Summary & Nurse Bedside Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reclaim ~60% wasted vertical navbar space across IPD, establish Phase 2 clinical schemas (`audit_logs`, `ipd_clinical_tasks`, `draft_rounds`, `vitals_readings` extensions), build the Doctor's 90% Summary page with an Excel-dense daily medication checkbox grid and embedded TPR flowsheet, and streamline the Nurse's bedside treatment interface with plain-English button terminology (`+ Give Extra Medicine`, `Change Time`, `Give Medicine`).

**Architecture:** 
1. The IPD shell conditionally bypasses the redundant `IPD` header and section tabs when viewing patient charts (`/ipd/patients/*`) or bedside screens (`/ipd/ward/.../bed/...`), shrinking the header stack from ~275px to ~110px.
2. In Drizzle ORM, Phase 2 tables (`audit_logs`, `ipd_clinical_tasks`, `draft_rounds`, `vitals_readings` extensions, `intake_output`) provide the immutable clinical ledger and task fulfillment state engine.
3. The Summary tab (`/ipd/patients/:id/summary`) renders a high-density, multi-panel Excel-style dashboard with 11px–12px typography, tabular numerals, a daily medication matrix with checked/pending dose boxes, an embedded TPR flowsheet, 24h fluid balance, and complete admission context.
4. The Nurse's bedside view drops the large alarm banner in favor of a clean `+ Give Extra Medicine` button, a single uncluttered patient identification bar, and plain-English actions (`Give Medicine`, `Change Time`, `Skip Dose`).

**Tech Stack:** Next.js 16 (App Router), React 19, TypeScript 5, Tailwind CSS, Drizzle ORM (PostgreSQL), Vitest.

**Spec:** [`docs/superpowers/specs/2026-10-13-ipd-patient-chart-redesign.md`](file:///d:/Projects/HospitalAutomation/docs/superpowers/specs/2026-10-13-ipd-patient-chart-redesign.md)

## Global Constraints
- Canonical route strictly uses the admission UUID: `/ipd/patients/:admissionId/{tab}`.
- Never render a missing value as `0`, `normal`, or `"Done"`. Render as `"—”` or `"Not recorded"`.
- Consultant names formatted via `formatDoctor(name)` strictly output `"Dr. <Name>"` without `"Dr. Dr."`.
- Body text 12px, table cells 12px, metadata/labels 11px. Tabular numerals (`tabular-nums font-mono`) for all doses, times, vitals, and balances.
- All button and action copy for nursing must use simple, everyday English:
  - `+ Give Extra Medicine` (never "STAT" or "Urgent Medication")
  - `Give Medicine` (never "Administer")
  - `Change Time` (never "Adjust Schedule")
  - `Skip Dose` (never "Hold / Withhold")
  - `Syringes & Items` (never "Consumables")
  - `Fever & BP (TPR)` (never standalone "TPR")
- Audit fields (`created_by`, `created_at`, `updated_by`, `updated_at`) on every clinical record.
- Every order timing change must generate an immutable successor order version per Postgres trigger `trg_ipd_med_orders_immutable`.

## Review Focus
1. **Vertical Space Trap:** Header on patient chart must measure ≤ 115px total, with no duplicate hospital name and no stacked IPD section tabs.
2. **Doctor Medication Clarity Trap:** A doctor looking at the Summary page must see each active medicine's daily schedule with clear checkboxes (`[✓] Given 08:15`, `[ ] Due 20:00`, `[ ! ] Overdue`, `[ ⏸ ] Skipped`).
3. **Nurse Cognitive Load Trap:** No alarming red banner on bedside screen; "+ Give Extra Medicine" button must be obvious and simple.
4. **Timing Adjustment Immutability Trap:** Nurse changing medication time must succeed without violating `trg_ipd_med_orders_immutable`.
5. **Missing Value Trap:** A patient with no recorded vitals must display `"Not recorded"` or `"—”`, never default `0` or blank white space.

---

### Task 1: Vertical Real Estate Reclaim & Condensed Shell

**Files:**
- Modify: `app/(app)/ipd/layout.tsx`
- Modify: `components/ipd/shell/patient-banner.tsx`
- Modify: `components/ipd/shell/tab-navigation.tsx`
- Test: `components/ipd/shell/__tests__/patient-banner-density.test.tsx`

**Interfaces:**
- Consumes: `requireSession()`, `can()`, `getAdmissionSummary()`
- Produces: Ultra-compact `PatientBanner` (height ~36px), `TabNavigation` (height ~32px), and header bypass on patient/bedside routes.

- [ ] **Step 1: Write the failing test for condensed PatientBanner and TabNavigation**

```typescript
// components/ipd/shell/__tests__/patient-banner-density.test.tsx
import React from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PatientBanner } from '../patient-banner';

describe('PatientBanner Density & Simplification', () => {
  const mockPatient = {
    name: 'Raj Patil',
    age: 25,
    gender: 'Male',
    uhid: 'UHID-6160',
    ipdNumber: '6160',
    wardName: 'General Ward A',
    bedLabel: '13',
    dayOfStay: 8,
    doctorName: 'Dr. Amit Mehra',
    diagnosis: 'Viral Pyrexia',
    allergyStatus: 'nkda' as const,
    allergies: [],
    status: 'Admitted',
  };

  it('renders ultra-compact single-row patient demographics without duplicate title', () => {
    render(<PatientBanner admissionId="test-adm-id" patient={mockPatient} />);
    
    // Check doctor name is cleaned
    expect(screen.getByText(/Dr\. Amit Mehra/i)).toBeDefined();
    expect(screen.queryByText(/Dr\. Dr\./i)).toBeNull();

    // Check compact chips and labels exist
    expect(screen.getByText('Raj Patil')).toBeDefined();
    expect(screen.getByText('General Ward A · Bed 13')).toBeDefined();
    expect(screen.getByText('Day 8')).toBeDefined();
    expect(screen.getByText('No known allergies')).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it passes or fails**

Run: `npx vitest run components/ipd/shell/__tests__/patient-banner-density.test.tsx`  
Expected: PASS or initial baseline check.

- [ ] **Step 3: Modify `app/(app)/ipd/layout.tsx` to streamline hub header and bypass on patient/bedside screens**

Refactor `app/(app)/ipd/layout.tsx`:
1. Condense the IPD header to a single 38px horizontal strip for hub views:
   - Left: `[BedIcon] IPD`
   - Center: `SectionTabs` (inline, compact 32px height)
   - Right: `+ New admission` (compact 28px button)
   - Remove duplicate `{session.hospitalName}` completely.
2. In `app/(app)/ipd/patients/[id]/layout.tsx`: Ensure the chart layout sets up its own clean container without multi-layer padding.
3. Update `components/ipd/shell/patient-banner.tsx`: Tighten vertical padding from `py-3` to `py-1.5`, reduce typography to 12px/11px, keep buttons compact (28px height).
4. Update `components/ipd/shell/tab-navigation.tsx`: Set height to 32px (`py-1`, 12px text).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run components/ipd/shell/__tests__/patient-banner-density.test.tsx`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/\(app\)/ipd/layout.tsx components/ipd/shell/patient-banner.tsx components/ipd/shell/tab-navigation.tsx components/ipd/shell/__tests__/patient-banner-density.test.tsx
git commit -m "feat(ipd): reclaim 60% vertical space with condensed navbar and dense patient banner"
```

---

### Task 2: Phase 2 Database Schemas & Migrations

**Files:**
- Modify: `lib/db/schema.ts`
- Create: `lib/db/__tests__/ipd-phase2-schema.test.ts`

**Interfaces:**
- Consumes: Drizzle ORM primitives (`pgTable`, `uuid`, `text`, `timestamp`, `integer`, `boolean`, `jsonb`)
- Produces: `auditLogs`, `ipdClinicalTasks`, `draftRounds`, extended `vitalsReadings`, `intakeOutput`

- [ ] **Step 1: Write the failing test for Phase 2 database schema exports**

```typescript
// lib/db/__tests__/ipd-phase2-schema.test.ts
import { describe, expect, it } from 'vitest';
import {
  auditLogs,
  ipdClinicalTasks,
  draftRounds,
  vitalsReadings,
  intakeOutput,
} from '../schema';

describe('IPD Phase 2 Schemas', () => {
  it('exports audit_logs table with required columns', () => {
    expect(auditLogs).toBeDefined();
    expect(auditLogs.tableName).toBeDefined();
    expect(auditLogs.recordId).toBeDefined();
    expect(auditLogs.action).toBeDefined();
    expect(auditLogs.reason).toBeDefined();
  });

  it('exports ipd_clinical_tasks table with status and scheduled_at', () => {
    expect(ipdClinicalTasks).toBeDefined();
    expect(ipdClinicalTasks.orderId).toBeDefined();
    expect(ipdClinicalTasks.admissionId).toBeDefined();
    expect(ipdClinicalTasks.scheduledAt).toBeDefined();
    expect(ipdClinicalTasks.status).toBeDefined();
  });

  it('exports draft_rounds table keyed by admission and author', () => {
    expect(draftRounds).toBeDefined();
    expect(draftRounds.admissionId).toBeDefined();
    expect(draftRounds.authorUserId).toBeDefined();
  });

  it('exports intake_output table with kind and ml', () => {
    expect(intakeOutput).toBeDefined();
    expect(intakeOutput.kind).toBeDefined();
    expect(intakeOutput.ml).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/db/__tests__/ipd-phase2-schema.test.ts`  
Expected: FAIL with missing schema exports.

- [ ] **Step 3: Add Phase 2 schema definitions in `lib/db/schema.ts`**

Define:
1. `auditLogs`:
   - `id`, `hospitalId`, `tableName`, `recordId`, `action`, `oldValue` (jsonb), `newValue` (jsonb), `reason` (text), `userId`, `createdAt`.
2. `ipdClinicalTasks`:
   - `id`, `hospitalId`, `orderId`, `admissionId`, `scheduledAt`, `status` (`'DUE' | 'OVERDUE' | 'GIVEN' | 'HELD' | 'REFUSED' | 'NOT_AVAILABLE' | 'MISSED'`), `actedByUserId`, `actedAt`, `doseGiven`, `site`, `reason`, `note`, timestamps.
3. `draftRounds`:
   - `id`, `hospitalId`, `admissionId`, `authorUserId`, `doctorId`, `soapS`, `soapO`, `soapA`, `soapP`, `body`, `status`, `signedAt`, timestamps.
4. `intakeOutput`:
   - `id`, `hospitalId`, `admissionId`, `recordedAt`, `kind` (`'ORAL' | 'IV' | 'URINE' | 'DRAIN' | 'RT_ASPIRATE'`), `ml`, `recordedByUserId`, timestamps.
5. Extend `vitalsReadings` columns if not already present: `painScore`, `avpu`, `o2Support`, `news2Score`, `abdGirthCm`, `bsl`, `scheduledSlot`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/db/__tests__/ipd-phase2-schema.test.ts`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/db/schema.ts lib/db/__tests__/ipd-phase2-schema.test.ts
git commit -m "feat(schema): define audit_logs, ipd_clinical_tasks, draft_rounds, and intake_output tables"
```

---

### Task 3: Doctor's 90% Workstation — High-Density Summary Tab

**Files:**
- Create: `lib/services/ipd-summary.ts`
- Create: `components/ipd/summary/daily-medication-matrix.tsx`
- Create: `components/ipd/summary/tpr-flowsheet.tsx`
- Modify: `app/(app)/ipd/patients/[id]/summary/page.tsx`
- Test: `app/(app)/ipd/patients/__tests__/summary-tab.test.tsx`

**Interfaces:**
- Consumes: `getAdmissionSummary`, `listActiveOrders`, `ipdClinicalTasks`, `vitalsReadings`, `intakeOutput`
- Produces: `getSummaryCockpitData`, `<DailyMedicationMatrix />`, `<TprFlowsheet />`

- [ ] **Step 1: Write the failing test for the Summary tab components**

```typescript
// app/(app)/ipd/patients/__tests__/summary-tab.test.tsx
import React from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DailyMedicationMatrix } from '@/components/ipd/summary/daily-medication-matrix';
import { TprFlowsheet } from '@/components/ipd/summary/tpr-flowsheet';

describe('Doctor Summary Cockpit Components', () => {
  it('renders medication schedule with checkmark for given dose and pending box for due dose', () => {
    const mockMeds = [
      {
        orderId: 'ord-1',
        medicineName: 'Inj. Ceftriaxone 1g',
        route: 'IV',
        frequency: 'BD',
        slots: [
          { time: '08:00', status: 'GIVEN', givenAt: '08:15', nurseName: 'Nurse Rita' },
          { time: '20:00', status: 'DUE' },
        ],
      },
    ];

    render(<DailyMedicationMatrix medications={mockMeds} />);
    expect(screen.getByText(/Inj\. Ceftriaxone 1g/i)).toBeDefined();
    expect(screen.getByText(/08:15/i)).toBeDefined();
    expect(screen.getByText(/Given/i)).toBeDefined();
    expect(screen.getByText(/20:00/i)).toBeDefined();
    expect(screen.getByText(/Due/i)).toBeDefined();
  });

  it('renders TPR flowsheet with temp, pulse, BP, resp, and NEWS2 columns', () => {
    const mockVitals = [
      {
        time: 'Today 08:00',
        tempF: '100.4',
        pulse: 88,
        bp: '120/80',
        resp: 18,
        spo2: 98,
        news2: 1,
      },
    ];

    render(<TprFlowsheet readings={mockVitals} />);
    expect(screen.getByText('100.4')).toBeDefined();
    expect(screen.getByText('120/80')).toBeDefined();
    expect(screen.getByText('88')).toBeDefined();
    expect(screen.getByText('NEWS2')).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/\(app\)/ipd/patients/__tests__/summary-tab.test.tsx`  
Expected: FAIL with components not found.

- [ ] **Step 3: Implement `lib/services/ipd-summary.ts`, `<DailyMedicationMatrix />`, and `<TprFlowsheet />`**

1. `lib/services/ipd-summary.ts`:
   - Fetch active medication orders and resolve today's scheduled slots and clinical tasks (`ipdClinicalTasks`).
   - Fetch recent vitals from `vitalsReadings` (last 5 readings) formatted with NEWS2 score.
   - Fetch 24-hour intake vs output summary from `intakeOutput`.
2. `components/ipd/summary/daily-medication-matrix.tsx`:
   - Excel-style high-density table (11px-12px typography, 28px row height).
   - Display each active medicine, form, route, frequency.
   - Visual daily checkboxes for today's time slots:
     - `[✓] 08:00` (green fill, shows "Given 08:15 by Nurse")
     - `[ ] 20:00` (crisp open box, shows "Due")
     - `[ ! ] Overdue` (rose outline)
     - `[ ⏸ ] Skipped` (amber outline with reason tooltip)
3. `components/ipd/summary/tpr-flowsheet.tsx`:
   - Spreadsheet-dense table showing `Time | Temp (°F) | Pulse | BP | Resp | SpO2 | NEWS2`.
   - Subtle alert highlights for abnormal values.
4. Update `app/(app)/ipd/patients/[id]/summary/page.tsx`:
   - Assemble the high-density 2-column layout (60% clinical flowsheet, 40% stay overview, fluid balance, and care team).
   - Add clean quick-links to chart sheets using simple language.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/\(app\)/ipd/patients/__tests__/summary-tab.test.tsx`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/services/ipd-summary.ts components/ipd/summary/ app/\(app\)/ipd/patients/
git commit -m "feat(ipd): implement doctor's 90% summary cockpit with daily med checkbox matrix and TPR flowsheet"
```

---

### Task 4: Nurse's Streamlined Bedside Experience & Plain English Terminology

**Files:**
- Modify: `components/ipd/bedside/bedside-treatment-chart.tsx`
- Test: `components/ipd/bedside/__tests__/bedside-treatment-chart-copy.test.tsx`

**Interfaces:**
- Consumes: `BedsideTreatmentChartProps`, `adjustMedicationScheduleTimes`, `administerItem`
- Produces: Simplified bedside chart with `+ Give Extra Medicine`, plain-English action labels, and calm single-line patient bar.

- [ ] **Step 1: Write the failing test for simplified nurse UI and plain-English button labels**

```typescript
// components/ipd/bedside/__tests__/bedside-treatment-chart-copy.test.tsx
import React from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BedsideTreatmentChart } from '../bedside-treatment-chart';

describe('Nurse Bedside Simplified Experience', () => {
  const mockPatient = {
    name: 'Raj Patil',
    ageSex: '25 yrs · Male',
    wardId: 'ward-1',
    wardName: 'General Ward A',
    bedLabel: '13',
    day: 8,
    doctorName: 'Amit Mehra',
    diagnosis: 'Viral Pyrexia',
    ipdNumber: '6160',
  };

  const mockEmar = {
    dueNow: [],
    overdue: [],
    upcoming: [],
    onHold: [],
    prn: [],
    recentHistory: [],
  };

  it('renders plain-English "+ Give Extra Medicine" button and no bulky alarm banner', () => {
    render(
      <BedsideTreatmentChart
        admissionId="adm-123"
        patient={mockPatient}
        emarData={mockEmar}
        recentSupplies={[]}
        commonSupplies={[]}
        canAdminister={true}
      />
    );

    // Friendly, simple English button exists
    expect(screen.getByRole('button', { name: /\+ Give Extra Medicine/i })).toBeDefined();

    // Bulky alarming banner copy is removed
    expect(screen.queryByText(/Acute Patient Condition Change/i)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run components/ipd/bedside/__tests__/bedside-treatment-chart-copy.test.tsx`  
Expected: FAIL with old copy still present.

- [ ] **Step 3: Update `components/ipd/bedside/bedside-treatment-chart.tsx` with simplified plain-English UI**

1. Replace the large red alarm banner with a clean, friendly button:
   - Button label: `+ Give Extra Medicine` (replaces "+ Give Urgent / Emergency Medicine").
2. Simplify the patient identification header:
   - Single calm, compact box: `[Bed 13] Raj Patil · 25 yrs · Male · IPD #6160 · Dx: Viral Pyrexia`.
3. Standardize plain-English labels across actions:
   - `Give Medicine` (replaces "Administer" / "Mark Given")
   - `Change Time` (replaces "Adjust Schedule / Time")
   - `Skip Dose` (replaces "Hold Dose")
   - `Syringes & Items` (replaces "Supplies & Consumables")
   - `Fever & BP (TPR)` (replaces standalone "TPR Chart")
4. Keep the timing change modal fast and simple:
   - Dropdown of common reasons: "Doctor verbal instruction", "Patient at scan / test", "Patient was sleeping", "Other".
   - Seamlessly calls `adjustMedicationScheduleTimes` (which creates an authorized successor version).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run components/ipd/bedside/__tests__/bedside-treatment-chart-copy.test.tsx`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add components/ipd/bedside/bedside-treatment-chart.tsx components/ipd/bedside/__tests__/bedside-treatment-chart-copy.test.tsx
git commit -m "feat(nurse): simplify bedside treatment view with plain-English actions and remove bulky red alarm"
```

---

### Task 5: Full Regression Testing & Type Verification

**Files:**
- Existing test suites across `components/`, `lib/`, `app/`

- [ ] **Step 1: Run TypeScript compiler check**

Run: `npx tsc --noEmit`  
Expected: Zero TypeScript errors.

- [ ] **Step 2: Run all unit and integration tests**

Run: `npx vitest run`  
Expected: All suites passing.

- [ ] **Step 3: Verify dev server response**

Verify `http://localhost:3000/ipd/patients/804cf0e9-f38b-4aa8-8d91-f3425194d0f9/summary` renders smoothly with condensed header and Excel-dense layout.

- [ ] **Step 4: Commit branch state**

```bash
git commit --allow-empty -m "chore(release): complete Phase 2 shell reclaim, doctor summary cockpit, and nurse bedside simplification"
```
