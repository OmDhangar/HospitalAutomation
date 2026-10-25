'use client';

import { useState } from 'react';
import { Button, Card, CardHeader, Field, Input } from '@/components/ui';
import { ConfirmModal } from '@/components/confirm-destructive';
import { SaveForm } from '@/components/save-form';
import {
  LAPSE_GRACE_DAYS,
  SUBSCRIPTION_STATUSES,
  TRIAL_MAX_DAYS,
  TRIAL_MIN_DAYS,
} from '@/lib/domain/subscription';
import { rupees } from '../../../ui';
import {
  changePlanAction,
  extendTermAction,
  renewTermAction,
  setSubscriptionStatusAction,
  startTrialAction,
} from '../actions';

const SELECT_CLASS =
  'block w-full rounded-lg border-0 bg-white px-3 py-2 text-sm text-ink-900 ' +
  'ring-1 ring-inset ring-ink-300 focus:ring-2 focus:ring-inset focus:ring-brand-600 focus:outline-none';

export function PlanActionsCard({
  hospitalId,
  currentTerm,
  endsAtIso,
  tiers,
}: {
  hospitalId: string;
  currentTerm?: {
    planTierCode: string;
    billingCycle: string;
    status: string;
  } | null;
  endsAtIso?: string | null;
  tiers: Array<{ code: string; name: string; monthlyPricePaise: number }>;
}) {
  const [changePlanOpen, setChangePlanOpen] = useState(false);
  const [renewOpen, setRenewOpen] = useState(false);

  return (
    <Card>
      <CardHeader title="Plan actions" />

      <div className="flex flex-wrap items-center justify-between gap-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="primary"
            onClick={() => setChangePlanOpen(true)}
          >
            Change plan…
          </Button>

          <Button
            type="button"
            variant="secondary"
            disabled={!currentTerm}
            onClick={() => setRenewOpen(true)}
          >
            Renew one more term
          </Button>
        </div>

        <span className="text-xs text-ink-400">Additive & non-destructive</span>
      </div>

      {/* Advanced disclosure */}
      <details className="border-t border-ink-200 bg-ink-50/30">
        <summary className="cursor-pointer px-4 py-3 text-xs font-semibold uppercase tracking-wide text-ink-600 hover:text-ink-900 select-none">
          ▸ Advanced (3)
        </summary>

        <div className="divide-y divide-ink-200 border-t border-ink-200 bg-white p-4 space-y-4">
          {/* 1. Set status */}
          <SaveForm action={setSubscriptionStatusAction} className="pt-2 first:pt-0">
            <input type="hidden" name="hospitalId" value={hospitalId} />
            <div className="flex flex-wrap items-end gap-3">
              <div className="min-w-[12rem] flex-1">
                <Field label="Set status">
                  <select
                    name="status"
                    defaultValue={currentTerm?.status ?? 'active'}
                    className={SELECT_CLASS}
                  >
                    {SUBSCRIPTION_STATUSES.map((status) => (
                      <option key={status} value={status} className="capitalize">
                        {status}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
              <Button type="submit" size="md">
                Set
              </Button>
            </div>
          </SaveForm>

          {/* 2. Extend expiry */}
          <SaveForm action={extendTermAction} className="pt-4">
            <input type="hidden" name="hospitalId" value={hospitalId} />
            <div className="flex flex-wrap items-end gap-3">
              <div className="min-w-[12rem] flex-1">
                <Field label="Extend expiry to" hint="Keeps tier, price and cycle">
                  <Input
                    type="date"
                    name="endsAt"
                    defaultValue={endsAtIso ?? undefined}
                    className="py-2 text-sm"
                  />
                </Field>
              </div>
              <Button type="submit" size="md">
                Extend
              </Button>
            </div>
          </SaveForm>

          {/* 3. Start trial */}
          <SaveForm action={startTrialAction} className="pt-4">
            <input type="hidden" name="hospitalId" value={hospitalId} />
            <div className="grid gap-3 sm:grid-cols-4">
              <div className="sm:col-span-2">
                <Field label="Trial tier" hint="Its limits and features apply">
                  <select
                    name="tierCode"
                    defaultValue={currentTerm?.planTierCode ?? tiers[0]?.code ?? ''}
                    className={SELECT_CLASS}
                  >
                    {tiers.map((tier) => (
                      <option key={tier.code} value={tier.code}>
                        {tier.name}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
              <div className="sm:col-span-1">
                <Field
                  label="Days"
                  hint={`${TRIAL_MIN_DAYS}–${TRIAL_MAX_DAYS} days`}
                >
                  <Input
                    name="days"
                    type="number"
                    inputMode="numeric"
                    min={TRIAL_MIN_DAYS}
                    max={TRIAL_MAX_DAYS}
                    required
                    placeholder="15"
                    className="py-2 text-sm"
                  />
                </Field>
              </div>
              <div className="flex items-end sm:col-span-1">
                <Button type="submit" variant="secondary" className="w-full">
                  Start trial
                </Button>
              </div>
            </div>
            <p className="mt-2 text-xs text-ink-500">
              Starts today at ₹0 and replaces current term. Hospital receives {LAPSE_GRACE_DAYS} grace
              days when expired before locking.
            </p>
          </SaveForm>
        </div>
      </details>

      {/* Change Plan Modal */}
      <ConfirmModal
        isOpen={changePlanOpen}
        onClose={() => setChangePlanOpen(false)}
        title="Change subscription plan"
      >
        <form action={changePlanAction} className="space-y-4">
          <input type="hidden" name="hospitalId" value={hospitalId} />

          <Field label="Move to tier">
            <select
              name="tierCode"
              defaultValue={currentTerm?.planTierCode ?? ''}
              className={SELECT_CLASS}
            >
              {tiers.map((tier) => (
                <option key={tier.code} value={tier.code}>
                  {tier.name} · {rupees(tier.monthlyPricePaise)}/mo
                </option>
              ))}
            </select>
          </Field>

          <Field label="Cycle">
            <select
              name="billingCycle"
              defaultValue={currentTerm?.billingCycle ?? 'monthly'}
              className={SELECT_CLASS}
            >
              <option value="monthly">Monthly</option>
              <option value="annual">Annual</option>
            </select>
          </Field>

          <Field label="Reason" hint="Recorded on the new term">
            <Input
              name="reason"
              placeholder="e.g. upgrade / negotiated"
              className="py-2 text-sm"
            />
          </Field>

          <p className="text-xs text-ink-500">
            A change takes effect immediately and opens a new term. Time this for a period boundary
            rather than mid-month.
          </p>

          <div className="flex items-center justify-end gap-2 pt-2 border-t border-ink-100">
            <Button
              type="button"
              variant="ghost"
              onClick={() => setChangePlanOpen(false)}
            >
              Cancel
            </Button>
            <Button type="submit" variant="primary">
              Apply plan
            </Button>
          </div>
        </form>
      </ConfirmModal>

      {/* Renew Modal */}
      <ConfirmModal
        isOpen={renewOpen}
        onClose={() => setRenewOpen(false)}
        title="Renew subscription for one more term?"
      >
        <form action={renewTermAction} className="space-y-4">
          <input type="hidden" name="hospitalId" value={hospitalId} />
          <p className="text-sm text-ink-700">
            This will extend the current term by one billing cycle at the agreed price and tier.
          </p>
          <div className="flex items-center justify-end gap-2 pt-2 border-t border-ink-100">
            <Button
              type="button"
              variant="ghost"
              onClick={() => setRenewOpen(false)}
            >
              Cancel
            </Button>
            <Button type="submit" variant="primary">
              Renew term
            </Button>
          </div>
        </form>
      </ConfirmModal>
    </Card>
  );
}
