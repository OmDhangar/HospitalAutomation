# QueueCare landing page — build brief

Paste this whole file as one message to a coding agent. It is self-contained.

---

**Build a landing page for QueueCare.**

## The product

QueueCare turns a hospital's chaotic physical OPD queue into a trackable digital
one. Patients book on WhatsApp or are added by reception, get a token number and
a live queue link, and can wait outside instead of crowding the corridor.
Reception runs the queue from one dashboard with a single *Call next* button. A
waiting-room screen shows who is being seen now.

Built for small and medium hospitals in rural and semi-urban India — 150–200 OPD
patients a day, Marathi/Hindi/English, cheap Android phones, unreliable
connections.

**The reader is a doctor who owns a hospital.** They are not shopping for
software. They are tired of a corridor full of people outside their door and
reception interrupting consultations to answer "how much longer?". Write to that
person. A secondary section addresses solo doctors and small clinics.

## Stack

Next.js 16 App Router, React 19, TypeScript, Tailwind CSS 4. Server components by
default. This is an existing app — the landing page goes inside it.

## Reuse the existing design system — do not invent a new palette

`app/globals.css` already defines these as Tailwind theme tokens. Use them:

- **Brand (teal):** `brand-50` `#f0fdfa` → `brand-600` `#0d9488` →
  `brand-700` `#0f766e` → `brand-950` `#042f2e`
- **Neutral (slate):** `ink-50` `#f8fafc` → `ink-200` `#e2e8f0` →
  `ink-500` `#64748b` → `ink-900` `#0f172a`
- **Shadows:** `shadow-[var(--shadow-card)]`, `shadow-[var(--shadow-raised)]`
- **Utilities:** `.numeric` (tabular figures — use for every token number),
  `.font-deva` (Devanagari), `.pulse-ring`

Fonts are already loaded in `app/layout.tsx`: Inter for Latin, Noto Sans
Devanagari for Marathi/Hindi. Do not add fonts.

Reusable components in `components/ui.tsx`: `Button` (variants
`primary|secondary|ghost|danger`, sizes `sm|md|lg|xl`), `Card`, `CardHeader`,
`Field`, `Input`, `Alert`, `cn`.

**Visual direction:** calm, clinical, trustworthy. Generous whitespace, restrained
colour, teal as an accent rather than a wash. This should look like software a
hospital would rely on, not a startup landing page. No gradient meshes, no
floating 3D blobs, no confetti. One dark section (the waiting-room display) for
rhythm.

## Files to create

```
app/(marketing)/layout.tsx      header + footer, no auth required
app/(marketing)/page.tsx        the page
app/(marketing)/actions.ts      'use server' — demo request handler
components/marketing/           section primitives and UI mockups
```

**Delete `app/page.tsx`** — it currently redirects to `/login` and would collide
with the marketing route for `/`.

The header calls `getSession()` from `lib/auth/session.ts`. If a session exists,
show a "Dashboard" link; otherwise "Sign in". Do **not** redirect signed-in users
away from the page.

## Sections

**1. Hero.** Headline naming the doctor's real problem, not the feature. One
sentence of explanation. Primary CTA scrolling to the demo form. Visual: a
side-by-side mockup of the patient's phone view (big number, "3 patients ahead of
you") and the reception dashboard.

**2. The problem.** Three or four short beats from behind the consulting-room
door: consultations interrupted, reception answering the same question all
morning, patients not daring to leave, the corridor full by 10am.

**3. How it works — the most important section on the page.** Six steps, each
with a faithful mockup built in HTML and CSS:

1. Patient messages the hospital on WhatsApp (or reception adds a walk-in)
2. Picks a doctor and when they are coming, from tappable menus
3. Gets a token number and a live queue link — no app to install
4. The waiting-room screen shows who is being seen now
5. Reception presses *Call next* — one button
6. The patient is messaged when they are close, and comes back

Make the flow legible at a glance. A doctor should understand the whole product
from this section alone.

**4. What each person gets.** Three columns — the doctor (their own queue on
their phone, honest numbers on how the day actually ran: patients seen, median
wait, median consultation), reception (one button, no paper register, no double
entry), the patient (no app, their own language, freedom to wait outside).

**5. For solo doctors.** Works with no receptionist — the doctor advances the
queue from their own phone between patients.

**6. Objections, answered plainly.** No app to install. Marathi, Hindi and
English. What happens when the internet drops (the queue keeps running; there is
a written paper fallback). What data is stored — a name and a phone number, never
diagnoses, prescriptions or test results. Reception is trained in fifteen
minutes. It sits alongside existing hospital software rather than replacing it.

**7. Demo form.** Exactly five fields: name, hospital or clinic name, mobile
number, city, patients per day (select: under 50 / 50–100 / 100–200 / over 200).
Nothing else — every extra field loses submissions.

**8. Footer.** Product name, a line on what it is, links to sign in and to the
privacy notice.

## Demo form implementation

Add a `demo_requests` table to `lib/db/schema.ts` using Drizzle:

```
id (uuid, defaultRandom), name (text), organisation (text),
phone_e164 (text), city (text), patients_per_day (text),
status (pgEnum: new|contacted|demoed|won|lost, default 'new'),
notes (text, nullable), created_at (timestamptz, defaultNow)
```

**No row-level security policy on this table** — it belongs to no hospital. Every
tenant table in this codebase has RLS; this one deliberately does not, like
`provider_invoices`. Follow the migration pattern in `drizzle/`:
`npx drizzle-kit generate --name demo_requests`, then `npm run db:migrate`.

The server action must:

- validate with `zod` (already a dependency)
- normalise the phone using `normalizeIndianPhone` from `lib/domain/phone.ts` —
  it already handles `98765 43210`, `+91 98765 43210`, `098765…` and so on. Do
  not write a new regex.
- include a hidden honeypot field; if it is filled, return success and write
  nothing
- refuse more than three submissions from one phone number per day
- return a friendly inline confirmation, not a redirect to another page

Add a "Demo requests" card to `app/(app)/admin/page.tsx`, behind the existing
`session.isPlatformAdmin` check, listing recent requests newest first.

## Hard constraints

- **Invent no social proof.** There are zero customers. No testimonials, no
  hospital logos, no "trusted by N clinics", no star ratings. If a section feels
  empty without them, cut the section. A fabricated testimonial on a healthcare
  site ends a sale the moment a doctor asks which hospital said it.
- **Invent no statistics.** No "reduces waiting time by 40%" or similar — nothing
  has been measured yet. Describe how it works, not results it has not produced.
- **No medical claims.** This is a queue tool, not a clinical device.
- **No new dependencies.** No animation library, no icon package, no UI kit.
  Inline SVG for icons.
- **No stock photos of doctors or patients.** Use mockups of the real interface.
- Accessible: real heading hierarchy, labelled inputs, visible focus rings,
  ≥4.5:1 text contrast, and respect `prefers-reduced-motion` (globals.css already
  has the media query).
- Mobile first. Many of these doctors will open the link on a phone. Nothing may
  scroll horizontally at 375px.

## Definition of done

- `npm run build` passes
- `npm test` still passes (122 tests)
- `/` renders signed out; shows "Dashboard" when signed in
- The demo form writes a row and it appears on `/admin`
- Honeypot and per-phone throttle both work
- No horizontal scroll at 375px; readable at 1440px
- `/dashboard`, `/q/<token>`, `/display/<branchId>` and `/login` still work
