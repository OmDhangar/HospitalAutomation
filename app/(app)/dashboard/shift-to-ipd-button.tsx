'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button, cn } from '@/components/ui';
import { BedIcon } from '@/components/icons';
import { useToast } from '@/components/toast';
import { shiftToIpdDynamic, undoShiftToIpdDynamic } from './ipd-actions';

/** How long the Undo in the toast is offered; the server allows ten minutes. */
const UNDO_TOAST_MS = 10_000;

/**
 * The doctor's one-click Shift to IPD (IPD plan §5.1). No dialog, no form:
 * the desk does the paperwork. A mis-tap is undone from the toast.
 */
export function ShiftToIpdButton({
  appointmentId,
  size = 'md',
  compact = false,
}: {
  appointmentId: string;
  size?: 'sm' | 'md';
  /** On a Seen-today row: a small button that fits beside the Paid pill. */
  compact?: boolean;
}) {
  const toast = useToast();
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [shifted, setShifted] = useState(false);

  const undo = (admissionId: string) => {
    startTransition(async () => {
      const res = await undoShiftToIpdDynamic({ admissionId });
      if (res.ok) {
        setShifted(false);
        toast.info('Shift to IPD undone');
        router.refresh();
      } else {
        toast.error('Could not undo', res.error);
      }
    });
  };

  const shift = () => {
    startTransition(async () => {
      const res = await shiftToIpdDynamic({ appointmentId });
      if (!res.ok) {
        toast.error('Could not shift to IPD', res.error);
        return;
      }
      setShifted(true);
      toast.showToast(`${res.patientName} shifted to IPD — awaiting bed.`, {
        type: 'success',
        description: res.created ? 'Reception will assign the bed.' : 'Already on the Awaiting bed list.',
        action: res.created ? { label: 'Undo', onClick: () => undo(res.admissionId) } : undefined,
        durationMs: res.created ? UNDO_TOAST_MS : 4000,
      });
      router.refresh();
    });
  };

  if (shifted) return <IpdBadge />;

  return (
    <Button
      type="button"
      size={compact ? 'sm' : size}
      variant="secondary"
      onClick={shift}
      isLoading={isPending}
      className={cn('inline-flex items-center gap-1.5', compact && 'min-h-9')}
      aria-label="Shift to IPD"
    >
      {isPending ? null : <BedIcon className="size-4 text-brand-700" />}
      {compact ? 'IPD' : 'Shift to IPD'}
    </Button>
  );
}

/** Shown in place of the button once the patient is on the IPD side. */
export function IpdBadge({ label = 'awaiting bed' }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-brand-50 px-2.5 py-1 text-xs font-semibold text-brand-800 ring-1 ring-inset ring-brand-200">
      <BedIcon className="size-3.5" />
      IPD · {label}
    </span>
  );
}
