'use client';

import { useState } from 'react';
import { Field, Input, cn } from '@/components/ui';
import { PAYER_KINDS, PAYER_KIND_LABELS, type PayerKind } from '@/lib/domain/payer';

const SELECT_CLASS =
  'block w-full rounded-lg border-0 bg-white px-3 py-2.5 text-ink-900 ring-1 ring-inset ring-ink-300 focus:ring-2 focus:ring-inset focus:ring-brand-600 focus:outline-none';

/**
 * The admission sheet's optional "Add details": reason, payer, deposit
 * (decision D-AD). Collapsed by default so the one primary action — Confirm
 * bed — stays the obvious next step. The deposit field exists only for roles
 * that may take money; the server checks again.
 */
export function AdmissionExtras({
  canCollect,
  defaultReason,
  defaultPayer,
  open = false,
}: {
  canCollect: boolean;
  defaultReason?: string | null;
  defaultPayer?: { kind: PayerKind; payerName: string | null; policyNumber: string | null } | null;
  open?: boolean;
}) {
  const [kind, setKind] = useState<PayerKind>(defaultPayer?.kind ?? 'self');

  return (
    <details open={open} className="group rounded-xl border border-ink-200 bg-white">
      <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between px-4 text-sm font-semibold text-ink-800">
        Add details
        <span className="text-xs font-normal text-ink-500 group-open:hidden">Reason, payer, deposit</span>
      </summary>
      <div className="space-y-4 border-t border-ink-200 p-4">
        <Field label="Reason for admission" hint="Optional, one line">
          <Input name="reason" maxLength={200} defaultValue={defaultReason ?? ''} placeholder="Fever with dehydration" />
        </Field>

        <fieldset>
          <legend className="mb-1.5 text-sm font-medium text-ink-700">Who pays</legend>
          <div className="grid grid-cols-2 gap-1 rounded-xl bg-ink-100 p-1 sm:grid-cols-4">
            {PAYER_KINDS.map((value) => (
              <label key={value} className="cursor-pointer">
                <input
                  type="radio"
                  name="payerKind"
                  value={value}
                  checked={kind === value}
                  onChange={() => setKind(value)}
                  className="peer sr-only"
                />
                <span
                  className={cn(
                    'flex min-h-11 items-center justify-center rounded-lg text-sm font-semibold',
                    'text-ink-600 peer-checked:bg-white peer-checked:text-ink-900 peer-checked:shadow-xs',
                    'peer-focus-visible:outline-2 peer-focus-visible:outline-brand-700',
                  )}
                >
                  {PAYER_KIND_LABELS[value]}
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        {kind !== 'self' ? (
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label={`${PAYER_KIND_LABELS[kind]} name`}>
              <Input name="payerName" required defaultValue={defaultPayer?.payerName ?? ''} placeholder="Star Health" />
            </Field>
            <Field label="Policy / card no." hint="Optional">
              <Input name="policyNumber" defaultValue={defaultPayer?.policyNumber ?? ''} />
            </Field>
            <Field label="Pre-auth amount (₹)" hint="Optional">
              <Input name="preauthRupees" inputMode="decimal" placeholder="25000" />
            </Field>
          </div>
        ) : null}

        {canCollect ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Deposit taken (₹)" hint="Optional. Counts towards the final bill.">
              <Input name="depositRupees" inputMode="decimal" placeholder="5000" />
            </Field>
            <Field label="Paid by">
              <select name="depositMethod" className={SELECT_CLASS} defaultValue="cash">
                <option value="cash">Cash</option>
                <option value="upi">UPI</option>
                <option value="card">Card</option>
                <option value="bank">Bank transfer</option>
              </select>
            </Field>
          </div>
        ) : null}
      </div>
    </details>
  );
}
