import Link from 'next/link';
import { AlertTriangleIcon, CheckIcon } from '@/components/icons';
import { cn } from '@/components/ui';
import type { AllergyStatus } from '@/lib/domain/allergy';

/**
 * Allergies on every sheet of the patient file (IPD sheets plan B2): red with
 * the allergies when there are any, green when asked and none known, amber
 * when nobody has asked yet. Tapping it opens the Allergies tab.
 */
export function AllergyBanner({
  status,
  allergies,
  href,
  timezone,
}: {
  status: AllergyStatus;
  allergies: { substance: string; severity: string }[];
  href: string;
  timezone: string;
}) {
  const date = (at: Date) => new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', timeZone: timezone }).format(at);
  const tone =
    status.kind === 'allergies'
      ? 'bg-red-600 text-white hover:bg-red-700'
      : status.kind === 'nkda'
        ? 'bg-emerald-50 text-emerald-900 ring-1 ring-emerald-200 hover:bg-emerald-100'
        : 'bg-amber-50 text-amber-900 ring-1 ring-amber-200 hover:bg-amber-100';
  return (
    <Link href={href} className={cn('flex min-h-11 items-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold', tone)}>
      {status.kind === 'nkda' ? <CheckIcon className="size-4 shrink-0" /> : <AlertTriangleIcon className="size-4 shrink-0" />}
      <span className="min-w-0">
        {status.kind === 'allergies' ? (
          <>
            ALLERGIES:{' '}
            {allergies.map((a, i) => (
              <span key={a.substance}>
                {i > 0 ? ', ' : ''}
                {a.substance}
                {a.severity === 'severe' ? ' (severe)' : ''}
              </span>
            ))}
          </>
        ) : status.kind === 'nkda' ? (
          `No known drug allergies · asked ${date(status.at)}`
        ) : status.kind === 'unable' ? (
          `Allergies not known: could not ask (${date(status.at)}) — ask again when you can`
        ) : (
          'Allergies not asked yet — ask the patient or family'
        )}
      </span>
    </Link>
  );
}
