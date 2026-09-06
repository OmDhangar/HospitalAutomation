import Link from 'next/link';
import { Card, CardHeader, cn } from '@/components/ui';
import type { UsageAxis, UsageLevel } from '@/lib/domain/subscription';
import type { HospitalUsage } from '@/lib/services/usage';

/** Money is stored in paise; nothing in the UI should do that arithmetic itself. */
export const rupees = (paise: number): string =>
  `₹${Math.round(paise / 100).toLocaleString('en-IN')}`;

export const formatDate = (date: Date, timezone: string): string =>
  new Intl.DateTimeFormat('en-IN', {
    timeZone: timezone,
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(date);

const LEVEL_BAR: Record<UsageLevel, string> = {
  normal: 'bg-brand-600',
  warning: 'bg-amber-500',
  critical: 'bg-orange-500',
  exhausted: 'bg-rose-500',
};

const LEVEL_TEXT: Record<UsageLevel, string> = {
  normal: 'text-ink-900',
  warning: 'text-amber-700',
  critical: 'text-orange-700',
  exhausted: 'text-rose-700',
};

export function UsageBar({
  label,
  axis,
  unit,
  hint,
}: {
  label: string;
  axis: UsageAxis;
  unit: string;
  hint?: string;
}) {
  // A hospital with no plan has not used 0% — the question does not apply, so
  // the bar is absent rather than empty.
  const hasAllowance = axis.allowance > 0;
  const width = Math.min(100, axis.percent ?? 0);

  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm font-medium text-ink-700">{label}</span>
        <span className={cn('numeric text-sm font-semibold', LEVEL_TEXT[axis.level])}>
          {axis.used.toLocaleString('en-IN')}
          {hasAllowance ? (
            <span className="font-normal text-ink-400">
              {' / '}
              {axis.allowance.toLocaleString('en-IN')} {unit}
            </span>
          ) : (
            <span className="font-normal text-ink-400"> {unit}</span>
          )}
        </span>
      </div>

      {hasAllowance ? (
        <>
          <div
            className="mt-2 h-2 overflow-hidden rounded-full bg-ink-200"
            role="progressbar"
            aria-valuenow={Math.round(axis.percent ?? 0)}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={`${label} usage`}
          >
            <div
              className={cn('h-full rounded-full transition-all', LEVEL_BAR[axis.level])}
              style={{ width: `${width}%` }}
            />
          </div>
          <p className="mt-1.5 text-xs text-ink-500">
            {Math.round(axis.percent ?? 0)}% used ·{' '}
            {axis.remaining.toLocaleString('en-IN')} {unit} remaining
            {hint ? ` · ${hint}` : ''}
          </p>
        </>
      ) : (
        <p className="mt-1.5 text-xs text-ink-400">No allowance configured</p>
      )}
    </div>
  );
}

const STATUS_STYLES: Record<string, string> = {
  active: 'bg-emerald-50 text-emerald-800 ring-emerald-200',
  trial: 'bg-sky-50 text-sky-800 ring-sky-200',
  expired: 'bg-rose-50 text-rose-800 ring-rose-200',
  cancelled: 'bg-ink-100 text-ink-600 ring-ink-200',
  suspended: 'bg-amber-50 text-amber-900 ring-amber-200',
};

export function SubscriptionStatusPill({ status }: { status: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium capitalize ring-1 ring-inset',
        STATUS_STYLES[status] ?? STATUS_STYLES.cancelled,
      )}
    >
      {status}
    </span>
  );
}

/**
 * Warnings a hospital should see without going looking for them.
 *
 * Nothing here blocks service: at 100% the queue keeps running and overage
 * bills at ₹1 an appointment. A queue that went dark mid-morning over a billing
 * threshold would be a far worse failure than an unexpected invoice line.
 */
export function UsageNotice({ usage }: { usage: HospitalUsage }) {
  const { appointments, expiry } = usage;

  const notices: Array<{ tone: 'warn' | 'error'; text: string }> = [];

  if (appointments.level === 'exhausted') {
    notices.push({
      tone: 'error',
      text: `You have used all ${appointments.allowance.toLocaleString('en-IN')} appointments included this month. Nothing stops working — additional appointments are billed at ₹1 each.`,
    });
  } else if (appointments.level === 'critical') {
    notices.push({
      tone: 'warn',
      text: `You are approaching your monthly limit — ${appointments.remaining.toLocaleString('en-IN')} appointments remaining.`,
    });
  } else if (appointments.level === 'warning') {
    notices.push({
      tone: 'warn',
      text: `You have used ${Math.round(appointments.percent ?? 0)}% of this month's included appointments.`,
    });
  }

  if (expiry.bucket === 'expired') {
    notices.push({ tone: 'error', text: 'Your subscription has expired. Please renew to continue.' });
  } else if (expiry.bucket && expiry.daysRemaining !== null) {
    notices.push({
      tone: 'warn',
      text:
        expiry.daysRemaining <= 1
          ? 'Your subscription expires tomorrow.'
          : `Your subscription expires in ${expiry.daysRemaining} days.`,
    });
  }

  if (notices.length === 0) return null;

  return (
    <div className="space-y-2">
      {notices.map((notice, index) => (
        <div
          key={index}
          role="alert"
          className={cn(
            'rounded-lg px-4 py-3 text-sm ring-1 ring-inset',
            notice.tone === 'error'
              ? 'bg-rose-50 text-rose-800 ring-rose-200'
              : 'bg-amber-50 text-amber-900 ring-amber-200',
          )}
        >
          {notice.text}
        </div>
      ))}
    </div>
  );
}

/**
 * The plan card on the hospital dashboard.
 *
 * Answers, without a click: what plan am I on, what does it cost, how much have
 * I used today and this month, how much is left, and when does it expire.
 */
export function SubscriptionCard({
  usage,
  tierName,
  timezone,
}: {
  usage: HospitalUsage;
  tierName: string | null;
  timezone: string;
}) {
  const { subscription } = usage;

  if (!subscription) {
    return (
      <Card>
        <CardHeader title="Subscription" hint="No plan assigned yet" />
        <div className="px-5 py-6 text-sm text-ink-600">
          This hospital has not been placed on a plan. Ask your QueueCare contact
          to set one up — the queue works in the meantime.
        </div>
      </Card>
    );
  }

  const perMonth = subscription.billingCycle === 'annual' ? 'per year' : 'per month';

  return (
    <Card>
      <CardHeader
        title="Your plan"
        hint={`${tierName ?? subscription.planTierCode} · billed ${subscription.billingCycle}`}
        action={<SubscriptionStatusPill status={subscription.status} />}
      />

      <div className="border-b border-ink-200 px-5 py-4">
        <p className="numeric text-2xl font-semibold text-ink-900">
          {rupees(subscription.pricePaise)}
          <span className="ml-1.5 text-sm font-normal text-ink-500">{perMonth}</span>
        </p>
      </div>

      <div className="space-y-5 px-5 py-5">
        <UsageBar
          label="Appointments this month"
          axis={usage.appointments}
          unit="appointments"
        />
        <UsageBar label="Seen today" axis={usage.today} unit="patients" />
        <UsageBar
          label="WhatsApp messages this month"
          axis={usage.messages}
          unit="messages"
          hint={
            usage.messagesPerAppointment !== null
              ? `${usage.messagesPerAppointment.toFixed(1)} per appointment`
              : undefined
          }
        />
      </div>

      <dl className="grid grid-cols-2 gap-4 border-t border-ink-200 px-5 py-4 text-sm">
        <div>
          <dt className="text-xs uppercase tracking-wide text-ink-500">Started</dt>
          <dd className="mt-0.5 text-ink-800">
            {formatDate(subscription.startsAt, timezone)}
          </dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-ink-500">
            {usage.expiry.bucket === 'expired' ? 'Expired' : 'Renews'}
          </dt>
          <dd className="mt-0.5 text-ink-800">
            {formatDate(subscription.endsAt, timezone)}
          </dd>
        </div>
      </dl>

      <div className="flex flex-wrap gap-3 border-t border-ink-200 bg-ink-50 px-5 py-3">
        <Link
          href="/subscription"
          className="text-sm font-medium text-brand-700 hover:text-brand-800"
        >
          Subscription details
        </Link>
        <Link
          href="/plans"
          className="text-sm font-medium text-brand-700 hover:text-brand-800"
        >
          Compare plans
        </Link>
      </div>
    </Card>
  );
}
