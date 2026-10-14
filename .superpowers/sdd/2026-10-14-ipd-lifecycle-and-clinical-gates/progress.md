# SDD ledger — plan: docs/superpowers/plans/2026-10-14-ipd-lifecycle-and-clinical-gates.md

## Pre-flight scan
| Tasks | Shared Interface | Analysis |
|---|---|---|
| Task 1 & Task 4 | Discharge Billing / Finalization Gate | Task 1 audits unbilled eMAR doses in discharge bill (`getGivenWithoutBillReport`); Task 4 gates finalization of discharge billing on finalized discharge summary. Compatible and complementary. |
| Task 2 & Task 4 | Medication Orders & Reconciled Meds | Task 2 enforces allergy/duplicate checks on active orders; Task 4 reconciles home meds and outputs structured take-home prescriptions on discharge summary. Independent schemas, consistent naming. |
| Task 3 & Task 5 | Clinical Banner & Demographics | Task 3 displays weight/height/BMI in banner; Task 5 displays NEWS2 escalation banner in banner. Both integrate into `PatientBanner` cleanly without layout regression. |

Pre-flight: clean. No conflicting signatures or schema collisions.

Task 1: complete (commits b146b56..5801600, tests: npx vitest run lib/services/__tests__/ipd-outbox-worker.test.ts "app/(app)/ipd/__tests__/given-without-bill.test.ts" "app/api/cron/ipd-outbox/__tests__/route.test.ts" → 10/10 pass)
Task 2: complete (tests: npx vitest run "app/(app)/ipd/__tests__/allergy-gate-bypass.test.ts" "app/(app)/ipd/__tests__/duplicate-therapy-gate.test.ts" "app/(app)/ipd/__tests__/verbal-orders-cosign.test.ts" → 8/8 pass; full IPD suite 61/61 pass)
Task 3: complete (tests: npx vitest run "app/(app)/ipd/__tests__/measurements.test.ts" "components/ipd/shell/__tests__/" → 13/13 pass; full IPD suite 20/20 pass)
