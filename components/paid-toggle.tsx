'use client';

import React, { useOptimistic, useState, useTransition } from 'react';
import { togglePaidDynamic } from '@/app/(app)/dashboard/actions';
import { Button, Field, Input, cn } from '@/components/ui';
import { useToast } from '@/components/toast';
import type { PaymentStatus } from '@/lib/domain/patient-billing';

/**
 * Glyph and word, never colour alone, and never red: red means "permanent" in
 * this interface, and an unpaid patient is the normal state of a queue, not an
 * error.
 */
const STYLES: Record<PaymentStatus, { label: string; glyph: string; className: string }> = {
  unpaid: {
    label: 'Unpaid',
    glyph: '○',
    className: 'bg-amber-50 text-amber-900 ring-amber-300',
  },
  partial: {
    label: 'Part paid',
    glyph: '◐',
    className: 'bg-sky-50 text-sky-900 ring-sky-300',
  },
  paid: {
    label: 'Paid',
    glyph: '✓',
    className: 'bg-emerald-50 text-emerald-900 ring-emerald-300',
  },
};

function PillFace({ status }: { status: PaymentStatus }) {
  const style = STYLES[status];
  return (
    <>
      <span aria-hidden="true">{style.glyph}</span>
      {style.label}
    </>
  );
}

/**
 * The payment pill on a queue row.
 *
 * One tap flips it, and the flip shows immediately rather than after the
 * round trip: this is the most frequent tap at the desk, and a spinner on
 * every one of them is what makes software feel slow. If the server refuses,
 * the pill flips back and a toast says why.
 *
 * Read-only for anyone who cannot take money (the doctor sees it, so they
 * need not ask reception, but cannot change it).
 */
export function PaidToggle({
  appointmentId,
  tokenNumber,
  status,
  readOnly = false,
  feeKnown,
  canSetFee,
  doctorName,
}: {
  appointmentId: string;
  tokenNumber: number;
  status: PaymentStatus;
  readOnly?: boolean;
  /** Whether the doctor has a consultation fee. Without one, Paid has nothing to charge. */
  feeKnown: boolean;
  /** Owners may set the missing fee from here; reception is sent to the owner. */
  canSetFee: boolean;
  doctorName: string;
}) {
  const toast = useToast();
  const [isPending, startTransition] = useTransition();
  const [shown, setShown] = useOptimistic(status);
  const [askingFee, setAskingFee] = useState(false);

  const baseClass = cn(
    'inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full px-3 text-xs font-bold ring-1 ring-inset',
    STYLES[shown].className,
  );

  if (readOnly) {
    return (
      <span className={baseClass} title="Payment status (reception updates this)">
        <PillFace status={shown} />
      </span>
    );
  }

  const submit = (paid: boolean, feeRupees?: string) => {
    startTransition(async () => {
      setShown(paid ? 'paid' : 'unpaid');
      const res = await togglePaidDynamic({ appointmentId, paid, feeRupees });
      if (res.ok) {
        setAskingFee(false);
        toast.success(paid ? `Marked paid (#${tokenNumber})` : `Marked unpaid (#${tokenNumber})`);
      } else if (res.code === 'fee_missing' && canSetFee) {
        setAskingFee(true);
      } else {
        toast.error('Payment not updated', res.error);
      }
    });
  };

  const handleTap = () => {
    // Part paid settles the rest; paid goes back to unpaid.
    const markPaid = shown !== 'paid';
    if (markPaid && !feeKnown) {
      if (canSetFee) setAskingFee(true);
      else toast.error('No fee set', `Ask the owner to set ${doctorName}'s consultation fee in Settings.`);
      return;
    }
    submit(markPaid);
  };

  return (
    <>
      <button
        type="button"
        onClick={handleTap}
        disabled={isPending}
        aria-label={`Payment: ${STYLES[shown].label}. Tap to mark ${shown === 'paid' ? 'unpaid' : 'paid'}.`}
        className={cn(baseClass, 'cursor-pointer transition-colors hover:brightness-95 disabled:cursor-wait')}
      >
        <PillFace status={shown} />
      </button>

      {askingFee ? (
        <FeePrompt
          doctorName={doctorName}
          isPending={isPending}
          onCancel={() => setAskingFee(false)}
          onSubmit={(feeRupees) => submit(true, feeRupees)}
        />
      ) : null}
    </>
  );
}

/** Asked once per doctor, the first time an owner marks one of their patients paid. */
function FeePrompt({
  doctorName,
  isPending,
  onCancel,
  onSubmit,
}: {
  doctorName: string;
  isPending: boolean;
  onCancel: () => void;
  onSubmit: (feeRupees: string) => void;
}) {
  const [fee, setFee] = useState('');

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-2xl ring-1 ring-black/10">
        <h3 className="text-base font-bold text-ink-900">Consultation fee for {doctorName}</h3>
        <p className="mt-1 text-xs text-ink-600">
          Set once. Every patient of this doctor is charged this fee when marked paid. You can
          change it later in Settings.
        </p>
        <form
          className="mt-4 space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit(fee);
          }}
        >
          <Field label="Fee (₹)">
            <Input
              type="text"
              inputMode="decimal"
              value={fee}
              onChange={(e) => setFee(e.target.value)}
              placeholder="300"
              autoFocus
              required
            />
          </Field>
          <div className="flex justify-end gap-2 border-t border-ink-100 pt-3">
            <Button type="button" variant="secondary" size="md" onClick={onCancel} disabled={isPending}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" size="md" isLoading={isPending}>
              Save fee & mark paid
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
