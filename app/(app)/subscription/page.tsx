import Link from 'next/link';
import { Button, Card, CardHeader, EmptyState, Stat } from '@/components/ui';
import {
  SubscriptionStatusPill,
  UsageBar,
  UsageNotice,
  formatDate,
  rupees,
} from '@/components/subscription';
import { requireSession } from '@/lib/auth/session';
import { MESSAGE_CATEGORY_LABELS } from '@/lib/domain/message-category';
import { canConfigureHospital } from '@/lib/services/auth';
import {
  getCurrentSubscription,
  getSubscriptionHistory,
  listActiveTiers,
} from '@/lib/services/subscriptions';
import { getHospitalUsage, getMessageBreakdown } from '@/lib/services/usage';

export const metadata = { title: 'Subscription · QueueCare' };

export default async function SubscriptionPage() {
  const session = await requireSession();

  // Billing is the owner's business, not reception's. Enforced here on the
  // server rather than by hiding a nav link.
  if (!canConfigureHospital(session.role)) {
    return (
      <Card>
        <EmptyState
          title="Only the hospital owner can view billing"
          hint="Ask your administrator if you need plan or usage information."
        />
      </Card>
    );
  }

  const [usage, subscription, tiers, history] = await Promise.all([
    getHospitalUsage({ hospitalId: session.hospitalId, timezone: session.timezone }),
    getCurrentSubscription(session.hospitalId),
    listActiveTiers(),
    getSubscriptionHistory(session.hospitalId),
  ]);

  if (!subscription || !usage.period) {
    return (
      <Card>
        <EmptyState
          title="No plan assigned yet"
          hint="Your queue works normally. Ask your QueueCare contact to set up a plan."
        />
      </Card>
    );
  }

  const tier = tiers.find((t) => t.code === subscription.planTierCode);
  const breakdown = await getMessageBreakdown({
    hospitalId: session.hospitalId,
    from: usage.period.start,
    to: usage.period.end,
  });
  const totalMessages = breakdown.reduce((sum, row) => sum + row.messages, 0);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-ink-900">Subscription</h1>
          <p className="mt-0.5 text-sm text-ink-500">{session.hospitalName}</p>
        </div>
        <Link href="/plans">
          <Button>Compare plans</Button>
        </Link>
      </div>

      <UsageNotice usage={usage} />

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <Card>
            <CardHeader
              title="Current plan"
              hint={tier?.name ?? subscription.planTierCode}
              action={<SubscriptionStatusPill status={subscription.status} />}
            />
            <dl className="grid grid-cols-2 divide-x divide-y divide-ink-200 sm:grid-cols-4 [&>*]:border-ink-200">
              <Stat
                label="Price"
                value={rupees(subscription.pricePaise)}
                hint={subscription.billingCycle === 'annual' ? 'per year' : 'per month'}
                tone="brand"
              />
              <Stat
                label="Billing"
                value={subscription.billingCycle === 'annual' ? 'Annual' : 'Monthly'}
              />
              <Stat
                label="Setup fee"
                value={
                  subscription.setupFeePaise === 0
                    ? 'Waived'
                    : rupees(subscription.setupFeePaise)
                }
                hint={subscription.setupFeePaise === 0 ? 'annual prepay' : 'one-time'}
              />
              <Stat
                label="Daily capacity"
                value={subscription.dailyAppointmentCapacity}
                hint="patients per day"
              />
            </dl>
          </Card>

          <Card>
            <CardHeader
              title="This billing period"
              hint={`${formatDate(usage.period.start, session.timezone)} — ${formatDate(
                new Date(usage.period.end.getTime() - 1),
                session.timezone,
              )}`}
            />
            <div className="space-y-5 px-5 py-5">
              <UsageBar
                label="Appointments"
                axis={usage.appointments}
                unit="appointments"
              />
              <UsageBar label="Seen today" axis={usage.today} unit="patients" />
              <UsageBar
                label="WhatsApp messages"
                axis={usage.messages}
                unit="messages"
                hint={
                  usage.messagesPerAppointment !== null
                    ? `${usage.messagesPerAppointment.toFixed(1)} per appointment`
                    : undefined
                }
              />
            </div>
          </Card>

          <Card>
            <CardHeader title="What your messages were for" hint="This period" />
            {breakdown.length === 0 ? (
              <EmptyState title="No messages sent yet this period" />
            ) : (
              <ul className="divide-y divide-ink-200">
                {breakdown.map((row) => (
                  <li
                    key={row.category}
                    className="flex items-center justify-between gap-3 px-5 py-3"
                  >
                    <span className="text-sm text-ink-800">
                      {MESSAGE_CATEGORY_LABELS[row.category]}
                    </span>
                    <span className="numeric text-sm font-medium text-ink-900">
                      {row.messages.toLocaleString('en-IN')}
                      <span className="ml-1.5 font-normal text-ink-400">
                        {totalMessages > 0
                          ? `${Math.round((row.messages / totalMessages) * 100)}%`
                          : ''}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        <div className="space-y-5">
          <Card>
            <CardHeader title="Term" />
            <dl className="space-y-3 px-5 py-4 text-sm">
              <div className="flex justify-between gap-3">
                <dt className="text-ink-500">Started</dt>
                <dd className="text-ink-900">
                  {formatDate(subscription.startsAt, session.timezone)}
                </dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-ink-500">
                  {usage.expiry.bucket === 'expired' ? 'Expired' : 'Renews'}
                </dt>
                <dd className="text-ink-900">
                  {formatDate(subscription.endsAt, session.timezone)}
                </dd>
              </div>
              {usage.expiry.daysRemaining !== null && usage.expiry.daysRemaining >= 0 ? (
                <div className="flex justify-between gap-3">
                  <dt className="text-ink-500">Days remaining</dt>
                  <dd className="numeric text-ink-900">{usage.expiry.daysRemaining}</dd>
                </div>
              ) : null}
            </dl>
            <p className="border-t border-ink-200 px-5 py-3 text-xs leading-relaxed text-ink-500">
              To change plan, billing cycle or renewal, contact your QueueCare
              representative. Online payment is not available yet.
            </p>
          </Card>

          {history.length > 1 ? (
            <Card>
              <CardHeader title="Plan history" />
              <ul className="divide-y divide-ink-200">
                {history.map((row) => (
                  <li key={row.id} className="px-5 py-3">
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="text-sm font-medium capitalize text-ink-900">
                        {row.planTierCode.replace('_', ' ')}
                      </span>
                      <span className="numeric text-sm text-ink-600">
                        {rupees(row.pricePaise)}
                      </span>
                    </div>
                    <p className="mt-0.5 text-xs text-ink-500">
                      {formatDate(row.startsAt, session.timezone)}
                      {row.changeReason ? ` · ${row.changeReason}` : ''}
                    </p>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}
        </div>
      </div>
    </div>
  );
}
