# OPD-to-IPD Clinical Continuity Design Specification

**Document Title:** Automated OPD Prescription Porting, Draft Orders Review Cockpit & Clinical Inpatient Handover  
**Document Path:** `docs/superpowers/specs/2026-11-04-opd-to-ipd-clinical-continuity-design.md`  
**Date:** November 2026  
**Status:** Approved Architectural Specification  
**Harness Module:** Inpatient Department (IPD) / Outpatient Department (OPD)  
**Related Standards:** NABH 5th Edition MOM (Medication Management), Practo Insta HMS & KareXpert Benchmark  

---

## 1. Problem & Clinical Motivation

In many hospital systems, when an outpatient is advised for admission, their OPD prescription records remain stranded within the outpatient encounter. Inpatient nurses and admitting doctors are forced to transcribe medications manually onto paper charts or re-enter them item-by-item into the IPD software.

This manual transcription causes three major clinical and operational failures:
1. **Omission Errors:** Chronic medications (antihypertensives, insulin, thyroid supplements) or acute oral antibiotics are frequently omitted during the initial 24 hours of hospital stay.
2. **Transcription Fatigue & Duplication:** Doctors spend 5–10 minutes re-typing orders that were prescribed minutes earlier in the OPD consultation room.
3. **Discontinuous eMAR:** Nursing ward staff cannot see scheduled medication doses on their bedside eMAR tablets until an inpatient doctor completes a new formal rounding order session.

---

## 2. Clinical Workflow & State Transition Architecture

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                        OPD-TO-IPD CLINICAL TRANSITION PIPELINE                         │
│                                                                                        │
│   OPD Consultation Saved (`saveConsultation`)                                          │
│   ┌──────────────────────────────────────────────────────────────┐                     │
│   │ • Patient consultation finalized with prescription items     │                     │
│   │ • Tables: `prescriptions` (status: 'final')                  │                     │
│   │           `prescription_items` (dose, frequency, etc.)       │                     │
│   └──────────────────────────────┬───────────────────────────────┘                     │
│                                  │                                                     │
│                                  ▼                                                     │
│   OPD Doctor advises Admission (`shiftToIpd` / `ShiftToIpdButton`)                     │
│   ┌──────────────────────────────────────────────────────────────┐                     │
│   │ • Doctor specifies urgency, provisional diagnosis & ward type │                     │
│   │ • System creates `admissions` (status: 'awaiting_bed')       │                     │
│   │ • ATOMIC TRIGGER: System inspects active OPD prescription    │                     │
│   │ • Parses dose, frequency, route, duration                    │                     │
│   │ • Inserts rows into `ipd_medication_orders`:                 │                     │
│   │   - status = 'draft'                                         │                     │
│   │   - origin = 'inpatient_order'                               │                     │
│   │   - specialInstructions = 'Ported from OPD Prescription'     │                     │
│   └──────────────────────────────┬───────────────────────────────┘                     │
│                                  │                                                     │
│                                  ▼                                                     │
│   Front Desk Bed Assignment (`executePatientIntake`)                                   │
│   ┌──────────────────────────────────────────────────────────────┐                     │
│   │ • Desk assigns Bed & Ward                                    │                     │
│   │ • Admission status transitions to 'admitted'                 │                     │
│   │ • Pre-existing draft orders remain attached to admission     │                     │
│   └──────────────────────────────┬───────────────────────────────┘                     │
│                                  │                                                     │
│                                  ▼                                                     │
│   Doctor Inpatient Review (`/ipd/patients/[id]/orders` or `/summary`)                  │
│   ┌──────────────────────────────────────────────────────────────┐                     │
│   │ • Amber Review Banner: "Draft OPD Orders Awaiting Sign-Off"   │                     │
│   │ • 1-Click "Approve All Valid Orders"                         │                     │
│   │ • Individual Line Actions: [Approve] [Modify] [Reject]       │                     │
│   └──────────────────────────────┬───────────────────────────────┘                     │
│                                  │                                                     │
│                                  ▼ (Upon Approval)                                     │
│   Bedside eMAR Nursing Grid (`/ipd/patients/[id]/emar`)                                │
│   ┌──────────────────────────────────────────────────────────────┐                     │
│   │ • Order status transitions to 'active', signedAt = now()     │                     │
│   │ • Schedulable doses immediately visible to ward nurses       │                     │
│   └──────────────────────────────────────────────────────────────┘                     │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Data Parsing & Domain Logic

### 3.1 Dose Parsing (`parseOpdDose`)
OPD prescriptions allow free-text or pre-formatted dose representations (e.g. `"1 tab"`, `"500 mg"`, `"2 puffs"`, `"10 ml"`, `"650mg"`). Inpatient medication administration requires structured numeric doses and discrete units:

| OPD Dose Input | Parsed `doseAmount` | Parsed `doseUnit` |
| :--- | :--- | :--- |
| `"500 mg"` | `"500"` | `"mg"` |
| `"650mg"` | `"650"` | `"mg"` |
| `"1 tab"` | `"1"` | `"tab"` |
| `"2 capsules"` | `"2"` | `"cap"` |
| `"10 ml"` | `"10"` | `"ml"` |
| `"1"` (fallback) | `"1"` | `medicine.form` or `"unit"` |

### 3.2 Frequency to Scheduled Timings (`mapFrequencyToTimes`)
Standard hospital timing schedules are mapped from standard clinical shorthand (strictly English):

| Frequency Code | Description | Standard Schedule Times | Schedule Type |
| :--- | :--- | :--- | :--- |
| `OD` / `Once Daily` | Once daily (Morning) | `["09:00"]` | `scheduled` |
| `BD` / `Twice Daily` | Twice daily | `["09:00", "21:00"]` | `scheduled` |
| `TDS` / `Thrice Daily` | Three times daily | `["08:00", "14:00", "20:00"]` | `scheduled` |
| `QID` / `Four times` | Four times daily | `["06:00", "12:00", "18:00", "22:00"]` | `scheduled` |
| `SOS` / `PRN` | As needed | `[]` | `prn` |
| `STAT` | Immediately | `[]` | `stat` |
| `HS` / `Night` | At bedtime | `["21:00"]` | `scheduled` |

### 3.3 Route Mapping
Maps OPD route strings to strict IPD route enums (`'oral' | 'iv_push' | 'iv_piggyback' | 'im' | 'sc' | 'nebulization' | 'topical' | 'inhalation' | 'sublingual' | 'rectal' | 'ophthalmic' | 'otic'`). If unspecified, defaults to `'oral'`.

---

## 4. Security & Safety Gates

1. **Role-Based Permissions:**
   - Viewing draft orders: `ipd.prescribe`, `clinical.read`, or `queue.mutate`.
   - Approving, modifying, or rejecting draft orders: strictly requires `ipd.prescribe` (Doctor / Owner role) and non-read-only session.
2. **Allergy Check Gate:**
   - If the patient has a documented allergy matching the medication or generic substance, approval is blocked unless a clinical override reason (>= 5 chars) is provided and audited.
3. **Duplicate Therapy Gate:**
   - If an active order for the same `medicineId` already exists on the inpatient chart, approval requires acknowledgment or modification.
4. **Tenant Isolation:**
   - Every operation is wrapped in `withTenant(hospitalId, ...)` with clinical session authorization.

---

## 5. UI / UX Design

1. **Orders Tab (`/ipd/patients/[id]/orders`):**
   - High-visibility banner above the active orders table when `draftOrders.length > 0`.
   - Banner displays count of pending admission orders ported from OPD.
   - Button: `Approve All Valid Orders` (Primary Emerald button).
   - Card list of individual draft items with:
     - Medicine Name, Strength, Form, Route, Dose, Frequency.
     - Doctor origin badge: `"Prescribed by Dr. [Name] in OPD"`.
     - Actions: `[Approve]` (Check icon), `[Modify]` (Edit icon), `[Reject]` (X icon with reason modal).
2. **Patient Summary Cockpit (`/ipd/patients/[id]/summary`):**
   - If draft orders are pending sign-off, add an attention item:
     - Tone: `warning` (Amber)
     - Label: `"X Draft OPD orders awaiting doctor review"`
     - Action: `"Review Orders →"` linking directly to `/ipd/patients/[id]/orders`.

---

## 6. Language & Compliance Rules

- **English Only:** All drug directions, timings, and notes are strictly English (Rule 2.2).
- **Audit Trails:** Every approval, rejection, and modification creates an immutable entry in `clinical_audit_logs`.
