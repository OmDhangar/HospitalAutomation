import Link from 'next/link';
import type { ReactNode } from 'react';
import { cn } from '@/components/ui';
import {
  ENTITLEMENT_LABEL,
  STANDING_LABEL,
  type AccountStanding,
  type EntitlementAxis,
} from '@/lib/domain/platform-account';
import type { ExpiryBucket, UsageAxis, UsageLevel } from '@/lib/domain/subscription';

/** Whole rupees. Paise are an implementation detail nobody reads a console in. */
export const rupees = (paise: number): string =>
  `₹${Math.round(paise / 100).toLocaleString('en-IN')}`;

export const shortDate = (date: Date | null): string =>
  date
    ? date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
    : '—';

export const dateTime = (date: Date | null): string =>
  date ? date.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '—';

/* -------------------------------------------------------------- standing */

const STANDING_STYLES: Record<AccountStanding, string> = {
  suspended: 'bg-ink-800 text-white ring-ink-800',
  expired: 'bg-rose-50 text-rose-800 ring-rose-200',
  lapsing: 'bg-amber-50 text-amber-900 ring-amber-200',
  over_limit: 'bg-amber-50 text-amber-900 ring-amber-200',
  unbilled: 'bg-violet-50 text-violet-800 ring-violet-200',
  trial: 'bg-brand-50 text-brand-800 ring-brand-200',
  healthy: 'bg-emerald-50 text-emerald-800 ring-emerald-200',
};

export function StandingPill({ standing }: { standing: AccountStanding }) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ring-inset',
        STANDING_STYLES[standing],
      )}
    >
      {STANDING_LABEL[standing]}
    </span>
  );
}

/* ----------------------------------------------------------------- bars */

const LEVEL_BAR: Record<UsageLevel, string> = {
  normal: 'bg-brand-500',
  warning: 'bg-amber-500',
  critical: 'bg-orange-500',
  exhausted: 'bg-rose-500',
};

/**
 * One measured axis, drawn.
 *
 * The bar is capped at 100% while the caption keeps the true number, because a
 * hospital at 140% of its allowance is a fact worth reading and a bar that
 * overflows its track is not.
 */
export function Meter({
  label,
  used,
  limit,
  level,
  percent,
  hint,
}: {
  label: string;
  used: number;
  limit: number | null;
  level: UsageLevel;
  percent: number | null;
  hint?: string;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-xs font-medium text-ink-600">{label}</span>
        <span className="numeric text-xs text-ink-700">
          {used.toLocaleString('en-IN')}
          <span className="text-ink-400">
            {limit === null ? ' / unlimited' : ` / ${limit.toLocaleString('en-IN')}`}
          </span>
        </span>
      </div>
      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-ink-100">
        <div
          className={cn('h-full rounded-full transition-[width]', LEVEL_BAR[level])}
          style={{ width: `${Math.min(100, percent ?? 0)}%` }}
        />
      </div>
      {hint ? <p className="mt-1 text-xs text-ink-400">{hint}</p> : null}
    </div>
  );
}

export function EntitlementMeter({ axis }: { axis: EntitlementAxis }) {
  return (
    <Meter
      label={ENTITLEMENT_LABEL[axis.kind]}
      used={axis.used}
      limit={axis.limit}
      level={axis.level}
      percent={axis.percent}
      hint={axis.atLimit && axis.limit !== null ? 'At the plan limit — the next one is refused' : undefined}
    />
  );
}

export function UsageMeter({ label, axis, hint }: { label: string; axis: UsageAxis; hint?: string }) {
  return (
    <Meter
      label={label}
      used={axis.used}
      limit={axis.allowance > 0 ? axis.allowance : null}
      level={axis.level}
      percent={axis.percent}
      hint={hint}
    />
  );
}

/* ---------------------------------------------------------------- term */

const BUCKET_STYLES: Record<NonNullable<ExpiryBucket>, string> = {
  expired: 'text-rose-700',
  tomorrow: 'text-rose-700',
  within_3_days: 'text-amber-700',
  within_7_days: 'text-amber-700',
  within_30_days: 'text-ink-600',
};

export function TermLabel({
  endsAt,
  bucket,
  daysRemaining,
}: {
  endsAt: Date | null;
  bucket: ExpiryBucket;
  daysRemaining: number | null;
}) {
  if (!endsAt) return <span className="text-ink-400">—</span>;

  return (
    <span className={cn('numeric text-xs', bucket ? BUCKET_STYLES[bucket] : 'text-ink-600')}>
      {shortDate(endsAt)}
      {daysRemaining !== null ? (
        <span className="ml-1 text-ink-400">
          {daysRemaining < 0
            ? `(${Math.abs(daysRemaining)}d ago)`
            : `(${daysRemaining}d)`}
        </span>
      ) : null}
    </span>
  );
}

/* --------------------------------------------------------------- layout */

export function SectionGrid({ children }: { children: ReactNode }) {
  return <div className="grid gap-4 p-5 sm:grid-cols-2 lg:grid-cols-3">{children}</div>;
}

export function DefinitionRow({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 px-5 py-2.5">
      <dt className="text-xs font-medium uppercase tracking-wide text-ink-500">{term}</dt>
      <dd className="text-right text-sm text-ink-900">{children}</dd>
    </div>
  );
}

export function BackLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-1 text-xs font-medium text-ink-500 hover:text-ink-800"
    >
      <span aria-hidden>←</span>
      {children}
    </Link>
  );
}

/** A destructive action gated on typing the word, not on a second click. */
export function ConfirmWord({ word, name }: { word: string; name: string }) {
  return (
    <input
      name={name}
      placeholder={word}
      autoComplete="off"
      aria-label={`Type ${word} to confirm`}
      className="w-28 rounded border border-ink-300 px-2 py-1 text-xs uppercase placeholder:normal-case"
    />
  );
}
