'use client';

import { cn } from '@/components/ui';

export type EmarBucketKey =
  | 'dueNow'
  | 'overdue'
  | 'upcoming'
  | 'prn'
  | 'onHold'
  | 'recentHistory';

export interface EmarBucketCounts {
  dueNow: number;
  overdue: number;
  upcoming: number;
  prn: number;
  onHold: number;
  recentHistory: number;
}

export interface EmarBucketTabsProps {
  activeBucket: EmarBucketKey;
  onChangeBucket: (bucket: EmarBucketKey) => void;
  counts: EmarBucketCounts;
  className?: string;
}

interface BucketConfig {
  key: EmarBucketKey;
  label: string;
  count: number;
  badgeTone: 'default' | 'rose' | 'amber' | 'emerald' | 'brand';
  highlightZero?: boolean;
}

export function EmarBucketTabs({
  activeBucket,
  onChangeBucket,
  counts,
  className,
}: EmarBucketTabsProps) {
  const tabs: BucketConfig[] = [
    {
      key: 'dueNow',
      label: 'Due Now',
      count: counts.dueNow,
      badgeTone: counts.dueNow > 0 ? 'emerald' : 'default',
    },
    {
      key: 'overdue',
      label: 'Overdue',
      count: counts.overdue,
      badgeTone: counts.overdue > 0 ? 'rose' : 'default',
    },
    {
      key: 'upcoming',
      label: 'Upcoming',
      count: counts.upcoming,
      badgeTone: 'brand',
    },
    {
      key: 'prn',
      label: 'PRN / SOS',
      count: counts.prn,
      badgeTone: 'default',
    },
    {
      key: 'onHold',
      label: 'On Hold',
      count: counts.onHold,
      badgeTone: counts.onHold > 0 ? 'amber' : 'default',
    },
    {
      key: 'recentHistory',
      label: 'Recent 24h',
      count: counts.recentHistory,
      badgeTone: 'default',
    },
  ];

  return (
    <div
      className={cn(
        'flex items-center gap-1.5 overflow-x-auto rounded-xl border border-ink-200 bg-white p-1.5 shadow-xs scrollbar-none',
        className,
      )}
      role="tablist"
      aria-label="Medication Administration Buckets"
    >
      {tabs.map((tab) => {
        const isActive = activeBucket === tab.key;

        return (
          <button
            key={tab.key}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => onChangeBucket(tab.key)}
            className={cn(
              'group flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-xs font-semibold transition',
              isActive
                ? 'bg-ink-900 text-white shadow-xs'
                : 'text-ink-600 hover:bg-ink-50 hover:text-ink-900',
            )}
          >
            <span>{tab.label}</span>
            <span
              className={cn(
                'inline-flex size-5 items-center justify-center rounded-full text-[11px] font-bold transition',
                isActive
                  ? 'bg-white/20 text-white'
                  : tab.badgeTone === 'rose'
                    ? 'bg-rose-100 text-rose-700 font-extrabold ring-1 ring-rose-300'
                    : tab.badgeTone === 'emerald'
                      ? 'bg-emerald-100 text-emerald-800'
                      : tab.badgeTone === 'amber'
                        ? 'bg-amber-100 text-amber-800'
                        : tab.badgeTone === 'brand'
                          ? 'bg-brand-100 text-brand-800'
                          : 'bg-ink-100 text-ink-600',
              )}
            >
              {tab.count}
            </span>
          </button>
        );
      })}
    </div>
  );
}
