
# IPD UI Clinical Refinements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refine the IPD user experience to match clinical expectations:
1. Provide a calendar/Excel-slot flowsheet on the specialized TPR page (`/ipd/patients/[id]/vitals`).
2. Add a prominent nurse "+ Record TPR" button accessible from the Patient Banner and Bedside eMAR.
3. Organize the summary and bedside views into a Bento grid with an independently scrollable "Previously Given Medicines" side card.
4. Replace the blurry prescription modal backdrop with a solid, high-contrast white form on dark backdrop.
5. Completely remove the separate "Rounds Mode" toggle/ambiguity so doctors experience a unified, simple 3-view workflow (Summary + direct actions, TPR flowsheet, Investigations).

---

## File Structure & Responsibilities

| File | Responsibility |
| :--- | :--- |
| `components/ipd/vitals/tpr-calendar-grid.tsx` | New component: Authentic calendar/Excel-style TPR flowsheet matrix with time slot columns (06:00, 10:00, 14:00, 18:00, 22:00, 02:00) and vital parameter rows (Temp, Pulse, BP, Resp, SpO2, NEWS2, Intake, Output, Treatments). |
| `components/ipd/vitals/vitals-and-io-tab.tsx` | Embeds `TprCalendarGrid` as the primary view on the specialized TPR page, retaining doctor vitals frequency order and quick-record modals. |
| `app/(app)/ipd/patients/[id]/vitals/page.tsx` | Server component providing vitals, fluid entries, and recent medication administrations for the calendar slots. |
| `components/ipd/shell/patient-banner.tsx` | Adds high-visibility `+ Record TPR` button in the sticky banner for instant bedside logging on mobile/tablet. |
| `components/ipd/bedside/bedside-treatment-chart.tsx` | Reorganizes bedside workspace into Bento grid with independently scrollable "Previously Given Medicines" left card and top-level `+ Record TPR` action. |
| `app/(app)/ipd/patients/[id]/summary/page.tsx` | Reorganizes summary into Bento grid, preserves existing vitals snapshot, links "Full Flowsheet →" to calendar TPR page, and adds direct doctor action buttons (`+ Progress Note`, `+ Prescribe`, `+ Order Test`). |
| `components/ipd/prescriptions/create-treatment-plan-modal.tsx` | Removes `backdrop-blur-*`, applies solid pure white `bg-white`, crisp `border-slate-300`, and high-contrast solid dark backdrop. |
| `components/ipd/summary/tpr-flowsheet.tsx` | Preserves compact summary flowsheet widget and ensures "Full Flowsheet →" redirects cleanly to `/ipd/patients/[id]/vitals`. |

---

## Tasks

### Task 1: Create Calendar-Style TPR Flowsheet Grid (`TprCalendarGrid`)

- [ ] **Step 1.1**: Create `components/ipd/vitals/tpr-calendar-grid.tsx`.
  - Format multi-day time slots across columns (e.g., standard clinical intervals: Morning 06:00, Mid-Day 10:00, Afternoon 14:00, Evening 18:00, Night 22:00, Late Night 02:00 or grouped timestamps).
  - Define parameter rows:
    - Temperature (°F) with fever styling (amber for ≥ 100.4°F, red for ≥ 102°F)
    - Pulse (bpm) with tachycardia/bradycardia alerts
    - Blood Pressure (Systolic/Diastolic mmHg)
    - Respiration Rate (/min)
    - SpO2 (%) with hypoxemia alert (< 95%)
    - Pain Score (0–10) & AVPU
    - NEWS2 Score badge
    - Fluid Intake (Oral ml, IV ml, Total In)
    - Fluid Output (Urine ml, Drain ml, Total Out)
    - Net Fluid Balance (ml)
    - Treatments / Administrations given during that slot
    - Logged by (Staff name/initials)
  - Style with authentic Excel-sheet borders (`border-collapse`, `border-ink-200`), sticky parameter headers on the left, and horizontal scrolling for multi-day stays.

- [ ] **Step 1.2**: Update `components/ipd/vitals/vitals-and-io-tab.tsx`.
  - Integrate `TprCalendarGrid` into the specialized TPR tab.
  - Keep the Doctor Vitals Frequency Order bar (`Q4H`, `Q2H`, etc.) and the NEWS2 escalation alert banner.
  - Provide toggle between "Calendar Slot Flowsheet" and "Sequential List Log" if needed, with Calendar Slot view default.

- [ ] **Step 1.3**: Update `app/(app)/ipd/patients/[id]/vitals/page.tsx`.
  - Pass recent administrations/treatments alongside vitals and fluids so treatment cells in the TPR grid are populated.

- [ ] **Step 1.4**: Run tests for vitals tab:
  ```bash
  npx vitest run vitals-tab
  ```

---

### Task 2: Add Prominent Nurse Quick TPR Entry Button

- [ ] **Step 2.1**: Update `components/ipd/shell/patient-banner.tsx`.
  - Add a dedicated, prominent `+ Record TPR` button in the sticky Patient Banner actions area.
  - Hook it to open `RecordVitalsModal` on click, enabling one-tap vitals entry from any patient tab on mobile, tablet, or desktop.

- [ ] **Step 2.2**: Update `components/ipd/bedside/bedside-treatment-chart.tsx`.
  - Add a primary `+ Record TPR` action button in the bedside eMAR header toolbar alongside "+ Give Extra Medicine".
  - Wire it to open `RecordVitalsModal` directly so nurses on mobile/tablet don't need to leave the treatment screen.

- [ ] **Step 2.3**: Run patient banner tests:
  ```bash
  npx vitest run patient-banner
  ```

---

### Task 3: Bento Grid Layout on Summary & Bedside Treatment Views

- [ ] **Step 3.1**: Update `app/(app)/ipd/patients/[id]/summary/page.tsx`.
  - Maintain the existing, user-approved compact vitals widget on the summary page.
  - Implement a Bento Grid layout:
    - **Top Action Bar**: Direct doctor action buttons:
      - `+ Add Progress Note` (opens clinical note modal)
      - `+ Prescribe Medication` (opens prescription modal)
      - `+ Order Investigation` (opens lab/radiology modal)
    - **Left Bento Card**: "Recently Given Medications & eMAR Lineage" with independent internal scrolling (`max-h-72 overflow-y-auto`).
    - **Center Bento Card**: Today's medication matrix with fulfillment checkboxes.
    - **Right Bento Cards**: 24h Fluid Balance summary card + Care team & Diagnosis overview.
  - Ensure the "Full Flowsheet →" link in the TPR summary widget navigates directly to `/ipd/patients/[id]/vitals`.

- [ ] **Step 3.2**: Update `components/ipd/bedside/bedside-treatment-chart.tsx`.
  - Reorganize into a Bento Grid:
    - **Left Side Bento Panel**: Compact, independently scrollable card showing "Administered Medications (Past 24h)" with doses, exact timestamps, and nurse initials.
    - **Main Area Bento Panel**: Active due doses and interactive administration buttons.
    - **Right / Bottom Panel**: Quick supplies and care entries.

- [ ] **Step 3.3**: Run summary and bedside tests:
  ```bash
  npx vitest run summary-tab bedside-treatment-workspace
  ```

---

### Task 4: Fix Prescription Modal Backdrop & Contrast (Plain White, No Blur)

- [ ] **Step 4.1**: Update `components/ipd/prescriptions/create-treatment-plan-modal.tsx`.
  - Remove `backdrop-blur-xs` and any blur classes from the overlay: replace with solid `bg-slate-900/60` (or `bg-black/60`).
  - Set the modal dialog surface to solid, opaque pure white `bg-white` (avoiding transparency or blur).
  - Add high-contrast crisp border (`border border-slate-300`) and elevated shadow (`shadow-2xl`).
  - Ensure form labels, medicine search results, and error banners have sharp, high-contrast text and background colors.

- [ ] **Step 4.2**: Verify related modal backdrops:
  - Check `order-signing-modal.tsx`, `add-clinical-note-modal.tsx`, and `order-investigation-modal.tsx` to remove `backdrop-blur-*` and ensure clean white surfaces.

- [ ] **Step 4.3**: Run prescription modal tests:
  ```bash
  npx vitest run create-treatment-plan-modal
  ```

---

### Task 5: Completely Remove Separate "Rounds Mode" Ambiguity

- [ ] **Step 5.1**: Review and eliminate separate "Rounds Mode" toggles or states.
  - Verify that no screens toggle between a separate "Rounds View" and "Normal View".
  - Ensure all doctor actions (`+ Progress Note`, `+ Prescribe`, `+ Order Tests`) live directly on the patient summary and respective sheets without entering a separate mode.

- [ ] **Step 5.2**: Verify `TabNavigation` and route consistency:
  - Maintain the clean, unified navigation tabs:
    - **Summary** (Doctor's primary cockpit)
    - **Prescriptions**
    - **eMAR**
    - **Vitals & TPR** (Calendar Flowsheet)
    - **Notes**
    - **Investigations**
    - **Billing**
    - **Discharge**

---

### Task 6: Full Verification & Automated Test Suite

- [ ] **Step 6.1**: Run the full IPD test suite to verify no regressions:
  ```bash
  npx vitest run ipd
  ```

- [ ] **Step 6.2**: Verify build and rendering:
  ```bash
  npm run build --no-lint
  ```
