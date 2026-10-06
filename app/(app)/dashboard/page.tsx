import Link from 'next/link';
import { Suspense } from 'react';
import { redirect } from 'next/navigation';
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
import {
  StethoscopeIcon,
  PhoneIcon,
  ClockIcon,
  ZapIcon,
  BuildingIcon,
  FileTextIcon,
  BedIcon,
} from '@/components/icons';
import { ConsultationGateProvider } from '@/components/clinical/consultation-gate';
import { PaidToggle } from '@/components/paid-toggle';
import { PlanExpiryNotice } from '@/components/plan-expiry-notice';
import { SubscriptionCard, UsageNotice } from '@/components/subscription';
import { requireSession } from '@/lib/auth/session';
import {
  can,
  canSwitchDashboardView,
  dashboardViewFor,
  homePathFor,
} from '@/lib/domain/permissions';
import type { PaymentStatus } from '@/lib/domain/patient-billing';
import { formatIndianPhone, isMockPhone } from '@/lib/domain/phone';
import { formatTimeIn, minutesBetween } from '@/lib/domain/time';
import type { DayCapacitySummary } from '@/lib/domain/capacity';
import { getDayCapacity } from '@/lib/services/capacity';
import { loadDashboardData } from '@/lib/services/dashboard-loader';
import type { QueueRow } from '@/lib/services/queue';
import {
  countAdmittedForDoctorUser,
  getIpdStatusesForAppointments,
  type IpdStatus,
} from '@/lib/services/ipd-census';
import { ConsultationPanel } from './consultation-panel';
import { IpdBadge, ShiftToIpdButton } from './shift-to-ipd-button';
import {
  AddWalkInForm,
  CallNextButton,
  DoctorTabs,
  EmergencyButton,
  PausePatientButton,
  PriorityButton,
  QueueActionButton,
  ReceptionDashboardLayout,
  ReleaseReservedButton,
  ResumePatientButton,
  SessionControl,
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
  // A role that cannot work the queue (a nurse) has no business on it.
  if (!can(session.role, 'queue.mutate')) redirect(homePathFor(session.role));
  const params = await searchParams;
  const now = new Date();
  const requestId = `page_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

  const isOwner = session.role === 'owner';
  const canSwitchView = canSwitchDashboardView(session.role);
  const canCollect = can(session.role, 'billing.collect');
  const canPrice = can(session.role, 'billing.price');
  // Support sessions are read-only and never see clinical records (0028).
  const showConsultation = can(session.role, 'clinical.write') && !session.readOnly;

  const requestedView = typeof params.view === 'string' ? params.view : null;
  const effectiveView = dashboardViewFor(session.role, requestedView);

  // Single consolidated loader — one transaction, parallel queries
  const { branches, doctors, snapshot, usage, tiers, paymentStatuses, consultationFeePaise } =
    await loadDashboardData({
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
  const seenToday = snapshot?.completed ?? [];

  // The day's quota for this doctor; null when no quota is configured.
  const capacity = await getDayCapacity({
    hospitalId: session.hospitalId,
    doctorId: currentDoctor.id,
    timezone: session.timezone,
    now,
  });
  const canManageCapacity = can(session.role, 'capacity.manage') && !session.readOnly;
  const sessionStarted = Boolean(snapshot?.sessionStartedAt);
  const notStartedButSeeing =
    !sessionStarted && (Boolean(serving) || (snapshot?.completedCount ?? 0) > 0);

  // Shift to IPD (T1.4): the doctor's one click, and the badge that replaces it.
  const canShift = can(session.role, 'ipd.shift') && !session.readOnly;
  const ipdStatuses: Record<string, IpdStatus> = can(session.role, 'ipd.view')
    ? await getIpdStatusesForAppointments(session.hospitalId, [
        ...(serving ? [serving.appointmentId] : []),
        ...seenToday.map((row) => row.appointmentId),
      ])
    : {};
  const ipd: IpdRowContext = { statuses: ipdStatuses, canShift };
  // The doctor's one tap to their admitted patients (T3.1).
  const canSeeAdmitted = effectiveView === 'doctor' && can(session.role, 'ipd.dischargeReady');
  const admittedCount = canSeeAdmitted ? await countAdmittedForDoctorUser(session.hospitalId, session.userId) : 0;

  /**
   * Everything a payment pill needs except the row. The doctor view always
   * gets a read-only pill: the doctor may be the owner, but in the consulting
   * room they are not at the till.
   */
  const payment: PaymentPillContext = {
    statuses: paymentStatuses,
    readOnly: effectiveView === 'doctor' || !canCollect,
    feeKnown: consultationFeePaise !== null,
    canSetFee: canPrice,
    doctorName: currentDoctor.name,
  };

  return (
    <>
      <AutoRefresh seconds={10} />

      {/* Renewal strip: owner and doctors, last 15 days only, streamed so the queue never waits on it. */}
      <Suspense fallback={null}>
        <PlanExpiryNotice />
      </Suspense>

      {/* ========================================================================= */}
      {/* 1. DOCTOR DASHBOARD VIEW (Distraction-Free Clinical Focus)               */}
      {/* ========================================================================= */}
      {effectiveView === 'doctor' ? (
        <div className="space-y-5">
          {/* Personalized Doctor Header Bar */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-2xl border border-ink-200 bg-white p-4 sm:px-6 shadow-xs">
            <div className="flex items-center gap-3.5 min-w-0">
              <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-brand-50 border border-brand-200 text-brand-700 shadow-xs">
                <StethoscopeIcon className="size-6 text-brand-600" />
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
                    {snapshot?.paused ? 'On a break' : 'Live Consultations'}
                  </span>
                </div>
                <p className="text-xs text-ink-500 mt-0.5 flex items-center gap-1.5">
                  <BuildingIcon className="size-3 text-ink-400" />
                  {currentDoctor.branchName} · Consultation Room
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2.5 self-end sm:self-auto shrink-0">
              {canSeeAdmitted ? (
                <Link
                  href="/ipd/my-patients"
                  className="inline-flex min-h-10 items-center gap-1.5 rounded-lg bg-brand-50 px-3 text-sm font-semibold text-brand-800 ring-1 ring-inset ring-brand-200 hover:bg-brand-100"
                >
                  <BedIcon className="size-4" />
                  Admitted <span className="numeric">({admittedCount})</span>
                </Link>
              ) : null}
              <SessionControl
                doctorId={selectedId!}
                started={sessionStarted}
                paused={snapshot?.paused ?? false}
              />
              {canSwitchView ? (
                <ViewModeToggle currentView="doctor" doctorId={selectedId} />
              ) : null}
            </div>
          </div>

          {snapshot?.paused ? (
            <Alert tone="warn">
              <strong>
                You are on a break
                {snapshot.breakStartedAt
                  ? ` since ${formatTimeIn(session.timezone, snapshot.breakStartedAt)}`
                  : ''}
                .
              </strong>{' '}
              {snapshot.pausedReason ? `${snapshot.pausedReason}. ` : ''}
              Patients see that you are on a break. Click &quot;End break&quot; when you are back;
              the break is not counted in the current patient&apos;s consultation time.
            </Alert>
          ) : null}

          <SessionNotice snapshot={snapshot} notStartedButSeeing={notStartedButSeeing} timezone={session.timezone} />

          {/* Main Grid: Left = Consultation & Waiting Queue, Right = Attention & Stats */}
          <div className="grid items-start gap-5 lg:grid-cols-3">
            {/* Main Clinical Focus Area */}
            <ConsultationGateProvider>
            <div className="space-y-5 lg:col-span-2">
              {/* NOW SERVING CARD */}
              <Card className={cn(serving?.isEmergency && 'border-2 border-red-500 ring-2 ring-red-300 shadow-lg shadow-red-100/50')}>
                {serving?.isEmergency ? (
                  <div className="flex items-center justify-between gap-3 bg-red-600 px-4 py-2.5 text-white sm:px-6 animate-pulse shadow-sm">
                    <div className="flex items-center gap-2">
                      <span className="flex size-2.5 rounded-full bg-white animate-ping" />
                      <span className="text-xs sm:text-sm font-black tracking-wider uppercase">
                        🚨 EMERGENCY ADMISSION — IMMEDIATE ATTENTION
                      </span>
                    </div>
                    <span className="rounded bg-red-700/90 px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide">
                      High Priority Case
                    </span>
                  </div>
                ) : null}
                <CardHeader
                  title="Now Serving"
                  hint={serving ? servingHint(serving) : 'Room is ready'}
                />

                <div className={cn('p-4 sm:p-6', serving?.isEmergency && 'bg-red-50/20')}>
                  {serving ? (
                    <div className="flex flex-wrap items-center gap-4 sm:gap-6">
                      <div
                        className={cn(
                          'flex size-20 shrink-0 items-center justify-center rounded-2xl sm:size-28',
                          serving.isEmergency
                            ? 'bg-red-600 text-white shadow-md ring-4 ring-red-300 animate-pulse'
                            : 'bg-brand-600 text-white shadow-sm',
                          serving.status === 'CALLED' && 'pulse-ring',
                        )}
                      >
                        <ServingNumber row={serving} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="truncate text-2xl font-bold text-ink-900">
                            {serving.patientName}
                            {serving.patientAge ? (
                              <span className="ml-2 text-lg font-normal text-ink-500">
                                ({serving.patientAge} yrs)
                              </span>
                            ) : null}
                          </p>
                          {serving.isEmergency ? (
                            <span className="inline-flex items-center gap-1 rounded-md bg-red-600 px-2.5 py-0.5 text-xs font-black text-white shadow-xs animate-pulse">
                              <span>🚨</span> EMERGENCY
                            </span>
                          ) : null}
                        </div>
                        <div className="mt-2 flex flex-wrap items-center gap-2">
                          <StatusPill status={serving.status} />
                          <TokenChip token={serving.tokenNumber} />
                          {serving.patientPhone && !isMockPhone(serving.patientPhone) ? (
                            <a
                              href={`tel:${serving.patientPhone}`}
                              className="inline-flex items-center gap-1.5 rounded-md bg-ink-100 px-2 py-0.5 text-xs font-semibold text-ink-700 hover:bg-ink-200 transition-colors"
                              title="Call patient"
                            >
                              <PhoneIcon className="size-3 text-ink-500" />
                              <span>{formatIndianPhone(serving.patientPhone)}</span>
                            </a>
                          ) : null}
                          <RowPaidToggle row={serving} payment={payment} />
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
                      <PausePatientButton
                        doctorId={selectedId!}
                        appointmentId={serving.appointmentId}
                        patientName={serving.patientName}
                        tokenNumber={serving.tokenNumber}
                        size="md"
                      />

                      <QueueActionButton
                        doctorId={selectedId!}
                        appointmentId={serving.appointmentId}
                        action="skip"
                        label="Skip"
                      />

                      {ipd.statuses[serving.appointmentId] ? (
                        <IpdBadge label={ipdLabel(ipd.statuses[serving.appointmentId])} />
                      ) : canShift ? (
                        <ShiftToIpdButton appointmentId={serving.appointmentId} />
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </Card>

              {serving && showConsultation ? (
                <ConsultationPanel
                  key={serving.appointmentId}
                  appointmentId={serving.appointmentId}
                  isEmergency={serving.isEmergency}
                />
              ) : null}

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
                  <WaitingList
                    rows={waiting}
                    doctorId={selectedId!}
                    now={now}
                    timezone={session.timezone}
                    payment={payment}
                  />
                )}
              </Card>
            </div>
            </ConsultationGateProvider>

            {/* Sidebar: Stats & Needs Attention (Skipped & Paused) */}
            <div className="space-y-5">
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

              <ParkedPatientsCard
                parked={snapshot?.parked ?? []}
                doctorId={selectedId!}
                timezone={session.timezone}
                payment={payment}
              />

              {canShift && seenToday.length > 0 ? (
                <DoctorSeenTodayCard rows={seenToday} ipd={ipd} />
              ) : null}

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
                        <span className="inline-flex items-center gap-1 rounded-md bg-brand-50 border border-brand-200 px-2 py-1 font-bold text-brand-900">
                          <ClockIcon className="size-3 text-brand-700" />
                          <span>{formatTimeIn(session.timezone, s.scheduledSlotAt!)}</span>
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
            {canSwitchView ? (
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
              <strong>
                {snapshot.doctorName} is on a break
                {snapshot.breakStartedAt
                  ? ` since ${formatTimeIn(session.timezone, snapshot.breakStartedAt)}`
                  : ''}
                .
              </strong>{' '}
              {snapshot.pausedReason ? `${snapshot.pausedReason}. ` : ''}
              Patients see a break notice, and no reminders are sent.
            </Alert>
          ) : null}

          <SessionNotice snapshot={snapshot} notStartedButSeeing={notStartedButSeeing} timezone={session.timezone} />

          {capacity ? (
            <CapacityStrip
              capacity={capacity}
              doctorId={selectedId ?? ''}
              timezone={session.timezone}
              canManage={canManageCapacity}
            />
          ) : null}

          {scheduledToday.length > 0 ? (
            <div className="rounded-xl border border-brand-200 bg-brand-50/70 p-3.5 text-xs text-brand-950 flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <ClockIcon className="size-4 text-brand-700 shrink-0" />
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

          {/* Responsive Layout (Mobile Segmented Tabs + Desktop Multi-Column) */}
          <ReceptionDashboardLayout
            waitingCount={waiting.length}
            queueContent={
              <>
                <Card className={cn(serving?.isEmergency && 'border-2 border-red-500 ring-2 ring-red-300 shadow-md shadow-red-100/50')}>
                  {serving?.isEmergency ? (
                    <div className="flex items-center justify-between gap-3 bg-red-600 px-4 py-2 text-white sm:px-6 animate-pulse">
                      <div className="flex items-center gap-2">
                        <span className="flex size-2 rounded-full bg-white animate-ping" />
                        <span className="text-xs font-black tracking-wider uppercase">
                          🚨 Emergency Case In Consultation
                        </span>
                      </div>
                    </div>
                  ) : null}
                  <CardHeader
                    title="Now serving"
                    hint={serving ? `${snapshot?.doctorName} · ${servingHint(serving)}` : snapshot?.doctorName}
                    action={
                      <SessionControl
                        doctorId={selectedId ?? ''}
                        started={sessionStarted}
                        paused={snapshot?.paused ?? false}
                      />
                    }
                  />

                  <div className={cn('p-4 sm:p-6', serving?.isEmergency && 'bg-red-50/20')}>
                    {serving ? (
                      <div className="flex flex-wrap items-center gap-4 sm:gap-6">
                        <div
                          className={cn(
                            'flex size-20 shrink-0 items-center justify-center rounded-2xl sm:size-28',
                            serving.isEmergency
                              ? 'bg-red-600 text-white shadow-md ring-4 ring-red-300 animate-pulse'
                              : 'bg-brand-600 text-white',
                            serving.status === 'CALLED' && 'pulse-ring',
                          )}
                        >
                          <ServingNumber row={serving} />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="truncate text-2xl font-semibold text-ink-900">
                              {serving.patientName}
                              {serving.patientAge ? (
                                <span className="ml-2 text-lg font-normal text-ink-500">
                                  ({serving.patientAge} yrs)
                                </span>
                              ) : null}
                            </p>
                            {serving.isEmergency ? (
                              <span className="inline-flex items-center gap-1 rounded-md bg-red-600 px-2 py-0.5 text-xs font-black text-white shadow-xs animate-pulse">
                                <span>🚨</span> EMERGENCY
                              </span>
                            ) : null}
                          </div>
                          <div className="mt-2 flex flex-wrap items-center gap-2">
                            <StatusPill status={serving.status} />
                            <TokenChip token={serving.tokenNumber} />
                            {serving.patientPhone && !isMockPhone(serving.patientPhone) ? (
                              <a
                                href={`tel:${serving.patientPhone}`}
                                className="inline-flex items-center gap-1.5 rounded-md bg-ink-100 px-2 py-0.5 text-xs font-semibold text-ink-700 hover:bg-ink-200 transition-colors"
                                title="Call patient"
                              >
                                <PhoneIcon className="size-3 text-ink-500" />
                                <span>{formatIndianPhone(serving.patientPhone)}</span>
                              </a>
                            ) : null}
                            <RowPaidToggle row={serving} payment={payment} />
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
                      </div>
                    ) : null}
                  </div>
                </Card>

                <Card>
                  <CardHeader title="Waiting" hint={`${waiting.length} in line`} />
                  {waiting.length === 0 ? (
                    <EmptyState title="Nobody is waiting" hint="Add a walk-in to start the queue." />
                  ) : (
                    <WaitingList
                      rows={waiting}
                      doctorId={selectedId!}
                      now={now}
                      timezone={session.timezone}
                      payment={payment}
                    />
                  )}
                </Card>
              </>
            }
            addContent={
              <Card>
                <CardHeader title="Add walk-in" hint="Issues a token and sends the queue link" />
                <AddWalkInForm
                  key={`${selectedId}-${capacity?.quotaReached ? 'full' : 'open'}`}
                  doctorId={selectedId ?? ''}
                  branchId={branchId}
                  doctorName={currentDoctor.name}
                  canCollect={canCollect}
                  feeKnown={consultationFeePaise !== null}
                  quotaReached={capacity?.quotaReached ?? false}
                  canIssueExtra={canManageCapacity}
                />
              </Card>
            }
            overviewContent={
              <>
                {seenToday.length > 0 ? (
                  <SeenTodayCard rows={seenToday} payment={payment} ipd={ipd} />
                ) : null}

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
                  payment={payment}
                />

                {usage ? (
                  <SubscriptionCard
                    usage={usage}
                    tierName={tierName}
                    timezone={session.timezone}
                  />
                ) : null}
              </>
            }
          />
        </div>
      )}
    </>
  );
}

function ParkedPatientsCard({
  parked,
  doctorId,
  timezone,
  payment,
}: {
  parked: QueueRow[];
  doctorId: string;
  timezone: string;
  payment: PaymentPillContext;
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
                    {row.patientPhone && !isMockPhone(row.patientPhone) ? (
                      <a
                        href={`tel:${row.patientPhone}`}
                        className="inline-flex items-center gap-1.5 rounded-md bg-ink-100 px-2 py-0.5 text-xs font-semibold text-ink-700 hover:bg-ink-200 transition-colors"
                        title="Call patient"
                      >
                        <PhoneIcon className="size-3 text-ink-500" />
                        <span>{formatIndianPhone(row.patientPhone)}</span>
                      </a>
                    ) : null}
                    <RowPaidToggle row={row} payment={payment} />
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
  doctorId,
  now,
  timezone,
  payment,
}: {
  row: QueueRow;
  doctorId: string;
  now: Date;
  timezone: string;
  payment: PaymentPillContext;
}) {
  return (
    <li
      className={cn(
        'flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3.5 sm:px-5 sm:py-3.5 transition-colors',
        row.isEmergency
          ? 'bg-red-50/70 border-l-4 border-l-red-600 border-y border-r border-red-200 shadow-2xs'
          : 'hover:bg-ink-50/50',
      )}
    >
      <div className="flex items-start sm:items-center gap-3 min-w-0">
        {row.callNumber != null ? (
          /* The serving order: what this patient will be called as. */
          <span
            className={cn(
              'shrink-0 flex flex-col items-center justify-center size-11 rounded-xl leading-none shadow-xs',
              row.isEmergency
                ? 'bg-red-600 border border-red-700 text-white animate-pulse'
                : 'bg-brand-50 border border-brand-200 text-brand-800',
            )}
            title={row.isEmergency ? `EMERGENCY: Will be called as number ${row.callNumber}` : `Will be called as number ${row.callNumber}`}
          >
            <span className={cn('text-[9px] font-semibold uppercase tracking-wide', row.isEmergency ? 'text-red-100' : 'text-brand-600')}>
              Call
            </span>
            <span className="numeric text-base font-bold">{row.callNumber}</span>
          </span>
        ) : (
          /* Not here yet: no place in the call order, only their token. */
          <span
            className={cn(
              'shrink-0 flex flex-col items-center justify-center size-11 rounded-xl leading-none shadow-xs',
              row.isEmergency
                ? 'bg-red-600 border border-red-700 text-white animate-pulse'
                : 'bg-ink-50 border border-ink-200 text-ink-600',
            )}
          >
            <span className={cn('text-[9px] font-semibold uppercase tracking-wide', row.isEmergency ? 'text-red-100' : 'text-ink-500')}>
              Token
            </span>
            <span className="numeric text-base font-bold">{row.tokenNumber}</span>
          </span>
        )}

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
            {row.isEmergency ? (
              <span className="inline-flex items-center gap-1 rounded-md bg-red-600 px-2 py-0.5 text-[11px] font-black text-white shadow-xs animate-pulse">
                <span>🚨</span> EMERGENCY
              </span>
            ) : null}
            {row.scheduledSlotAt ? (
              <span className="inline-flex items-center gap-1 rounded bg-brand-100 px-1.5 py-0.5 text-[10px] font-bold text-brand-900">
                <ClockIcon className="size-3 text-brand-800" />
                <span>{formatTimeIn(timezone, row.scheduledSlotAt)}</span>
              </span>
            ) : null}
            {row.patientPhone && !isMockPhone(row.patientPhone) ? (
              <a
                href={`tel:${row.patientPhone}`}
                className="inline-flex items-center gap-1.5 rounded-md bg-ink-100 px-2 py-0.5 text-xs font-semibold text-ink-700 hover:bg-ink-200 transition-colors"
                title="Call patient"
              >
                <PhoneIcon className="size-3 text-ink-500" />
                <span>{formatIndianPhone(row.patientPhone)}</span>
              </a>
            ) : null}
            <RowPaidToggle row={row} payment={payment} />
          </div>
          <p className="text-xs text-ink-500 mt-0.5 flex flex-wrap items-center gap-1">
            <span>
              Token {row.tokenNumber} · waiting {waitedFor(row.enqueuedAt, now)}
            </span>
            {row.etaAt ? (
              <span>· expected ~{formatTimeIn(timezone, row.etaAt)}</span>
            ) : null}
            {row.isEmergency ? (
              <span className="inline-flex items-center gap-0.5 text-red-700 font-bold ml-1">
                · Top Emergency Priority
              </span>
            ) : row.priority > 0 ? (
              <span className="inline-flex items-center gap-0.5 text-amber-700 font-semibold ml-1">
                · <ZapIcon className="size-3 text-amber-600 inline" /> Priority
                {row.priorityRank ? ` #${row.priorityRank}` : ''}
              </span>
            ) : null}
            {row.queueAfterToken != null && row.priority === 0 && !row.isEmergency ? (
              <span className="text-ink-600">· returned late, after token {row.queueAfterToken}</span>
            ) : null}
            {row.quotaPool === 'extra' ? (
              <span className="font-semibold text-amber-700">· extra token</span>
            ) : null}
          </p>
        </div>
      </div>

      <div className="flex items-center gap-1.5 self-end sm:self-auto shrink-0 pt-1 sm:pt-0">
        <EmergencyButton doctorId={doctorId} appointmentId={row.appointmentId} isEmergency={row.isEmergency} />
        {row.priority === 0 && !row.isEmergency ? (
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

type PaymentPillContext = {
  statuses: Record<string, PaymentStatus>;
  readOnly: boolean;
  feeKnown: boolean;
  canSetFee: boolean;
  doctorName: string;
};

function RowPaidToggle({ row, payment }: { row: QueueRow; payment: PaymentPillContext }) {
  return (
    <PaidToggle
      appointmentId={row.appointmentId}
      tokenNumber={row.tokenNumber}
      status={payment.statuses[row.appointmentId] ?? 'unpaid'}
      readOnly={payment.readOnly}
      feeKnown={payment.feeKnown}
      canSetFee={payment.canSetFee}
      doctorName={payment.doctorName}
    />
  );
}

/**
 * Patients the doctor has finished with. The queue forgets them; the desk
 * cannot, because in most OPDs the fee is paid on the way out.
 */
function SeenTodayCard({
  rows,
  payment,
  ipd,
}: {
  rows: QueueRow[];
  payment: PaymentPillContext;
  ipd: IpdRowContext;
}) {
  const unpaid = rows.filter((row) => (payment.statuses[row.appointmentId] ?? 'unpaid') !== 'paid');
  return (
    <Card>
      <CardHeader
        title="Seen today"
        hint={unpaid.length > 0 ? `${unpaid.length} not paid yet` : 'All paid'}
      />
      <ul className="max-h-80 divide-y divide-ink-200 overflow-y-auto">
        {rows.map((row) => (
          <li key={row.appointmentId} className="flex items-center justify-between gap-3 px-4 py-2.5 sm:px-5">
            <div className="flex min-w-0 items-center gap-3">
              <span className="numeric flex size-8 shrink-0 items-center justify-center rounded-lg bg-ink-100 text-sm font-bold text-ink-600">
                {row.tokenNumber}
              </span>
              <p className="truncate text-sm font-semibold text-ink-900">{row.patientName}</p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {ipd.statuses[row.appointmentId] ? (
                <IpdBadge label={ipdLabel(ipd.statuses[row.appointmentId])} />
              ) : ipd.canShift ? (
                <ShiftToIpdButton appointmentId={row.appointmentId} compact />
              ) : null}
              <RowPaidToggle row={row} payment={payment} />
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** Which OPD rows are on the IPD side, and whether this user may shift one. */
type IpdRowContext = { statuses: Record<string, IpdStatus>; canShift: boolean };

const ipdLabel = (status: IpdStatus): string =>
  status === 'awaiting_bed' ? 'awaiting bed' : status === 'discharge_ready' ? 'going home' : 'admitted';

/**
 * The doctor's own Seen today: the doctor may decide to admit after the
 * consultation is over, so each finished patient keeps a one-tap Shift to IPD.
 */
function DoctorSeenTodayCard({ rows, ipd }: { rows: QueueRow[]; ipd: IpdRowContext }) {
  return (
    <Card>
      <CardHeader title="Seen today" hint="Admit a patient after the consultation" />
      <ul className="max-h-80 divide-y divide-ink-200 overflow-y-auto">
        {rows.map((row) => (
          <li key={row.appointmentId} className="flex items-center justify-between gap-3 px-4 py-2.5">
            <div className="flex min-w-0 items-center gap-3">
              <span className="numeric flex size-8 shrink-0 items-center justify-center rounded-lg bg-ink-100 text-sm font-bold text-ink-600">
                {row.tokenNumber}
              </span>
              <p className="truncate text-sm font-semibold text-ink-900">{row.patientName}</p>
            </div>
            {ipd.statuses[row.appointmentId] ? (
              <IpdBadge label={ipdLabel(ipd.statuses[row.appointmentId])} />
            ) : (
              <ShiftToIpdButton appointmentId={row.appointmentId} compact />
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

/**
 * Start OPD reminders. The ETA patients see depends on it, so the desk is
 * told when the day looks started but is not.
 */
function SessionNotice({
  snapshot,
  notStartedButSeeing,
  timezone,
}: {
  snapshot: { sessionStartedAt: Date | null; scheduledStartAt: Date | null; etaState: string; delayMinutes: number } | null;
  notStartedButSeeing: boolean;
  timezone: string;
}) {
  if (!snapshot || snapshot.sessionStartedAt) return null;
  if (notStartedButSeeing) {
    return (
      <Alert tone="info">
        Patients are being seen but OPD has not been started. Tap <strong>Start OPD</strong> so
        patients&apos; expected times follow the live queue.
      </Alert>
    );
  }
  if (snapshot.etaState === 'not_started' && snapshot.scheduledStartAt) {
    return (
      <Alert tone="warn">
        OPD was scheduled to start at {formatTimeIn(timezone, snapshot.scheduledStartAt)} (
        {snapshot.delayMinutes} min ago). Patients see &quot;Doctor has not started OPD yet&quot; until
        you tap <strong>Start OPD</strong>.
      </Alert>
    );
  }
  return null;
}

/**
 * Today's token quota at a glance: reserved walk-ins, the shared pool, extra
 * tokens, and when online booking opens. Refreshes with the dashboard.
 */
function CapacityStrip({
  capacity,
  doctorId,
  timezone,
  canManage,
}: {
  capacity: DayCapacitySummary;
  doctorId: string;
  timezone: string;
  canManage: boolean;
}) {
  const sharedTotal = capacity.quota - capacity.walkInReserved;
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-ink-200 bg-white px-4 py-3 text-sm text-ink-700">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <span>
          <strong className="text-ink-900">Quota</strong>{' '}
          <span className="numeric">{capacity.totalActive}/{capacity.quota}</span>
        </span>
        {capacity.walkInReserved > 0 ? (
          <span>
            Reserved walk-in{' '}
            <span className="numeric">{capacity.reservedActive}/{capacity.walkInReserved}</span>
            {capacity.released ? ' (unused released to online)' : ''}
          </span>
        ) : null}
        <span>
          Shared <span className="numeric">{capacity.sharedActive}/{capacity.released ? capacity.sharedCap : sharedTotal}</span>
        </span>
        {capacity.extraActive > 0 ? (
          <span className="font-semibold text-amber-700">
            Extra <span className="numeric">{capacity.extraActive}</span>
          </span>
        ) : null}
        {capacity.onlineOpensAt ? (
          <span className="text-ink-500">Online opens {formatTimeIn(timezone, capacity.onlineOpensAt)}</span>
        ) : null}
        {capacity.quotaReached ? (
          <span className="font-semibold text-rose-700">Quota full</span>
        ) : capacity.onlineBlockedByReserve ? (
          <span className="font-semibold text-amber-700">
            Online full — {capacity.reservedUnused} reserved walk-in place
            {capacity.reservedUnused === 1 ? '' : 's'} unused
          </span>
        ) : null}
      </div>
      {canManage && !capacity.released && capacity.reservedUnused > 0 ? (
        <ReleaseReservedButton doctorId={doctorId} count={capacity.reservedUnused} />
      ) : null}
    </div>
  );
}

/**
 * The one waiting line, in the order Next calls it. Each row leads with its
 * call number. A patient who is not there when called is put on hold and
 * leaves this list until they are resumed.
 */
function WaitingList({
  rows,
  doctorId,
  now,
  timezone,
  payment,
}: {
  rows: QueueRow[];
  doctorId: string;
  now: Date;
  timezone: string;
  payment: PaymentPillContext;
}) {
  return (
    <ul className="divide-y divide-ink-200">
      {rows.map((row) => (
        <WaitingRow
          key={row.appointmentId}
          row={row}
          doctorId={doctorId}
          now={now}
          timezone={timezone}
          payment={payment}
        />
      ))}
    </ul>
  );
}

/** "Call 3 · Token 31": the serving number first, the booking token beside it. */
function servingHint(row: QueueRow): string {
  return row.callNumber != null ? `Call ${row.callNumber} · Token #${row.tokenNumber}` : `Token #${row.tokenNumber}`;
}

/**
 * The big number in the Now serving card. It is the call number — the order
 * patients are seen in — so a token served early never reads as a jump.
 */
function ServingNumber({ row }: { row: QueueRow }) {
  if (row.callNumber == null) {
    return <span className="numeric text-4xl font-bold sm:text-5xl">{row.tokenNumber}</span>;
  }
  return (
    <span className="flex flex-col items-center leading-none">
      <span className="text-[10px] font-semibold uppercase tracking-wider opacity-80 sm:text-xs">Call</span>
      <span className="numeric text-4xl font-bold sm:text-5xl">{row.callNumber}</span>
    </span>
  );
}

/** The booking token, shown beside the call number; it never changes. */
function TokenChip({ token }: { token: number }) {
  return (
    <span className="inline-flex items-center rounded-md bg-ink-100 px-2 py-0.5 text-xs font-semibold text-ink-700">
      Token {token}
    </span>
  );
}
