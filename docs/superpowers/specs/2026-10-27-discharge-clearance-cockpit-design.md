# Inpatient Discharge Clearance Cockpit Design Specification

**Document:** `docs/superpowers/specs/2026-10-27-discharge-clearance-cockpit-design.md`  
**Date:** 2026-10-27  
**Status:** Approved  

---

## 1. Problem Statement & Background

In the current IPD Discharge view (`components/ipd/discharge/discharge-tab.tsx`), the clearance cockpit is a static 4-box mockup that lacks operational usability:
* **Step 1 (Medical Clearance):** A simple single toggle button with no discharge type (Regular, LAMA, DAMA, Transfer) or clinical stability criteria.
* **Step 2 (Pharmacy Reconciliation & Return):** A single dummy local state checkbox with no real-world details on which unconsumed bedside medications were issued, what needs to be returned to the pharmacy, whether a credit note was issued, whether clinical MedRec was completed, or if take-home medications were counseled.
* **Missing Clearances:** Crucial hospital handovers mandated by NABH (Nursing IV cannula/catheter removal, belongings handover, zero pending lab specimens) are absent.
* **Gate Pass Security:** There is no tamper-evident, sequentially numbered Exit Gate Pass to prevent patients from leaving before full clinical and financial clearance.

---

## 2. Market Benchmark & Architectural Principles

Benchmarked against market-leading hospital systems (Epic Willow/Cadence, Cerner Millennium, Apollo Prism / Max Healthcare HIS, and NABH 5th Edition standards), the revamped Discharge Clearance Cockpit introduces a **5-Card Clearance Matrix**:

1. **Medical Clearance & Fit-to-Leave (Consultant Doctor):** Clinical stability certification, discharge classification (`regular`, `lama`, `dama`, `transfer`, `absconded`, `death`), and consultant sign-off.
2. **Pharmacy Clearance & Returns (Pharmacy & Nursing):**
   * *Bedside Returns Tracker:* Itemized unconsumed ampoules/vials/tablets returned to the inpatient pharmacy desk with Credit Note tracking.
   * *Medication Reconciliation (MedRec):* Verification that pre-admission home medications were reconciled with discharge medications.
   * *Take-Home (TTA) Dispensing & Counseling:* Take-home prescriptions fulfilled with nurse bedside counseling recorded.
3. **Nursing & Bedside Handover (Ward Nurse):** Invasive line removals (IV cannula, Foley catheter, drains), post-discharge wound care, discharge vitals, and return of patient original diagnostic films and personal belongings.
4. **Discharge Summary & Documentation (Doctor & Resident):** Finalized clinical summary version tracking, prescriber doctor registration details, and printed patient card.
5. **Billing Settlement & Exit Gate Pass (Billing Desk & Security):** Settlement of inpatient charges, insurance/TPA authorization, advance deposit reconciliation/refund, and final generation of a sequentially numbered **Discharge Gate Pass** (`GP-YYYY-XXXX`).

---

## 3. Data Architecture (`lib/db/schema.ts`)

### `ipd_discharge_clearances` Table

```typescript
export const ipdDischargeClearances = pgTable(
  'ipd_discharge_clearances',
  {
    id: id(),
    hospitalId: uuid('hospital_id')
      .notNull()
      .references(() => hospitals.id, { onDelete: 'cascade' }),
    admissionId: uuid('admission_id')
      .notNull()
      .references(() => admissions.id, { onDelete: 'cascade' }),

    // 1. Medical Clearance
    dischargeType: text('discharge_type')
      .$type<'regular' | 'lama' | 'dama' | 'transfer' | 'absconded' | 'death'>()
      .notNull()
      .default('regular'),
    clinicalFitAt: timestamp('clinical_fit_at', { withTimezone: true }),
    clinicalFitByUserId: uuid('clinical_fit_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    clinicalStabilityNotes: text('clinical_stability_notes'),

    // 2. Pharmacy Clearance
    pharmacyReturnedAt: timestamp('pharmacy_returned_at', { withTimezone: true }),
    pharmacyReturnedByUserId: uuid('pharmacy_returned_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    pharmacyCreditNoteNo: text('pharmacy_credit_note_no'),
    pharmacyCreditAmountPaise: integer('pharmacy_credit_amount_paise').default(0),
    pharmacyReturnItems: jsonb('pharmacy_return_items')
      .$type<PharmacyReturnItem[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    takeHomeDispensedAt: timestamp('take_home_dispensed_at', { withTimezone: true }),
    takeHomeCounseled: boolean('take_home_counseled').notNull().default(false),
    takeHomeCounselingNotes: text('take_home_counseling_notes'),

    // 3. Nursing Clearance
    nursingClearedAt: timestamp('nursing_cleared_at', { withTimezone: true }),
    nursingClearedByUserId: uuid('nursing_cleared_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    ivCannulaRemoved: boolean('iv_cannula_removed').notNull().default(false),
    foleyCatheterRemoved: boolean('foley_catheter_removed').notNull().default(false),
    drainsRemoved: boolean('drains_removed').notNull().default(false),
    woundDressingDone: boolean('wound_dressing_done').notNull().default(false),
    belongingsAndReportsHandedOver: boolean('belongings_and_reports_handed_over').notNull().default(false),
    dischargeVitalsTaken: boolean('discharge_vitals_taken').notNull().default(false),
    nursingHandoverNotes: text('nursing_handover_notes'),

    // 4. Diagnostics Clearance
    diagnosticsClearedAt: timestamp('diagnostics_cleared_at', { withTimezone: true }),
    diagnosticsClearedByUserId: uuid('diagnostics_cleared_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    diagnosticsNotes: text('diagnostics_notes'),

    // 5. Billing & Gate Pass
    billingClearedAt: timestamp('billing_cleared_at', { withTimezone: true }),
    billingClearedByUserId: uuid('billing_cleared_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    gatePassNumber: text('gate_pass_number'),
    gatePassIssuedAt: timestamp('gate_pass_issued_at', { withTimezone: true }),
    gatePassIssuedByUserId: uuid('gate_pass_issued_by_user_id').references(() => users.id, { onDelete: 'set null' }),

    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('ipd_discharge_clearances_tenant_adm_idx').on(t.hospitalId, t.admissionId),
  ],
);
```

### Supporting Domain Types

```typescript
export interface PharmacyReturnItem {
  medicineName: string;
  batchNumber?: string;
  dispensedQty: number;
  returnedQty: number;
  unitPricePaise?: number;
  creditPaise?: number;
  reason?: 'unconsumed' | 'discontinued' | 'changed_dose' | 'other';
}

export interface DischargeClearanceStatus {
  isMedicalCleared: boolean;
  isPharmacyCleared: boolean;
  isNursingCleared: boolean;
  isSummaryFinalized: boolean;
  isBillingCleared: boolean;
  canIssueGatePass: boolean;
  completedCount: number;
}
```

---

## 4. Domain Services (`lib/services/ipd-clearance.ts`)

1. **`getDischargeClearance(hospitalId, admissionId)`**:
   Aggregates live departmental status into a single reactive payload for the cockpit, including:
   - Clinical stability and consultant sign-off.
   - List of unconsumed bedside medicine items vs returned items.
   - Clinical MedRec status from `lib/services/medrec.ts`.
   - Take-home medication count from `lib/services/ipd-discharge-summary.ts`.
   - Nursing line checklist completion.
   - Discharge summary versioning from `ipdDischargeSummaries`.
   - Financial ledger summary (total, TPA share, deposit, balance) from `discharge-billing.ts`.
2. **`updateMedicalClearance(...)`**: Toggles medical readiness and updates discharge type & clinical stability notes.
3. **`recordPharmacyClearance(...)`**: Records returned medicines, batch numbers, credit note number, and take-home counseling acknowledgment.
4. **`updateNursingClearance(...)`**: Records cannula/catheter removal, dressing, belongings handover, and discharge vitals.
5. **`issueDischargeGatePass(...)`**:
   - **Hard Gate:** Strictly validates that all 5 departments are cleared. Throws `ClearanceGateError` if any mandatory item is pending.
   - Assigns sequential gate pass number (`GP-YYYY-XXXX`) and marks admission departure ready.

---

## 5. UI Architecture & Components

```
components/ipd/discharge/
├── discharge-tab.tsx                    # Cockpit container with progress header & 5-card grid
├── cards/
│   ├── medical-clearance-card.tsx       # Step 1: Consultant sign-off & stability criteria
│   ├── pharmacy-clearance-card.tsx      # Step 2: Bedside returns, MedRec & take-home counseling
│   ├── nursing-clearance-card.tsx       # Step 3: Invasive lines checklist & belongings handover
│   ├── summary-clearance-card.tsx       # Step 4: Versioned discharge summary & follow-up
│   └── billing-gate-pass-card.tsx       # Step 5: Ledger settlement & exit Gate Pass
├── drawers/
│   ├── pharmacy-return-drawer.tsx       # Interactive drawer for logging returned medicine items & credit note
│   ├── medical-clearance-modal.tsx      # Modal for consultant fit-to-leave & discharge type
│   └── gate-pass-modal.tsx              # Tamper-evident printable Gate Pass slip with QR/barcode
└── discharge-summary-drawer.tsx         # Existing drawer for clinical discharge summary editing
```

---

## 6. Role-Based Access Control (RBAC)

* **Medical Clearance:** `ipd.dischargeReady` (Doctor, Admin).
* **Pharmacy Clearance:** `pharmacy.dispense` or `nurse` (Pharmacist, Ward Nurse, Admin).
* **Nursing Handover:** `ipd.chart` or `nurse` (Ward Nurse, Sister In-Charge).
* **Discharge Summary:** `ipd.discharge` (Attending Doctor, Resident).
* **Billing & Gate Pass:** `billing.collect` or `ipd.discharge` (Billing Desk, Admin).

---

## 7. Verification & Testing

* **Integration Tests:** `lib/services/__tests__/ipd-clearance.integration.test.ts` testing individual department sign-offs, pharmacy return credit calculation, audit trail generation, and hard gate enforcement on gate pass generation.
* **Component Tests:** `components/ipd/discharge/__tests__/discharge-tab.test.tsx` testing the 5 clearance cards, reactive progress counter, pharmacy drawer interactions, and gate pass modal rendering.
