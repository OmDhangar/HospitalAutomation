# SDD ledger — plan: docs/superpowers/plans/2026-10-13-ipd-phase1-foundations.md

## Pre-flight
- Pre-flight: Interfaces scanned. Task 1 produces constants consumed by Task 3 and Task 6. Task 2 produces formatDoctor consumed by Task 4. Task 4 produces PatientBanner consumed by Task 5. Task 5 produces layout for Task 6.

## Task 1: Clinical Constants & Status Colors
- Status: COMPLETED
- Commit: 858b359 feat(clinical): define clinical constants, reason codes, and badge styles
- Tests: constants/__tests__/clinical.test.ts (PASS)

## Task 2: Doctor Title Formatter (formatDoctor)
- Status: COMPLETED
- Commit: cb1f9a5 feat(domain): implement formatDoctor with double-title elimination
- Tests: lib/domain/__tests__/doctor.test.ts (PASS)

## Task 3: Standard Drawer & StatusBadge Components
- Status: COMPLETED
- Commit: 0075b1b feat(ui): add clinical Drawer and StatusBadge components
- Tests: components/ipd/__tests__/drawer-and-badge.test.tsx (PASS)

## Task 4: Sticky PatientBanner Component
- Status: COMPLETED
- Commit: 21fcdbe feat(ui): implement sticky PatientBanner component with title-casing and clean consultant
- Tests: components/ipd/shell/__tests__/patient-banner.test.tsx (PASS)

## Task 5: Canonical Layout & 8-Tab Navigation Shell
- Status: COMPLETED
- Commit: 012eb0c feat(ipd): implement canonical patient chart layout and 8-tab navigation
- Tests: app/(app)/ipd/patients/__tests__/tab-navigation.test.tsx (PASS)

## Task 6: Minimal Working Orders and Discharge Tabs (No Regression)
- Status: COMPLETED
- Commit: 18beacd feat(ipd): implement non-regressive minimal Orders and Discharge tabs
- Tests: app/(app)/ipd/patients/__tests__/orders-and-discharge-tabs.test.tsx (PASS)

## Task 7: Safe Lookup Route & Legacy Redirects
- Status: COMPLETED
- Commit: c348097 feat(ipd): add safe UHID lookup redirect and canonical summary routing
- Tests: app/(app)/ipd/lookup/__tests__/lookup.test.ts (PASS)

## Task 8: Verification & Phase 1 Gate
- Status: VERIFIED
- Typecheck: Full application code clean.
- Unit Tests: 7/7 test files, 12/12 tests PASS.
  - constants/__tests__/clinical.test.ts (PASS)
  - lib/domain/__tests__/doctor.test.ts (PASS)
  - components/ipd/__tests__/drawer-and-badge.test.tsx (PASS)
  - components/ipd/shell/__tests__/patient-banner.test.tsx (PASS)
  - app/(app)/ipd/patients/__tests__/tab-navigation.test.tsx (PASS)
  - app/(app)/ipd/patients/__tests__/orders-and-discharge-tabs.test.tsx (PASS)
  - app/(app)/ipd/lookup/__tests__/lookup.test.ts (PASS)
