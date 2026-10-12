# SDD ledger — plan: docs/superpowers/plans/2026-10-12-ipd-emar-phase3-doctor-cockpit.md

## Pre-flight Scan
| Task Pair | Produces / Consumes | Scan Result |
| :--- | :--- | :--- |
| Task 1 & Task 2 | Permissions & Routes / Server Action authorization checks | Consistent (`ipd.prescribe`, `ipd.view`) |
| Task 2 & Task 3 | Cockpit data loaders / Clinical context and active order review components | Consistent (`vitalsFreshness`, `allergyAssessment`, `activeOrders`) |
| Task 3 & Task 4 | Order resolution states / Signing modal diff and submission payload | Consistent (`OrderResolution`, `DraftOrderInput`) |
| Task 4 & Task 5 | Prescribing section & signing modal / Unified cockpit page orchestrator | Consistent |

Pre-flight: clean. Ready for Task 1.

Task 1: complete (commit fdef1c7, tests: npx vitest run lib/domain/__tests__/permissions.test.ts → 31/31 pass)

