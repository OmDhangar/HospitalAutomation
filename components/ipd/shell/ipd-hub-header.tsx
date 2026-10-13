'use client';

import React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { BedIcon, PlusIcon } from '@/components/icons';
import { cn } from '@/components/ui';
import type { SectionTab } from '@/components/ipd/section-tabs';

export function IpdHubHeader({
  tabs,
  canAdmit,
}: {
  tabs: readonly SectionTab[];
  canAdmit: boolean;
}) {
  const pathname = usePathname();

  // If inside a patient chart (/ipd/patients/*) or bedside chart (/ipd/ward/.../bed/...),
  // do NOT render the IPD hub strip. The patient has their own dedicated PatientBanner and TabNavigation.
  const isPatientOrBedsideView =
    pathname.startsWith('/ipd/patients') ||
    pathname.includes('/bed/') ||
    pathname.startsWith('/ipd/rounds');

  if (isPatientOrBedsideView) {
    return null;
  }

  const isActive = (href: string) =>
    href === '/ipd'
      ? pathname === '/ipd' || pathname.startsWith('/ipd/admissions')
      : pathname.startsWith(href);

  return (
    <div className="-mx-3.5 -mt-3.5 mb-3 border-b border-brand-200 bg-brand-50/80 px-3.5 sm:-mx-6 sm:px-6 lg:-mt-6">
      <div className="flex h-10 items-center justify-between gap-3">
        {/* Left: Bed icon + IPD title (no duplicate hospital name) */}
        <div className="flex items-center gap-2">
          <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-brand-600 text-white shadow-xs">
            <BedIcon className="size-3.5" />
          </span>
          <span className="text-xs font-bold text-ink-900 tracking-tight">IPD</span>
        </div>

        {/* Center: Inline compact tabs */}
        {tabs.length > 1 && (
          <nav aria-label="IPD sections" className="flex items-center gap-1 overflow-x-auto scrollbar-none h-full">
            {tabs.map((tab) => (
              <Link
                key={tab.href}
                href={tab.href}
                aria-current={isActive(tab.href) ? 'page' : undefined}
                className={cn(
                  'inline-flex h-full items-center border-b-2 px-2.5 text-xs font-semibold transition-colors',
                  isActive(tab.href)
                    ? 'border-brand-600 text-brand-800'
                    : 'border-transparent text-ink-600 hover:text-ink-900',
                )}
              >
                {tab.label}
              </Link>
            ))}
          </nav>
        )}

        {/* Right: Compact Admit Button */}
        {canAdmit && (
          <Link
            href="/ipd/new"
            className="inline-flex h-7 items-center gap-1 rounded-md bg-brand-600 px-2.5 text-xs font-semibold text-white shadow-2xs hover:bg-brand-700"
          >
            <PlusIcon className="size-3.5" />
            <span className="hidden sm:inline">New admission</span>
            <span className="sm:hidden">Admit</span>
          </Link>
        )}
      </div>
    </div>
  );
}
