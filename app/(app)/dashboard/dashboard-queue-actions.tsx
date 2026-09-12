'use client';

import React, { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Field, Input, cn } from '@/components/ui';
import { useToast } from '@/components/toast';
import type { QueueAction } from '@/lib/domain/types';
import {
  addWalkInDynamic,
  advanceQueueDynamic,
  queueActionDynamic,
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
}: {
  doctorId: string;
  branchId: string;
}) {
  const router = useRouter();
  const toast = useToast();

  const [name, setName] = useState('');
  const [age, setAge] = useState('');
  const [phone, setPhone] = useState('');
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
        whatsappOptIn,
      });

      if (res.ok) {
        toast.success(
          `Token #${res.tokenNumber} Created!`,
          `${name.trim()}${parsedAge ? ` (${parsedAge}y)` : ''} added to the queue successfully.`,
        );
        setName('');
        setAge('');
        setPhone('');
        router.refresh();
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
}: {
  doctorId: string;
  disabled: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [isPending, startTransition] = useTransition();

  const handleCallNext = () => {
    startTransition(async () => {
      const res = await advanceQueueDynamic({ doctorId });
      if (res.ok) {
        toast.success('Next Patient Called', 'Queue advanced to next patient.');
        router.refresh();
      } else {
        toast.error('Failed to call next patient', res.error);
      }
    });
  };

  return (
    <Button
      type="button"
      variant="primary"
      size="xl"
      onClick={handleCallNext}
      disabled={disabled || isPending}
      isLoading={isPending}
    >
      {isPending ? 'Calling...' : 'Call next patient'}
    </Button>
  );
}

export function QueueActionButton({
  doctorId,
  appointmentId,
  action,
  label,
  size = 'lg',
  variant = 'secondary',
}: {
  doctorId: string;
  appointmentId: string;
  action: QueueAction;
  label: string;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
}) {
  const router = useRouter();
  const toast = useToast();
  const [isPending, startTransition] = useTransition();

  const handleAction = () => {
    startTransition(async () => {
      const res = await queueActionDynamic({ doctorId, appointmentId, action });
      if (res.ok) {
        toast.info(`Status Updated: ${label}`);
        router.refresh();
      } else {
        toast.error(`Failed: ${label}`, res.error);
      }
    });
  };

  return (
    <Button
      type="button"
      size={size}
      variant={variant}
      onClick={handleAction}
      isLoading={isPending}
    >
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
  const router = useRouter();
  const toast = useToast();
  const [isPending, startTransition] = useTransition();

  const handlePriority = () => {
    startTransition(async () => {
      const res = await setPriorityDynamic({ doctorId, appointmentId, priority: 10 });
      if (res.ok) {
        toast.success('Moved to Front', 'Patient assigned priority status.');
        router.refresh();
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
  const router = useRouter();
  const toast = useToast();
  const [isPending, startTransition] = useTransition();

  const handleTogglePause = () => {
    startTransition(async () => {
      const res = await togglePauseDynamic({ doctorId, paused: !paused });
      if (res.ok) {
        toast.info(paused ? 'Queue Resumed' : 'Queue Paused');
        router.refresh();
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
