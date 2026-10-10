import Link from 'next/link';
import { notFound } from 'next/navigation';
import { PrinterIcon } from '@/components/icons';
import { OutboxStatus } from '@/components/ipd/outbox-status';
import { TprChart } from '@/components/ipd/tpr-chart';
import { requireModule } from '@/lib/auth/modules';
import { requireSession } from '@/lib/auth/session';
import { can } from '@/lib/domain/permissions';
import { addDays, chartDayOf, isChartDay, readingSummary } from '@/lib/domain/tpr';
import { moduleAllows } from '@/lib/modules/registry';
import { getLatestVitals, getTprDay, undoableUntil } from '@/lib/services/tpr';
import { loadAdmission } from '../data';

export const metadata = { title: 'TPR chart · IPD' };

/**
 * The T.P.R. chart tab of the patient file (IPD sheets plan B1): one paper
 * sheet per chart day (8 am–8 am), today's by default, with the days before
 * a tap away. Readings are added on today's sheet only; earlier sheets are
 * read and printed.
 */
export default async function TprPage({ params, searchParams }: PageProps<'/ipd/admissions/[id]/tpr'>) {
  const session = await requireSession();
  const states = await requireModule(session, 'charts');
  const { id } = await params;
  const query = await searchParams;

  const admission = await loadAdmission(session.hospitalId, id);
  if (!admission) notFound();

  const now = new Date();
  const today = chartDayOf(now, session.timezone);
  const firstDay = admission.admittedAt ? chartDayOf(admission.admittedAt, session.timezone) : today;
  const requested = typeof query.day === 'string' && isChartDay(query.day) ? query.day : today;
  const day = requested > today ? today : requested < firstDay ? firstDay : requested;

  const chart = await getTprDay({ hospitalId: session.hospitalId, admissionId: id, day, timezone: session.timezone });

  const inBed = admission.status === 'admitted' || admission.status === 'discharge_ready';
  const canChart =
    day === today &&
    inBed &&
    !session.readOnly &&
    can(session.role, 'ipd.chart') &&
    moduleAllows(states, 'charts', 'write', admission.bed?.wardId ?? null);

  // The hints in the entry boxes: the last reading on any sheet (one indexed row), only when adding is possible.
  const latest = canChart ? (chart.readings.at(-1) ?? (await getLatestVitals(session.hospitalId, id))) : null;
  const base = `/ipd/admissions/${id}/tpr`;
  const dayText = new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(
    new Date(`${day}T00:00:00Z`),
  );
  const stayDay = Math.round((Date.parse(day) - Date.parse(firstDay)) / 86_400_000) + 1;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <nav aria-label="Chart day" className="flex items-center gap-1">
          {day > firstDay ? (
            <Link href={`${base}?day=${addDays(day, -1)}`} className="inline-flex min-h-11 shrink-0 items-center whitespace-nowrap rounded-lg px-3 text-sm font-semibold text-ink-700 ring-1 ring-ink-300 hover:bg-ink-50">
              ← Day before
            </Link>
          ) : null}
          <p className="px-2 text-base font-bold text-ink-900">
            {dayText}
            <span className="ml-1.5 text-sm font-normal text-ink-500">
              Day {stayDay} · 8 am to 8 am{day === today ? ' · today' : ''}
            </span>
          </p>
          {day < today ? (
            <Link href={day === addDays(today, -1) ? base : `${base}?day=${addDays(day, 1)}`} className="inline-flex min-h-11 shrink-0 items-center whitespace-nowrap rounded-lg px-3 text-sm font-semibold text-ink-700 ring-1 ring-ink-300 hover:bg-ink-50">
              Next day →
            </Link>
          ) : null}
        </nav>
        <Link
          href={`/print/ipd-file/${id}?sheets=tpr&day=${day}`}
          target="_blank"
          className="inline-flex min-h-11 items-center gap-1.5 rounded-lg px-3 text-sm font-semibold text-ink-700 ring-1 ring-ink-300 hover:bg-ink-50"
        >
          <PrinterIcon className="size-4" />
          Print this sheet
        </Link>
      </div>

      {/* Sends readings saved offline, and says what is waiting or was refused. */}
      {canChart ? <OutboxStatus /> : null}

      {day === today && !inBed ? (
        <p className="rounded-xl bg-ink-100 px-4 py-3 text-sm text-ink-700">
          {admission.status === 'discharged' ? 'The patient has been discharged; the chart is closed.' : 'Readings can be added once the patient has a bed.'}
        </p>
      ) : null}

      <TprChart
        key={day}
        admissionId={id}
        patientLabel={`${admission.patientName}${admission.bed && inBed ? ` · Bed ${admission.bed.label}` : ''}`}
        timezone={session.timezone}
        canChart={canChart}
        showHistory={can(session.role, 'acct.view') && !session.readOnly}
        // eslint-disable-next-line @typescript-eslint/no-unused-vars -- dropped: the client never needs them
        readings={chart.readings.map(({ recordedByUserId, recordedAt, voidedAt, voidReason, ...reading }) => ({
          ...reading,
          observedAt: reading.observedAt.toISOString(),
          undoUntil: undoableUntil({ recordedByUserId, recordedAt, voidedAt }, session.userId, now)?.toISOString() ?? null,
        }))}
        voided={chart.voided.map((reading) => ({
          id: reading.id,
          observedAt: reading.observedAt.toISOString(),
          voidReason: reading.voidReason,
          summary: readingSummary(reading),
        }))}
        treatment={chart.treatment.map((given) => ({ ...given, occurredAt: given.occurredAt.toISOString() }))}
        totals={chart.totals}
        last={
          latest
            ? {
                pulse: latest.pulse,
                bpSystolic: latest.bpSystolic,
                bpDiastolic: latest.bpDiastolic,
                spo2: latest.spo2,
                tempFTenths: latest.tempFTenths,
                bslMgDl: latest.bslMgDl,
                respRate: latest.respRate,
                abdGirthCm: latest.abdGirthCm,
                onOxygen: latest.onOxygen,
              }
            : null
        }
      />
    </div>
  );
}
