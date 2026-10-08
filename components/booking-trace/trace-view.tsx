import type { ReactNode } from 'react';
import { Card, CardHeader, EmptyState, Field, Input, Stat, cn } from '@/components/ui';
import { ORIGIN_LABEL, maskPhone, type TraceVerdict } from '@/lib/domain/booking-trace';
import type { BookingTrace, TracedBooking } from '@/lib/services/booking-trace';
import { PrintButton } from './print-button';

export type TraceFilters = {
  date: string;
  doctor: string;
  token: string;
  phone: string;
};

const SELECT_CLASS =
  'block w-full rounded-lg border-0 bg-white px-3 py-2.5 text-sm text-ink-900 ring-1 ring-inset ring-ink-300 ' +
  'focus:ring-2 focus:ring-inset focus:ring-brand-600 focus:outline-none';

const VERDICT_STYLE: Record<TraceVerdict['level'], string> = {
  fault: 'bg-rose-50 text-rose-900 ring-rose-200',
  ok: 'bg-emerald-50 text-emerald-900 ring-emerald-200',
  note: 'bg-amber-50 text-amber-950 ring-amber-200',
};
const VERDICT_TAG: Record<TraceVerdict['level'], string> = {
  fault: 'Fault',
  ok: 'Correct',
  note: 'Note',
};

/**
 * The booking trace: every token of a day, how it was created, by whom, what
 * the patient was sent, and whether its number followed the reserve in force.
 *
 * Shared by the platform console and the hospital owner's Activity page, so
 * both look at the same evidence. A plain GET form drives the filters: the
 * URL is the state, and a filtered view can be bookmarked or sent.
 */
export function TraceView({
  trace,
  timezone,
  filters,
  hiddenParams = {},
  leadingFilter,
  heading,
}: {
  trace: BookingTrace;
  timezone: string;
  filters: TraceFilters;
  /** Kept on every filter submit, e.g. the hospital chosen in the console. */
  hiddenParams?: Record<string, string>;
  /** An extra control placed before the others, e.g. the hospital picker. */
  leadingFilter?: ReactNode;
  heading: string;
}) {
  const time = (d: Date | null) =>
    d
      ? new Intl.DateTimeFormat('en-IN', {
          timeZone: timezone,
          hour: 'numeric',
          minute: '2-digit',
          second: '2-digit',
          hour12: true,
        }).format(d)
      : '—';
  const dateTime = (d: Date | null) =>
    d
      ? new Intl.DateTimeFormat('en-IN', {
          timeZone: timezone,
          day: 'numeric',
          month: 'short',
          hour: 'numeric',
          minute: '2-digit',
          hour12: true,
        }).format(d)
      : '—';

  // Faults first, then in the order the bookings were made.
  const bookings = [...trace.bookings].sort(
    (a, b) =>
      Number(b.verdicts.some((v) => v.level === 'fault')) - Number(a.verdicts.some((v) => v.level === 'fault')) ||
      a.createdAt.getTime() - b.createdAt.getTime(),
  );
  const filtered = Boolean(filters.token || filters.phone);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-ink-900">{heading}</h2>
          <p className="mt-0.5 text-sm text-ink-500">
            How every token on {trace.serviceDate} was created, by whom, what the patient was sent, and whether
            its number followed the walk-in reserve in force at that moment.
          </p>
        </div>
        <PrintButton />
      </div>

      <Card className="print:hidden">
        <form method="get" className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2 lg:grid-cols-5 lg:items-end">
          {Object.entries(hiddenParams).map(([name, value]) => (
            <input key={name} type="hidden" name={name} value={value} />
          ))}
          {leadingFilter}
          <Field label="Date">
            <Input type="date" name="date" defaultValue={filters.date} required />
          </Field>
          <Field label="Doctor">
            <select name="doctor" defaultValue={filters.doctor} className={SELECT_CLASS}>
              <option value="">All doctors</option>
              {trace.doctors.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Token number">
            <Input type="number" name="token" min={1} defaultValue={filters.token} placeholder="e.g. 3" />
          </Field>
          <Field label="Phone digits">
            <Input type="text" name="phone" inputMode="numeric" defaultValue={filters.phone} placeholder="e.g. 3273" />
          </Field>
          <button
            type="submit"
            className="h-10 rounded-lg bg-brand-600 px-4 text-sm font-semibold text-white hover:bg-brand-700 cursor-pointer"
          >
            Show trace
          </button>
        </form>
      </Card>

      <Card>
        <dl className="grid grid-cols-2 divide-x divide-y divide-ink-200 sm:grid-cols-4 sm:divide-y-0">
          <Stat label="Bookings" value={trace.totals.all} hint={filtered ? 'matching the filter' : undefined} />
          <Stat label="Online" value={trace.totals.online} tone="brand" hint="WhatsApp or booking page" />
          <Stat label="At the desk" value={trace.totals.desk} />
          <Stat
            label="Allocation faults"
            value={trace.totals.faults}
            tone={trace.totals.faults > 0 ? 'warn' : 'default'}
            hint={trace.totals.faults === 0 ? 'every token followed the rules' : 'online token inside the reserve'}
          />
        </dl>
      </Card>

      {bookings.length === 0 ? (
        <Card>
          <EmptyState
            title="No bookings match"
            hint="Check the date and doctor. Only bookings for this service date are shown."
          />
        </Card>
      ) : (
        <div className="space-y-3">
          {bookings.map((b) => (
            <BookingCard key={b.appointmentId} booking={b} time={time} dateTime={dateTime} />
          ))}
        </div>
      )}

      <Card>
        <CardHeader
          title="Capacity settings history"
          hint="Every change to quota and walk-in reserve, newest first. Verdicts use the settings in force when each booking was made."
        />
        {trace.capacityHistory.length === 0 ? (
          <p className="px-5 pb-5 text-sm text-ink-500">
            No changes recorded. Verdicts use the doctors&apos; current settings.
          </p>
        ) : (
          <ul className="divide-y divide-ink-100">
            {trace.capacityHistory.map((c, i) => (
              <li key={i} className="flex flex-wrap items-baseline justify-between gap-2 px-5 py-2.5 text-sm">
                <span className="text-ink-900">
                  <strong>{c.doctorName}</strong>: reserve {c.before.walkInReserved} → {c.after.walkInReserved},
                  quota {c.before.quota ?? 'no limit'} → {c.after.quota ?? 'no limit'}
                </span>
                <span className="text-xs text-ink-500">
                  {dateTime(c.at)}
                  {c.actor ? ` · by ${c.actor}` : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function BookingCard({
  booking: b,
  time,
  dateTime,
}: {
  booking: TracedBooking;
  time: (d: Date | null) => string;
  dateTime: (d: Date | null) => string;
}) {
  const fault = b.verdicts.some((v) => v.level === 'fault');
  return (
    <Card className={cn('break-inside-avoid', fault && 'ring-2 ring-rose-300')}>
      <div className="flex flex-wrap items-start justify-between gap-3 px-5 pt-4">
        <div className="flex items-start gap-3">
          <span
            className={cn(
              'numeric inline-flex min-w-12 items-center justify-center rounded-xl px-2.5 py-1.5 text-xl font-bold',
              b.online ? 'bg-brand-50 text-brand-800' : 'bg-ink-100 text-ink-800',
            )}
          >
            {b.tokenLabel}
          </span>
          <div>
            <p className="font-semibold text-ink-900">{b.patientName}</p>
            <p className="text-xs text-ink-500">
              {maskPhone(b.phoneE164)} · {b.doctorName} · {b.status.replace('_', ' ').toLowerCase()}
              {b.quotaPool ? ` · ${b.quotaPool} pool` : ''}
            </p>
          </div>
        </div>
        <span
          className={cn(
            'rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset',
            b.online ? 'bg-brand-50 text-brand-800 ring-brand-200' : 'bg-ink-50 text-ink-700 ring-ink-200',
          )}
        >
          {ORIGIN_LABEL[b.origin]}
        </span>
      </div>

      <dl className="grid grid-cols-1 gap-x-6 gap-y-1 px-5 pt-3 text-sm sm:grid-cols-2">
        <div className="flex gap-2">
          <dt className="text-ink-500">Created</dt>
          <dd className="text-ink-900">{time(b.createdAt)}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="text-ink-500">Created by</dt>
          <dd className="text-ink-900">{b.createdBy}</dd>
        </div>
        {b.scheduledSlotAt ? (
          <div className="flex gap-2">
            <dt className="text-ink-500">Booked slot</dt>
            <dd className="text-ink-900">{dateTime(b.scheduledSlotAt)}</dd>
          </div>
        ) : null}
        <div className="flex gap-2">
          <dt className="text-ink-500">Reserve at booking</dt>
          <dd className="text-ink-900">
            {b.reserveAtBooking > 0 ? `tokens 1–${b.reserveAtBooking}` : 'none'}
            {b.reserveKnownFrom === 'current' ? ' (current settings; no change recorded)' : ''}
          </dd>
        </div>
        <div className="flex gap-2">
          <dt className="text-ink-500">Patient wrote on WhatsApp</dt>
          <dd className="text-ink-900">
            {b.lastWhatsAppFromPatientAt ? `last message ${dateTime(b.lastWhatsAppFromPatientAt)}` : 'never'}
          </dd>
        </div>
      </dl>

      <ul className="space-y-1.5 px-5 pt-3">
        {b.verdicts.map((v, i) => (
          <li key={i} className={cn('rounded-lg px-3 py-2 text-sm ring-1 ring-inset', VERDICT_STYLE[v.level])}>
            <strong className="mr-1.5">{VERDICT_TAG[v.level]}:</strong>
            {v.message}
          </li>
        ))}
      </ul>

      <details className="px-5 pb-4 pt-3 [&[open]>summary]:mb-2" open={fault}>
        <summary className="cursor-pointer text-xs font-semibold text-brand-700 hover:text-brand-900">
          Timeline ({b.timeline.length} events)
        </summary>
        <ol className="space-y-1 border-l-2 border-ink-200 pl-3 text-xs">
          {b.timeline.map((e, i) => (
            <li key={i} className="text-ink-700">
              <span className="numeric font-semibold text-ink-900">{time(e.at)}</span> · {e.label}
              {e.actor ? <span className="text-ink-500"> · by {e.actor}</span> : null}
              {e.kind === 'message' && e.detail ? <span className="text-ink-500"> · {e.detail}</span> : null}
            </li>
          ))}
        </ol>
      </details>
    </Card>
  );
}
