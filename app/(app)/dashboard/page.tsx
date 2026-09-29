import Link from 'next/link';
import { AutoRefresh } from '@/components/auto-refresh';
import {
  Alert,
  Button,
  Card,
  CardHeader,
  EmptyState,
  StatusPill,
  Stat,
  cn,
} from '@/components/ui';
import { SubscriptionCard, UsageNotice } from '@/components/subscription';
import { requireSession } from '@/lib/auth/session';
import { formatTimeIn, minutesBetween } from '@/lib/domain/time';
import { loadDashboardData } from '@/lib/services/dashboard-loader';
import type { QueueRow } from '@/lib/services/queue';
import {
  AddWalkInForm,
  CallNextButton,
  DoctorTabs,
  PausePatientButton,
  PriorityButton,
  QueueActionButton,
  ResumePatientButton,
  TogglePauseButton,
  ViewModeToggle,
} from './dashboard-queue-actions';

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
  const requestId = `page_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

  const isDoctorRole = session.role === 'doctor';
  const isOwner = session.role === 'owner';

  // Determine effective view: doctor role is always Doctor view; owner can toggle; receptionist is Reception view
  const requestedView = typeof params.view === 'string' ? params.view : null;
  const effectiveView: 'doctor' | 'reception' = isDoctorRole
    ? 'doctor'
    : isOwner && requestedView === 'doctor'
      ? 'doctor'
      : isOwner && requestedView === 'reception'
        ? 'reception'
        : isOwner
          ? 'reception' // Owners default to reception desk view with instant doctor switch
          : 'reception';

  // Single consolidated loader — one transaction, parallel queries
  const { branches, doctors, snapshot, usage, tiers } = await loadDashboardData({
    hospitalId: session.hospitalId,
    requestId,
    branchId:
      (typeof params.branch === 'string' ? params.branch : null) ??
      session.branchId ??
      null,
    selectedDoctorId: typeof params.doctor === 'string' ? params.doctor : null,
    timezone: session.timezone,
    isOwner,
    now,
  });

  const branchId = branches[0]?.id ?? null;

  // Resolve doctor: in doctor view, prefer matching user doctor, otherwise first available
  const userMatchedDoctor =
    doctors.find((d) => d.userId === session.userId) ??
    doctors.find((d) => d.name.toLowerCase().includes(session.name.toLowerCase())) ??
    doctors[0];

  const selectedId =
    (typeof params.doctor === 'string' ? params.doctor : null) ??
    (effectiveView === 'doctor' ? userMatchedDoctor?.id : doctors[0]?.id) ??
    null;

  const currentDoctor = doctors.find((d) => d.id === selectedId) ?? doctors[0] ?? null;

  if (!branchId || doctors.length === 0 || !currentDoctor) {
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

      {/* ========================================================================= */}
      {/* 1. DOCTOR DASHBOARD VIEW (Distraction-Free Clinical Focus)               */}
      {/* ========================================================================= */}
      {effectiveView === 'doctor' ? (
        <div className="space-y-5">
          {/* Personalized Doctor Header Bar */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-2xl border border-ink-200 bg-white p-4 sm:px-6 shadow-xs">
            <div className="flex items-center gap-3.5 min-w-0">
              <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-brand-50 border border-brand-200 text-brand-700 text-xl font-bold">
                🩺
              </div>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h1 className="truncate text-lg font-bold text-ink-900">
                    {currentDoctor.name}
                  </h1>
                  {currentDoctor.specialty ? (
                    <span className="rounded-full bg-brand-100 px-2.5 py-0.5 text-xs font-semibold text-brand-800">
                      {currentDoctor.specialty}
                    </span>
                  ) : null}
                  <span
                    className={cn(
                      'inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold',
                      snapshot?.paused
                        ? 'bg-amber-100 text-amber-900'
                        : 'bg-emerald-100 text-emerald-800',
                    )}
                  >
                    <span
                      className={cn(
                        'size-1.5 rounded-full',
                        snapshot?.paused ? 'bg-amber-600' : 'bg-emerald-600 animate-pulse',
                      )}
                    />
                    {snapshot?.paused ? 'Room Paused' : 'Live Consultations'}
                  </span>
                </div>
                <p className="text-xs text-ink-500 mt-0.5">
                  {currentDoctor.branchName} · Consultation Room
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2.5 self-end sm:self-auto shrink-0">
              <TogglePauseButton
                doctorId={selectedId!}
                paused={snapshot?.paused ?? false}
              />
              {isOwner ? (
                <ViewModeToggle currentView="doctor" doctorId={selectedId} />
              ) : null}
            </div>
          </div>

          {snapshot?.paused ? (
            <Alert tone="warn">
              <strong>Your consultation queue is currently on hold.</strong>{' '}
              {snapshot.pausedReason ? `${snapshot.pausedReason}. ` : ''}
              Patients are informed that the doctor is temporarily away. Click &quot;Resume Room&quot; when ready.
            </Alert>
          ) : null}

          {/* Main Grid: Left = Consultation & Waiting Queue, Right = Attention & Stats */}
          <div className="grid items-start gap-5 lg:grid-cols-3">
            {/* Main Clinical Focus Area */}
            <div className="space-y-5 lg:col-span-2">
              {/* NOW SERVING CARD (Large, High-Contrast with the 3 Core Clinical Actions) */}
              <Card>
                <CardHeader
                  title="Now Serving"
                  hint={serving ? `Token #${serving.tokenNumber}` : 'Room is ready'}
                />

                <div className="p-4 sm:p-6">
                  {serving ? (
                    <div className="flex flex-wrap items-center gap-4 sm:gap-6">
                      <div
                        className={cn(
                          'flex size-20 shrink-0 items-center justify-center rounded-2xl sm:size-28',
                          'bg-brand-600 text-white shadow-sm',
                          serving.status === 'CALLED' && 'pulse-ring',
                        )}
                      >
                        <span className="numeric text-4xl font-bold sm:text-5xl">
                          {serving.tokenNumber}
                        </span>
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-2xl font-bold text-ink-900">
                          {serving.patientName}
                          {serving.patientAge ? (
                            <span className="ml-2 text-lg font-normal text-ink-500">
                              ({serving.patientAge} yrs)
                            </span>
                          ) : null}
                        </p>
                        <div className="mt-2 flex flex-wrap items-center gap-2">
                          <StatusPill status={serving.status} />
                          <span className="text-sm text-ink-600 font-medium">
                            {serving.status === 'CALLED'
                              ? `Called ${waitedFor(serving.calledAt, now)} ago`
                              : `With doctor for ${waitedFor(serving.calledAt, now)}`}
                          </span>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center gap-4 py-2 sm:gap-6">
                      <div className="flex size-20 shrink-0 items-center justify-center rounded-2xl bg-ink-100 text-ink-300 sm:size-28">
                        <span className="numeric text-4xl font-bold sm:text-5xl">–</span>
                      </div>
                      <div>
                        <p className="text-lg font-semibold text-ink-800">
                          No patient currently in room
                        </p>
                        <p className="mt-1 text-sm text-ink-500">
                          {waiting.length > 0
                            ? `${waiting.length} patient${waiting.length === 1 ? '' : 's'} waiting in line.`
                            : 'Queue is clear. No patients waiting.'}
                        </p>
                      </div>
                    </div>
                  )}
                </div>

                {/* The 3 Core Action Buttons for Doctor */}
                <div className="flex flex-col sm:flex-row flex-wrap items-stretch sm:items-center gap-2.5 sm:gap-3 border-t border-ink-200 bg-ink-50 p-4 sm:px-6 sm:py-4">
                  <CallNextButton
                    doctorId={selectedId!}
                    disabled={waiting.length === 0 && !serving}
                    label={
                      serving
                        ? waiting.length > 0
                          ? 'Complete & Call Next'
                          : 'Complete Consultation'
                        : 'Call Next Patient'
                    }
                  />

                  {serving ? (
                    <div className="grid grid-cols-2 sm:flex sm:flex-wrap gap-2 sm:gap-2.5 w-full sm:w-auto">
                      {/* Button 2: Pause Patient (Lab test / X-ray / Investigation) */}
                      <PausePatientButton
                        doctorId={selectedId!}
                        appointmentId={serving.appointmentId}
                        patientName={serving.patientName}
                        tokenNumber={serving.tokenNumber}
                        size="md"
                      />

                      {/* Button 3: Skip Patient */}
                      <QueueActionButton
                        doctorId={selectedId!}
                        appointmentId={serving.appointmentId}
                        action="skip"
                        label="Skip"
                      />

                      {serving.status === 'CALLED' ? (
                        <div className="col-span-2 sm:col-auto">
                          <QueueActionButton
                            doctorId={selectedId!}
                            appointmentId={serving.appointmentId}
                            action="start_consultation"
                            label="Start Consultation"
                            className="w-full sm:w-auto"
                          />
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </Card>

              {/* WAITING QUEUE LIST */}
              <Card>
                <CardHeader
                  title="Waiting Queue"
                  hint={`${waiting.length} patient${waiting.length === 1 ? '' : 's'} in line`}
                />
                {waiting.length === 0 ? (
                  <EmptyState
                    title="Nobody is waiting"
                    hint="New arrivals registered at reception will appear here instantly."
                  />
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

            {/* Sidebar: Stats & Needs Attention (Skipped & Paused) */}
            <div className="space-y-5">
              {/* Today's Stats Card */}
              <Card>
                <CardHeader title="Today's Overview" hint={snapshot?.serviceDate} />
                <dl className="grid grid-cols-2 divide-x divide-y divide-ink-200 [&>*]:border-ink-200">
                  <Stat label="Waiting" value={snapshot?.waitingCount ?? 0} tone="brand" />
                  <Stat label="Completed" value={snapshot?.completedCount ?? 0} />
                  <Stat
                    label="Avg Consult"
                    value={
                      snapshot?.medianConsultMinutes
                        ? `${Math.round(snapshot.medianConsultMinutes)}m`
                        : '—'
                    }
                    hint="median duration"
                  />
                  <Stat
                    label="Queue Delay"
                    value={snapshot?.delayMinutes ? `${snapshot.delayMinutes}m` : 'On time'}
                    tone={snapshot && snapshot.delayMinutes > 20 ? 'warn' : 'default'}
                  />
                </dl>
              </Card>

              {/* Parked / Needs Attention List (Skipped & On-Hold patients) */}
              <ParkedPatientsCard
                parked={snapshot?.parked ?? []}
                doctorId={selectedId!}
                timezone={session.timezone}
              />

              {/* Scheduled Appointments Preview */}
              {scheduledToday.length > 0 ? (
                <Card>
                  <CardHeader
                    title="Scheduled Today"
                    hint={`${scheduledToday.length} booking${scheduledToday.length === 1 ? '' : 's'}`}
                  />
                  <ul className="divide-y divide-ink-200 p-2">
                    {scheduledToday.map((s) => (
                      <li key={s.appointmentId} className="flex items-center justify-between p-2.5 text-xs">
                        <div className="min-w-0">
                          <p className="font-semibold text-ink-900 truncate">
                            {s.patientName}
                          </p>
                          <p className="text-ink-500">Token #{s.tokenNumber}</p>
                        </div>
                        <span className="rounded bg-brand-50 border border-brand-200 px-2 py-1 font-bold text-brand-900">
                          🕒 {formatTimeIn(session.timezone, s.scheduledSlotAt!)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </Card>
              ) : null}
            </div>
          </div>
        </div>
      ) : (
        /* ========================================================================= */
        /* 2. RECEPTIONIST / OWNER DASHBOARD VIEW (Full Desk Controls)              */
        /* ========================================================================= */
        <div className="space-y-5">
          {/* Doctor selector tabs + View Toggle */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <DoctorTabs doctors={doctors} selectedId={selectedId!} />
            {isOwner ? (
              <div className="self-end sm:self-auto mb-5 shrink-0">
                <ViewModeToggle currentView="reception" doctorId={selectedId} />
              </div>
            ) : null}
          </div>

          {params.error === 'phone' ? (
            <Alert tone="error">
              Enter a name and a valid 10-digit Indian mobile number.
            </Alert>
          ) : null}

          {usage?.subscription ? (
            <UsageNotice usage={usage} />
          ) : null}

          {snapshot?.paused ? (
            <Alert tone="warn">
              <strong>{snapshot.doctorName} is paused.</strong>{' '}
              {snapshot.pausedReason ? `${snapshot.pausedReason}. ` : ''}
              Patients are told the queue is on hold, and no reminders are sent.
            </Alert>
          ) : null}

          {scheduledToday.length > 0 ? (
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
          ) : null}

          <div className="grid items-start gap-5 lg:grid-cols-3">
            {/* Left 2 cols: Live Queue Table */}
            <div className="space-y-5 lg:col-span-2">
              <Card>
                <CardHeader
                  title="Now serving"
                  hint={snapshot?.doctorName}
                  action={
                    <TogglePauseButton
                      doctorId={selectedId ?? ''}
                      paused={snapshot?.paused ?? false}
                    />
                  }
                />

                <div className="p-4 sm:p-6">
                  {serving ? (
                    <div className="flex flex-wrap items-center gap-4 sm:gap-6">
                      <div
                        className={cn(
                          'flex size-20 shrink-0 items-center justify-center rounded-2xl sm:size-28',
                          'bg-brand-600 text-white',
                          serving.status === 'CALLED' && 'pulse-ring',
                        )}
                      >
                        <span className="numeric text-4xl font-bold sm:text-5xl">
                          {serving.tokenNumber}
                        </span>
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-2xl font-semibold text-ink-900">
                          {serving.patientName}
                          {serving.patientAge ? (
                            <span className="ml-2 text-lg font-normal text-ink-500">
                              ({serving.patientAge} yrs)
                            </span>
                          ) : null}
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
                    <div className="flex items-center gap-4 py-2 sm:gap-6">
                      <div className="flex size-20 shrink-0 items-center justify-center rounded-2xl bg-ink-100 text-ink-300 sm:size-28">
                        <span className="numeric text-4xl font-bold sm:text-5xl">–</span>
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

                <div className="flex flex-col sm:flex-row flex-wrap items-stretch sm:items-center gap-2.5 sm:gap-3 border-t border-ink-200 bg-ink-50 p-4 sm:px-6 sm:py-4">
                  <CallNextButton
                    doctorId={selectedId ?? ''}
                    disabled={waiting.length === 0 && !serving}
                  />

                  {serving ? (
                    <div className="grid grid-cols-2 sm:flex sm:flex-wrap gap-2 sm:gap-2.5 w-full sm:w-auto">
                      <QueueActionButton
                        doctorId={selectedId!}
                        appointmentId={serving.appointmentId}
                        action="skip"
                        label="Skip"
                      />
                      <PausePatientButton
                        doctorId={selectedId!}
                        appointmentId={serving.appointmentId}
                        patientName={serving.patientName}
                        tokenNumber={serving.tokenNumber}
                        size="md"
                      />
                      {serving.status === 'CALLED' ? (
                        <div className="col-span-2 sm:col-auto">
                          <QueueActionButton
                            doctorId={selectedId!}
                            appointmentId={serving.appointmentId}
                            action="start_consultation"
                            label="Start consultation"
                            className="w-full sm:w-auto"
                          />
                        </div>
                      ) : null}
                    </div>
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

            {/* Right col: Add Walk-in, Stats, Needs Attention, Subscriptions */}
            <div className="space-y-5">
              <Card>
                <CardHeader title="Add walk-in" hint="Issues a token and sends the queue link" />
                <AddWalkInForm doctorId={selectedId ?? ''} branchId={branchId} />
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

              <ParkedPatientsCard
                parked={snapshot?.parked ?? []}
                doctorId={selectedId!}
                timezone={session.timezone}
              />

              {usage ? (
                <SubscriptionCard
                  usage={usage}
                  tierName={tierName}
                  timezone={session.timezone}
                />
              ) : null}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function ParkedPatientsCard({
  parked,
  doctorId,
  timezone,
}: {
  parked: QueueRow[];
  doctorId: string;
  timezone: string;
}) {
  return (
    <Card>
      <CardHeader
        title="Needs attention"
        hint="Skipped or on hold — still recoverable"
      />
      {parked.length === 0 ? (
        <EmptyState title="Nothing parked" hint="No skipped or on-hold patients." />
      ) : (
        <ul className="divide-y divide-ink-200">
          {parked.map((row) => (
            <li key={row.appointmentId} className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3.5 sm:px-5 sm:py-3">
              <div className="flex items-center gap-3 min-w-0">
                <span className="numeric w-9 shrink-0 text-lg font-bold text-ink-600 bg-ink-100 rounded-lg size-9 flex items-center justify-center">
                  {row.tokenNumber}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-bold text-ink-900">
                    {row.patientName}
                    {row.patientAge ? (
                      <span className="ml-1.5 text-xs text-ink-500 font-normal">
                        ({row.patientAge}y)
                      </span>
                    ) : null}
                  </p>
                  <div className="mt-0.5 flex flex-wrap items-center gap-2">
                    <StatusPill status={row.status} />
                    {row.status === 'HELD' && row.resumeAt ? (
                      <span className="text-xs text-amber-800 font-medium">
                        Auto-resumes at {formatTimeIn(timezone, row.resumeAt)}
                      </span>
                    ) : null}
                  </div>
                </div>
              </div>
              <div className="self-end sm:self-auto">
                {row.status === 'HELD' ? (
                  <ResumePatientButton
                    doctorId={doctorId}
                    appointmentId={row.appointmentId}
                    patientName={row.patientName}
                    tokenNumber={row.tokenNumber}
                    size="sm"
                  />
                ) : (
                  <QueueActionButton
                    doctorId={doctorId}
                    appointmentId={row.appointmentId}
                    action="recall"
                    label="Recall"
                    size="sm"
                  />
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
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
    <li className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3.5 sm:px-5 sm:py-3.5 hover:bg-ink-50/50 transition-colors">
      <div className="flex items-start sm:items-center gap-3 min-w-0">
        <span className="numeric shrink-0 size-9 rounded-xl bg-brand-50 border border-brand-200 text-brand-800 text-base font-bold flex items-center justify-center">
          {row.tokenNumber}
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
            <p className="truncate text-sm font-bold text-ink-900">
              {row.patientName}
              {row.patientAge ? (
                <span className="ml-1 text-xs text-ink-500 font-normal">
                  ({row.patientAge}y)
                </span>
              ) : null}
            </p>
            {row.scheduledSlotAt ? (
              <span className="inline-flex items-center gap-1 rounded bg-brand-100 px-1.5 py-0.5 text-[10px] font-bold text-brand-900">
                🕒 {formatTimeIn(timezone, row.scheduledSlotAt)}
              </span>
            ) : null}
          </div>
          <p className="text-xs text-ink-500 mt-0.5">
            #{position} in line · waiting {waitedFor(row.enqueuedAt, now)}
            {row.priority > 0 ? ' · ⚡ priority' : ''}
          </p>
        </div>
      </div>

      <div className="flex items-center gap-1.5 self-end sm:self-auto shrink-0 pt-1 sm:pt-0">
        {row.priority === 0 ? (
          <PriorityButton doctorId={doctorId} appointmentId={row.appointmentId} />
        ) : null}
        <PausePatientButton
          doctorId={doctorId}
          appointmentId={row.appointmentId}
          patientName={row.patientName}
          tokenNumber={row.tokenNumber}
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

