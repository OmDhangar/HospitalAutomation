import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Privacy Policy · Qurio',
  description:
    'Learn how Qurio handles patient and clinic data for WhatsApp appointment booking and live OPD queue management.',
};

export default function PrivacyPolicyPage() {
  return (
    <div className="min-h-screen bg-white text-ink-900 selection:bg-brand-100 selection:text-brand-900">
      {/* ------------------------------------------------------------- Header */}
      <header className="sticky top-0 z-40 border-b border-ink-200/80 bg-white/95 backdrop-blur-sm">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">
          <Link href="/" className="flex items-center gap-2.5 group">
            <span className="flex size-9 items-center justify-center rounded-xl bg-brand-600 font-bold text-white shadow-sm transition-transform group-hover:scale-105">
              Q
            </span>
            <div className="flex flex-col">
              <span className="text-lg font-bold tracking-tight text-ink-900 leading-none">
                Qurio
              </span>
              <span className="text-[10px] font-medium text-ink-500 tracking-wide uppercase mt-0.5">
                Hospital Queue Automation
              </span>
            </div>
          </Link>

          <div className="flex items-center gap-3 sm:gap-4">
            <Link
              href="/"
              className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold text-ink-600 hover:bg-ink-100 hover:text-ink-900 transition-colors"
            >
              <svg
                className="size-3.5"
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth={2.5}
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M10.5 19.5 3 12m0 0 7.5-7.5M3 12h18"
                />
              </svg>
              <span>Back to Home</span>
            </Link>
            <Link
              href="/pricing"
              className="rounded-lg px-3 py-1.5 text-xs font-semibold text-ink-600 hover:bg-ink-100 hover:text-ink-900 transition-colors"
            >
              Pricing
            </Link>
            <Link
              href="/login"
              className="rounded-lg bg-brand-600 px-3.5 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-brand-700 active:bg-brand-800 transition-colors"
            >
              Hospital Sign In
            </Link>
          </div>
        </div>
      </header>

      {/* -------------------------------------------------------- Hero Header */}
      <section className="border-b border-ink-200 bg-gradient-to-b from-brand-50/70 via-brand-50/20 to-white px-4 py-12 sm:px-6 sm:py-16">
        <div className="mx-auto max-w-6xl">
          <div className="flex flex-wrap items-center gap-2 text-xs font-medium text-ink-500 mb-4">
            <Link href="/" className="hover:text-brand-700 transition-colors">
              Home
            </Link>
            <span>/</span>
            <span className="text-brand-800 font-semibold">Privacy Policy</span>
          </div>

          <div className="max-w-3xl">
            <div className="inline-flex items-center gap-2 rounded-full border border-brand-200 bg-brand-100/70 px-3 py-1 text-xs font-bold uppercase tracking-wider text-brand-800">
              <span className="size-1.5 rounded-full bg-brand-600 animate-pulse" />
              Patient Trust &amp; Transparency
            </div>
            <h1 className="mt-3 text-3xl font-extrabold tracking-tight text-ink-950 sm:text-4xl lg:text-5xl">
              Privacy Policy
            </h1>
            <p className="mt-4 text-base sm:text-lg text-ink-600 leading-relaxed">
              Qurio (&ldquo;we,&rdquo; &ldquo;us,&rdquo; &ldquo;our&rdquo;) provides a WhatsApp-based
              appointment and queue management platform (&ldquo;the Service&rdquo;) used by hospitals
              and clinics to coordinate patient bookings and live OPD queues. This policy details what
              information we collect, how it is processed, and your privacy rights.
            </p>

            <div className="mt-6 flex flex-wrap items-center gap-4 text-xs text-ink-500 border-t border-ink-200/80 pt-4">
              <div className="flex items-center gap-1.5 font-medium text-ink-700">
                <svg
                  className="size-4 text-brand-600"
                  fill="none"
                  viewBox="0 0 24 24"
                  strokeWidth={2}
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M6.75 3v2.25M17.25 3v2.253 18.75m3-18.75H3.75a2.25 2.25 0 0 0-2.25 2.25v13.5A2.25 2.25 0 0 0 3.75 21h16.5A2.25 2.25 0 0 0 22 18.75V5.25A2.25 2.25 0 0 0 19.75 3Z"
                  />
                </svg>
                <span>Last updated: 16/09/2026</span>
              </div>
              <span className="hidden sm:inline text-ink-300">•</span>
              <span className="text-ink-600">Effective for all patients, clinics &amp; hospital staff</span>
            </div>
          </div>
        </div>
      </section>

      {/* ------------------------------------------------ Key Highlights Grid */}
      <section className="border-b border-ink-200/80 bg-ink-50/50 px-4 py-8 sm:px-6">
        <div className="mx-auto max-w-6xl">
          <h2 className="text-xs font-bold uppercase tracking-widest text-brand-700 mb-4">
            Key Privacy Guarantees at a Glance
          </h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-xl border border-ink-200 bg-white p-4 shadow-sm">
              <div className="flex size-8 items-center justify-center rounded-lg bg-emerald-50 text-emerald-600 font-bold mb-2.5">
                <svg className="size-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75 11.25 15 15 9.75m-3-7.036A11.959 11.959 0 0 1 3.598 6 11.99 11.99 0 0 0 3 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285Z" />
                </svg>
              </div>
              <h3 className="text-xs font-bold text-ink-900">Zero Medical Data Collected</h3>
              <p className="mt-1 text-[11px] text-ink-600 leading-relaxed">
                We never ask for or store medical history, prescriptions, or clinical diagnoses.
              </p>
            </div>

            <div className="rounded-xl border border-ink-200 bg-white p-4 shadow-sm">
              <div className="flex size-8 items-center justify-center rounded-lg bg-brand-50 text-brand-600 font-bold mb-2.5">
                <svg className="size-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M8.625 12a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0H8.25m4.125 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0H12m4.125 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 0 1-2.555-.337A5.972 5.972 0 0 1 5.41 20.97a5.969 5.969 0 0 1-.474-.065 4.48 4.48 0 0 0 .978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25Z" />
                </svg>
              </div>
              <h3 className="text-xs font-bold text-ink-900">Official WhatsApp Business</h3>
              <p className="mt-1 text-[11px] text-ink-600 leading-relaxed">
                Secure message dispatch governed by Meta&apos;s enterprise data processing terms.
              </p>
            </div>

            <div className="rounded-xl border border-ink-200 bg-white p-4 shadow-sm">
              <div className="flex size-8 items-center justify-center rounded-lg bg-sky-50 text-sky-600 font-bold mb-2.5">
                <svg className="size-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M18.364 18.364A9 9 0 0 0 5.636 5.636m12.728 12.728A9 9 0 0 1 5.636 5.636m12.728 12.728L5.636 5.636" />
                </svg>
              </div>
              <h3 className="text-xs font-bold text-ink-900">Never Sold to Advertisers</h3>
              <p className="mt-1 text-[11px] text-ink-600 leading-relaxed">
                We do not sell, broker, or monetize patient or hospital contact details with third parties.
              </p>
            </div>

            <div className="rounded-xl border border-ink-200 bg-white p-4 shadow-sm">
              <div className="flex size-8 items-center justify-center rounded-lg bg-amber-50 text-amber-600 font-bold mb-2.5">
                <svg className="size-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 1 0-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 0 0 2.25-2.25v-6.75a2.25 2.25 0 0 0-2.25-2.25H6.75a2.25 2.25 0 0 0-2.25 2.25v6.75a2.25 2.25 0 0 0 2.25 2.25Z" />
                </svg>
              </div>
              <h3 className="text-xs font-bold text-ink-900">Encrypted &amp; Role-Guarded</h3>
              <p className="mt-1 text-[11px] text-ink-600 leading-relaxed">
                Strict multi-tenant isolation, encrypted connections, and authenticated staff access.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ------------------------------------------------- Main Content Grid */}
      <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6 sm:py-16">
        <div className="grid gap-12 lg:grid-cols-12">
          {/* Sticky Table of Contents Sidebar */}
          <aside className="hidden lg:col-span-4 lg:block">
            <div className="sticky top-24 rounded-2xl border border-ink-200 bg-ink-50/70 p-5 shadow-sm">
              <div className="flex items-center gap-2 pb-3 border-b border-ink-200">
                <svg
                  className="size-4 text-brand-700"
                  fill="none"
                  viewBox="0 0 24 24"
                  strokeWidth={2}
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25H12"
                  />
                </svg>
                <h2 className="text-xs font-bold uppercase tracking-wider text-ink-900">
                  Table of Contents
                </h2>
              </div>

              <nav className="mt-3 space-y-1 text-xs">
                {[
                  { href: '#information-we-collect', label: '1. Information We Collect' },
                  { href: '#how-we-use-information', label: '2. How We Use Information' },
                  { href: '#message-delivery', label: '3. Message Delivery (WhatsApp / Meta)' },
                  { href: '#data-sharing', label: '4. Data Sharing with Hospitals' },
                  { href: '#data-retention', label: '5. Data Retention' },
                  { href: '#data-security', label: '6. Data Security' },
                  { href: '#your-rights', label: '7. Your Privacy Rights' },
                  { href: '#children-privacy', label: '8. Children’s Privacy' },
                  { href: '#policy-changes', label: '9. Changes to This Policy' },
                  { href: '#contact-us', label: '10. Contact Us' },
                ].map((item) => (
                  <a
                    key={item.href}
                    href={item.href}
                    className="block rounded-lg px-2.5 py-1.5 font-medium text-ink-600 hover:bg-white hover:text-brand-700 transition-colors"
                  >
                    {item.label}
                  </a>
                ))}
              </nav>

              <div className="mt-6 rounded-xl border border-brand-200 bg-brand-50/60 p-3.5">
                <p className="text-[11px] font-bold text-brand-900">Questions or Data Inquiries?</p>
                <p className="mt-1 text-[11px] text-brand-800 leading-relaxed">
                  Email our privacy team directly for rights requests or clarifications.
                </p>
                <a
                  href="mailto:omdhangar24@gmail.com"
                  className="mt-2.5 inline-flex items-center gap-1 text-[11px] font-bold text-brand-700 hover:text-brand-900 hover:underline"
                >
                  omdhangar24@gmail.com &rarr;
                </a>
              </div>
            </div>
          </aside>

          {/* Policy Body */}
          <main className="space-y-12 lg:col-span-8">
            {/* Section 1: Information We Collect */}
            <section id="information-we-collect" className="scroll-mt-24">
              <div className="flex items-center gap-2.5">
                <span className="flex size-7 items-center justify-center rounded-lg bg-brand-100 text-xs font-bold text-brand-800">
                  1
                </span>
                <h2 className="text-xl font-bold tracking-tight text-ink-900 sm:text-2xl">
                  Information We Collect
                </h2>
              </div>

              <p className="mt-3 text-sm text-ink-600 leading-relaxed">
                We only collect data strictly necessary to schedule appointments, issue OPD queue tokens,
                and maintain service security. Information originates from three primary touchpoints:
              </p>

              <div className="mt-5 space-y-4">
                {/* Patient data card */}
                <div className="rounded-xl border border-ink-200 bg-white p-5 shadow-sm">
                  <div className="flex items-center gap-2 text-brand-800 font-bold text-sm">
                    <svg className="size-4 text-brand-600" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0ZM4.501 20.118a7.5 7.5 0 0 1 14.998 0A17.933 17.933 0 0 1 12 21.75c-2.676 0-5.216-.584-7.499-1.632Z" />
                    </svg>
                    <span>From Patients using WhatsApp</span>
                  </div>
                  <ul className="mt-3 space-y-2 text-xs text-ink-700">
                    <li className="flex items-start gap-2">
                      <span className="text-brand-600 font-bold">•</span>
                      <span><strong>Phone Number:</strong> WhatsApp mobile number used to request slots or track queues.</span>
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="text-brand-600 font-bold">•</span>
                      <span><strong>Patient Name:</strong> Optional full or preferred name provided by the patient during booking.</span>
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="text-brand-600 font-bold">•</span>
                      <span><strong>Booking Details:</strong> Selected doctor, clinical department, appointment time-slot, and assigned token number.</span>
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="text-brand-600 font-bold">•</span>
                      <span><strong>Message Timestamps:</strong> Exact time of inbound and outbound WhatsApp interactions.</span>
                    </li>
                  </ul>
                </div>

                {/* Hospital staff data card */}
                <div className="rounded-xl border border-ink-200 bg-white p-5 shadow-sm">
                  <div className="flex items-center gap-2 text-ink-900 font-bold text-sm">
                    <svg className="size-4 text-brand-600" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 21h19.5m-18-18v18m10.5-18v18m6-13.5V21M6.75 6.75h.75m-.75 3h.75m-.75 3h.75m3-6h.75m-.75 3h.75m-.75 3h.75M6.75 21v-3.75c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21M3 3h12m-.75 4.5H21m-3.75 3.75h.008v.008h-.008v-.008Zm0 3h.008v.008h-.008v-.008Zm0 3h.008v.008h-.008v-.008Z" />
                    </svg>
                    <span>From Hospital &amp; Clinic Staff using the Dashboard</span>
                  </div>
                  <ul className="mt-3 space-y-2 text-xs text-ink-700">
                    <li className="flex items-start gap-2">
                      <span className="text-brand-600 font-bold">•</span>
                      <span><strong>Account Credentials:</strong> Staff name, institutional email address, and authenticated login credentials.</span>
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="text-brand-600 font-bold">•</span>
                      <span><strong>Operational Actions:</strong> Audit trail of administrative actions (e.g., calling next token, pausing a queue, marking delays, updating doctor schedule).</span>
                    </li>
                  </ul>
                </div>

                {/* Automatically collected data card */}
                <div className="rounded-xl border border-ink-200 bg-white p-5 shadow-sm">
                  <div className="flex items-center gap-2 text-ink-900 font-bold text-sm">
                    <svg className="size-4 text-brand-600" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9 17.25v1.007a3 3 0 0 1-.879 2.122L7.5 21h9l-.621-.621A3 3 0 0 1 15 18.257V17.25m6-12V15a2.25 2.25 0 0 1-2.25 2.25H5.25A2.25 2.25 0 0 1 3 15V5.25m18 0A2.25 2.25 0 0 0 18.75 3H5.25A2.25 2.25 0 0 0 3 5.25m18 0H3" />
                    </svg>
                    <span>Automatically Collected Technical Logs</span>
                  </div>
                  <ul className="mt-3 space-y-2 text-xs text-ink-700">
                    <li className="flex items-start gap-2">
                      <span className="text-brand-600 font-bold">•</span>
                      <span><strong>Device &amp; Browser Metadata:</strong> Operating system, browser family, viewport characteristics, and IP address.</span>
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="text-brand-600 font-bold">•</span>
                      <span><strong>Diagnostic Records:</strong> API latency metrics, error stack traces, and security audit logs to guarantee platform resilience.</span>
                    </li>
                  </ul>
                </div>
              </div>

              {/* Crucial Medical Exclusions Alert */}
              <div className="mt-5 rounded-xl border border-emerald-200 bg-emerald-50/70 p-4.5">
                <div className="flex items-start gap-3">
                  <div className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-emerald-600 text-white font-bold text-xs mt-0.5">
                    ✓
                  </div>
                  <div>
                    <h3 className="text-xs font-bold uppercase tracking-wider text-emerald-950">
                      Explicit Medical Data Exclusion
                    </h3>
                    <p className="mt-1 text-xs text-emerald-900 leading-relaxed">
                      We <strong>do not knowingly collect or store medical records, clinical diagnoses, symptoms, lab reports, or treatment details</strong> through this Service. Only scheduling and queue-related metadata (which doctor, what arrival window, queue position) is processed.
                    </p>
                  </div>
                </div>
              </div>
            </section>

            {/* Section 2: How We Use Information */}
            <section id="how-we-use-information" className="scroll-mt-24 border-t border-ink-200 pt-8">
              <div className="flex items-center gap-2.5">
                <span className="flex size-7 items-center justify-center rounded-lg bg-brand-100 text-xs font-bold text-brand-800">
                  2
                </span>
                <h2 className="text-xl font-bold tracking-tight text-ink-900 sm:text-2xl">
                  How We Use This Information
                </h2>
              </div>

              <p className="mt-3 text-sm text-ink-600 leading-relaxed">
                We process personal information solely for legitimate operational purposes required to deliver the Service:
              </p>

              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                {[
                  {
                    title: 'Appointment & Token Assignment',
                    desc: 'To register bookings, allocate sequential tokens, and broadcast real-time queue positions via WhatsApp.',
                  },
                  {
                    title: 'Hospital Schedule Management',
                    desc: 'To empower hospital staff to control consultation flows, advance queues, and adjust doctor availability.',
                  },
                  {
                    title: 'Automated Reminders & Nudges',
                    desc: 'To dispatch automated WhatsApp notifications when a patient’s turn approaches, avoiding crowded corridors.',
                  },
                  {
                    title: 'Reliability & Performance Monitoring',
                    desc: 'To analyze response times, ensure 99.9% uptime, and prevent platform abuse or denial of service.',
                  },
                  {
                    title: 'Statutory & Legal Compliance',
                    desc: 'To fulfill legal obligations, accounting standards, or applicable regulatory mandates.',
                  },
                  {
                    title: 'Quality & Support Service',
                    desc: 'To investigate technical discrepancies, troubleshoot webhooks, and resolve hospital queries.',
                  },
                ].map((item) => (
                  <div key={item.title} className="rounded-xl border border-ink-200 bg-ink-50/40 p-4">
                    <h3 className="text-xs font-bold text-ink-900">{item.title}</h3>
                    <p className="mt-1 text-xs text-ink-600 leading-relaxed">{item.desc}</p>
                  </div>
                ))}
              </div>
            </section>

            {/* Section 3: Message Delivery (WhatsApp / Meta) */}
            <section id="message-delivery" className="scroll-mt-24 border-t border-ink-200 pt-8">
              <div className="flex items-center gap-2.5">
                <span className="flex size-7 items-center justify-center rounded-lg bg-brand-100 text-xs font-bold text-brand-800">
                  3
                </span>
                <h2 className="text-xl font-bold tracking-tight text-ink-900 sm:text-2xl">
                  How Messages Are Delivered
                </h2>
              </div>

              <div className="mt-4 rounded-2xl border border-ink-200 bg-white p-5 shadow-sm space-y-4 text-xs text-ink-700 leading-relaxed">
                <p>
                  This Service relies on the official <strong>WhatsApp Business Platform</strong>, operated by Meta Platforms, Inc., to transmit and receive patient messages.
                </p>
                <p>
                  Message content and telephone numbers are securely routed and processed by Meta as part of real-time message delivery, governed strictly by{' '}
                  <a
                    href="https://www.whatsapp.com/legal/business-data-processing-terms"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-semibold text-brand-700 underline hover:text-brand-900 transition-colors"
                  >
                    Meta&apos;s Business Data Processing Terms
                  </a>
                  .
                </p>
                <div className="rounded-xl border border-brand-200 bg-brand-50/60 p-3.5 text-brand-950 font-medium">
                  <strong>Zero Commercial Sale Guarantee:</strong> We do not sell, rent, or trade patient telephone numbers, queue history, or staff records to marketing brokers or advertising networks.
                </div>
              </div>
            </section>

            {/* Section 4: Data Sharing with Hospitals */}
            <section id="data-sharing" className="scroll-mt-24 border-t border-ink-200 pt-8">
              <div className="flex items-center gap-2.5">
                <span className="flex size-7 items-center justify-center rounded-lg bg-brand-100 text-xs font-bold text-brand-800">
                  4
                </span>
                <h2 className="text-xl font-bold tracking-tight text-ink-900 sm:text-2xl">
                  Data Sharing with Hospitals &amp; Clinics
                </h2>
              </div>

              <div className="mt-4 space-y-3 text-xs sm:text-sm text-ink-700 leading-relaxed">
                <p>
                  Appointment and queue data collected through this Service is shared exclusively with the specific hospital, clinic, or healthcare provider the patient has chosen to book with. The healthcare provider is solely responsible for clinical care and in-person consultations.
                </p>
                <p>
                  Qurio acts strictly as a <strong>technology service provider and data processor</strong> on behalf of the hospital for scheduling, live queue estimation, and communication dispatch.
                </p>
              </div>
            </section>

            {/* Section 5: Data Retention */}
            <section id="data-retention" className="scroll-mt-24 border-t border-ink-200 pt-8">
              <div className="flex items-center gap-2.5">
                <span className="flex size-7 items-center justify-center rounded-lg bg-brand-100 text-xs font-bold text-brand-800">
                  5
                </span>
                <h2 className="text-xl font-bold tracking-tight text-ink-900 sm:text-2xl">
                  Data Retention &amp; Disposal
                </h2>
              </div>

              <div className="mt-4 rounded-xl border border-ink-200 bg-ink-50/40 p-5 text-xs text-ink-700 space-y-3 leading-relaxed">
                <p>
                  We retain appointment records and live queue timestamps for a standard duration of <strong>12 months</strong> following the date of the appointment, or as required by the partner hospital&apos;s own institutional record-keeping policies.
                </p>
                <p>
                  Upon expiration of the retention window, data is either permanently deleted from active production databases or irreversibly anonymized for aggregated operational performance reporting, unless prolonged retention is mandated by law.
                </p>
              </div>
            </section>

            {/* Section 6: Data Security */}
            <section id="data-security" className="scroll-mt-24 border-t border-ink-200 pt-8">
              <div className="flex items-center gap-2.5">
                <span className="flex size-7 items-center justify-center rounded-lg bg-brand-100 text-xs font-bold text-brand-800">
                  6
                </span>
                <h2 className="text-xl font-bold tracking-tight text-ink-900 sm:text-2xl">
                  Data Security Safeguards
                </h2>
              </div>

              <p className="mt-3 text-xs sm:text-sm text-ink-600 leading-relaxed">
                We implement industry-standard technical and organizational safeguards to protect data against unauthorized disclosure, alteration, or destruction:
              </p>

              <div className="mt-4 grid gap-3 sm:grid-cols-2 text-xs">
                <div className="rounded-xl border border-ink-200 bg-white p-4 shadow-sm">
                  <div className="font-bold text-ink-900">Transport &amp; Storage Encryption</div>
                  <div className="mt-1 text-ink-600">All data in transit is protected using TLS 1.3 / HTTPS encryption.</div>
                </div>
                <div className="rounded-xl border border-ink-200 bg-white p-4 shadow-sm">
                  <div className="font-bold text-ink-900">Multi-Tenant Isolation</div>
                  <div className="mt-1 text-ink-600">Each hospital&apos;s records are strictly segregated via scoped database queries.</div>
                </div>
                <div className="rounded-xl border border-ink-200 bg-white p-4 shadow-sm">
                  <div className="font-bold text-ink-900">Role-Based Access Control (RBAC)</div>
                  <div className="mt-1 text-ink-600">Only authorized clinic personnel with active credentials can access token dashboards.</div>
                </div>
                <div className="rounded-xl border border-ink-200 bg-white p-4 shadow-sm">
                  <div className="font-bold text-ink-900">Responsible Disclosure</div>
                  <div className="mt-1 text-ink-600">Continuous monitoring and rapid incident mitigation workflows.</div>
                </div>
              </div>

              <p className="mt-3 text-[11px] text-ink-500 leading-relaxed">
                While no electronic transmission or cloud system can guarantee absolute invulnerability, we actively review our architecture. Users are encouraged to report any suspected vulnerability to our security contact immediately.
              </p>
            </section>

            {/* Section 7: Your Privacy Rights */}
            <section id="your-rights" className="scroll-mt-24 border-t border-ink-200 pt-8">
              <div className="flex items-center gap-2.5">
                <span className="flex size-7 items-center justify-center rounded-lg bg-brand-100 text-xs font-bold text-brand-800">
                  7
                </span>
                <h2 className="text-xl font-bold tracking-tight text-ink-900 sm:text-2xl">
                  Your Rights &amp; Choices
                </h2>
              </div>

              <p className="mt-3 text-xs sm:text-sm text-ink-600 leading-relaxed">
                Depending on your jurisdiction, you possess specific legal rights regarding your personal information:
              </p>

              <div className="mt-4 space-y-2.5 text-xs text-ink-700">
                <div className="flex items-start gap-3 rounded-lg border border-ink-200 bg-white p-3.5">
                  <span className="font-bold text-brand-700">01</span>
                  <div>
                    <strong className="text-ink-900">Right to Access:</strong> Request a confirmation and copy of personal contact and booking records processed under your number.
                  </div>
                </div>
                <div className="flex items-start gap-3 rounded-lg border border-ink-200 bg-white p-3.5">
                  <span className="font-bold text-brand-700">02</span>
                  <div>
                    <strong className="text-ink-900">Right to Rectification:</strong> Request correction of incomplete, erroneous, or outdated personal details.
                  </div>
                </div>
                <div className="flex items-start gap-3 rounded-lg border border-ink-200 bg-white p-3.5">
                  <span className="font-bold text-brand-700">03</span>
                  <div>
                    <strong className="text-ink-900">Right to Erasure (&ldquo;Right to be Forgotten&rdquo;):</strong> Request deletion of your phone number and appointment logs, subject to statutory clinic record obligations.
                  </div>
                </div>
              </div>

              <div className="mt-4 rounded-xl border border-ink-200 bg-ink-50 p-4 text-xs text-ink-700">
                <span>To submit a rights request, visit our portal at </span>
                <a
                  href="https://hospital-automation-sepia.vercel.app/"
                  className="font-semibold text-brand-700 hover:text-brand-900 underline"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Qurio — OPD Queue Management Platform
                </a>
                <span> or email our Data Protection Officer at </span>
                <a
                  href="mailto:omdhangar24@gmail.com"
                  className="font-semibold text-brand-700 hover:text-brand-900 underline"
                >
                  omdhangar24@gmail.com
                </a>
                .
              </div>
            </section>

            {/* Section 8: Children's Privacy */}
            <section id="children-privacy" className="scroll-mt-24 border-t border-ink-200 pt-8">
              <div className="flex items-center gap-2.5">
                <span className="flex size-7 items-center justify-center rounded-lg bg-brand-100 text-xs font-bold text-brand-800">
                  8
                </span>
                <h2 className="text-xl font-bold tracking-tight text-ink-900 sm:text-2xl">
                  Children&apos;s Privacy
                </h2>
              </div>

              <p className="mt-3 text-xs sm:text-sm text-ink-700 leading-relaxed">
                This Service is intended for use by adults booking consultations for themselves or on behalf of minors (such as pediatric OPD visits). We do not knowingly collect personal information directly from children under 18 without parental or guardian authorization and involvement.
              </p>
            </section>

            {/* Section 9: Changes to This Policy */}
            <section id="policy-changes" className="scroll-mt-24 border-t border-ink-200 pt-8">
              <div className="flex items-center gap-2.5">
                <span className="flex size-7 items-center justify-center rounded-lg bg-brand-100 text-xs font-bold text-brand-800">
                  9
                </span>
                <h2 className="text-xl font-bold tracking-tight text-ink-900 sm:text-2xl">
                  Changes to This Policy
                </h2>
              </div>

              <p className="mt-3 text-xs sm:text-sm text-ink-700 leading-relaxed">
                We may periodically update this Privacy Policy to reflect modifications in our operational practices, regulatory mandates, or technological integrations. Material updates will be clearly reflected by revising the &ldquo;Last updated&rdquo; timestamp at the top of this document.
              </p>
            </section>

            {/* Section 10: Contact Us */}
            <section id="contact-us" className="scroll-mt-24 border-t border-ink-200 pt-8">
              <div className="flex items-center gap-2.5">
                <span className="flex size-7 items-center justify-center rounded-lg bg-brand-100 text-xs font-bold text-brand-800">
                  10
                </span>
                <h2 className="text-xl font-bold tracking-tight text-ink-900 sm:text-2xl">
                  Contact Us
                </h2>
              </div>

              <p className="mt-3 text-xs sm:text-sm text-ink-600 leading-relaxed">
                If you have questions, feedback, or data requests regarding this Privacy Policy, please get in touch with our team:
              </p>

              <div className="mt-5 rounded-2xl border border-ink-200 bg-white p-6 shadow-sm">
                <div className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <span className="text-[10px] font-bold uppercase tracking-wider text-ink-400">
                      Organization
                    </span>
                    <p className="mt-1 text-sm font-bold text-ink-900">Qurio</p>
                    <p className="text-xs text-ink-500">OPD Queue &amp; Patient Flow Automation</p>
                  </div>

                  <div>
                    <span className="text-[10px] font-bold uppercase tracking-wider text-ink-400">
                      Direct Email
                    </span>
                    <p className="mt-1">
                      <a
                        href="mailto:omdhangar24@gmail.com"
                        className="text-sm font-bold text-brand-700 hover:text-brand-900 hover:underline"
                      >
                        omdhangar24@gmail.com
                      </a>
                    </p>
                    <p className="text-xs text-ink-500">Privacy &amp; Data Protection Officer</p>
                  </div>

                  <div className="sm:col-span-2 pt-3 border-t border-ink-100">
                    <span className="text-[10px] font-bold uppercase tracking-wider text-ink-400">
                      Platform URL
                    </span>
                    <p className="mt-1">
                      <a
                        href="https://hospital-automation-sepia.vercel.app/"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs font-medium text-brand-700 hover:text-brand-900 hover:underline break-all"
                      >
                        https://hospital-automation-sepia.vercel.app/
                      </a>
                    </p>
                  </div>
                </div>
              </div>
            </section>
          </main>
        </div>
      </div>

      {/* ------------------------------------------------------------- Footer */}
      <footer className="border-t border-ink-200 bg-ink-900 py-12 text-ink-400">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <div className="flex flex-col items-center justify-between gap-6 sm:flex-row">
            <div>
              <div className="flex items-center gap-2">
                <span className="flex size-6 items-center justify-center rounded-lg bg-brand-500 text-xs font-bold text-white">
                  Q
                </span>
                <p className="text-sm font-bold text-white">Qurio</p>
              </div>
              <p className="text-xs text-ink-400 mt-1">
                OPD queue and patient flow management for Indian hospitals and clinics.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-6 text-xs">
              <Link href="/" className="hover:text-white transition-colors">
                Home
              </Link>
              <Link href="/pricing" className="hover:text-white transition-colors">
                Pricing
              </Link>
              <Link href="/login" className="hover:text-white transition-colors">
                Hospital Sign In
              </Link>
              <Link href="/book" className="hover:text-white transition-colors">
                Patient Slot Booking
              </Link>
              <Link href="/privacy" className="text-white font-semibold hover:text-brand-300 transition-colors">
                Privacy Policy
              </Link>
            </div>
          </div>

          <div className="mt-8 border-t border-ink-800 pt-6 text-center text-[11px] text-ink-500">
            © {new Date().getFullYear()} Qurio. All rights reserved. Privacy by design.
          </div>
        </div>
      </footer>
    </div>
  );
}
