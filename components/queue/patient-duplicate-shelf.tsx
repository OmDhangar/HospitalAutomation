'use client';

import React from 'react';
import type { PatientDuplicateMatch } from '@/lib/services/patient-merge';
import { Button, cn } from '@/components/ui';
import { CheckIcon, UserPlusIcon } from '@/components/icons';

export type PatientDuplicateShelfProps = {
  matches: PatientDuplicateMatch[];
  isLoading?: boolean;
  onSelectPatient: (patient: PatientDuplicateMatch['patient']) => void;
  onForceNew: () => void;
};

export function PatientDuplicateShelf({
  matches,
  isLoading = false,
  onSelectPatient,
  onForceNew,
}: PatientDuplicateShelfProps) {
  if (isLoading) {
    return (
      <div className="rounded-xl border border-ink-200 bg-ink-50/70 p-3 text-xs text-ink-500 animate-pulse">
        Checking patient directory for matching profiles…
      </div>
    );
  }

  if (matches.length === 0) {
    return null;
  }

  const hasExact = matches.some((m) => m.tier === 'exact');
  const hasHigh = matches.some((m) => m.tier === 'high');

  return (
    <div
      className={cn(
        'rounded-xl border p-3.5 space-y-3 transition-all',
        hasExact
          ? 'border-emerald-300 bg-emerald-50/70'
          : hasHigh
            ? 'border-amber-300 bg-amber-50/70'
            : 'border-blue-200 bg-blue-50/60',
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              'size-2.5 rounded-full animate-ping',
              hasExact ? 'bg-emerald-500' : hasHigh ? 'bg-amber-500' : 'bg-blue-500',
            )}
          />
          <h4
            className={cn(
              'text-xs font-bold uppercase tracking-wider',
              hasExact ? 'text-emerald-900' : hasHigh ? 'text-amber-900' : 'text-blue-900',
            )}
          >
            {hasExact
              ? 'Existing Patient Found'
              : hasHigh
                ? 'Possible Duplicate Record'
                : 'Family Member on File'}
          </h4>
        </div>
        <span className="text-2xs font-semibold px-2 py-0.5 rounded-full bg-white/80 text-ink-700 ring-1 ring-inset ring-ink-200 shadow-2xs">
          {matches.length} candidate{matches.length === 1 ? '' : 's'}
        </span>
      </div>

      <div className="space-y-2">
        {matches.map((item) => {
          const p = item.patient;
          const badgeColor =
            item.tier === 'exact'
              ? 'bg-emerald-100 text-emerald-800 ring-emerald-200'
              : item.tier === 'high'
                ? 'bg-amber-100 text-amber-800 ring-amber-200'
                : 'bg-blue-100 text-blue-800 ring-blue-200';

          const badgeLabel =
            item.tier === 'exact'
              ? 'Exact Returning Patient'
              : item.tier === 'high'
                ? 'Possible Duplicate'
                : 'Family Member (Same Phone)';

          return (
            <div
              key={p.id}
              className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 rounded-lg bg-white p-2.5 shadow-2xs ring-1 ring-inset ring-ink-200"
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold text-ink-950">{p.name}</span>
                  {p.mrn ? (
                    <span className="rounded bg-brand-50 px-1.5 py-0.5 text-xs font-mono font-medium text-brand-700 ring-1 ring-inset ring-brand-200">
                      {p.mrn}
                    </span>
                  ) : null}
                  <span className={cn('rounded px-1.5 py-0.5 text-2xs font-bold ring-1 ring-inset', badgeColor)}>
                    {badgeLabel}
                  </span>
                </div>
                <p className="mt-0.5 text-xs text-ink-600">
                  {[p.age ? `${p.age}y` : null, p.gender, p.address].filter(Boolean).join(' · ')}
                </p>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                <Button
                  type="button"
                  size="sm"
                  variant="primary"
                  className={cn(
                    'text-xs font-semibold',
                    item.tier === 'exact' ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-brand-600 hover:bg-brand-700',
                  )}
                  onClick={() => onSelectPatient(p)}
                >
                  <CheckIcon className="size-3.5 mr-1" />
                  Use This Patient
                </Button>
              </div>
            </div>
          );
        })}
      </div>

      <div className="flex items-center justify-between pt-1 border-t border-ink-200/60">
        <p className="text-2xs text-ink-500">
          Not the same person? Confirm as a distinct family profile.
        </p>
        <button
          type="button"
          onClick={onForceNew}
          className="inline-flex items-center gap-1 text-xs font-semibold text-brand-700 hover:text-brand-900 underline"
        >
          <UserPlusIcon className="size-3.5" />
          Different Person (Family Member)
        </button>
      </div>
    </div>
  );
}
