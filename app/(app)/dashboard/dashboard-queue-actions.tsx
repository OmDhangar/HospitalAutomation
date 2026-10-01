'use client';

import React, { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Field, Input, cn } from '@/components/ui';
import { useConsultationGate } from '@/components/clinical/consultation-gate';
import { useToast } from '@/components/toast';
import { playChime } from '@/lib/utils/sound';
import type { QueueAction } from '@/lib/domain/types';
import {
  addWalkInDynamic,
  advanceQueueDynamic,
  pauseAppointmentDynamic,
  queueActionDynamic,
  resumeAppointmentDynamic,
  setPriorityDynamic,
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
              'shrink-0 inline-flex items-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium transition-all cursor-pointer select-none',
              isSelected
                ? 'bg-brand-600 text-white shadow-sm ring-2 ring-brand-600'
                : 'bg-white text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-50',
              isPending && !isSelected && 'opacity-60 cursor-not-allowed',
            )}
          >
            {isLoadingThis ? (
              <span className="inline-block size-3.5 animate-spin rounded-full border-2 border-white border-t-transparent" />
            ) : null}
            <span>{doctor.name}</span>
            {doctor.specialty ? (
              <span
                className={cn(
                  'text-xs',
                  isSelected ? 'text-brand-100' : 'text-ink-500',
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
}: {
  doctorId: string;
  branchId: string;
  doctorName: string;
  /** Whether this user may take money; otherwise the Paid choice is not offered. */
  canCollect: boolean;
  /** Without a consultation fee there is nothing to charge, so Paid is disabled. */
  feeKnown: boolean;
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
        // Ready for the next person in line without reaching for the mouse.
        nameRef.current?.focus();
      } else {
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

      <Field label="Mobile number" hint="10 digits. The queue link goes here.">
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

      {/*
       * After the phone, so the common case — name, phone, Enter — never has
       * to pass through it. Optional: many patients will not have it handy.
       */}
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
              { value: false, label: 'Unpaid', glyph: '○' },
              { value: true, label: 'Paid', glyph: '✓' },
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
                  <span aria-hidden="true">{option.glyph}</span>
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

      <Button
        type="submit"
        variant="primary"
        size="lg"
        className="w-full"
        isLoading={isPending}
      >
        {isPending ? 'Adding Walk-in...' : 'Add to queue'}
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
      if (res.ok) {
        toast.success('Queue Advanced', 'Next patient called successfully.');
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
        <span>🩺</span>
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
        <span>📋</span>
        <span>Reception Desk</span>
      </button>
    </div>
  );
}

/**
 * Colour carries the meaning, because the word may not.
 *
 * Reception is often run by someone whose English is limited and who is
 * working fast with a queue of people in front of them. Reading "Skip" and
 * "Cancel" under pressure and picking correctly is a demand the interface can
 * remove: the two are never confused when one is amber and the other is red.
 *
 * The scale is consequence, not category — how hard the action is to undo:
 *
 *   slate   start/resume   routine, reversible
 *   amber   hold           paused, the patient keeps their place
 *   blue    skip · recall  reorders the queue, fully reversible
 *   rose    cancel         ends the appointment, messages the patient
 *   red     no-show        ends it and records a permanent absence
 *
 * Colour is never the only signal: each button keeps its label, so nothing
 * here depends on distinguishing red from amber. That matters for the roughly
 * one in twelve Indian men with red-green colour blindness.
 */
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

/**
 * A shape for each action, for when colour alone will not do.
 *
 * Printed, photocopied, on a sun-bleached monitor, or read by someone who
 * cannot separate the reds from the ambers — the glyph still distinguishes
 * them. Chosen to be legible at a glance rather than decorative.
 */
const ACTION_GLYPHS: Partial<Record<QueueAction, string>> = {
  hold: '⏸',
  resume: '▶',
  skip: '⤼',
  recall: '↩',
  cancel: '✕',
  mark_no_show: '⊘',
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
  const glyph = ACTION_GLYPHS[action];

  return (
    <Button
      type="button"
      size={size}
      // A toned action supplies its own colours, so the base variant would
      // otherwise fight them. Anything without a tone keeps the default.
      variant={tone ? 'ghost' : variant}
      onClick={handleAction}
      isLoading={isPending}
      className={cn(tone, className)}
    >
      {glyph && !isPending ? (
        <span aria-hidden="true" className="text-base leading-none">
          {glyph}
        </span>
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
    >
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
        toast.info(paused ? 'Queue Resumed' : 'Queue Paused');
      } else {
        toast.error('Pause operation failed', res.error);
      }
    });
  };

  return (
    <Button
      type="button"
      size="sm"
      onClick={handleTogglePause}
      isLoading={isPending}
    >
      {paused ? 'Resume queue' : 'Pause queue'}
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
        className="bg-amber-50 text-amber-900 ring-1 ring-inset ring-amber-300 hover:bg-amber-100 font-medium"
      >
        <span aria-hidden="true">⏸</span>
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
                className="rounded-lg p-1 text-ink-400 hover:bg-ink-100 hover:text-ink-700"
              >
                ✕
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
                        'rounded-lg px-2.5 py-2 text-xs font-semibold ring-1 transition-all',
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
      className="bg-emerald-50 text-emerald-900 ring-1 ring-inset ring-emerald-300 hover:bg-emerald-100 font-medium"
    >
      <span aria-hidden="true">▶</span>
      Resume
    </Button>
  );
}
