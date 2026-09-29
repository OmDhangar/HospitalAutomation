'use client';

import { useMemo, useState } from 'react';
import { Alert, Button, Field, Input, cn } from '@/components/ui';
import {
  judgePrice,
  quoteCustomPlan,
  undercutsLadder,
  type PlanTierLike,
} from '@/lib/domain/custom-plan';
import { createCustomPlanAction } from './actions';

const rupees = (paise: number) => `₹${Math.round(paise / 100).toLocaleString('en-IN')}`;

const SELECT_CLASS =
  'block w-full rounded-lg border-0 bg-white px-3 py-2.5 text-sm text-ink-900 ' +
  'ring-1 ring-inset ring-ink-300 focus:ring-2 focus:ring-inset focus:ring-brand-600 focus:outline-none';

/**
 * The quote, recomputed as you type.
 *
 * A client component because the whole value is seeing the margin move while
 * you argue about the price — a round trip per keystroke would make the
 * calculator something you use once and then do in your head. The pricing
 * functions are pure and dependency-free, so they run here and on the server
 * unchanged, and the server recomputes on submit rather than trusting these
 * numbers.
 */
export function CustomPlanBuilder({
  hospitals,
  tiers,
  paisePerMessage,
  rateSource,
}: {
  hospitals: Array<{ id: string; name: string; slug: string; branches: number; doctors: number; staff: number }>;
  tiers: PlanTierLike[];
  paisePerMessage: number;
  rateSource: 'invoice' | 'estimate';
}) {
  const [hospitalId, setHospitalId] = useState(hospitals[0]?.id ?? '');
  const [patientsPerDay, setPatientsPerDay] = useState(400);
  const [branches, setBranches] = useState(3);
  const [doctors, setDoctors] = useState(25);
  const [staffLogins, setStaffLogins] = useState(30);
  const [ratio, setRatio] = useState(3);
  const [targetMargin, setTargetMargin] = useState(65);
  const [billingCycle, setBillingCycle] = useState<'monthly' | 'annual'>('monthly');
  const [price, setPrice] = useState<number | null>(null);

  const quote = useMemo(
    () =>
      quoteCustomPlan({
        patientsPerDay,
        branches,
        doctors,
        staffLogins,
        messagesPerAppointment: ratio,
        paisePerMessage,
        targetMargin: targetMargin / 100,
        billingCycle,
      }),
    [patientsPerDay, branches, doctors, staffLogins, ratio, paisePerMessage, targetMargin, billingCycle],
  );

  // Null price means "use the suggestion" — so changing an input moves the
  // price with it until the operator deliberately overrides.
  const effectivePrice = price ?? quote.suggestedMonthlyPaise;
  const verdict = judgePrice({ monthlyPricePaise: effectivePrice, quote });
  const undercut = undercutsLadder({
    monthlyPricePaise: effectivePrice,
    patientsPerDay,
    tiers,
  });

  const hospital = hospitals.find((h) => h.id === hospitalId);

  const VERDICT_STYLES = {
    loss: 'bg-rose-50 text-rose-800 ring-rose-200',
    thin: 'bg-amber-50 text-amber-900 ring-amber-200',
    healthy: 'bg-emerald-50 text-emerald-800 ring-emerald-200',
  } as const;

  return (
    <form action={createCustomPlanAction} className="grid gap-5 lg:grid-cols-5">
      <input type="hidden" name="hospitalId" value={hospitalId} />
      <input type="hidden" name="monthlyPricePaise" value={effectivePrice} />
      <input type="hidden" name="annualPricePaise" value={quote.suggestedAnnualPaise} />
      <input type="hidden" name="setupFeePaise" value={quote.setupFeePaise} />
      <input type="hidden" name="patientsPerDay" value={patientsPerDay} />
      <input type="hidden" name="includedAppointments" value={quote.includedAppointments} />
      <input type="hidden" name="includedMessages" value={quote.includedMessages} />
      <input type="hidden" name="billingCycle" value={billingCycle} />

      {/* ------------------------------------------------------- inputs */}
      <div className="space-y-4 lg:col-span-3">
        <Field label="Hospital" hint="The plan is built for one account and hidden from public pricing">
          <select
            value={hospitalId}
            onChange={(event) => setHospitalId(event.target.value)}
            className={SELECT_CLASS}
          >
            {hospitals.map((h) => (
              <option key={h.id} value={h.id}>
                {h.name} — {h.branches} branches, {h.doctors} doctors, {h.staff} logins
              </option>
            ))}
          </select>
        </Field>

        {hospital ? (
          <button
            type="button"
            onClick={() => {
              setBranches(hospital.branches || 1);
              setDoctors(hospital.doctors || 1);
              setStaffLogins(hospital.staff || 1);
            }}
            className="text-xs font-medium text-brand-700 underline-offset-2 hover:underline"
          >
            Fill branches, doctors and logins from what they actually have
          </button>
        ) : null}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Patients per day" hint="Across every branch, at the volume being sold">
            <Input
              type="number"
              min={1}
              value={patientsPerDay}
              onChange={(e) => setPatientsPerDay(Number(e.target.value) || 0)}
              className="py-2.5 text-sm"
            />
          </Field>
          <Field label="Messages per appointment" hint="3.0 is the product budget">
            <Input
              type="number"
              min={0}
              step="0.1"
              value={ratio}
              onChange={(e) => setRatio(Number(e.target.value) || 0)}
              className="py-2.5 text-sm"
            />
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Branches">
            <Input
              type="number"
              min={1}
              name="maxBranches"
              value={branches}
              onChange={(e) => setBranches(Number(e.target.value) || 0)}
              className="py-2.5 text-sm"
            />
          </Field>
          <Field label="Doctors">
            <Input
              type="number"
              min={1}
              name="maxDoctors"
              value={doctors}
              onChange={(e) => setDoctors(Number(e.target.value) || 0)}
              className="py-2.5 text-sm"
            />
          </Field>
          <Field label="Staff logins">
            <Input
              type="number"
              min={1}
              name="maxStaffLogins"
              value={staffLogins}
              onChange={(e) => setStaffLogins(Number(e.target.value) || 0)}
              className="py-2.5 text-sm"
            />
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Target margin %" hint="Drives the suggestion only">
            <Input
              type="number"
              min={0}
              max={95}
              value={targetMargin}
              onChange={(e) => setTargetMargin(Number(e.target.value) || 0)}
              className="py-2.5 text-sm"
            />
          </Field>
          <Field label="Billing cycle">
            <select
              value={billingCycle}
              onChange={(e) => setBillingCycle(e.target.value as 'monthly' | 'annual')}
              className={SELECT_CLASS}
            >
              <option value="monthly">Monthly</option>
              <option value="annual">Annual</option>
            </select>
          </Field>
          <Field label="Support tier">
            <select name="supportTier" defaultValue="dedicated" className={SELECT_CLASS}>
              <option value="dedicated">Dedicated account manager</option>
              <option value="priority_4h">Priority, 4-hour</option>
              <option value="whatsapp_4h">WhatsApp, 4-hour</option>
              <option value="whatsapp_12h">WhatsApp, 12-hour</option>
              <option value="email_24h">Email, 24-hour</option>
            </select>
          </Field>
        </div>

        <Field label="Plan name" hint="Appears on the invoice and in the tier list">
          <Input
            name="name"
            required
            defaultValue=""
            placeholder={hospital ? `${hospital.name} — bespoke` : 'Bespoke plan'}
            className="py-2.5 text-sm"
          />
        </Field>

        <fieldset className="rounded-lg border border-ink-200 p-3">
          <legend className="px-1 text-xs font-medium text-ink-600">Included features</legend>
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            {[
              ['hasDisplayBoard', 'Display board'],
              ['hasOwnerReport', 'Owner report'],
              ['hasAdvancedReports', 'Advanced reports'],
              ['hasDataExport', 'Data export'],
              ['hasAuditLog', 'Audit log'],
            ].map(([name, label]) => (
              <label key={name} className="flex items-center gap-1.5 text-sm text-ink-700">
                <input type="checkbox" name={name} defaultChecked className="size-4" />
                {label}
              </label>
            ))}
          </div>
        </fieldset>
      </div>

      {/* -------------------------------------------------------- quote */}
      <div className="space-y-3 lg:col-span-2">
        <div className="rounded-xl border border-ink-200 bg-ink-50/60 p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-ink-500">
            Monthly cost to us
          </p>
          <dl className="mt-2 space-y-1.5 text-sm">
            <div className="flex justify-between">
              <dt className="text-ink-600">Messaging</dt>
              <dd className="numeric text-ink-900">{rupees(quote.messagingCostPaise)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-ink-600">SIM, support, infra</dt>
              <dd className="numeric text-ink-900">{rupees(quote.fixedCostPaise)}</dd>
            </div>
            <div className="flex justify-between border-t border-ink-200 pt-1.5 font-medium">
              <dt className="text-ink-800">Breakeven</dt>
              <dd className="numeric text-ink-900">{rupees(quote.totalCostPaise)}</dd>
            </div>
          </dl>
          <p className="mt-2 text-xs text-ink-500">
            at ₹{(paisePerMessage / 100).toFixed(4)}/message
            {rateSource === 'invoice' ? ', from your latest invoice' : ' (estimate — record an invoice)'}
          </p>
        </div>

        <Field label="Monthly price" hint={`Suggested ${rupees(quote.suggestedMonthlyPaise)} at ${targetMargin}% margin`}>
          <Input
            type="number"
            min={0}
            value={Math.round(effectivePrice / 100)}
            onChange={(e) => setPrice(Math.round((Number(e.target.value) || 0) * 100))}
            className="py-2.5 text-sm"
          />
        </Field>
        {price !== null ? (
          <button
            type="button"
            onClick={() => setPrice(null)}
            className="text-xs font-medium text-ink-500 underline-offset-2 hover:underline"
          >
            Reset to the suggestion
          </button>
        ) : null}

        <div
          className={cn(
            'rounded-lg px-3 py-2.5 text-sm ring-1 ring-inset',
            VERDICT_STYLES[verdict.level],
          )}
        >
          <p className="font-semibold">
            {verdict.marginPercent.toFixed(1)}% contribution margin
          </p>
          <p className="mt-0.5 text-xs">{verdict.message}</p>
        </div>

        {undercut ? (
          <Alert tone="warn">
            This is below <span className="font-medium">{undercut.name}</span> at{' '}
            {rupees(undercut.monthlyPricePaise)}/mo, which is sold at only{' '}
            {undercut.patientsPerDay} patients a day. Hard to defend if the two customers
            ever compare notes.
          </Alert>
        ) : null}

        <dl className="rounded-xl border border-ink-200 p-4 text-sm">
          <div className="flex justify-between py-1">
            <dt className="text-ink-600">Appointments / month</dt>
            <dd className="numeric text-ink-900">
              {quote.monthlyAppointments.toLocaleString('en-IN')}
            </dd>
          </div>
          <div className="flex justify-between py-1">
            <dt className="text-ink-600">Included allowance</dt>
            <dd className="numeric text-ink-900">
              {quote.includedAppointments.toLocaleString('en-IN')}
            </dd>
          </div>
          <div className="flex justify-between py-1">
            <dt className="text-ink-600">Included messages</dt>
            <dd className="numeric text-ink-900">
              {quote.includedMessages.toLocaleString('en-IN')}
            </dd>
          </div>
          <div className="flex justify-between border-t border-ink-200 py-1 pt-2">
            <dt className="text-ink-600">Annual price</dt>
            <dd className="numeric text-ink-900">{rupees(quote.suggestedAnnualPaise)}</dd>
          </div>
          <div className="flex justify-between py-1">
            <dt className="text-ink-600">Setup fee</dt>
            <dd className="numeric text-ink-900">{rupees(quote.setupFeePaise)}</dd>
          </div>
        </dl>

        <label className="flex items-start gap-2 text-sm text-ink-700">
          <input type="checkbox" name="assign" value="true" defaultChecked className="mt-0.5 size-4" />
          <span>
            Move this hospital onto the plan now
            <span className="block text-xs text-ink-500">
              Opens a new term immediately and supersedes the current one.
            </span>
          </span>
        </label>

        <Button
          type="submit"
          variant="primary"
          size="lg"
          className="w-full"
          disabled={!hospitalId}
        >
          Create plan
        </Button>
      </div>
    </form>
  );
}
