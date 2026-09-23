import type { Metadata } from 'next';
import Link from 'next/link';
import { AuthButton } from '@/components/marketing/auth-button';
import { PricingView, type PricingTierData } from '@/components/marketing/pricing-view';
import { getSession } from '@/lib/auth/session';
import { SEED_PLAN_TIERS } from '@/lib/domain/pricing';
import { getCurrentSubscription, listActiveTiers } from '@/lib/services/subscriptions';

export const metadata: Metadata = {
  title: 'Pricing & Plans · Qurio',
  description:
    'Transparent, capacity-based pricing for clinics and hospitals. Every plan includes the full product: WhatsApp booking, live queue tracker, TV display, and reception caller.',
};

export default async function PricingPage() {
  const [session, dbTiers] = await Promise.all([
    getSession().catch(() => null),
    listActiveTiers().catch(() => []),
  ]);

  let currentSubscription = null;
  if (session?.hospitalId) {
    currentSubscription = await getCurrentSubscription(session.hospitalId).catch(() => null);
  }

  // Use active tiers from DB, fallback to domain seed if DB has no tiers loaded yet
  const tiers: PricingTierData[] =
    dbTiers.length > 0
      ? dbTiers.map((t) => ({
          code: t.code,
          name: t.name,
          patientsPerDay: t.patientsPerDay,
          includedAppointments: t.includedAppointments,
          includedMessages: t.includedMessages,
          monthlyPricePaise: t.monthlyPricePaise,
          annualPricePaise: t.annualPricePaise,
          setupFeePaise: t.setupFeePaise,
          overagePaisePerAppointment: t.overagePaisePerAppointment,
          overagePaisePerMessage: t.overagePaisePerMessage,
        }))
      : SEED_PLAN_TIERS.map((t) => ({
          code: t.code,
          name: t.name,
          patientsPerDay: t.patientsPerDay,
          includedAppointments: t.includedAppointments,
          includedMessages: t.includedMessages,
          monthlyPricePaise: t.monthlyPricePaise,
          annualPricePaise: t.annualPricePaise,
          setupFeePaise: t.setupFeePaise,
          overagePaisePerAppointment: t.overagePaisePerAppointment,
          overagePaisePerMessage: t.overagePaisePerMessage,
        }));

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

          <nav className="hidden items-center gap-7 text-xs font-semibold text-ink-600 md:flex">
            <Link href="/#problem" className="hover:text-ink-900 transition-colors">
              The Problem
            </Link>
            <Link href="/#how-it-works" className="hover:text-ink-900 transition-colors">
              How It Works
            </Link>
            <Link href="/#benefits" className="hover:text-ink-900 transition-colors">
              Benefits
            </Link>
            <Link
              href="/pricing"
              className="text-brand-700 font-bold hover:text-ink-900 transition-colors"
            >
              Pricing
            </Link>
            <Link href="/#faq" className="hover:text-ink-900 transition-colors">
              Questions
            </Link>
          </nav>

          <AuthButton />
        </div>
      </header>

      {/* -------------------------------------------------------- Main Body */}
      <main>
        <PricingView
          tiers={tiers}
          currentTierCode={currentSubscription?.planTierCode}
          isAuthenticated={!!session}
        />
      </main>

      {/* ------------------------------------------------------------- Footer */}
      <footer className="border-t border-ink-200 bg-ink-900 py-12 text-ink-400">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <div className="flex flex-col items-center justify-between gap-6 sm:flex-row">
            <div>
              <p className="text-sm font-bold text-white">Qurio</p>
              <p className="text-xs text-ink-400 mt-0.5">
                OPD queue and patient flow management for Indian hospitals.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-6 text-xs">
              <Link href="/" className="hover:text-white transition-colors">
                Home
              </Link>
              <Link href="/pricing" className="hover:text-white transition-colors">
                Pricing & Plans
              </Link>
              <Link href="/login" className="hover:text-white transition-colors">
                Hospital Sign In
              </Link>
              <Link href="/book" className="hover:text-white transition-colors">
                Patient Slot Booking
              </Link>
              <Link href="/privacy" className="hover:text-white transition-colors">
                Privacy Policy
              </Link>
              <a href="#demo" className="hover:text-white transition-colors">
                Request Demo
              </a>
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
