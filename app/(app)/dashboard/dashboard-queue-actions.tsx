'use client';

import React, { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Field, Input, cn } from '@/components/ui';
import {
  StethoscopeIcon,
  FileTextIcon,
  UserPlusIcon,
  BarChartIcon,
  PauseIcon,
  ZapIcon,
  CheckIcon,
  XIcon,
} from '@/components/icons';
import { useConsultationGate } from '@/components/clinical/consultation-gate';
import { useToast } from '@/components/toast';
import { playChime } from '@/lib/utils/sound';
import type { QueueAction } from '@/lib/domain/types';
import {
  addWalkInDynamic,
  advanceQueueDynamic,
  markArrivedDynamic,
  pauseAppointmentDynamic,
  queueActionDynamic,
  releaseReservedDynamic,
  resumeAppointmentDynamic,
  setPriorityDynamic,
  startSessionDynamic,
  togglePauseDynamic,
} from './actions';

export function DoctorTabs({
  doctors,
  selectedId,
}: {
  doctors: Array<{ id: string; name: string; specialty: string | null }>;
  selectedId: string;
}) {
  const router = useRouter();
  const [activeId, setActiveId] = useState(selectedId);
  const [isPending, startTransition] = useTransition();

  React.useEffect(() => {
    setActiveId(selectedId);
  }, [selectedId]);

  const handleSelectDoctor = (id: string) => {
    if (id === activeId) return;
    setActiveId(id);
    startTransition(() => {
      router.push(`/dashboard?doctor=${id}`, { scroll: false });
    });
  };

  return (
    <div className="mb-5 flex items-center gap-2 overflow-x-auto pb-1 scrollbar-none">
      {doctors.map((doctor) => {
        const isSelected = doctor.id === activeId;
        const isLoadingThis = isSelected && isPending;
        return (
          <button
            key={doctor.id}
            type="button"
            onClick={() => handleSelectDoctor(doctor.id)}
            disabled={isPending}
            className={cn(
              'shrink-0 inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold transition-all cursor-pointer select-none',
              isSelected
                ? 'bg-brand-600 text-white shadow-xs ring-2 ring-brand-600'
                : 'bg-white text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-50',
              isPending && !isSelected && 'opacity-60 cursor-not-allowed',
            )}
          >
            {isLoadingThis ? (
              <span className="inline-block size-3.5 animate-spin rounded-full border-2 border-white border-t-transparent" />
            ) : (
              <StethoscopeIcon className={cn('size-4', isSelected ? 'text-white' : 'text-brand-600')} />
            )}
            <span>{doctor.name}</span>
            {doctor.specialty ? (
              <span
                className={cn(
                  'rounded-md px-1.5 py-0.5 text-xs font-normal',
                  isSelected ? 'bg-brand-700 text-brand-100' : 'bg-ink-100 text-ink-600',
                )}
              >
                {doctor.specialty}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

export function AddWalkInForm({
  doctorId,
  branchId,
  doctorName,
  canCollect,
  feeKnown,
  quotaReached = false,
  canIssueExtra = false,
}: {
  doctorId: string;
  branchId: string;
  doctorName: string;
  /** Whether this user may take money; otherwise the Paid choice is not offered. */
  canCollect: boolean;
  /** Without a consultation fee there is nothing to charge, so Paid is disabled. */
  feeKnown: boolean;
  /** Today's token quota is full; only an EXTRA token can be issued. */
  quotaReached?: boolean;
  /** The owner may issue an EXTRA token once the quota is full. */
  canIssueExtra?: boolean;
}) {
  const toast = useToast();
  const nameRef = React.useRef<HTMLInputElement>(null);

  const [name, setName] = useState('');
  const [age, setAge] = useState('');
  const [phone, setPhone] = useState('');
  const [address, setAddress] = useState('');
  const [paid, setPaid] = useState(false);
  const [whatsappOptIn, setWhatsappOptIn] = useState(true);
  const [isPending, startTransition] = useTransition();
  // Set when the server says the quota is full, as well as from the page.
  const [full, setFull] = useState(quotaReached);
  const [extra, setExtra] = useState(false);
  const offerExtra = (full || quotaReached) && canIssueExtra;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      toast.error('Please enter patient name');
      return;
    }
    if (!phone.trim()) {
      toast.error('Please enter patient phone number');
      return;
    }

    const parsedAge = age.trim() ? parseInt(age.trim(), 10) : null;

    startTransition(async () => {
      const res = await addWalkInDynamic({
        doctorId,
        branchId,
        name,
        age: parsedAge,
        phone,
        address,
        whatsappOptIn,
        paid: canCollect && feeKnown && paid,
        extraToken: offerExtra && extra,
      });

      if (res.ok) {
        toast.success(
          `Token #${res.tokenNumber} Created!`,
          `${name.trim()}${parsedAge ? ` (${parsedAge}y)` : ''} added to the queue successfully.`,
        );
        if (res.warning) toast.error('Payment not recorded', res.warning);
        setName('');
        setAge('');
        setPhone('');
        setAddress('');
        setPaid(false);
        setExtra(false);
        // Ready for the next person in line without reaching for the mouse.
        nameRef.current?.focus();
      } else {
        if (res.quotaReached) setFull(true);
        toast.error('Could not add patient', res.error);
      }
    });
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4 p-5">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="sm:col-span-2">
          <Field label="Patient name">
            <Input
              ref={nameRef}
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              placeholder="Ramesh Patil"
              autoComplete="off"
            />
          </Field>
        </div>
        <div>
          <Field label="Age">
            <Input
              type="number"
              min="0"
              max="125"
              value={age}
              onChange={(e) => setAge(e.target.value)}
              placeholder="35"
              autoComplete="off"
            />
          </Field>
        </div>
      </div>

      <Field label="Mobile number" hint="10 digits. The queue link goes here. No phone? Enter 0000000000.">
        <Input
          type="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          required
          inputMode="numeric"
          placeholder="98765 43210"
          autoComplete="off"
        />
      </Field>

      <Field label="Address" hint="Optional. Helps reach family in an emergency.">
        <Input
          type="text"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          maxLength={500}
          placeholder="Village / area"
          autoComplete="off"
        />
      </Field>

      {canCollect ? (
        <div>
          <span className="mb-1.5 block text-sm font-medium text-ink-700">Payment</span>
          <div className="inline-flex rounded-xl bg-ink-100 p-1 ring-1 ring-ink-200" role="radiogroup">
            {[
              { value: false, label: 'Unpaid' },
              { value: true, label: 'Paid' },
            ].map((option) => {
              const selected = paid === option.value;
              const disabled = option.value && !feeKnown;
              return (
                <button
                  key={option.label}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  disabled={disabled}
                  onClick={() => setPaid(option.value)}
                  className={cn(
                    'inline-flex h-9 items-center gap-1.5 rounded-lg px-4 text-sm font-semibold transition-all',
                    selected
                      ? option.value
                        ? 'bg-emerald-600 text-white shadow-xs'
                        : 'bg-white text-ink-900 shadow-xs ring-1 ring-ink-200'
                      : 'text-ink-600 hover:text-ink-900',
                    disabled && 'cursor-not-allowed opacity-50 hover:text-ink-600',
                  )}
                >
                  {option.value ? (
                    <CheckIcon className="size-3.5" />
                  ) : (
                    <span className="size-2 rounded-full border border-current" />
                  )}
                  {option.label}
                </button>
              );
            })}
          </div>
          {!feeKnown ? (
            <span className="mt-1 block text-xs text-ink-500">
              No consultation fee is set for {doctorName} yet, so this visit is added as unpaid.
            </span>
          ) : null}
        </div>
      ) : null}

      <label className="flex items-start gap-2.5 text-sm text-ink-700 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={whatsappOptIn}
          onChange={(e) => setWhatsappOptIn(e.target.checked)}
          className="mt-0.5 size-4 rounded border-ink-300 text-brand-600 focus:ring-brand-600"
        />
        <span>
          Patient agreed to WhatsApp updates
          <span className="mt-0.5 block text-xs text-ink-500">
            Untick if they said no. They still get a token and QR code.
          </span>
        </span>
      </label>

      {full || quotaReached ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          <p className="font-semibold">Today&apos;s token quota for {doctorName} is full.</p>
          {offerExtra ? (
            <label className="mt-2 flex items-start gap-2.5 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={extra}
                onChange={(e) => setExtra(e.target.checked)}
                className="mt-0.5 size-4 rounded border-amber-300 text-amber-600 focus:ring-amber-600"
              />
              <span>
                Issue an extra token
                <span className="mt-0.5 block text-xs text-amber-800">
                  For an emergency or a patient who must be seen today. It continues the token
                  sequence; no existing token changes. Recorded in the audit log.
                </span>
              </span>
            </label>
          ) : (
            <p className="mt-1 text-xs">Only the owner can issue an extra token.</p>
          )}
        </div>
      ) : null}

      <Button
        type="submit"
        variant="primary"
        size="lg"
        className="w-full"
        isLoading={isPending}
      >
        <UserPlusIcon className="size-4 mr-1.5" />
        {isPending ? 'Adding Walk-in...' : offerExtra && extra ? 'Issue extra token' : 'Add to queue'}
      </Button>
    </form>
  );
}

export function CallNextButton({
  doctorId,
  disabled,
  label = 'Call next patient',
  size = 'xl',
}: {
  doctorId: string;
  disabled: boolean;
  label?: string;
  size?: 'md' | 'lg' | 'xl';
}) {
  const toast = useToast();
  const gate = useConsultationGate();
  const [isPending, startTransition] = useTransition();

  const handleCallNext = () => {
    startTransition(async () => {
      // In the doctor view, an unsaved consultation is saved first. If that
      // fails the queue stays put, and the panel says why.
      if (gate && !(await gate.run())) return;
      playChime();
      const res = await advanceQueueDynamic({ doctorId });
      if (res.ok && res.noArrivedPatient) {
        // Nobody present is waiting. Booked patients who have not arrived are
        // never called, and pressing Next does not count as them arriving.
        toast.info('No arrived patients are currently available.', 'Patients appear here once they check in.');
      } else if (res.ok) {
        toast.success('Queue Advanced', res.called ? 'Next patient called successfully.' : 'Consultation completed.');
      } else {
        toast.error('Failed to call next patient', res.error);
      }
    });
  };

  return (
    <Button
      type="button"
      variant="primary"
      size={size}
      onClick={handleCallNext}
      disabled={disabled || isPending}
      isLoading={isPending}
    >
      {isPending ? 'Calling...' : label}
    </Button>
  );
}

export function ViewModeToggle({
  currentView,
  doctorId,
}: {
  currentView: 'doctor' | 'reception';
  doctorId?: string | null;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const handleSwitch = (view: 'doctor' | 'reception') => {
    if (view === currentView) return;
    startTransition(() => {
      const query = new URLSearchParams();
      query.set('view', view);
      if (doctorId) query.set('doctor', doctorId);
      router.push(`/dashboard?${query.toString()}`);
    });
  };

  return (
    <div className="inline-flex items-center rounded-xl bg-ink-100 p-1 border border-ink-200">
      <button
        type="button"
        onClick={() => handleSwitch('doctor')}
        disabled={isPending}
        className={cn(
          'flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-all cursor-pointer select-none',
          currentView === 'doctor'
            ? 'bg-white text-ink-900 shadow-xs ring-1 ring-ink-200'
            : 'text-ink-600 hover:text-ink-900',
        )}
      >
        <StethoscopeIcon className="size-3.5 text-brand-600" />
        <span>Doctor View</span>
      </button>
      <button
        type="button"
        onClick={() => handleSwitch('reception')}
        disabled={isPending}
        className={cn(
          'flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-all cursor-pointer select-none',
          currentView === 'reception'
            ? 'bg-white text-ink-900 shadow-xs ring-1 ring-ink-200'
            : 'text-ink-600 hover:text-ink-900',
        )}
      >
        <FileTextIcon className="size-3.5 text-brand-600" />
        <span>Reception Desk</span>
      </button>
    </div>
  );
}

const ACTION_TONES: Partial<Record<QueueAction, string>> = {
  hold:
    'bg-amber-50 text-amber-900 ring-1 ring-inset ring-amber-300 ' +
    'hover:bg-amber-100 active:bg-amber-200 focus-visible:outline-amber-600',
  resume:
    'bg-emerald-50 text-emerald-900 ring-1 ring-inset ring-emerald-300 ' +
    'hover:bg-emerald-100 active:bg-emerald-200 focus-visible:outline-emerald-600',
  skip:
    'bg-sky-50 text-sky-900 ring-1 ring-inset ring-sky-300 ' +
    'hover:bg-sky-100 active:bg-sky-200 focus-visible:outline-sky-600',
  recall:
    'bg-sky-50 text-sky-900 ring-1 ring-inset ring-sky-300 ' +
    'hover:bg-sky-100 active:bg-sky-200 focus-visible:outline-sky-600',
  cancel:
    'bg-rose-50 text-rose-800 ring-1 ring-inset ring-rose-300 ' +
    'hover:bg-rose-100 active:bg-rose-200 focus-visible:outline-rose-600',
  mark_no_show:
    'bg-red-600 text-white ring-1 ring-inset ring-red-700 ' +
    'hover:bg-red-700 active:bg-red-800 focus-visible:outline-red-700',
};

export function QueueActionButton({
  doctorId,
  appointmentId,
  action,
  label,
  size = 'lg',
  variant = 'secondary',
  className,
}: {
  doctorId: string;
  appointmentId: string;
  action: QueueAction;
  label: string;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  className?: string;
}) {
  const toast = useToast();
  const [isPending, startTransition] = useTransition();

  const handleAction = () => {
    if (action === 'call' || action === 'recall') {
      playChime();
    }
    startTransition(async () => {
      const res = await queueActionDynamic({ doctorId, appointmentId, action });
      if (res.ok) {
        toast.info(`Status Updated: ${label}`);
      } else {
        toast.error(`Failed: ${label}`, res.error);
      }
    });
  };

  const tone = ACTION_TONES[action];

  return (
    <Button
      type="button"
      size={size}
      variant={tone ? 'ghost' : variant}
      onClick={handleAction}
      isLoading={isPending}
      className={cn(tone, className)}
    >
      {action === 'mark_no_show' ? (
        <XIcon className="size-3.5" />
      ) : null}
      {label}
    </Button>
  );
}

export function PriorityButton({
  doctorId,
  appointmentId,
}: {
  doctorId: string;
  appointmentId: string;
}) {
  const toast = useToast();
  const [isPending, startTransition] = useTransition();

  const handlePriority = () => {
    startTransition(async () => {
      const res = await setPriorityDynamic({ doctorId, appointmentId, priority: 10 });
      if (res.ok) {
        toast.success('Moved to Front', 'Patient assigned priority status.');
      } else {
        toast.error('Priority update failed', res.error);
      }
    });
  };

  return (
    <Button
      type="button"
      size="sm"
      title="Move to the front of the waiting line"
      onClick={handlePriority}
      isLoading={isPending}
      className="inline-flex items-center gap-1 bg-amber-50 text-amber-900 border border-amber-200 hover:bg-amber-100"
    >
      <ZapIcon className="size-3 text-amber-600" />
      Priority
    </Button>
  );
}

export function TogglePauseButton({
  doctorId,
  paused,
}: {
  doctorId: string;
  paused: boolean;
}) {
  const toast = useToast();
  const [isPending, startTransition] = useTransition();

  const handleTogglePause = () => {
    startTransition(async () => {
      const res = await togglePauseDynamic({ doctorId, paused: !paused });
      if (res.ok) {
        toast.info(
          paused ? 'Break ended' : 'Break started',
          paused ? undefined : 'Patients now see that the doctor is on a break.',
        );
      } else {
        toast.error('Pause operation failed', res.error);
      }
    });
  };

  return (
    <Button
      type="button"
      size="sm"
      title={
        paused
          ? 'Doctor is back: the queue moves again'
          : 'Doctor is stepping out: patients see a break notice'
      }
      onClick={handleTogglePause}
      isLoading={isPending}
      className="inline-flex items-center gap-1.5"
    >
      <PauseIcon className="size-3.5 text-amber-600" />
      {paused ? 'End break' : 'Start break'}
    </Button>
  );
}

/**
 * Start OPD until the doctor's session has begun, then the Break toggle.
 *
 * Start OPD is the only thing that records the session start: calling a
 * patient early, or ending a break, never does.
 */
export function SessionControl({
  doctorId,
  started,
  paused,
}: {
  doctorId: string;
  started: boolean;
  paused: boolean;
}) {
  const toast = useToast();
  const [isPending, startTransition] = useTransition();

  if (started) return <TogglePauseButton doctorId={doctorId} paused={paused} />;

  const handleStart = () => {
    startTransition(async () => {
      const res = await startSessionDynamic({ doctorId });
      if (res.ok) {
        toast.success(
          'OPD started',
          res.delayMinutes ? `Started ${res.delayMinutes} min after the scheduled time.` : 'Patient estimates now follow the live queue.',
        );
      } else {
        toast.error('Could not start OPD', res.error);
      }
    });
  };

  return (
    <Button
      type="button"
      size="sm"
      variant="primary"
      title="The doctor has begun seeing patients"
      onClick={handleStart}
      isLoading={isPending}
      className="inline-flex items-center gap-1.5"
    >
      <StethoscopeIcon className="size-3.5" />
      Start OPD
    </Button>
  );
}

/**
 * For the patient who reached the desk without tapping "I've Arrived". Small
 * and inline on purpose: the normal desk flow is just Next.
 */
export function MarkArrivedButton({ doctorId, appointmentId }: { doctorId: string; appointmentId: string }) {
  const toast = useToast();
  const [isPending, startTransition] = useTransition();
  return (
    <button
      type="button"
      disabled={isPending}
      onClick={() =>
        startTransition(async () => {
          const res = await markArrivedDynamic({ doctorId, appointmentId });
          if (res.ok) {
            toast.success(
              'Marked arrived',
              res.late ? 'Their turn had passed, so they join after the next patients present.' : undefined,
            );
          } else {
            toast.error('Could not mark arrived', res.error);
          }
        })
      }
      className="ml-1 font-semibold text-brand-700 underline underline-offset-2 hover:text-brand-900 disabled:opacity-50"
    >
      {isPending ? 'Marking…' : 'Mark arrived'}
    </button>
  );
}

/** Owner: hand unused reserved walk-in capacity to online bookings for today. */
export function ReleaseReservedButton({ doctorId, count }: { doctorId: string; count: number }) {
  const toast = useToast();
  const [isPending, startTransition] = useTransition();
  return (
    <Button
      type="button"
      size="sm"
      isLoading={isPending}
      onClick={() =>
        startTransition(async () => {
          const res = await releaseReservedDynamic({ doctorId });
          if (res.ok) toast.success('Released', `${count} unused walk-in place${count === 1 ? '' : 's'} opened to online booking.`);
          else toast.error('Could not release', res.error);
        })
      }
    >
      Release {count} to online
    </Button>
  );
}

export function PausePatientButton({
  doctorId,
  appointmentId,
  patientName,
  tokenNumber,
  size = 'md',
}: {
  doctorId: string;
  appointmentId: string;
  patientName?: string;
  tokenNumber?: number;
  size?: 'sm' | 'md' | 'lg';
}) {
  const toast = useToast();
  const [isOpen, setIsOpen] = useState(false);
  const [minutes, setMinutes] = useState<number | null>(15);
  const [reason, setReason] = useState('Stepped out / Test');
  const [isPending, startTransition] = useTransition();

  const handlePause = (e: React.FormEvent) => {
    e.preventDefault();
    startTransition(async () => {
      const res = await pauseAppointmentDynamic({
        doctorId,
        appointmentId,
        resumeAfterMinutes: minutes,
        reason,
      });

      if (res.ok) {
        toast.info(
          `Token #${tokenNumber ?? ''} Paused`,
          `${patientName ?? 'Patient'} placed on hold${minutes ? ` for ${minutes} mins` : ''}.`,
        );
        setIsOpen(false);
      } else {
        toast.error('Failed to pause patient', res.error);
      }
    });
  };

  return (
    <>
      <Button
        type="button"
        size={size}
        variant="ghost"
        onClick={() => setIsOpen(true)}
        className="bg-amber-50 text-amber-900 ring-1 ring-inset ring-amber-300 hover:bg-amber-100 font-medium inline-flex items-center gap-1.5"
      >
        <PauseIcon className="size-3.5 text-amber-700" />
        Pause / Hold
      </Button>

      {isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 animate-in fade-in duration-200">
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl ring-1 ring-black/10">
            <div className="flex items-center justify-between border-b border-ink-100 pb-3">
              <h3 className="text-base font-bold text-ink-900">
                Pause Patient {tokenNumber ? `(#${tokenNumber})` : ''}
              </h3>
              <button
                type="button"
                onClick={() => setIsOpen(false)}
                className="rounded-lg p-1 text-ink-400 hover:bg-ink-100 hover:text-ink-700 cursor-pointer"
              >
                <XIcon className="size-4" />
              </button>
            </div>

            <form onSubmit={handlePause} className="mt-4 space-y-4">
              <p className="text-xs text-ink-600">
                Temporarily removes <strong className="text-ink-900">{patientName ?? 'patient'}</strong> from the active calling queue while keeping their token and place.
              </p>

              <Field label="Auto-resume timer" hint="The appointment will automatically return to the queue when the timer expires.">
                <div className="grid grid-cols-3 gap-2">
                  {[
                    { label: '10 mins', val: 10 },
                    { label: '15 mins', val: 15 },
                    { label: '30 mins', val: 30 },
                    { label: '45 mins', val: 45 },
                    { label: '60 mins', val: 60 },
                    { label: 'Manual', val: null },
                  ].map((opt) => (
                    <button
                      key={String(opt.val)}
                      type="button"
                      onClick={() => setMinutes(opt.val)}
                      className={cn(
                        'rounded-lg px-2.5 py-2 text-xs font-semibold ring-1 transition-all cursor-pointer',
                        minutes === opt.val
                          ? 'bg-amber-500 text-white ring-amber-500 shadow-sm'
                          : 'bg-ink-50 text-ink-700 ring-ink-200 hover:bg-ink-100',
                      )}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </Field>

              <Field label="Reason (Optional)">
                <Input
                  type="text"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="e.g. Blood test, X-Ray, Stepped out"
                />
              </Field>

              <div className="flex justify-end gap-2 pt-2 border-t border-ink-100">
                <Button
                  type="button"
                  variant="secondary"
                  size="md"
                  onClick={() => setIsOpen(false)}
                  disabled={isPending}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  variant="primary"
                  size="md"
                  isLoading={isPending}
                  className="bg-amber-600 hover:bg-amber-700 focus-visible:outline-amber-600"
                >
                  Confirm Pause
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}

export function ResumePatientButton({
  doctorId,
  appointmentId,
  patientName,
  tokenNumber,
  size = 'sm',
}: {
  doctorId: string;
  appointmentId: string;
  patientName?: string;
  tokenNumber?: number;
  size?: 'sm' | 'md' | 'lg';
}) {
  const toast = useToast();
  const [isPending, startTransition] = useTransition();

  const handleResume = () => {
    startTransition(async () => {
      const res = await resumeAppointmentDynamic({ doctorId, appointmentId });
      if (res.ok) {
        toast.success(
          `Token #${tokenNumber ?? ''} Resumed!`,
          `${patientName ?? 'Patient'} rejoined the waiting line.`,
        );
      } else {
        toast.error('Failed to resume patient', res.error);
      }
    });
  };

  return (
    <Button
      type="button"
      size={size}
      variant="ghost"
      onClick={handleResume}
      isLoading={isPending}
      className="bg-emerald-50 text-emerald-900 ring-1 ring-inset ring-emerald-300 hover:bg-emerald-100 font-medium inline-flex items-center gap-1.5"
    >
      <CheckIcon className="size-3.5 text-emerald-700" />
      Resume
    </Button>
  );
}

/**
 * Mobile-First Segmented Dashboard Layout for Receptionist & Owner View
 *
 * On mobile (< lg): Provides clean sticky tabs (Live Queue | Add Walk-In | Overview)
 * so staff can add a patient in 1 tap with zero vertical scrolling.
 * On desktop (>= lg): Displays the full multi-column layout side-by-side.
 */
export function ReceptionDashboardLayout({
  waitingCount,
  queueContent,
  addContent,
  overviewContent,
}: {
  waitingCount: number;
  queueContent: React.ReactNode;
  addContent: React.ReactNode;
  overviewContent: React.ReactNode;
}) {
  const [activeTab, setActiveTab] = useState<'queue' | 'add' | 'overview'>('queue');

  return (
    <div>
      {/* Mobile Sticky Segmented Controller (< lg) */}
      <div className="lg:hidden sticky top-2 z-30 mb-4 grid grid-cols-3 gap-1 rounded-2xl bg-white/95 p-1.5 border border-ink-200 shadow-md backdrop-blur-md">
        <button
          type="button"
          onClick={() => setActiveTab('queue')}
          className={cn(
            'flex items-center justify-center gap-1.5 rounded-xl py-2 px-1 text-xs font-bold transition-all cursor-pointer select-none',
            activeTab === 'queue'
              ? 'bg-brand-600 text-white shadow-sm'
              : 'text-ink-600 hover:text-ink-900 hover:bg-ink-50',
          )}
        >
          <FileTextIcon className="size-3.5 shrink-0" />
          <span className="truncate">Queue ({waitingCount})</span>
        </button>

        <button
          type="button"
          onClick={() => setActiveTab('add')}
          className={cn(
            'flex items-center justify-center gap-1.5 rounded-xl py-2 px-1 text-xs font-bold transition-all cursor-pointer select-none',
            activeTab === 'add'
              ? 'bg-brand-600 text-white shadow-sm'
              : 'text-ink-600 hover:text-ink-900 hover:bg-ink-50',
          )}
        >
          <UserPlusIcon className="size-3.5 shrink-0" />
          <span className="truncate">Add Walk-In</span>
        </button>

        <button
          type="button"
          onClick={() => setActiveTab('overview')}
          className={cn(
            'flex items-center justify-center gap-1.5 rounded-xl py-2 px-1 text-xs font-bold transition-all cursor-pointer select-none',
            activeTab === 'overview'
              ? 'bg-brand-600 text-white shadow-sm'
              : 'text-ink-600 hover:text-ink-900 hover:bg-ink-50',
          )}
        >
          <BarChartIcon className="size-3.5 shrink-0" />
          <span className="truncate">Overview</span>
        </button>
      </div>

      {/* Desktop Layout: Multi-column 3 cols side-by-side */}
      <div className="hidden lg:grid items-start gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">{queueContent}</div>
        <div className="space-y-5">
          {addContent}
          {overviewContent}
        </div>
      </div>

      {/* Mobile Layout: Only show active tab */}
      <div className="lg:hidden space-y-5">
        {activeTab === 'queue' && queueContent}
        {activeTab === 'add' && addContent}
        {activeTab === 'overview' && (
          <>
            {addContent}
            {overviewContent}
          </>
        )}
      </div>
    </div>
  );
}
