'use client';

import React, { useOptimistic, useState, useTransition } from 'react';
import { togglePaidDynamic } from '@/app/(app)/dashboard/actions';
import { CheckIcon, XIcon } from '@/components/icons';
import { Button, Field, Input, cn } from '@/components/ui';
import { useToast } from '@/components/toast';
import type { PaymentStatus } from '@/lib/domain/patient-billing';

/**
 * Glyph and word, never colour alone, and never red: red means "permanent" in
 * this interface, and an unpaid patient is the normal state of a queue, not an
 * error.
 */
const STYLES: Record<PaymentStatus, { label: string; className: string }> = {
  unpaid: {
    label: 'Unpaid',
    className: 'bg-amber-50 text-amber-900 ring-amber-300',
  },
  partial: {
    label: 'Part paid',
    className: 'bg-sky-50 text-sky-900 ring-sky-300',
  },
  paid: {
    label: 'Paid',
    className: 'bg-emerald-50 text-emerald-900 ring-emerald-300',
  },
};

function PillFace({ status }: { status: PaymentStatus }) {
  const style = STYLES[status];
  return (
    <>
      <span aria-hidden="true" className="inline-flex items-center">
        {status === 'paid' ? (
          <CheckIcon className="size-3.5" />
        ) : status === 'partial' ? (
          '◐'
        ) : (
          '○'
        )}
      </span>
      <span>{style.label}</span>
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
  const [editingPayment, setEditingPayment] = useState(false);

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

  const submit = (args: {
    paid: boolean;
    feeRupees?: string;
    reason?: string;
    waiveCharges?: boolean;
  }) => {
    startTransition(async () => {
      setShown(args.paid ? 'paid' : 'unpaid');
      const res = await togglePaidDynamic({
        appointmentId,
        paid: args.paid,
        feeRupees: args.feeRupees,
        reason: args.reason,
        waiveCharges: args.waiveCharges,
      });
      if (res.ok) {
        setAskingFee(false);
        setEditingPayment(false);
        toast.success(
          args.paid
            ? `Marked paid (#${tokenNumber})`
            : args.reason
              ? `Refund / Status updated (#${tokenNumber})`
              : `Marked unpaid (#${tokenNumber})`,
        );
      } else if (res.code === 'fee_missing' && canSetFee) {
        setAskingFee(true);
      } else {
        toast.error('Payment not updated', res.error);
      }
    });
  };

  const handleTap = () => {
    if (shown === 'paid' || shown === 'partial') {
      // Open quick modal to allow refund / return money / scheme waiver or simple mark unpaid
      setEditingPayment(true);
      return;
    }

    if (!feeKnown) {
      if (canSetFee) setAskingFee(true);
      else toast.error('No fee set', `Ask the owner to set ${doctorName}'s consultation fee in Settings.`);
      return;
    }

    submit({ paid: true });
  };

  return (
    <>
      <button
        type="button"
        onClick={handleTap}
        disabled={isPending}
        aria-label={`Payment: ${STYLES[shown].label}. Tap to edit or update payment.`}
        className={cn(baseClass, 'cursor-pointer transition-colors hover:brightness-95 disabled:cursor-wait')}
      >
        <PillFace status={shown} />
      </button>

      {editingPayment ? (
        <ReturnRefundModal
          tokenNumber={tokenNumber}
          isPending={isPending}
          onCancel={() => setEditingPayment(false)}
          onSubmit={(reason, waiveCharges) =>
            submit({ paid: false, reason, waiveCharges })
          }
        />
      ) : null}

      {askingFee ? (
        <FeePrompt
          doctorName={doctorName}
          isPending={isPending}
          onCancel={() => setAskingFee(false)}
          onSubmit={(feeRupees) => submit({ paid: true, feeRupees })}
        />
      ) : null}
    </>
  );
}

const REASON_PRESETS = [
  'Doctor Waived / Scheme',
  'Cash Returned to Patient',
  'Govt Health Scheme (Free)',
  'Follow-up / Re-visit',
  'Marked paid by mistake',
];

/** 2-tap quick modal for reception to handle doctor returned money or scheme waiver. */
function ReturnRefundModal({
  tokenNumber,
  isPending,
  onCancel,
  onSubmit,
}: {
  tokenNumber: number;
  isPending: boolean;
  onCancel: () => void;
  onSubmit: (reason: string, waiveCharges: boolean) => void;
}) {
  const [reason, setReason] = useState(REASON_PRESETS[0]);
  const [customReason, setCustomReason] = useState('');
  const [waiveCharges, setWaiveCharges] = useState(true);

  const finalReason = customReason.trim() || reason;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 animate-in fade-in duration-150">
      <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl ring-1 ring-black/10">
        <div className="flex items-center justify-between border-b border-ink-100 pb-3">
          <h3 className="text-base font-bold text-ink-900">
            Edit Payment / Return Money · Token #{tokenNumber}
          </h3>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Close modal"
            className="rounded-lg p-1 text-ink-400 hover:bg-ink-100 hover:text-ink-700"
          >
            <XIcon className="size-4" />
          </button>
        </div>

        <form
          className="mt-4 space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit(finalReason, waiveCharges);
          }}
        >
          <Field label="Reason for returning money / marking unpaid">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 mb-2">
              {REASON_PRESETS.map((preset) => (
                <button
                  key={preset}
                  type="button"
                  onClick={() => {
                    setReason(preset);
                    setCustomReason('');
                  }}
                  className={cn(
                    'rounded-lg px-2.5 py-1.5 text-xs text-left font-semibold ring-1 transition-all',
                    reason === preset && !customReason
                      ? 'bg-brand-50 text-brand-900 ring-brand-300'
                      : 'bg-ink-50 text-ink-700 ring-ink-200 hover:bg-ink-100',
                  )}
                >
                  {preset}
                </button>
              ))}
            </div>
            <Input
              type="text"
              value={customReason}
              onChange={(e) => setCustomReason(e.target.value)}
              placeholder="Or type custom reason..."
            />
          </Field>

          <label className="flex items-start gap-2.5 rounded-xl bg-ink-50 p-3 text-xs text-ink-700 ring-1 ring-ink-200 cursor-pointer">
            <input
              type="checkbox"
              checked={waiveCharges}
              onChange={(e) => setWaiveCharges(e.target.checked)}
              className="mt-0.5 size-4 rounded border-ink-300 text-brand-600 focus:ring-brand-500"
            />
            <div>
              <span className="font-bold text-ink-900">Waive consultation charge (balance ₹0)</span>
              <p className="text-ink-500 mt-0.5">
                Check this if the patient was excused from the fee (e.g. under a scheme) so they don’t appear as an unpaid debtor.
              </p>
            </div>
          </label>

          <div className="flex justify-end gap-2 border-t border-ink-100 pt-3">
            <Button type="button" variant="secondary" size="md" onClick={onCancel} disabled={isPending}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              size="md"
              isLoading={isPending}
              className="bg-amber-600 hover:bg-amber-700 focus-visible:outline-amber-600 text-white"
            >
              Confirm Refund / Unpaid
            </Button>
          </div>
        </form>
      </div>
    </div>
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
