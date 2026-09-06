import Link from 'next/link';
import { AutoRefresh } from '@/components/auto-refresh';
import {
  Alert,
  Button,
  Card,
  CardHeader,
  EmptyState,
  Field,
  Input,
  StatusPill,
  Stat,
  cn,
} from '@/components/ui';
import { SubscriptionCard, UsageNotice } from '@/components/subscription';
import { requireSession } from '@/lib/auth/session';
import { formatTimeIn, minutesBetween } from '@/lib/domain/time';
import { listBranches } from '@/lib/services/auth';
import { listDoctors } from '@/lib/services/hospital';
import { getQueueSnapshot, type QueueRow } from '@/lib/services/queue';
import { listActiveTiers } from '@/lib/services/subscriptions';
import { getHospitalUsage } from '@/lib/services/usage';
import {
  addWalkInAction,
  advanceQueueAction,
  prioritiseAction,
  queueActionForm,
  togglePauseAction,
} from './actions';

export const metadata = { title: 'Queue · OPD Queue' };

const waitedFor = (since: Date | null, now: Date): string => {
  if (!since) return '—';
  const minutes = Math.max(0, Math.round(minutesBetween(since, now)));
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
};

export default async function DashboardPage({ searchParams }: PageProps<'/dashboard'>) {
  const session = await requireSession();
  const params = await searchParams;
  const now = new Date();

  const branches = await listBranches(session.hospitalId);
  const branchId =
    (typeof params.branch === 'string' ? params.branch : null) ??
    session.branchId ??
    branches[0]?.id ??
    null;

  const doctors = await listDoctors({ hospitalId: session.hospitalId, branchId });
  const selectedId =
    (typeof params.doctor === 'string' ? params.doctor : null) ?? doctors[0]?.id ?? null;

  if (!branchId || doctors.length === 0) {
    return (
      <Card>
        <EmptyState
          title="No doctors set up yet"
          hint="Add a branch and at least one doctor in Settings before running a queue."
        />
        <div className="border-t border-ink-200 px-6 py-4 text-center">
          <Link href="/settings">
            <Button variant="primary">Go to settings</Button>
          </Link>
        </div>
      </Card>
    );
  }

  const isOwner = session.role === 'owner';

  const [snapshot, usage, tiers] = await Promise.all([
    selectedId
      ? getQueueSnapshot({
          hospitalId: session.hospitalId,
          doctorId: selectedId,
          timezone: session.timezone,
          now,
        })
      : null,
    isOwner
      ? getHospitalUsage({ hospitalId: session.hospitalId, timezone: session.timezone })
      : null,
    isOwner ? listActiveTiers() : Promise.resolve([]),
  ]);

  const tierName = usage?.subscription
    ? (tiers.find((t) => t.code === usage.subscription!.planTierCode)?.name ?? null)
    : null;

  const serving = snapshot?.rows.find(
    (row) => row.status === 'CALLED' || row.status === 'IN_CONSULTATION',
  );
  const waiting = snapshot?.rows.filter((row) => row.status === 'WAITING') ?? [];
  const scheduledToday = snapshot?.rows.filter((row) => Boolean(row.scheduledSlotAt)) ?? [];

  return (
    <>
      <AutoRefresh seconds={10} />

      {/* Doctor selector. Counts sit in the tab so reception can triage at a
          glance without opening each queue in turn. */}
      <div className="mb-5 flex flex-wrap gap-2">
        {doctors.map((doctor) => (
          <Link
            key={doctor.id}
            href={`/dashboard?doctor=${doctor.id}`}
            className={cn(
              'rounded-lg px-4 py-2.5 text-sm font-medium transition-colors',
              doctor.id === selectedId
                ? 'bg-brand-600 text-white shadow-sm'
                : 'bg-white text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-50',
            )}
          >
            {doctor.name}
            {doctor.specialty ? (
              <span
                className={cn(
                  'ml-2 text-xs',
                  doctor.id === selectedId ? 'text-brand-100' : 'text-ink-500',
                )}
              >
                {doctor.specialty}
              </span>
            ) : null}
          </Link>
        ))}
      </div>

      {params.error === 'phone' ? (
        <div className="mb-4">
          <Alert tone="error">
            Enter a name and a valid 10-digit Indian mobile number.
          </Alert>
        </div>
      ) : null}

      {usage?.subscription ? (
        <div className="mb-4">
          <UsageNotice usage={usage} />
        </div>
      ) : null}

      {snapshot?.paused ? (
        <div className="mb-4">
          <Alert>
            <strong>{snapshot.doctorName} is paused.</strong>{' '}
            {snapshot.pausedReason ? `${snapshot.pausedReason}. ` : ''}
            Patients are told the queue is on hold, and no reminders are sent.
          </Alert>
        </div>
      ) : null}

      {scheduledToday.length > 0 ? (
        <div className="mb-4">
          <div className="rounded-xl border border-brand-200 bg-brand-50/70 p-3.5 text-xs text-brand-950 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="text-base">🕒</span>
              <span>
                <strong>
                  {scheduledToday.length} Scheduled Appointment{scheduledToday.length === 1 ? '' : 's'} Today:
                </strong>{' '}
                {scheduledToday
                  .map(
                    (s) =>
                      `${s.patientName} (Token ${s.tokenNumber} at ${formatTimeIn(session.timezone, s.scheduledSlotAt!)})`,
                  )
                  .join(' · ')}
              </span>
            </div>
            <span className="rounded-full bg-brand-200/80 px-2.5 py-0.5 text-[10px] font-bold text-brand-900">
              Doctor Notified
            </span>
          </div>
        </div>
      ) : null}

      <div className="grid items-start gap-5 lg:grid-cols-3">
        {/* ------------------------------------ left: what the queue is doing */}
        <div className="space-y-5 lg:col-span-2">
          <Card>
            <CardHeader
              title="Now serving"
              hint={snapshot?.doctorName}
              action={
                <form action={togglePauseAction}>
                  <input type="hidden" name="doctorId" value={selectedId ?? ''} />
                  <input
                    type="hidden"
                    name="paused"
                    value={String(!(snapshot?.paused ?? false))}
                  />
                  <Button type="submit" size="sm">
                    {snapshot?.paused ? 'Resume queue' : 'Pause queue'}
                  </Button>
                </form>
              }
            />

            <div className="p-6">
              {serving ? (
                <div className="flex flex-wrap items-center gap-6">
                  <div
                    className={cn(
                      'flex size-28 shrink-0 items-center justify-center rounded-2xl',
                      'bg-brand-600 text-white',
                      serving.status === 'CALLED' && 'pulse-ring',
                    )}
                  >
                    <span className="numeric text-5xl font-bold">
                      {serving.tokenNumber}
                    </span>
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-2xl font-semibold text-ink-900">
                      {serving.patientName}
                    </p>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <StatusPill status={serving.status} />
                      <span className="text-sm text-ink-500">
                        {serving.status === 'CALLED'
                          ? `called ${waitedFor(serving.calledAt, now)} ago`
                          : `with doctor ${waitedFor(serving.calledAt, now)}`}
                      </span>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-6 py-2">
                  <div className="flex size-28 shrink-0 items-center justify-center rounded-2xl bg-ink-100 text-ink-300">
                    <span className="numeric text-5xl font-bold">–</span>
                  </div>
                  <div>
                    <p className="text-lg font-medium text-ink-700">
                      Nobody has been called yet
                    </p>
                    <p className="mt-1 text-sm text-ink-500">
                      {waiting.length > 0
                        ? `${waiting.length} patient${waiting.length === 1 ? '' : 's'} waiting.`
                        : 'The queue is empty.'}
                    </p>
                  </div>
                </div>
              )}
            </div>

            {/* One primary action. Everything else is deliberately smaller. */}
            <div className="flex flex-wrap items-center gap-3 border-t border-ink-200 bg-ink-50 px-6 py-4">
              <form action={advanceQueueAction}>
                <input type="hidden" name="doctorId" value={selectedId ?? ''} />
                <Button
                  type="submit"
                  variant="primary"
                  size="xl"
                  disabled={waiting.length === 0 && !serving}
                >
                  Call next patient
                </Button>
              </form>

              {serving ? (
                <>
                  <QueueActionButton
                    doctorId={selectedId!}
                    appointmentId={serving.appointmentId}
                    action="skip"
                    label="Skip"
                  />
                  <QueueActionButton
                    doctorId={selectedId!}
                    appointmentId={serving.appointmentId}
                    action="hold"
                    label="Hold"
                  />
                  {serving.status === 'CALLED' ? (
                    <QueueActionButton
                      doctorId={selectedId!}
                      appointmentId={serving.appointmentId}
                      action="start_consultation"
                      label="Start consultation"
                    />
                  ) : null}
                </>
              ) : null}
            </div>
          </Card>

          <Card>
            <CardHeader title="Waiting" hint={`${waiting.length} in line`} />
            {waiting.length === 0 ? (
              <EmptyState title="Nobody is waiting" hint="Add a walk-in to start the queue." />
            ) : (
              <ul className="divide-y divide-ink-200">
                {waiting.map((row, index) => (
                  <WaitingRow
                    key={row.appointmentId}
                    row={row}
                    position={index + 1}
                    doctorId={selectedId!}
                    now={now}
                    timezone={session.timezone}
                  />
                ))}
              </ul>
            )}
          </Card>
        </div>

        {/* ------------------------------------ right: what reception does next */}
        <div className="space-y-5">
          <Card>
            <CardHeader title="Add walk-in" hint="Issues a token and sends the queue link" />
            <form action={addWalkInAction} className="space-y-4 p-5">
              <input type="hidden" name="doctorId" value={selectedId ?? ''} />
              <input type="hidden" name="branchId" value={branchId} />
              <Field label="Patient name">
                <Input name="name" required placeholder="Ramesh Patil" autoComplete="off" />
              </Field>
              <Field label="Mobile number" hint="10 digits. The queue link goes here.">
                <Input
                  name="phone"
                  required
                  inputMode="numeric"
                  placeholder="98765 43210"
                  autoComplete="off"
                />
              </Field>
              <label className="flex items-start gap-2.5 text-sm text-ink-700">
                <input
                  type="checkbox"
                  name="whatsappOptIn"
                  value="yes"
                  defaultChecked
                  className="mt-0.5 size-4 rounded border-ink-300 text-brand-600 focus:ring-brand-600"
                />
                <span>
                  Patient agreed to WhatsApp updates
                  <span className="mt-0.5 block text-xs text-ink-500">
                    Untick if they said no. They still get a token and the printed
                    QR code.
                  </span>
                </span>
              </label>
              <Button type="submit" variant="primary" size="lg" className="w-full">
                Add to queue
              </Button>
            </form>
          </Card>

          <Card>
            <CardHeader title="Today" hint={snapshot?.serviceDate} />
            <dl className="grid grid-cols-2 divide-x divide-y divide-ink-200 [&>*]:border-ink-200">
              <Stat label="Waiting" value={snapshot?.waitingCount ?? 0} tone="brand" />
              <Stat label="Completed" value={snapshot?.completedCount ?? 0} />
              <Stat
                label="Avg consult"
                value={
                  snapshot?.medianConsultMinutes
                    ? `${Math.round(snapshot.medianConsultMinutes)}m`
                    : '—'
                }
                hint="median today"
              />
              <Stat
                label="Running late"
                value={snapshot?.delayMinutes ? `${snapshot.delayMinutes}m` : 'On time'}
                tone={snapshot && snapshot.delayMinutes > 20 ? 'warn' : 'default'}
              />
            </dl>
          </Card>

          <Card>
            <CardHeader
              title="Needs attention"
              hint="Skipped or on hold — still recoverable"
            />
            {(snapshot?.parked.length ?? 0) === 0 ? (
              <EmptyState title="Nothing parked" />
            ) : (
              <ul className="divide-y divide-ink-200">
                {snapshot!.parked.map((row) => (
                  <li key={row.appointmentId} className="flex items-center gap-3 px-5 py-3">
                    <span className="numeric w-9 shrink-0 text-lg font-semibold text-ink-500">
                      {row.tokenNumber}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-ink-800">
                        {row.patientName}
                      </p>
                      <StatusPill status={row.status} />
                    </div>
                    <QueueActionButton
                      doctorId={selectedId!}
                      appointmentId={row.appointmentId}
                      action={row.status === 'SKIPPED' ? 'recall' : 'resume'}
                      label={row.status === 'SKIPPED' ? 'Recall' : 'Resume'}
                      size="sm"
                    />
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {usage ? (
            <SubscriptionCard
              usage={usage}
              tierName={tierName}
              timezone={session.timezone}
            />
          ) : null}
        </div>
      </div>
    </>
  );
}

function WaitingRow({
  row,
  position,
  doctorId,
  now,
  timezone,
}: {
  row: QueueRow;
  position: number;
  doctorId: string;
  now: Date;
  timezone: string;
}) {
  return (
    <li className="flex flex-wrap items-center gap-3 px-5 py-3">
      <span className="numeric w-10 shrink-0 text-xl font-semibold text-ink-900">
        {row.tokenNumber}
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="truncate text-sm font-medium text-ink-900">{row.patientName}</p>
          {row.scheduledSlotAt ? (
            <span className="inline-flex items-center gap-1 rounded bg-brand-100 px-1.5 py-0.5 text-[10px] font-semibold text-brand-900">
              🕒 {formatTimeIn(timezone, row.scheduledSlotAt)}
            </span>
          ) : null}
        </div>
        <p className="text-xs text-ink-500">
          #{position} in line · waiting {waitedFor(row.enqueuedAt, now)}
          {row.priority > 0 ? ' · priority' : ''}
        </p>
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        {row.priority === 0 ? (
          <form action={prioritiseAction}>
            <input type="hidden" name="doctorId" value={doctorId} />
            <input type="hidden" name="appointmentId" value={row.appointmentId} />
            <input type="hidden" name="priority" value="10" />
            <Button type="submit" size="sm" title="Move to the front of the waiting line">
              Priority
            </Button>
          </form>
        ) : null}
        <QueueActionButton
          doctorId={doctorId}
          appointmentId={row.appointmentId}
          action="hold"
          label="Hold"
          size="sm"
        />
        <QueueActionButton
          doctorId={doctorId}
          appointmentId={row.appointmentId}
          action="mark_no_show"
          label="No show"
          size="sm"
          variant="danger"
        />
      </div>
    </li>
  );
}

function QueueActionButton({
  doctorId,
  appointmentId,
  action,
  label,
  size = 'lg',
  variant = 'secondary',
}: {
  doctorId: string;
  appointmentId: string;
  action: string;
  label: string;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
}) {
  return (
    <form action={queueActionForm}>
      <input type="hidden" name="doctorId" value={doctorId} />
      <input type="hidden" name="appointmentId" value={appointmentId} />
      <input type="hidden" name="action" value={action} />
      <Button type="submit" size={size} variant={variant}>
        {label}
      </Button>
    </form>
  );
}
