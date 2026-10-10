import Link from 'next/link';
import { notFound } from 'next/navigation';
import { PrinterIcon } from '@/components/icons';
import { requireModule } from '@/lib/auth/modules';
import { requireSession } from '@/lib/auth/session';
import { readWardDeviceCookie } from '@/lib/auth/ward-device-cookie';
import { can } from '@/lib/domain/permissions';
import { addDays, chartDayOf, isChartDay } from '@/lib/domain/tpr';
import { moduleAllows } from '@/lib/modules/registry';
import { getTreatmentCard, listDeviceWitnessRequests, listOrderingDoctors, listWitnessCandidates } from '@/lib/services/mar';
import { listPinPeople, resolveWardDevice } from '@/lib/services/staff-access';
import { getAdmissionDue } from '@/lib/services/due';
import { timingText } from '@/lib/domain/due';
import { loadAdmission } from '../data';
import { TreatmentCard } from './treatment-card';

export const metadata = { title: 'Treatment · IPD' };

/**
 * The Treatment tab of the patient file (IPD sheets plan B3-min): the
 * doctor's treatment card and the doses of one chart day (8 am–8 am, like the
 * paper MAR), today's by default. Doses are recorded on today's sheet only.
 */
export default async function TreatmentPage({ params, searchParams }: PageProps<'/ipd/admissions/[id]/treatment'>) {
  const session = await requireSession();
  const states = await requireModule(session, 'mar');
  const { id } = await params;
  const query = await searchParams;
  const admission = await loadAdmission(session.hospitalId, id);
  if (!admission) notFound();

  const now = new Date();
  const today = chartDayOf(now, session.timezone);
  const firstDay = admission.admittedAt ? chartDayOf(admission.admittedAt, session.timezone) : today;
  const requested = typeof query.day === 'string' && isChartDay(query.day) ? query.day : today;
  const day = requested > today ? today : requested < firstDay ? firstDay : requested;

  const inBed = admission.status === 'admitted' || admission.status === 'discharge_ready';
  const canRecord =
    day === today && inBed && !session.readOnly && moduleAllows(states, 'mar', 'write', admission.bed?.wardId ?? null);
  const stage = states.get('mar')?.stage ?? 'observe';

  const device = session.channel === 'ward_device' ? await resolveWardDevice(await readWardDeviceCookie()) : null;
  const [card, due, doctors, candidates, deviceRequests, devicePeople] = await Promise.all([
    getTreatmentCard({ hospitalId: session.hospitalId, admissionId: id, day, timezone: session.timezone }),
    getAdmissionDue({ hospitalId: session.hospitalId, admissionId: id, day, timezone: session.timezone, now }),
    canRecord ? listOrderingDoctors(session.hospitalId) : Promise.resolve([]),
    canRecord ? listWitnessCandidates(session.hospitalId, session.userId) : Promise.resolve([]),
    device && canRecord ? listDeviceWitnessRequests({ hospitalId: session.hospitalId, deviceId: device.id }) : Promise.resolve([]),
    device && canRecord ? listPinPeople(device) : Promise.resolve([]),
  ]);
  const myDoctor = doctors.find((d) => d.userId === session.userId);
  // Opened from the due board: this line's dose at this due time.
  const focus =
    typeof query.order === 'string' && typeof query.due === 'string' && /^[0-9a-f-]{36}$/i.test(query.order) && !Number.isNaN(Date.parse(query.due))
      ? { orderId: query.order, dueAt: new Date(query.due).toISOString() }
      : null;
  const base = `/ipd/admissions/${id}/treatment`;
  const dayText = new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${day}T00:00:00Z`));

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <nav aria-label="MAR day" className="flex items-center gap-1">
          {day > firstDay ? (
            <Link href={`${base}?day=${addDays(day, -1)}`} className="inline-flex min-h-11 shrink-0 items-center whitespace-nowrap rounded-lg px-3 text-sm font-semibold text-ink-700 ring-1 ring-ink-300 hover:bg-ink-50">
              ← Day before
            </Link>
          ) : null}
          <p className="px-2 text-base font-bold text-ink-900">
            {dayText}
            <span className="ml-1.5 text-sm font-normal text-ink-500">8 am to 8 am{day === today ? ' · today' : ''}</span>
          </p>
          {day < today ? (
            <Link href={day === addDays(today, -1) ? base : `${base}?day=${addDays(day, 1)}`} className="inline-flex min-h-11 shrink-0 items-center whitespace-nowrap rounded-lg px-3 text-sm font-semibold text-ink-700 ring-1 ring-ink-300 hover:bg-ink-50">
              Next day →
            </Link>
          ) : null}
        </nav>
        <Link
          href={`/print/ipd-file/${id}?sheets=treatment&day=${day}`}
          target="_blank"
          className="inline-flex min-h-11 items-center gap-1.5 rounded-lg px-3 text-sm font-semibold text-ink-700 ring-1 ring-ink-300 hover:bg-ink-50"
        >
          <PrinterIcon className="size-4" />
          Print this sheet
        </Link>
      </div>

      {day === today && !inBed ? (
        <p className="rounded-xl bg-ink-100 px-4 py-3 text-sm text-ink-700">
          {admission.status === 'discharged' ? 'The patient has been discharged; the card is closed.' : 'Doses can be recorded once the patient has a bed.'}
        </p>
      ) : null}
      {stage !== 'enforce' ? (
        <p className="rounded-xl bg-amber-50 px-4 py-2 text-xs text-amber-900">
          Trial stage: a risk-class dose missing its countersign, bed code or witness is saved and flagged, not refused.
        </p>
      ) : null}

      <TreatmentCard
        key={day}
        admissionId={id}
        timezone={session.timezone}
        canRecord={canRecord}
        canOrder={can(session.role, 'ipd.order')}
        canTranscribe={can(session.role, 'ipd.transcribe')}
        canAdminister={can(session.role, 'ipd.administer')}
        canCountersign={can(session.role, 'ipd.countersign')}
        isOwner={session.role === 'owner'}
        myUserId={session.userId}
        channel={session.channel}
        enforce={stage === 'enforce'}
        doctors={doctors}
        defaultDoctorId={myDoctor?.id ?? admission.doctorId ?? null}
        canQuickAddMedicine={can(session.role, 'medicines.quickAdd')}
        orders={card.orders.map((o) => ({
          id: o.id,
          kind: o.kind,
          taskKind: o.taskKind,
          timingText: timingText(o.timing, session.timezone),
          timeCritical: due.get(o.id)?.timeCritical ?? false,
          windowBefore: due.get(o.id)?.windowBefore ?? 60,
          windowAfter: due.get(o.id)?.windowAfter ?? 60,
          instances: (due.get(o.id)?.instances ?? []).map((i) => ({
            dueAt: i.dueAt,
            status: i.status as never,
            overdueMin: i.overdueMin,
            recorded: i.recorded,
            closeToPrevious: i.closeToPrevious,
          })),
          description: o.description,
          dose: o.dose,
          route: o.route,
          frequency: o.frequency,
          instructions: o.instructions,
          orderedAt: o.orderedAt.toISOString(),
          doctorName: o.doctorName,
          doctorUserId: o.doctorUserId,
          enteredBy: o.enteredBy,
          enteredByUserId: o.enteredByUserId,
          transcribed: o.transcribed,
          countersigned: Boolean(o.countersignedAt),
          stopReason: o.stopReason,
          status: o.status,
          risk: o.risk ? { className: o.risk.className, needsWitness: o.risk.needsWitness } : null,
          dosesRecorded: o.dosesRecorded,
        }))}
        doses={card.doses.map((d) => ({
          id: d.id,
          orderId: d.orderId,
          state: d.state,
          occurredAt: d.occurredAt.toISOString(),
          dose: d.dose,
          quantity: d.quantity,
          reasonCode: d.reasonCode,
          reasonText: d.reasonText,
          recordedBy: d.recordedBy,
          recordedByUserId: d.recordedByUserId,
          witnessStatus: d.witnessStatus,
          witnessedBy: d.witnessedBy,
          flags: d.flags,
          voided: Boolean(d.voidedAt),
          voidReason: d.voidReason,
          pendingRequest: d.pendingRequest ? { method: d.pendingRequest.method, witnessName: d.pendingRequest.witnessName } : null,
        }))}
        witnessCandidates={candidates.map(({ userId, name }) => ({ userId, name }))}
        deviceRequests={deviceRequests
          .filter((r) => r.admissionId === id)
          .map((r) => ({ id: r.id, description: r.description, dose: r.dose, actorUserId: r.actorUserId, actorName: r.actorName, occurredAt: r.occurredAt.toISOString() }))}
        devicePeople={devicePeople}
        focus={focus}
      />
    </div>
  );
}
