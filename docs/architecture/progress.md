# Progress log

What each phase delivered, in the order it was built. The roadmap and the
reasoning behind it are in [../plans/hms-expansion-plan.md](../plans/hms-expansion-plan.md).
The decisions made along the way are in [decisions.md](decisions.md).

| Phase | What | Status |
|---|---|---|
| 0 | Permission matrix, role-check fixes | Done, committed (`ae68611`) |
| 1 | Walk-in address, billing foundation, Paid toggle | Done, committed (`ae68611`), migrated |
| 1+ | Security fix: RLS on two schedule tables | Done, committed (`ae68611`), migrated |
| 2 | Medicine catalogue, OPD consultation and prescription, print, history | Built and tested, **not yet committed or migrated** |
| 3 | IPD: admission, ward timeline, drugs given, IPD bill, discharge | Next |
| 4 | Lab: orders, worklist, results, lab billing | Planned |

---

## Phase 0: permissions

**Problem:** Three role checks were negations (`role !== 'doctor'`). A future
nurse or lab login would have seen Reports and the reception desk.

**Built:**
- `lib/domain/permissions.ts`: the `can(role, permission)` matrix.
  `StaffRole` is derived from the database enum.
- `app/(app)/layout.tsx`, `dashboard/page.tsx`: use the matrix.
- Settings rejects an unknown role instead of failing in the database.

## Phase 1: walk-in address and billing foundation

**For the hospital:**
- An optional **Address** field on the walk-in form.
- A one-tap **Paid / Unpaid** pill on every queue row (read-only for doctors).
- A **Seen today** card, so reception can collect after the consultation.
- A **consultation fee** per doctor in Settings.

**Built:**
- Migrations 0025 (`patients.address`) and 0026 (`encounters`, `services`,
  `bills`, `bill_items`, `patient_payments`, freeze triggers, RLS).
- `lib/domain/patient-billing.ts`: bill arithmetic in paise.
- `lib/services/patient-billing.ts`: fees, draft bill, charge once, pay and void.
- `components/paid-toggle.tsx`: optimistic pill, and the fee prompt for owners.
- `scripts/verify-migrations.mts`: rehearse migrations on a scratch database.

**Found and fixed along the way:**
- **Migration 0027:** `doctor_slot_overrides` and `doctor_interval_blocks` had no
  row-level security since 0015. A new test now asserts that no tenant table
  is unprotected.
- Production had no default privileges for the app role. New tables would have
  been invisible to the app. Fixed before migrating.

## Phase 2: medicines and OPD prescriptions

**For the hospital:**
- **Settings → Medicines:** the owner's catalogue.
  - Add, price, rename and remove medicines.
  - A "No price yet" filter.
  - One click adds 65 common generics (no prices).
- **Settings → Doctors → Doctor's login:** link each doctor to the login they
  use. **Required once per doctor** before they can write prescriptions.
- **Consultation panel** on the doctor's dashboard, under Now Serving:
  - Diagnosis, notes, prescription, advice and follow-up on one card.
  - Medicine search, with "add it if it's missing".
  - One-tap "Frequent" medicines, carrying the doctor's usual dose.
  - **Repeat last prescription** for returning patients.
  - Autosaved as you type.
  - "Complete & Call Next" saves the consultation first, and won't advance if
    saving fails.
  - After saving, the record is read-only. Revise creates a new version.
- **Earlier visits:** the patient's history, built from the records. Every view
  is logged.
- **Printable prescription** (A5): hospital, doctor, patient, diagnosis,
  medicines, advice, follow-up. No prices. Superseded prescriptions print with
  a banner.

**Built:**
- Migration 0028:
  - `medicines`, `consultation_drafts`, `diagnoses`, `clinical_notes`,
    `prescriptions`, `prescription_items`, `record_access_logs`.
  - The `clinical_access` key.
  - Guard triggers.
  - One-login-per-doctor index.
- `lib/db/index.ts`: `withTenant(…, { clinical: true })`.
- `lib/domain/consultation.ts`, `medicine.ts`, `starter-medicines.ts`.
- `lib/services/encounters.ts`, moved out of billing because both modules use
  it.
- `lib/services/consultations.ts`, `medicines.ts`; `hospital.ts#setDoctorUser`.
- `app/(app)/dashboard/consultation-panel.tsx` + `consultation-actions.ts`.
- `components/clinical/`: `medicine-picker.tsx`, `consultation-gate.tsx`.
- `app/print/prescription/[id]/`: the printable page.
- `app/api/medicines/search/route.ts`: typeahead (no prices for doctors).
- `app/(app)/settings/medicines/`: catalogue screen.

**Tests:**
- Unit tests for consultation validation, medicines and permissions.
- `consultations.integration.test.ts`:
  - saves are atomic;
  - old prescriptions keep their names after a rename;
  - removed medicines are refused on new prescriptions, and old ones still print;
  - revisions supersede, and saving unchanged content does nothing;
  - saved prescriptions can't be edited;
  - clinical rows are hidden without the key and from support sessions;
  - hospitals can't see each other's records;
  - drafts detect conflicts;
  - history is logged;
  - one login can't be linked to two doctors.

**Before the pilot doctor can use it:**
1. Apply migration 0028 (`npm run db:migrate`).
2. Settings → Doctors: link the doctor to their login.
3. Settings → Medicines: "Add common medicines" (or add their own).

## What is next: Phase 3 (IPD)

- Admit from the consultation panel, or directly for emergencies.
- An **Admitted** list for the ward.
- A per-patient timeline: progress notes, treatments, drugs given.
- The IPD bill: pick a medicine and a quantity, and the server prices it.
  Deposits, interim and final bills with numbering.
- Discharge summary and printout.

Open questions for the pilot are in [../plans/hms-expansion-plan.md §12](../plans/hms-expansion-plan.md).
