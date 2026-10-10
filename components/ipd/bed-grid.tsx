import Link from 'next/link';
import { cn } from '@/components/ui';
import { dayOfStay, shortPatientName } from '@/lib/domain/admission';
import type { CensusBed } from '@/lib/services/ipd-census';

/**
 * The ward as staff see it: one square tile per bed (IPD plan §5.2, §5.6).
 *
 * This grid is how a patient is identified on the ward (decision D-ID): a
 * nurse taps the bed, not a QR code. So an occupied tile shows the bed number
 * large and the patient's name beside it, and a free tile is visibly empty.
 *
 * A server component: the caller decides where each tile leads, which is
 * different for the desk (the patient's IPD page), the nurse (the record
 * screen) and the admission sheet (pick this bed).
 */
export function BedGrid({
  beds,
  timezone,
  now,
  size = 'md',
  hrefFor,
  emptyHrefFor,
  selectedBedId,
  label,
  badgeFor,
}: {
  beds: readonly CensusBed[];
  timezone: string;
  now: Date;
  /** md: the desk's grid (72 px tiles). lg: the nurse's phone grid (88 px). */
  size?: 'md' | 'lg';
  /** Where an occupied tile leads; null leaves it inert. */
  hrefFor?: (bed: CensusBed) => string | null;
  /** Where a free tile leads (assigning a waiting patient); null leaves it inert. */
  emptyHrefFor?: (bed: CensusBed) => string | null;
  selectedBedId?: string | null;
  label: string;
  /** "1 due", "2 overdue" from the due board (B3b); red once a time-critical dose is escalated. */
  badgeFor?: (bed: CensusBed) => { text: string; tone: 'due' | 'overdue' | 'escalated' } | null;
}) {
  if (beds.length === 0) {
    return <p className="px-1 py-3 text-sm text-ink-500">No beds in this ward yet.</p>;
  }
  return (
    <ul
      aria-label={label}
      className={cn(
        'grid gap-2',
        size === 'lg'
          ? 'grid-cols-[repeat(auto-fill,minmax(5.5rem,1fr))]'
          : 'grid-cols-[repeat(auto-fill,minmax(4.5rem,1fr))]',
      )}
    >
      {beds.map((bed) => {
        const occupant = bed.occupant;
        const href = occupant ? (hrefFor?.(bed) ?? null) : (emptyHrefFor?.(bed) ?? null);
        const going = occupant?.status === 'discharge_ready';
        const badge = occupant ? (badgeFor?.(bed) ?? null) : null;
        const body = (
          <>
            <span
              className={cn(
                'numeric font-bold leading-none',
                size === 'lg' ? 'text-2xl' : 'text-xl',
                occupant ? 'text-ink-900' : 'text-ink-400',
              )}
            >
              {bed.label}
            </span>
            {occupant ? (
              <>
                <span
                  className={cn(
                    'mt-1 w-full truncate text-center font-semibold text-ink-800',
                    size === 'lg' ? 'text-base' : 'text-xs',
                  )}
                >
                  {shortPatientName(occupant.patientName)}
                </span>
                <span className={cn('text-ink-500', size === 'lg' ? 'text-sm' : 'text-[11px]')}>
                  {going
                    ? 'Going home'
                    : occupant.admittedAt
                      ? `Day ${dayOfStay(occupant.admittedAt, now, timezone)}`
                      : ''}
                </span>
                {badge ? (
                  <span
                    className={cn(
                      'mt-0.5 rounded-full px-1.5 text-[11px] font-bold leading-5',
                      badge.tone === 'escalated' ? 'bg-red-600 text-white' : badge.tone === 'overdue' ? 'bg-amber-500 text-white' : 'bg-sky-100 text-sky-900',
                    )}
                  >
                    {badge.text}
                  </span>
                ) : null}
              </>
            ) : (
              <span className={cn('mt-1 text-ink-400', size === 'lg' ? 'text-sm' : 'text-[11px]')}>Free</span>
            )}
          </>
        );
        const tileClass = cn(
          'flex aspect-square flex-col items-center justify-center rounded-xl p-1.5 ring-1 ring-inset transition-colors',
          size === 'lg' ? 'min-h-22' : 'min-h-18',
          occupant
            ? going
              ? 'bg-amber-50 ring-amber-300'
              : 'bg-brand-50 ring-brand-300'
            : 'bg-white ring-ink-200',
          selectedBedId === bed.id && 'ring-2 ring-brand-700 bg-brand-100',
          href && 'hover:ring-brand-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-700',
        );
        const description = occupant
          ? `Bed ${bed.label}, ${occupant.patientName}${going ? ', going home' : ''}${badge ? `, ${badge.text}` : ''}`
          : `Bed ${bed.label}, free`;
        return (
          <li key={bed.id}>
            {href ? (
              <Link href={href} className={tileClass} aria-label={description}>
                {body}
              </Link>
            ) : (
              <div className={tileClass} aria-label={description}>
                {body}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
