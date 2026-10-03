# Professional HMS Redesign & Mobile-First Queue UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform the hospital application into a clinical-grade, professional Hospital Management System (HMS) by replacing all raw emojis with precision SVG icons, upgrading UI styling, and implementing a zero-scroll mobile-first segmented queue & booking interface for receptionists and owners.

**Architecture:** 
- Centralize clean, accessible SVG vector icons in `components/icons.tsx`.
- Create a client-side `MobileDashboardTabs` component in `dashboard-queue-actions.tsx` to handle tab switching on mobile (`< lg`) while preserving the 3-column layout on desktop (`≥ lg`).
- Refactor all surfaces (dashboard, navigation, settings, display, reports, booking, alerts) to use consistent clinical iconography, badges, and responsive touch-first form controls.

**Tech Stack:** Next.js 16 (App Router), React 19, TypeScript, Tailwind CSS v4, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-02-professional-hms-redesign.md`

## Global Constraints
- Do not install heavyweight external UI icon libraries if lightweight, zero-dependency SVG components in `components/icons.tsx` can fulfill all requirements cleanly.
- Maintain full keyboard accessibility, semantic HTML, and ARIA labels.
- Mobile view (`< lg`) must allow adding a walk-in patient without scrolling past the waiting list.
- All existing tests in `vitest run` must pass without regressions.

## Review Focus
1. Mobile tab switching persists without unnecessary page reloads.
2. Form fields auto-focus properly when opening the "Add Walk-in" tab on mobile.
3. TV Display maintains high visibility from distance with clean SVG icons and high contrast.
4. Color-blind accessible status indicators (icons + text labels, not color alone).
5. Touch targets on mobile meet standard 44px minimum touch targets.

---

### Task 1: Create Centralized SVG Iconography System

**Files:**
- Create: `components/icons.tsx`
- Modify: `components/ui.tsx`

**Interfaces:**
- Produces: `StethoscopeIcon`, `TvIcon`, `ClockIcon`, `PhoneIcon`, `UserPlusIcon`, `BuildingIcon`, `MapPinIcon`, `ZapIcon`, `SettingsIcon`, `ShieldIcon`, `BarChartIcon`, `CreditCardIcon`, `FileTextIcon`, `LayersIcon`, `AlertTriangleIcon`, `InfoIcon`, `CalendarIcon`, `CheckIcon`, `XIcon`, `MenuIcon`, `UserIcon`, `PauseIcon`, `ChevronRightIcon` (all accepting standard `className?: string`).

- [ ] **Step 1: Write tests for icon components**
Create `components/__tests__/icons.test.tsx` verifying icons render with appropriate SVG attributes (`viewBox="0 0 24 24"`, `stroke="currentColor"`, `aria-hidden="true"`).

- [ ] **Step 2: Run test to verify it fails**
Run: `npm run test components/__tests__/icons.test.tsx`
Expected: FAIL (file not found)

- [ ] **Step 3: Implement `components/icons.tsx`**
Implement the full suite of SVG icons with configurable `className`, `size`, stroke widths, and accessibility defaults.

- [ ] **Step 4: Run test to verify it passes**
Run: `npm run test components/__tests__/icons.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**
```bash
git add components/icons.tsx components/__tests__/icons.test.tsx
git commit -m "feat(ui): add centralized SVG icon system for professional HMS"
```

---

### Task 2: Implement Mobile-First Segmented Queue Dashboard & Actions

**Files:**
- Modify: `app/(app)/dashboard/dashboard-queue-actions.tsx`
- Modify: `app/(app)/dashboard/page.tsx`

**Interfaces:**
- Consumes: `components/icons.tsx`
- Produces: `MobileDashboardSwitcher` component managing `'queue' | 'add' | 'overview'` active tab state on mobile.

- [ ] **Step 1: Add `MobileDashboardSwitcher` and refactor action buttons in `dashboard-queue-actions.tsx`**
  - Implement `MobileDashboardSwitcher` with sticky segmented tabs `[ Live Queue (N) ]`, `[ Add Walk-In ]`, `[ Today's Overview ]`.
  - Update `ViewModeToggle` to use `StethoscopeIcon` and `FileTextIcon` instead of `🩺` and `📋`.
  - Upgrade `CallNextButton`, `PausePatientButton`, and `QueueActionButton` with clean SVG icons and clinical styling.

- [ ] **Step 2: Refactor `app/(app)/dashboard/page.tsx`**
  - Integrate `MobileDashboardSwitcher` into the receptionist dashboard layout.
  - On mobile (`< lg`), conditionally render the active segment; on desktop (`≥ lg`), render the full 3-column dashboard.
  - Replace all doctor `🩺`, phone `📞`, clock `🕒`, and priority `⚡` emojis with `StethoscopeIcon`, `PhoneIcon`, `ClockIcon`, and `ZapIcon`.
  - Update doctor view header avatar and scheduled appointment banners.

- [ ] **Step 3: Run typecheck and existing tests**
Run: `npm run typecheck` and `npm run test`
Expected: PASS

- [ ] **Step 4: Commit**
```bash
git add app/\(app\)/dashboard/dashboard-queue-actions.tsx app/\(app\)/dashboard/page.tsx
git commit -m "feat(dashboard): add mobile segmented queue switcher and SVG iconography"
```

---

### Task 3: Elevate Navigation, Settings, and Scheduling Interfaces

**Files:**
- Modify: `components/mobile-nav.tsx`
- Modify: `app/(app)/settings/page.tsx`
- Modify: `app/(app)/settings/scheduling/doctor-schedule-manager.tsx`

**Interfaces:**
- Consumes: `components/icons.tsx`

- [ ] **Step 1: Update `components/mobile-nav.tsx`**
Replace emoji mapping with `StethoscopeIcon`, `BarChartIcon`, `CreditCardIcon`, `FileTextIcon`, `SettingsIcon`, `ShieldIcon`, `MenuIcon`, and `XIcon`.

- [ ] **Step 2: Update `app/(app)/settings/page.tsx`**
  - Replace `🏥` with `BuildingIcon`.
  - Replace `🩺`, `📍`, `⏱️` in doctor list with `StethoscopeIcon`, `MapPinIcon`, `ClockIcon`.
  - Replace `🌟 Hybrid`, `🎫 Live Queue`, `🕒 Time Slots` with clinical badge components.

- [ ] **Step 3: Update `app/(app)/settings/scheduling/doctor-schedule-manager.tsx`**
Replace emojis in schedule mode selection, dynamic tokens, and day cards with SVG icons.

- [ ] **Step 4: Run typecheck**
Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**
```bash
git add components/mobile-nav.tsx app/\(app\)/settings/page.tsx app/\(app\)/settings/scheduling/doctor-schedule-manager.tsx
git commit -m "feat(settings): replace emojis with professional HMS iconography and badges"
```

---

### Task 4: Upgrade TV Display, Public Booking, Reports, and System Alerts

**Files:**
- Modify: `app/display/[branchId]/page.tsx`
- Modify: `app/(app)/reports/page.tsx`
- Modify: `app/book/book-form.tsx`
- Modify: `lib/services/booking.ts`
- Modify: `components/toast.tsx`
- Modify: `components/display-live-updater.tsx`

- [ ] **Step 1: Update `app/display/[branchId]/page.tsx` and reports**
  - Replace empty state `🩺` with `StethoscopeIcon`.
  - Replace patient `👤` tag and break `⏸` status with SVG icons.
  - In `reports/page.tsx`, replace `📺 Open waiting-room display` with `TvIcon` and clean button styling.

- [ ] **Step 2: Update booking forms and notifications**
  - Replace `🕒` and `➕` in `app/book/book-form.tsx` and `lib/services/booking.ts`.
  - In `components/toast.tsx` and `components/display-live-updater.tsx`, replace `⚠️` and `ℹ️` with `AlertTriangleIcon` and `InfoIcon`.

- [ ] **Step 3: Run full test suite**
Run: `npm run test:all`
Expected: All tests PASS.

- [ ] **Step 4: Commit**
```bash
git add app/display/\[branchId\]/page.tsx app/\(app\)/reports/page.tsx app/book/book-form.tsx lib/services/booking.ts components/toast.tsx components/display-live-updater.tsx
git commit -m "feat(display): upgrade TV display, reports, booking, and alerts to SVG icons"
```

---

### Task 5: End-to-End Verification & Quality Review

- [ ] **Step 1: Execute full test and typecheck verification**
Run: `npm run typecheck && npm run test`
Expected: 0 errors, 100% test pass rate.

- [ ] **Step 2: Perform responsive viewport verification**
Verify that on mobile screens (`< 1024px`), switching to "Add Walk-In" immediately focuses the registration form with zero waiting list scrolling required, and on desktop (`≥ 1024px`), the full 3-column layout displays side-by-side.
