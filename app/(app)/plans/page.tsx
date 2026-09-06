import Link from 'next/link';
import { Button, Card, CardHeader, EmptyState, cn } from '@/components/ui';
import { rupees } from '@/components/subscription';
import { requireSession } from '@/lib/auth/session';
import { canConfigureHospital } from '@/lib/services/auth';
import { getCurrentSubscription, listActiveTiers } from '@/lib/services/subscriptions';

export const metadata = { title: 'Plans · QueueCare' };

export default async function PlansPage() {
  const session = await requireSession();

  if (!canConfigureHospital(session.role)) {
    return (
      <Card>
        <EmptyState title="Only the hospital owner can view plans" />
      </Card>
    );
  }

  // Every figure on this page comes from the database. Nothing is hardcoded, so
  // a repricing or a deactivated tier shows up here without a deploy.
  const [tiers, current] = await Promise.all([
    listActiveTiers(),
    getCurrentSubscription(session.hospitalId),
  ]);

  const currentTier = tiers.find((t) => t.code === current?.planTierCode);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-ink-900">Plans</h1>
          <p className="mt-0.5 text-sm text-ink-500">
            Every plan includes the full product. Only capacity differs.
          </p>
        </div>
        <Link href="/subscription">
          <Button>Your subscription</Button>
        </Link>
      </div>

      {tiers.length === 0 ? (
        <Card>
          <EmptyState title="No plans are published yet" />
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {tiers.map((tier) => {
            const isCurrent = tier.code === current?.planTierCode;
            const isLarger =
              currentTier !== undefined &&
              tier.includedAppointments > currentTier.includedAppointments;

            return (
              <Card
                key={tier.code}
                className={cn(isCurrent && 'ring-2 ring-brand-600')}
              >
                <div className="flex items-start justify-between gap-3 px-5 pb-3 pt-4">
                  <div>
                    <h2 className="text-base font-semibold text-ink-900">{tier.name}</h2>
                    <p className="mt-0.5 text-xs text-ink-500">
                      Around {tier.patientsPerDay} patients a day
                    </p>
                  </div>
                  {isCurrent ? (
                    <span className="shrink-0 rounded-full bg-brand-600 px-2.5 py-0.5 text-xs font-medium text-white">
                      Current
                    </span>
                  ) : null}
                </div>

                <div className="px-5 pb-4">
                  <p className="numeric text-2xl font-semibold text-ink-900">
                    {rupees(tier.monthlyPricePaise)}
                    <span className="ml-1 text-sm font-normal text-ink-500">/month</span>
                  </p>
                  <p className="mt-1 text-xs text-ink-500">
                    or {rupees(tier.annualPricePaise)}/year —{' '}
                    <span className="text-brand-700">
                      setup fee waived on annual
                    </span>
                  </p>
                </div>

                <dl className="space-y-2 border-t border-ink-200 px-5 py-4 text-sm">
                  <div className="flex justify-between gap-3">
                    <dt className="text-ink-500">Appointments a month</dt>
                    <dd className="numeric font-medium text-ink-900">
                      {tier.includedAppointments.toLocaleString('en-IN')}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-ink-500">Patients a day</dt>
                    <dd className="numeric font-medium text-ink-900">
                      {tier.patientsPerDay}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-ink-500">WhatsApp messages</dt>
                    <dd className="numeric font-medium text-ink-900">
                      {tier.includedMessages.toLocaleString('en-IN')}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-ink-500">Setup fee</dt>
                    <dd className="numeric font-medium text-ink-900">
                      {rupees(tier.setupFeePaise)}
                    </dd>
                  </div>
                </dl>

                <div className="border-t border-ink-200 bg-ink-50 px-5 py-3 text-xs text-ink-500">
                  {isCurrent
                    ? 'Your current plan.'
                    : isLarger
                      ? 'Larger than your current plan — contact us to upgrade.'
                      : 'Smaller than your current plan — contact us to change.'}
                </div>
              </Card>
            );
          })}
        </div>
      )}

      <Card>
        <CardHeader title="Going over your plan" />
        <div className="space-y-2 px-5 py-4 text-sm leading-relaxed text-ink-600">
          <p>
            Nothing stops working if you exceed your included appointments. Your
            queue keeps running and additional appointments are billed at ₹1 each.
          </p>
          <p>
            If you are regularly above your plan, moving up a tier costs less than
            the overage. We will tell you when that happens rather than waiting for
            you to notice.
          </p>
        </div>
      </Card>
    </div>
  );
}
