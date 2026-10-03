# Specification: Professional HMS Redesign & Mobile-First Queue UX

- **Author**: Antigravity & Engineering Team
- **Date**: 2026-10-02
- **Status**: Approved for Implementation

---

## 1. Problem Statement & Motivation

1. **Cartoonish UI from Raw Emojis:**
   The use of Unicode emojis (`🩺`, `📺`, `🕒`, `📞`, `➕`, `💊`, `🏥`, `🌟`, `🎫`, `⚙️`, `🛡️`, etc.) across action buttons, status pills, headers, and navigation gives the impression of an informal, toy application rather than an enterprise-grade, HIPAA/clinical-grade Hospital Management System (HMS).
2. **Mobile Walk-in Booking Usability Failure:**
   On mobile devices (`< 1024px`), CSS Grid collapses into a single column. The "Now Serving" card and the entire "Waiting Queue" (which can contain 10–30+ patients) render *above* the "Add Walk-In" form. Receptionists and hospital owners using their phones must scroll through the entire list of patients before they can register a new walk-in, leading to frustration and slow check-ins.

---

## 2. Core Architectural & UX Changes

### 2.1. Mobile-First Segmented Queue Dashboard
On the Receptionist/Owner view (`app/(app)/dashboard/page.tsx`), we introduce a responsive mobile-first segmented navigation:

- **Mobile Viewport (`< lg`):**
  A sticky, tap-friendly segmented controller is displayed at the top:
  `[ 📋 Live Queue (Count) ] | [ ➕ Add Walk-In ] | [ 📊 Overview & Stats ]`
  - **Live Queue tab:** Focuses on "Now Serving" + "Waiting Queue" with high visual density.
  - **Add Walk-In tab:** Displays the patient registration form with immediate focus, zero scrolling required.
  - **Overview tab:** Shows today's stats, parked/needs attention patients, scheduled appointments, and subscription notices.
- **Desktop Viewport (`≥ lg`):**
  The segmented controller is hidden (`hidden lg:grid`), rendering the full multi-column dashboard side-by-side as usual.

### 2.2. Enterprise HMS Iconography System
A dedicated SVG icon library (`components/icons.tsx`) provides crisp, scalable, stroke-consistent Lucide-style icons. Raw Unicode emojis are completely eliminated from:
- Dashboard queue actions (`ViewModeToggle`, `CallNextButton`, `PausePatientButton`, `PriorityButton`, `RowPaidToggle`, `WaitingRow`)
- Patient contact badges (`PhoneCall` icon instead of `📞`)
- Mobile Navigation drawer (`MobileNav`)
- TV Waiting-Room Display (`app/display/[branchId]/page.tsx`)
- Settings & Doctor onboarding forms (`app/(app)/settings/page.tsx` & `doctor-schedule-manager.tsx`)
- Reports and Analytics (`app/(app)/reports/page.tsx`)
- Public Booking Form (`app/book/book-form.tsx`)
- Toasts and Offline alerts (`components/toast.tsx` & `components/display-live-updater.tsx`)

### 2.3. Professional Clinical Badges & Typography
- Replace emoji-based practice mode strings (`🌟 Hybrid`, `🎫 Live Queue`, `🕒 Time Slots`) with sleek clinical badges (`Hybrid Practice`, `Live Queue`, `Scheduled Slots`) with subtle background tints and border styling.
- Refine input focus states and button micro-interactions for rapid data entry in high-stress clinic environments.

---

## 3. Component & File Changes

| File | Change Details |
| :--- | :--- |
| `components/icons.tsx` | Create zero-dependency SVG icon components matching Lucide specs (`Stethoscope`, `Tv`, `Clock`, `PhoneCall`, `UserPlus`, `Building2`, `MapPin`, `Zap`, `Settings`, `Shield`, `BarChart3`, `CreditCard`, `FileText`, `Layers`, `AlertTriangle`, `Info`, `Calendar`, `ChevronRight`, `Plus`, `Check`, `X`, `Menu`). |
| `app/(app)/dashboard/page.tsx` | Add responsive mobile segmented container; replace all doctor, phone, clock, and priority emojis with SVG icons; update header styling. |
| `app/(app)/dashboard/dashboard-queue-actions.tsx` | Add `MobileDashboardSwitcher` client state component; replace emojis in `ViewModeToggle` and action buttons; enhance button styling. |
| `components/mobile-nav.tsx` | Replace emoji map with SVG icons; polish drawer navigation items. |
| `app/display/[branchId]/page.tsx` | Replace empty doctor state and patient badge emojis with SVG icons. |
| `app/(app)/settings/page.tsx` | Replace branch, doctor, specialty, time, and practice mode emojis with SVG icons and clinical badges. |
| `app/(app)/settings/scheduling/doctor-schedule-manager.tsx` | Replace emojis in schedule manager cards and mode badges. |
| `app/(app)/reports/page.tsx` | Replace "Open waiting display" and doctor specialty emojis with SVGs. |
| `app/book/book-form.tsx` & `lib/services/booking.ts` | Replace clock and plus emojis with clean SVGs / text. |
| `components/toast.tsx` & `components/display-live-updater.tsx` | Replace warning/info emojis with SVG icons. |

---

## 4. Testing & Verification

1. **Unit & Integration Tests:** Run `npm run test` to verify no domain logic regressions.
2. **Type Safety:** Run `npm run typecheck` to ensure all JSX and TypeScript types are error-free.
3. **Responsive Mobile Testing:** Verify 375px mobile viewport has 0 scroll to access walk-in registration form.
4. **Desktop Layout Testing:** Verify 1280px+ desktop viewport renders full 3-column command center without tabs.
