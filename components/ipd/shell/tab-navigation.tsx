'use client';

import React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

export interface TabItem {
  id: string;
  label: string;
  hrefSegment: string;
  badge?: number | string | null;
  badgeVariant?: 'primary' | 'danger' | 'warning' | 'success';
}

export interface TabNavigationProps {
  admissionId: string;
  currentTab?: string;
  counts?: {
    unverifiedOrders?: number;
    overdueDoses?: number;
    criticalInvestigations?: number;
    isDischargeReady?: boolean;
  };
  className?: string;
}

export function TabNavigation({
  admissionId,
  currentTab,
  counts,
  className = '',
}: TabNavigationProps) {
  const pathname = usePathname();

  // If currentTab is not explicitly passed, infer it from the pathname:
  // e.g. /ipd/patients/[id]/orders -> 'orders'
  const activeTabId =
    currentTab ||
    (pathname
      ? pathname.split(`/ipd/patients/${admissionId}/`)[1]?.split('/')[0] ||
        'summary'
      : 'summary');

  const tabs: TabItem[] = [
    {
      id: 'summary',
      label: 'Summary',
      hrefSegment: 'summary',
    },
    {
      id: 'orders',
      label: 'Orders',
      hrefSegment: 'orders',
      badge: counts?.unverifiedOrders && counts.unverifiedOrders > 0 ? counts.unverifiedOrders : null,
      badgeVariant: 'warning',
    },
    {
      id: 'emar',
      label: 'eMAR',
      hrefSegment: 'emar',
      badge: counts?.overdueDoses && counts.overdueDoses > 0 ? counts.overdueDoses : null,
      badgeVariant: 'danger',
    },
    {
      id: 'vitals',
      label: 'Vitals & I/O',
      hrefSegment: 'vitals',
    },
    {
      id: 'notes',
      label: 'Notes',
      hrefSegment: 'notes',
    },
    {
      id: 'investigations',
      label: 'Investigations',
      hrefSegment: 'investigations',
      badge:
        counts?.criticalInvestigations && counts.criticalInvestigations > 0
          ? counts.criticalInvestigations
          : null,
      badgeVariant: 'danger',
    },
    {
      id: 'billing',
      label: 'Consumables & Billing',
      hrefSegment: 'billing',
    },
    {
      id: 'discharge',
      label: 'Discharge',
      hrefSegment: 'discharge',
      badge: counts?.isDischargeReady ? 'Ready' : null,
      badgeVariant: 'success',
    },
  ];

  return (
    <nav
      aria-label="Patient Chart Navigation"
      className={`border-b border-ink-100 bg-surface px-3.5 sm:px-5 sticky top-[56px] z-20 overflow-x-auto no-scrollbar whitespace-nowrap ${className}`}
    >
      <ul className="flex items-center gap-1 sm:gap-1.5 -mb-px">
        {tabs.map((tab) => {
          const isActive =
            activeTabId.toLowerCase() === tab.id.toLowerCase() ||
            activeTabId.toLowerCase() === tab.hrefSegment.toLowerCase();

          return (
            <li key={tab.id} className="inline-block">
              <Link
                href={`/ipd/patients/${admissionId}/${tab.hrefSegment}`}
                className={`group inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-semibold border-b-2 transition-colors min-h-[32px] ${
                  isActive
                    ? 'border-primary text-primary'
                    : 'border-transparent text-ink-500 hover:text-ink-800 hover:border-ink-200'
                }`}
                aria-current={isActive ? 'page' : undefined}
              >
                <span>{tab.label}</span>
                {tab.badge != null && (
                  <span
                    className={`inline-flex items-center justify-center px-1.5 py-0.2 rounded-full text-[10px] font-semibold ${
                      tab.badgeVariant === 'danger'
                        ? 'bg-rose-100 text-rose-800'
                        : tab.badgeVariant === 'warning'
                          ? 'bg-amber-100 text-amber-800'
                          : tab.badgeVariant === 'success'
                            ? 'bg-emerald-100 text-emerald-800'
                            : 'bg-primary/10 text-primary'
                    }`}
                  >
                    {tab.badge}
                  </span>
                )}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
