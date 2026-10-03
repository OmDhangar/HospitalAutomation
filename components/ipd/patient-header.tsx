import { cn } from '@/components/ui';
import { BedIcon } from '@/components/icons';
import { dayOfStay } from '@/lib/domain/admission';
import { formatIndianPhone } from '@/lib/domain/phone';
import type { IpdStatus } from '@/lib/services/ipd-census';

const STATUS: Record<IpdStatus | 'discharged' | 'cancelled', { label: string; className: string }> = {
  awaiting_bed: { label: 'Awaiting bed', className: 'bg-amber-50 text-amber-900 ring-amber-300' },
  admitted: { label: 'Admitted', className: 'bg-brand-50 text-brand-800 ring-brand-300' },
  discharge_ready: { label: 'Ready to go home', className: 'bg-emerald-50 text-emerald-800 ring-emerald-300' },
  discharged: { label: 'Discharged', className: 'bg-ink-100 text-ink-600 ring-ink-200' },
  cancelled: { label: 'Cancelled', className: 'bg-ink-100 text-ink-500 ring-ink-200' },
};

export function AdmissionStatusChip({ status }: { status: keyof typeof STATUS }) {
  const style = STATUS[status];
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset',
        style.className,
      )}
    >
      {style.label}
    </span>
  );
}

/**
 * Who this is, on every patient screen (IPD plan §6.4): the name large enough
 * to check against the patient in the bed, then age/sex, bed, day of stay,
 * doctor. Sticky on phones, so it never scrolls away while recording.
 */
export function PatientHeader({
  name,
  age,
  gender,
  phoneE164,
  bed,
  admittedAt,
  doctorName,
  status,
  timezone,
  now,
  sticky = true,
}: {
  name: string;
  age: number | null;
  gender: string | null;
  phoneE164?: string | null;
  bed: { label: string; wardName: string } | null;
  admittedAt: Date | null;
  doctorName: string;
  status: keyof typeof STATUS;
  timezone: string;
  now: Date;
  sticky?: boolean;
}) {
  const ageSex = [age !== null ? String(age) : null, gender ? gender[0].toUpperCase() : null]
    .filter(Boolean)
    .join(' ');
  return (
    <div
      className={cn(
        'rounded-xl border border-ink-200 bg-white px-4 py-3 shadow-xs sm:px-5',
        sticky && 'sticky top-14 z-30',
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h1 className="truncate text-xl font-bold text-ink-900 sm:text-2xl">{name}</h1>
          <p className="mt-0.5 text-sm text-ink-600">
            {[ageSex || null, phoneE164 ? formatIndianPhone(phoneE164) : null, `Dr ${doctorName.replace(/^Dr\.?\s*/i, '')}`]
              .filter(Boolean)
              .join(' · ')}
          </p>
        </div>
        <AdmissionStatusChip status={status} />
      </div>
      <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm font-medium text-ink-800">
        <span className="inline-flex items-center gap-1.5">
          <BedIcon className="size-4 text-brand-700" />
          {bed ? (
            <>
              {bed.wardName} · <span className="numeric">Bed {bed.label}</span>
            </>
          ) : (
            'No bed yet'
          )}
        </span>
        {admittedAt && status !== 'discharged' ? (
          <span className="numeric text-ink-600">Day {dayOfStay(admittedAt, now, timezone)}</span>
        ) : null}
      </p>
    </div>
  );
}
