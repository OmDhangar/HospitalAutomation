'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { Button, Card, cn } from '@/components/ui';
import { DemoForm } from '@/components/marketing/demo-form';

export type PricingTierData = {
  code: string;
  name: string;
  patientsPerDay: number;
  includedAppointments: number;
  includedMessages: number;
  monthlyPricePaise: number;
  annualPricePaise: number;
  setupFeePaise: number;
  overagePaisePerAppointment: number;
  overagePaisePerMessage: number;
};

export function rupees(paise: number): string {
  return `₹${Math.round(paise / 100).toLocaleString('en-IN')}`;
}

export function PricingView({
  tiers,
  currentTierCode,
  isAuthenticated = false,
}: {
  tiers: PricingTierData[];
  currentTierCode?: string | null;
  isAuthenticated?: boolean;
}) {
  const [billingCycle, setBillingCycle] = useState<'monthly' | 'annual'>('annual');
  const [patientSlider, setPatientSlider] = useState<number>(100);
  const [expandedFaq, setExpandedFaq] = useState<number | null>(null);

  // Find recommended tier based on calculator slider
  const recommendedTier =
    tiers.find((t) => t.patientsPerDay >= patientSlider) || tiers[tiers.length - 1];

  const faqs = [
    {
      q: 'What happens if our hospital exceeds the included appointments?',
      a: 'Your queue never stops. Patient care is never interrupted. Additional appointments beyond your monthly quota are billed transparently at just ₹1 each. If you regularly exceed your capacity, moving to a higher tier is cheaper than paying overages, and our team will notify you proactively.',
    },
    {
      q: 'Do we need to purchase new computers, scanners, or tablets?',
      a: 'No special hardware is required. Qurio runs completely in the web browser on any existing desktop, laptop, smartphone, or tablet at your reception. The waiting room live screen works on any smart TV or tablet with a browser.',
    },
    {
      q: 'How does the Annual Billing discount work?',
      a: 'On an annual subscription, you pay for 10 months and receive 12 months of service (2 months completely free). In addition, the ₹5,000 one-time setup fee is 100% waived.',
    },
    {
      q: 'What does the one-time Setup Fee cover?',
      a: 'The setup fee covers full onboarding: configuring your dedicated WhatsApp business sender, setting up doctor schedules, customized digital signage templates (QR code posters for your entrance), and a live 15-minute training session for reception and doctors.',
    },
    {
      q: 'Can multiple doctors and consulting rooms use the same plan?',
      a: 'Yes! We do not charge per doctor or per receptionist. Every tier allows unlimited doctor profiles, unlimited departments/rooms, and unlimited reception logins. Tiers are sized solely by total outpatient capacity.',
    },
    {
      q: 'What happens if our clinic internet connection drops?',
      a: 'Qurio is built for resilience. Existing token numbers already issued to patients remain completely valid, and reception can continue queue management with built-in offline synchronization or simple paper tokens until connection restores.',
    },
    {
      q: 'What patient data is stored by Qurio?',
      a: 'Strict privacy-by-design: We only store the patient’s name and mobile number needed to message their token and queue updates. We never request, collect, or store medical histories, diagnoses, or prescriptions.',
    },
  ];

  return (
    <div className="space-y-20 pb-20">
      {/* -------------------------------------------------- Hero Header */}
      <section className="text-center max-w-3xl mx-auto pt-6 sm:pt-10">
        <div className="inline-flex items-center gap-1.5 rounded-full border border-brand-200 bg-brand-50 px-3.5 py-1 text-xs font-bold uppercase tracking-wider text-brand-800 mb-4">
          Fair & Transparent Pricing
        </div>
        <h1 className="text-3xl font-extrabold tracking-tight text-ink-950 sm:text-5xl">
          Complete transparency. No hidden charges.
        </h1>
        <p className="mt-4 text-base sm:text-lg text-ink-600 leading-relaxed">
          Every plan includes the complete Qurio software with zero feature gating. Capacity is the
          only difference.
        </p>

        {/* Billing Cycle Switcher */}
        <div className="mt-8 inline-flex items-center rounded-2xl border border-ink-200 bg-ink-50/80 p-1.5 shadow-inner">
          <button
            type="button"
            onClick={() => setBillingCycle('monthly')}
            className={cn(
              'rounded-xl px-4 py-2 text-xs sm:text-sm font-semibold transition-all duration-150',
              billingCycle === 'monthly'
                ? 'bg-white text-ink-900 shadow-sm'
                : 'text-ink-600 hover:text-ink-900',
            )}
          >
            Monthly Billing
          </button>
          <button
            type="button"
            onClick={() => setBillingCycle('annual')}
            className={cn(
              'flex items-center gap-2 rounded-xl px-4 py-2 text-xs sm:text-sm font-semibold transition-all duration-150',
              billingCycle === 'annual'
                ? 'bg-brand-600 text-white shadow-sm'
                : 'text-ink-600 hover:text-ink-900',
            )}
          >
            <span>Annual Billing</span>
            <span
              className={cn(
                'rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider',
                billingCycle === 'annual'
                  ? 'bg-brand-800 text-brand-100'
                  : 'bg-emerald-100 text-emerald-800',
              )}
            >
              2 Months Free + ₹0 Setup Fee
            </span>
          </button>
        </div>
      </section>

      {/* -------------------------------------------------- Pricing Grid */}
      <section className="max-w-7xl mx-auto px-4 sm:px-6">
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-3">
          {tiers.map((tier) => {
            const isCurrent = tier.code === currentTierCode;
            const isPopular = tier.code === 'hospital' || tier.code === 'clinic';
            const pricePaise =
              billingCycle === 'annual'
                ? Math.round(tier.annualPricePaise / 12)
                : tier.monthlyPricePaise;
            const setupFeeDisplay =
              billingCycle === 'annual'
                ? 'Setup fee waived'
                : `${rupees(tier.setupFeePaise)} one-time setup`;

            return (
              <div
                key={tier.code}
                className={cn(
                  'relative flex flex-col rounded-2xl border bg-white p-6 transition-all duration-200 hover:shadow-lg',
                  isCurrent
                    ? 'border-brand-600 ring-2 ring-brand-600 shadow-md'
                    : isPopular
                      ? 'border-brand-300 shadow-[var(--shadow-raised)]'
                      : 'border-ink-200 shadow-sm',
                )}
              >
                {/* Popular / Current Badges */}
                <div className="flex items-center justify-between gap-2 mb-3 min-h-[24px]">
                  {isPopular ? (
                    <span className="inline-flex items-center rounded-full bg-brand-100 px-2.5 py-0.5 text-xs font-bold text-brand-800 uppercase tracking-wide">
                      {tier.code === 'hospital' ? 'Most Popular' : 'Clinics Choice'}
                    </span>
                  ) : (
                    <span />
                  )}
                  {isCurrent ? (
                    <span className="inline-flex items-center rounded-full bg-brand-600 px-2.5 py-0.5 text-xs font-semibold text-white">
                      Your Active Plan
                    </span>
                  ) : null}
                </div>

                {/* Tier Name & Subtitle */}
                <div>
                  <h3 className="text-xl font-bold text-ink-900">{tier.name}</h3>
                  <p className="mt-1 text-xs text-ink-600">
                    Designed for ~{tier.patientsPerDay} patients / day
                  </p>
                </div>

                {/* Price Display */}
                <div className="mt-6 border-b border-ink-100 pb-5">
                  <div className="flex items-baseline gap-1.5">
                    <span className="text-3xl sm:text-4xl font-extrabold text-ink-950">
                      {rupees(pricePaise)}
                    </span>
                    <span className="text-xs text-ink-500 font-medium">/ month</span>
                  </div>
                  <p className="mt-2 text-xs text-ink-500">
                    {billingCycle === 'annual' ? (
                      <>
                        Billed {rupees(tier.annualPricePaise)} / year ·{' '}
                        <span className="font-semibold text-brand-700">{setupFeeDisplay}</span>
                      </>
                    ) : (
                      <>
                        Billed monthly ·{' '}
                        <span className="font-medium text-ink-600">{setupFeeDisplay}</span>
                      </>
                    )}
                  </p>
                </div>

                {/* Capacity & Quotas */}
                <div className="py-5 space-y-3 border-b border-ink-100 text-xs">
                  <div className="flex items-center justify-between text-ink-700">
                    <span className="text-ink-500">Monthly Appointments</span>
                    <span className="font-bold text-ink-900">
                      {tier.includedAppointments.toLocaleString('en-IN')}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-ink-700">
                    <span className="text-ink-500">Daily Capacity</span>
                    <span className="font-bold text-ink-900">~{tier.patientsPerDay} patients/day</span>
                  </div>
                  <div className="flex items-center justify-between text-ink-700">
                    <span className="text-ink-500">WhatsApp Messages</span>
                    <span className="font-bold text-ink-900">
                      {tier.includedMessages.toLocaleString('en-IN')}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-ink-700">
                    <span className="text-ink-500">Overage Rate</span>
                    <span className="font-bold text-emerald-700">₹1 / extra patient</span>
                  </div>
                </div>

                {/* Key Inclusions */}
                <div className="pt-5 pb-6 flex-1">
                  <p className="text-xs font-bold uppercase tracking-wider text-ink-400 mb-3">
                    Includes Full Platform:
                  </p>
                  <ul className="space-y-2.5 text-xs text-ink-700">
                    <li className="flex items-start gap-2">
                      <span className="text-brand-600 font-bold">✓</span>
                      <span>WhatsApp Bot in Marathi, Hindi & English</span>
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="text-brand-600 font-bold">✓</span>
                      <span>Live patient queue status tracker web link</span>
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="text-brand-600 font-bold">✓</span>
                      <span>1-Click reception Call Next operator screen</span>
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="text-brand-600 font-bold">✓</span>
                      <span>Smart automated 2-patient recall WhatsApp nudges</span>
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="text-brand-600 font-bold">✓</span>
                      <span>Waiting room live TV display mode</span>
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="text-brand-600 font-bold">✓</span>
                      <span>Unlimited doctors & staff logins</span>
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="text-brand-600 font-bold">✓</span>
                      <span>On-site & video staff training (15 mins)</span>
                    </li>
                  </ul>
                </div>

                {/* CTA Button */}
                <div className="mt-auto pt-2">
                  {isAuthenticated ? (
                    isCurrent ? (
                      <Link href="/subscription" className="w-full block">
                        <Button variant="secondary" className="w-full">
                          View Current Subscription
                        </Button>
                      </Link>
                    ) : (
                      <Link href="/subscription" className="w-full block">
                        <Button variant={isPopular ? 'primary' : 'secondary'} className="w-full">
                          Manage / Change Plan
                        </Button>
                      </Link>
                    )
                  ) : (
                    <a href="#demo" className="w-full block">
                      <Button
                        variant={isPopular ? 'primary' : 'secondary'}
                        size="md"
                        className="w-full shadow-sm"
                      >
                        Schedule Demo for {tier.name}
                      </Button>
                    </a>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* ------------------------------------------- Initial Stages Transparency */}
      <section className="bg-ink-50/70 border-y border-ink-200 py-16 px-4 sm:px-6">
        <div className="max-w-6xl mx-auto">
          <div className="text-center max-w-3xl mx-auto mb-14">
            <span className="text-xs font-bold uppercase tracking-widest text-brand-700">
              What to Expect
            </span>
            <h2 className="mt-2 text-2xl font-bold tracking-tight text-ink-900 sm:text-3xl">
              What specifically we provide in the initial stages
            </h2>
            <p className="mt-3 text-sm text-ink-600 leading-relaxed">
              We know hospital mornings are busy. Our onboarding is designed to be completely zero-friction,
              ensuring your staff is up and running in under 15 minutes with zero disruption to patient care.
            </p>
          </div>

          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {/* Step 1 */}
            <div className="rounded-2xl border border-ink-200 bg-white p-6 shadow-sm">
              <div className="flex size-10 items-center justify-center rounded-xl bg-brand-100 text-brand-800 font-bold text-sm mb-4">
                1
              </div>
              <h3 className="text-base font-bold text-ink-900">15-Minute OPD Flow Assessment</h3>
              <p className="mt-2 text-xs text-ink-600 leading-relaxed">
                We study your clinic timings, average patient volume, consulting rooms, and walk-in
                patterns to customize token ranges and doctors’ schedules precisely for your hospital.
              </p>
            </div>

            {/* Step 2 */}
            <div className="rounded-2xl border border-ink-200 bg-white p-6 shadow-sm">
              <div className="flex size-10 items-center justify-center rounded-xl bg-brand-100 text-brand-800 font-bold text-sm mb-4">
                2
              </div>
              <h3 className="text-base font-bold text-ink-900">Dedicated WhatsApp Number Setup</h3>
              <p className="mt-2 text-xs text-ink-600 leading-relaxed">
                We configure your clinic’s official WhatsApp sender with verified templates in
                Marathi, Hindi, and English so patients get instant, crystal-clear token confirmations.
              </p>
            </div>

            {/* Step 3 */}
            <div className="rounded-2xl border border-ink-200 bg-white p-6 shadow-sm">
              <div className="flex size-10 items-center justify-center rounded-xl bg-brand-100 text-brand-800 font-bold text-sm mb-4">
                3
              </div>
              <h3 className="text-base font-bold text-ink-900">15-Minute Staff Training</h3>
              <p className="mt-2 text-xs text-ink-600 leading-relaxed">
                Reception staff learn to advance the queue with a single button and register walk-ins
                in 5 seconds. Doctors access their live queue on mobile between consultations.
              </p>
            </div>

            {/* Step 4 */}
            <div className="rounded-2xl border border-ink-200 bg-white p-6 shadow-sm">
              <div className="flex size-10 items-center justify-center rounded-xl bg-brand-100 text-brand-800 font-bold text-sm mb-4">
                4
              </div>
              <h3 className="text-base font-bold text-ink-900">Physical Signage & QR Kit</h3>
              <p className="mt-2 text-xs text-ink-600 leading-relaxed">
                We deliver high-resolution, branded printable standees and posters for your entrance
                and waiting room, guiding arriving patients to scan and join the digital line.
              </p>
            </div>

            {/* Step 5 */}
            <div className="rounded-2xl border border-ink-200 bg-white p-6 shadow-sm">
              <div className="flex size-10 items-center justify-center rounded-xl bg-brand-100 text-brand-800 font-bold text-sm mb-4">
                5
              </div>
              <h3 className="text-base font-bold text-ink-900">Waiting Room Display Setup</h3>
              <p className="mt-2 text-xs text-ink-600 leading-relaxed">
                We help you open the live privacy-safe token board on your existing waiting-room TV,
                monitor, or tablet so patients see real-time updates without crowding reception.
              </p>
            </div>

            {/* Step 6 */}
            <div className="rounded-2xl border border-ink-200 bg-white p-6 shadow-sm">
              <div className="flex size-10 items-center justify-center rounded-xl bg-brand-100 text-brand-800 font-bold text-sm mb-4">
                6
              </div>
              <h3 className="text-base font-bold text-ink-900">First-Morning Live Support</h3>
              <p className="mt-2 text-xs text-ink-600 leading-relaxed">
                A dedicated Qurio specialist is live on phone and remote assist during your first OPD
                session to ensure smooth operations and answer any instant queries.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* --------------------------------- Interactive Plan Recommendation Tool */}
      <section className="max-w-4xl mx-auto px-4 sm:px-6">
        <Card className="p-6 sm:p-10 bg-gradient-to-br from-brand-50/60 via-white to-ink-50/50 border-brand-200 shadow-[var(--shadow-raised)]">
          <div className="text-center max-w-2xl mx-auto">
            <span className="text-xs font-bold uppercase tracking-widest text-brand-700">
              Plan Calculator
            </span>
            <h3 className="mt-1 text-xl sm:text-2xl font-bold text-ink-900">
              Not sure which plan matches your hospital?
            </h3>
            <p className="mt-2 text-xs sm:text-sm text-ink-600">
              Select your approximate daily OPD patient volume to find the right tier.
            </p>
          </div>

          <div className="mt-8 max-w-xl mx-auto">
            <div className="flex items-center justify-between text-xs font-semibold text-ink-700 mb-2">
              <span>Expected Daily Patients:</span>
              <span className="text-base font-extrabold text-brand-700">
                ~{patientSlider} patients / day
              </span>
            </div>

            <input
              type="range"
              min="15"
              max="300"
              step="5"
              value={patientSlider}
              onChange={(e) => setPatientSlider(Number(e.target.value))}
              className="w-full h-2.5 bg-ink-200 rounded-lg appearance-none cursor-pointer accent-brand-600"
              aria-label="Expected daily patients slider"
            />

            <div className="flex justify-between text-[11px] text-ink-400 mt-2 font-medium">
              <span>Solo (15-25/day)</span>
              <span>Clinic (60/day)</span>
              <span>Practice (100/day)</span>
              <span>Hospital (150/day)</span>
              <span>Large (200+/day)</span>
            </div>

            {recommendedTier ? (
              <div className="mt-8 rounded-2xl border border-brand-200 bg-white p-5 shadow-sm">
                <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
                  <div>
                    <span className="text-[10px] font-bold uppercase tracking-wider text-brand-700">
                      Recommended Tier
                    </span>
                    <h4 className="text-xl font-extrabold text-ink-900">{recommendedTier.name}</h4>
                    <p className="text-xs text-ink-600 mt-0.5">
                      Covers up to {recommendedTier.includedAppointments.toLocaleString('en-IN')}{' '}
                      appointments and {recommendedTier.includedMessages.toLocaleString('en-IN')}{' '}
                      WhatsApp messages / month.
                    </p>
                  </div>
                  <div className="text-center sm:text-right shrink-0">
                    <p className="text-2xl font-extrabold text-ink-900">
                      {rupees(recommendedTier.monthlyPricePaise)}
                      <span className="text-xs font-normal text-ink-500">/mo</span>
                    </p>
                    <p className="text-[11px] text-emerald-700 font-semibold">
                      or {rupees(recommendedTier.annualPricePaise)}/yr (Save ₹5,000 setup fee)
                    </p>
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        </Card>
      </section>

      {/* --------------------------------- Everything Included In Every Plan */}
      <section className="max-w-6xl mx-auto px-4 sm:px-6">
        <div className="text-center max-w-2xl mx-auto mb-12">
          <span className="text-xs font-bold uppercase tracking-widest text-brand-700">
            Uncompromising Quality
          </span>
          <h2 className="mt-1 text-2xl font-bold tracking-tight text-ink-900 sm:text-3xl">
            Every plan includes the complete product
          </h2>
          <p className="mt-2 text-xs sm:text-sm text-ink-600">
            We don’t lock essential features behind higher enterprise plans. Every clinic gets the
            exact same reliable software.
          </p>
        </div>

        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {[
            {
              icon: '💬',
              title: 'Multilingual WhatsApp Bot',
              desc: 'Seamless booking and instant token issuance in Marathi, Hindi, and English with zero patient app installation.',
            },
            {
              icon: '⏱️',
              title: 'Live Queue Web Tracker',
              desc: 'Patients track live queue countdown on their phones, so waiting corridors remain peaceful and empty.',
            },
            {
              icon: '🛎️',
              title: '1-Click Call Next Caller',
              desc: 'Reception advances patients with a single tap. Walk-in patients registered in under 5 seconds.',
            },
            {
              icon: '📺',
              title: 'Waiting Room TV Display',
              desc: 'Privacy-first token screen for waiting hall TVs showing current calling tokens without exposing patient names.',
            },
            {
              icon: '🔔',
              title: 'Smart 2-Patient Nudges',
              desc: 'Automated WhatsApp recall alerts sent when only 2 patients remain ahead, giving patients time to return.',
            },
            {
              icon: '📊',
              title: 'Doctor Live OPD Metrics',
              desc: 'Real-time insight on waiting times, consultation lengths, and patients seen without interruptions.',
            },
            {
              icon: '👥',
              title: 'Unlimited Doctors & Rooms',
              desc: 'Add all consulting doctors, OPD rooms, and receptionists without any extra per-seat license fees.',
            },
            {
              icon: '🔒',
              title: 'Privacy-First Architecture',
              desc: 'Zero medical records, diagnoses, or prescriptions stored. Strict patient data confidentiality guaranteed.',
            },
          ].map((feature) => (
            <div
              key={feature.title}
              className="rounded-2xl border border-ink-200 bg-white p-5 shadow-sm transition-all hover:border-brand-300"
            >
              <span className="text-2xl" aria-hidden="true">
                {feature.icon}
              </span>
              <h3 className="mt-3 text-sm font-bold text-ink-900">{feature.title}</h3>
              <p className="mt-1.5 text-xs text-ink-600 leading-relaxed">{feature.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ------------------------------------------ Feature Comparison Table */}
      <section className="max-w-6xl mx-auto px-4 sm:px-6">
        <div className="text-center max-w-2xl mx-auto mb-10">
          <span className="text-xs font-bold uppercase tracking-widest text-brand-700">
            Side-by-Side
          </span>
          <h2 className="mt-1 text-2xl font-bold tracking-tight text-ink-900 sm:text-3xl">
            Compare Plan Capacities
          </h2>
        </div>

        <div className="overflow-x-auto rounded-2xl border border-ink-200 bg-white shadow-sm">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-ink-200 bg-ink-50/80 text-ink-900">
              <tr>
                <th className="py-3.5 px-4 font-bold">Plan Tier</th>
                <th className="py-3.5 px-4 font-bold">Daily Patients</th>
                <th className="py-3.5 px-4 font-bold">Monthly Appts</th>
                <th className="py-3.5 px-4 font-bold">WhatsApp Quota</th>
                <th className="py-3.5 px-4 font-bold">Monthly Price</th>
                <th className="py-3.5 px-4 font-bold">Annual (2 Mo Free)</th>
                <th className="py-3.5 px-4 font-bold">Overage Rate</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100 text-ink-700">
              {tiers.map((t) => (
                <tr key={t.code} className="hover:bg-ink-50/50">
                  <td className="py-3.5 px-4 font-semibold text-ink-900">{t.name}</td>
                  <td className="py-3.5 px-4">~{t.patientsPerDay} / day</td>
                  <td className="py-3.5 px-4 font-medium">
                    {t.includedAppointments.toLocaleString('en-IN')}
                  </td>
                  <td className="py-3.5 px-4 font-medium">
                    {t.includedMessages.toLocaleString('en-IN')}
                  </td>
                  <td className="py-3.5 px-4 font-bold text-ink-900">
                    {rupees(t.monthlyPricePaise)}
                  </td>
                  <td className="py-3.5 px-4 font-semibold text-brand-700">
                    {rupees(t.annualPricePaise)} / yr
                  </td>
                  <td className="py-3.5 px-4 text-emerald-700 font-medium">₹1 / appointment</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* ----------------------------------------------------------------- FAQ */}
      <section className="max-w-4xl mx-auto px-4 sm:px-6">
        <div className="text-center max-w-2xl mx-auto mb-10">
          <span className="text-xs font-bold uppercase tracking-widest text-brand-700">
            Clear Answers
          </span>
          <h2 className="mt-1 text-2xl font-bold tracking-tight text-ink-900 sm:text-3xl">
            Frequently Asked Questions
          </h2>
        </div>

        <div className="space-y-3">
          {faqs.map((faq, idx) => {
            const isOpen = expandedFaq === idx;
            return (
              <div
                key={faq.q}
                className="rounded-2xl border border-ink-200 bg-white transition-all overflow-hidden"
              >
                <button
                  type="button"
                  onClick={() => setExpandedFaq(isOpen ? null : idx)}
                  className="w-full flex items-center justify-between gap-4 p-5 text-left text-sm font-bold text-ink-900 hover:bg-ink-50/50"
                  aria-expanded={isOpen}
                >
                  <span>{faq.q}</span>
                  <span className="text-ink-400 text-base font-normal shrink-0">
                    {isOpen ? '−' : '+'}
                  </span>
                </button>
                {isOpen ? (
                  <div className="px-5 pb-5 text-xs text-ink-600 leading-relaxed border-t border-ink-100 pt-3">
                    {faq.a}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </section>

      {/* --------------------------------------------------- Schedule Demo CTA */}
      <section id="demo" className="max-w-xl mx-auto px-4 sm:px-6 pt-6">
        <div className="text-center mb-8">
          <span className="text-xs font-bold uppercase tracking-widest text-brand-700">
            Get Started
          </span>
          <h2 className="mt-1 text-2xl font-bold tracking-tight text-ink-900 sm:text-3xl">
            Schedule a 10-Minute Hospital Demo
          </h2>
          <p className="mt-2 text-xs sm:text-sm text-ink-600">
            See how Qurio runs your physical OPD smoothly. Fill out this brief form and our team will
            connect with you today.
          </p>
        </div>

        <Card className="p-6 sm:p-8 shadow-[var(--shadow-raised)]">
          <DemoForm />
        </Card>
      </section>
    </div>
  );
}
