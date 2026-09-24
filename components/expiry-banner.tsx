import Link from 'next/link';
import { cn } from '@/components/ui';
import type { ExpiryBucket } from '@/lib/domain/subscription';

/**
 * The plan-expiry strip that sits above every page.
 *
 * Deliberately not a card on the subscription page, where it would only be
 * seen by someone already thinking about billing. The person who needs to act
 * is an owner in the middle of a clinic day, and by the time a plan lapses the
 * failure is invisible in the product — appointments still book, so nobody
 * discovers it until a patient says they were never messaged.
 *
 * It stays quiet until the last 30 days, then escalates. A banner that is
 * always on screen is furniture, and furniture does not get clicked.
 */

type Tone = 'info' | 'warn' | 'urgent' | 'dead';

const TONE_STYLES: Record<Tone, string> = {
  info: 'border-ink-200 bg-white text-ink-700',
  warn: 'border-amber-200 bg-amber-50 text-amber-900',
  urgent: 'border-orange-200 bg-orange-50 text-orange-900',
  dead: 'border-rose-200 bg-rose-50 text-rose-900',
};

const DOT_STYLES: Record<Tone, string> = {
  info: 'bg-ink-400',
  warn: 'bg-amber-500',
  urgent: 'bg-orange-500',
  dead: 'bg-rose-500',
};

const BUTTON_STYLES: Record<Tone, string> = {
  info: 'bg-ink-900 text-white hover:bg-ink-800',
  warn: 'bg-amber-600 text-white hover:bg-amber-700',
  urgent: 'bg-orange-600 text-white hover:bg-orange-700',
  dead: 'bg-rose-600 text-white hover:bg-rose-700',
};

function toneFor(bucket: ExpiryBucket): Tone {
  switch (bucket) {
    case 'expired':
      return 'dead';
    case 'tomorrow':
    case 'within_3_days':
      return 'urgent';
    case 'within_7_days':
      return 'warn';
    default:
      return 'info';
  }
}

/**
 * Says what happens, not what the status is.
 *
 * "Expired" tells an owner nothing actionable; "patients are no longer being
 * messaged" tells them what it costs to ignore this.
 */
function message(bucket: ExpiryBucket, days: number | null): string {
  switch (bucket) {
    case 'expired':
      return 'Your plan has expired. Renew to keep sending patient reminders.';
    case 'tomorrow':
      return 'Your plan expires tomorrow.';
    case 'within_3_days':
    case 'within_7_days':
    case 'within_30_days':
      return `Your plan has ${days} day${days === 1 ? '' : 's'} remaining.`;
    default:
      return '';
  }
}

export function ExpiryBanner({
  bucket,
  daysRemaining,
  canRenew,
}: {
  bucket: ExpiryBucket;
  daysRemaining: number | null;
  /** Only an owner can pay, so anyone else is pointed at the plan page. */
  canRenew: boolean;
}) {
  // Null bucket means the renewal is comfortably far off. Nothing to say.
  if (bucket === null) return null;

  const tone = toneFor(bucket);

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        'mb-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-xl border p-3.5 sm:px-4 sm:py-3 shadow-xs',
        TONE_STYLES[tone],
      )}
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <span className={cn('size-2.5 shrink-0 rounded-full', DOT_STYLES[tone])} />
        <p className="min-w-0 text-sm font-medium leading-tight">
          {message(bucket, daysRemaining)}
        </p>
      </div>

      <Link
        href="/subscription"
        className={cn(
          'w-full sm:w-auto text-center shrink-0 rounded-lg px-3.5 py-2 sm:py-1.5 text-sm font-semibold transition-colors shadow-xs',
          'focus-visible:outline-2 focus-visible:outline-offset-2',
          BUTTON_STYLES[tone],
        )}
      >
        {canRenew ? 'Renew plan' : 'View plan'}
      </Link>
    </div>
  );
}
