import Link from 'next/link';
import { Alert, Button, Card, CardHeader, EmptyState, Stat } from '@/components/ui';
import {
  SubscriptionStatusPill,
  UsageBar,
  UsageNotice,
  formatDate,
  rupees,
} from '@/components/subscription';
import { requireSession } from '@/lib/auth/session';
import { computeCharge, formatRupees } from '@/lib/domain/billing';
import { MESSAGE_CATEGORY_LABELS } from '@/lib/domain/message-category';
import { isRazorpayConfigured, isTestMode } from '@/lib/payments/razorpay';
import { canConfigureHospital } from '@/lib/services/auth';
import { listPayments, paymentErrorMessage, type PaymentError } from '@/lib/services/payments';
import {
  getCurrentSubscription,
  getSubscriptionHistory,
  listActiveTiers,
} from '@/lib/services/subscriptions';
import { getHospitalUsage, getMessageBreakdown } from '@/lib/services/usage';
import { checkPaymentStatus, renewPlan } from './actions';

export const metadata = { title: 'Subscription · Qurio' };

export default async function SubscriptionPage({
  searchParams,
}: PageProps<'/subscription'>) {
  const session = await requireSession();
  const params = await searchParams;

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
          hint="Your queue works normally. Ask your Qurio contact to set up a plan."
        />
      </Card>
    );
  }

  const tier = tiers.find((t) => t.code === subscription.planTierCode);
  const paymentsEnabled = isRazorpayConfigured();
  const testMode = isTestMode();

  /**
   * Payment history is only read when payments are actually switched on.
   *
   * Not merely an optimisation. Plan and usage are the reason an owner opens
   * this page, and neither depends on a payment ever having existed — so a
   * hospital that has never used online payment should not have that page fail
   * because of a table it does not use. It also keeps the page working on a
   * deployment where the code shipped ahead of the migration.
   */
  const [breakdown, recentPayments] = await Promise.all([
    getMessageBreakdown({
      hospitalId: session.hospitalId,
      from: usage.period.start,
      to: usage.period.end,
    }),
    paymentsEnabled ? listPayments(session.hospitalId) : Promise.resolve([]),
  ]);
  const totalMessages = breakdown.reduce((sum, row) => sum + row.messages, 0);

  // Shown before the owner commits, so the amount on the Razorpay page is
  // never a surprise. Computed from the same function that creates the charge.
  const charge = computeCharge(subscription.pricePaise);

  // A link already waiting to be paid. Surfaced rather than silently reused, so
  // an owner who lost the tab can find their way back to it.
  const openPayment = recentPayments.find(
    (payment) => payment.status === 'created' && payment.shortUrl,
  );

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

      <PaymentNotice params={params} />

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
            <div className="space-y-3 border-t border-ink-200 px-5 py-4">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-sm text-ink-600">Renewal amount</span>
                <span className="numeric text-sm font-semibold text-ink-900">
                  {formatRupees(charge.totalPaise)}
                </span>
              </div>
              {charge.taxPaise > 0 ? (
                <p className="text-xs text-ink-500">
                  {formatRupees(charge.amountPaise)} + {charge.gstPercent}% GST (
                  {formatRupees(charge.taxPaise)})
                </p>
              ) : null}

              {paymentsEnabled ? (
                <>
                  <form action={renewPlan}>
                    <Button type="submit" variant="primary" className="w-full">
                      {usage.expiry.bucket === 'expired' ? 'Renew now' : 'Renew plan'}
                    </Button>
                  </form>
                  <p className="text-xs leading-relaxed text-ink-500">
                    Opens a secure Razorpay page. UPI, card and net banking accepted.
                    {testMode ? ' TEST MODE — no real money moves.' : ''}
                  </p>
                </>
              ) : (
                <p className="text-xs leading-relaxed text-ink-500">
                  To renew or change plan, contact your Qurio representative. Online
                  payment is not enabled for this hospital yet.
                </p>
              )}

              {openPayment?.shortUrl ? (
                <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
                  <p className="text-xs leading-relaxed text-amber-900">
                    A payment link for {formatRupees(openPayment.totalPaise)} is already
                    open.
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <a
                      href={openPayment.shortUrl}
                      className="text-xs font-semibold text-amber-900 underline underline-offset-2"
                    >
                      Open payment page
                    </a>
                    {/* For the case where the webhook never arrived: paying is
                        not the same as us having heard about it. */}
                    <form action={checkPaymentStatus}>
                      <input type="hidden" name="paymentId" value={openPayment.id} />
                      <button
                        type="submit"
                        className="text-xs font-semibold text-amber-900 underline underline-offset-2"
                      >
                        I have already paid
                      </button>
                    </form>
                  </div>
                </div>
              ) : null}
            </div>
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

/**
 * The outcome of a payment attempt.
 *
 * Error codes are matched against the known set rather than printed, so a
 * crafted query string cannot put arbitrary text on a billing page — the one
 * place a hospital is most likely to believe what it reads.
 *
 * "done" deliberately does not claim success. Razorpay's callback fires when
 * the customer is redirected, which is not the same as the payment having
 * settled; the webhook is what confirms it. Saying "paid" here and being wrong
 * is worse than saying "confirming".
 */
function PaymentNotice({
  params,
}: {
  params: Record<string, string | string[] | undefined>;
}) {
  const error = typeof params.error === 'string' ? params.error : null;
  const payment = typeof params.payment === 'string' ? params.payment : null;

  const KNOWN: PaymentError['code'][] = [
    'NOT_CONFIGURED',
    'NO_SUBSCRIPTION',
    'NOT_PERMITTED',
    'GATEWAY_UNAVAILABLE',
    'ALREADY_PAID',
  ];
  const known = KNOWN.find((code) => code === error);

  return (
    <>
      {payment === 'done' ? (
        <Alert tone="warn">
          Thanks — confirming your payment with the bank. Your plan updates
          automatically, usually within a minute.
        </Alert>
      ) : null}
      {payment === 'confirmed' ? (
        <Alert tone="warn">Payment confirmed. Your plan has been extended.</Alert>
      ) : null}
      {payment === 'pending' ? (
        <Alert tone="warn">
          We have not received this payment yet. If you have just paid, wait a
          minute and check again.
        </Alert>
      ) : null}
      {known ? <Alert tone="error">{paymentErrorMessage(known)}</Alert> : null}
    </>
  );
}
