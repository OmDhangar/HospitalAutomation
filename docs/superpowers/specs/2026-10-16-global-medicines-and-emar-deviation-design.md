# Global Medicines Catalogue, eMAR Timing Deviation & Prescription UX Design

## Context & Problem Statement

1. **eMAR Bedside Dosage Timing Deviation Error:**
   When bedside dosage timing is adjusted or delayed (even with a nurse-documented reason like *"Patient away from ward for scan/X-ray/OT"*), confirming the administered dose throws:
   `Error: Order has expired past its treatment duration` (`lib/services/ipd-emar.ts:333`).
   This occurs because:
   - `recordAdministration` strictly fails any administration where `now > order.endsAt`, with zero grace period or allowance for clinical deviation reasons.
   - `adjustMedicationScheduleTimes` creates successor orders copying the old `order.endsAt`, which if in the past leaves the adjusted order immediately expired.

2. **Prescription Count Miscommunication:**
   In [`DailyMedicationMatrix`](file:///d:/Projects/HospitalAutomation/components/ipd/summary/daily-medication-matrix.tsx), a patient has 3 active prescriptions (Ceftriaxone, Hydrocortisone, Pantoprazole). When the doctor clicks "+ Add Prescription" or "💊 + Prescribe Medicine", [`CreateTreatmentPlanModal`](file:///d:/Projects/HospitalAutomation/components/ipd/prescriptions/create-treatment-plan-modal.tsx) opens with:
   `PRESCRIPTIONS IN THIS TREATMENT PLAN (0) - No medications added yet.`
   This creates confusion because the doctor thinks the 3 active medications were lost. The modal does not display active orders, and the custom input lacks autocomplete.

3. **Lack of Global Master Medicine List & Unpriced Hospital Workflow:**
   Each hospital only has ~48 starter medicines in [`STARTER_MEDICINES`](file:///d:/Projects/HospitalAutomation/lib/domain/starter-medicines.ts). Doctors must manually type any other medicine. The user requires a comprehensive global medicine database across standard medical practice, with instant autocomplete, an indicator when a medicine is not yet priced in that hospital, and a non-blocking workflow where the doctor can prescribe it immediately while hospital admins can set pricing later in Settings.

---

## Architecture & Design

### 1. eMAR Timing Deviation & Graceful Administration

#### Root Causes
- `lib/services/ipd-emar.ts`: `if (order.endsAt && now > order.endsAt) throw new Error('Order has expired past its treatment duration');`
- `lib/services/ipd-medication-orders.ts`: `adjustMedicationScheduleTimes` copied `endsAt: order.endsAt` verbatim, causing newly rescheduled orders to be born expired if `order.endsAt <= now`.

#### Solution
1. In `adjustMedicationScheduleTimes`:
   - If `order.durationDays` is set, set `newEndsAt = new Date(now.getTime() + order.durationDays * 24 * 60 * 60 * 1000)`.
   - If `order.endsAt` is null or in the past (`order.endsAt <= now`), ensure `newEndsAt` is extended by at least 24 hours (or end of next day) so the newly scheduled slot can be administered.
2. In `recordAdministration`:
   - If `order.endsAt && now > order.endsAt`:
     - If the administration includes a clinical note or timing deviation reason (e.g., `timingReason`, `clinicalNote`), OR if the administration occurs within a generous clinical grace window (e.g., within 48 hours of `endsAt` while the admission stay is active):
       - Allow administration to succeed.
       - Append `[Late administration documented]` to the administration clinical note if not already noted.
     - Only throw `Order has expired past its treatment duration` if the order was administered more than 48 hours after `endsAt` without any clinical rationale.

---

### 2. Prescription Modal Refinement (`CreateTreatmentPlanModal`)

#### Active Prescriptions Display
- Accept `activeOrders` prop (or active medication view items).
- Dynamic Header:
  - If `activeOrders.length > 0`: **"Add Prescriptions to Treatment Plan"** with a badge `3 Active Prescriptions`.
  - If `activeOrders.length === 0`: **"Create IPD Treatment Plan & Prescriptions"**.
- Active Orders Reference Section:
  - Collapsible card titled **"Currently Active Prescriptions (${activeOrders.length})"** showing medicine name, dose, route, and frequency.
  - Clear note: *"These active prescriptions will continue. Use the form below to add new medications to this plan."*
- Staged Orders Header:
  - Renamed from `PRESCRIPTIONS IN THIS TREATMENT PLAN (0)` to **"New Prescriptions to Add (${stagedOrders.length})"**.
- Submit Button Label:
  - If active orders exist: **"Save & Add to Treatment Plan"**.
  - Else: **"Save & Start Treatment Plan"**.

---

### 3. Global Medicine Master & Frictionless Hospital Pricing

#### Schema: `global_medicines`
Add a global table in [`lib/db/schema.ts`](file:///d:/Projects/HospitalAutomation/lib/db/schema.ts) (not tenant-scoped):
```typescript
export const globalMedicines = pgTable(
  'global_medicines',
  {
    id: id(),
    name: text('name').notNull(),
    genericName: text('generic_name'),
    strength: text('strength'),
    form: text('form'),
    category: text('category').notNull().default('General'),
    unit: text('unit').notNull().default('unit'),
    defaultRoute: text('default_route').default('oral'),
    defaultFrequency: text('default_frequency').default('OD'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('global_medicines_identity_key').on(
      sql`lower(name)`,
      sql`coalesce(lower(strength), '')`,
      sql`coalesce(lower(form), '')`,
    ),
    index('global_medicines_name_idx').on(sql`lower(name) text_pattern_ops`),
    index('global_medicines_generic_idx').on(sql`lower(generic_name) text_pattern_ops`),
  ],
);
```

#### Pre-Seeded Standard Medical Practice Medicines
A dedicated dataset in `lib/domain/global-medicines-data.ts` containing 120+ essential medicines across clinical specialties:
- **Antibiotics:** Augmentin 625mg/1.2g, Ceftriaxone 1g/2g, Meropenem 1g, Piperacillin-Tazobactam 4.5g, Cefoperazone-Sulbactam 1.5g, Metronidazole 500mg IV/400mg Tab, Amikacin 500mg, Levofloxacin 500mg, Azithromycin 500mg, Doxycycline 100mg.
- **Pain & Anti-inflammatory:** Paracetamol 650mg Tab/1g IV, Tramadol 50mg/100mg, Diclofenac 50mg/75mg Inj, Ketorolac 30mg, Aceclofenac 100mg, Ibuprofen 400mg.
- **Gastrointestinal / Antacids:** Pantoprazole 40mg IV/Tab, Rabeprazole 20mg, Omeprazole 20mg/40mg IV, Ondansetron 4mg/8mg, Metoclopramide 10mg, Sucralfate syrup.
- **IV Fluids:** Normal Saline 0.9% 500ml, Ringer Lactate 500ml, Dextrose 5% 500ml, Dextrose Normal Saline (DNS) 500ml, Isolyte-P / Isolyte-M, 3% Hypertonic Saline.
- **Steroids & Emergency:** Hydrocortisone 100mg/200mg Inj, Dexamethasone 4mg/8mg Inj, Methylprednisolone 40mg/125mg/500mg/1g, Adrenaline 1:1000, Atropine 0.6mg, Noradrenaline 4mg.
- **Respiratory:** Salbutamol nebulizer/inhaler, Ipratropium 250mcg/500mcg, Budecort 0.5mg/1mg respules, Deriphyllin 2ml Inj, Montelukast 10mg.
- **Cardiovascular & Antihypertensive:** Amlodipine 5mg, Telmisartan 40mg/80mg, Enalapril 5mg, Labetalol 20mg/100mg, Furosemide (Lasix) 20mg/40mg Inj, Nitroglycerin 25mg/50ml infusion, Clopidogrel 75mg, Aspirin 75mg/150mg, Atorvastatin 20mg/40mg.
- **Endocrine & Diabetes:** Human Actrapid Insulin, Human Mixtard 30/70, Metformin 500mg/850mg, Glimepiride 1mg/2mg.

#### Unified Search API (`/api/medicines/search`)
Search logic:
1. Query hospital's local `medicines` table (with price status).
2. Query `global_medicines` matching query prefix.
3. Merge results:
   - If already in hospital catalogue, return tenant item with `isPriced: sellingPricePaise !== null`.
   - If only in `global_medicines`, return with `isPriced: false`, `isGlobal: true`, and note `Pricing not set in this hospital`.

#### Auto-Provisioning Unpriced Medicines on Prescription
When doctor selects a global medicine:
- Input fields (dose, unit, route, freq) auto-populate from default attributes.
- Doctor clicks "Add to Plan" — not blocked.
- When saving the treatment plan or signing orders, `resolveMedicineIdInTx` inserts into the tenant's `medicines` table as `sellingPricePaise: null`.
- Settings → Medicines displays it under `unpriced` filter with a badge to let billing staff set price when desired.
- Doctor flow is 100% uninterrupted.

---

## Migration Plan
- Create migration `0050_global_medicines.sql` with `global_medicines` table definition and seed statements.
- Ensure all tests pass (`npm test`).
