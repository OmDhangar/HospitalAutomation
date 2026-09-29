import Link from 'next/link';
import { Alert, Card, CardHeader, EmptyState } from '@/components/ui';
import { requirePlatformAdmin } from '@/lib/auth/platform';
import { SEED_PLAN_TIERS } from '@/lib/domain/pricing';
import { listCustomPlans } from '@/lib/services/custom-plans';
import { listAccounts } from '@/lib/services/platform-accounts';
import { resolvePaisePerMessage } from '@/lib/services/platform';
import { listActiveTiers } from '@/lib/services/subscriptions';
import { rupees } from '../ui';
import { CustomPlanBuilder } from './builder';

export const metadata = { title: 'Plans · Platform' };

const ERRORS: Record<string, string> = {
  INVALID_INPUT: 'Check the volume and price. Nothing was created.',
  HOSPITAL_NOT_FOUND: 'That hospital no longer exists.',
  CODE_TAKEN: 'A plan with that code already exists.',
};

/**
 * Bespoke plans for hospitals the published ladder does not fit.
 *
 * The ladder stops at 300 patients a day, where flat costs still matter. Above
 * that messaging is effectively the whole cost base, so the shape of the ladder
 * stops being informative and a price has to be built from the volume rather
 * than looked up.
 */
export default async function PlansPage({ searchParams }: PageProps<'/admin/plans'>) {
  await requirePlatformAdmin();
  const params = await searchParams;

  const [accounts, custom, published, rate] = await Promise.all([
    listAccounts(),
    listCustomPlans().catch(() => []),
    listActiveTiers().catch(() => [...SEED_PLAN_TIERS]),
    resolvePaisePerMessage(),
  ]);

  const hospitals = accounts.map((account) => ({
    id: account.hospitalId,
    name: account.name,
    slug: account.slug,
    branches: account.branchCount,
    doctors: account.doctorCount,
    staff: account.staffCount,
  }));

  // Only the three fields the comparison needs cross to the client. Sending
  // whole tier rows would ship the rate card's cost assumptions to a browser.
  const ladder = published.map((tier) => ({
    name: tier.name,
    patientsPerDay: tier.patientsPerDay,
    monthlyPricePaise: tier.monthlyPricePaise,
  }));

  const error = typeof params.error === 'string' ? ERRORS[params.error] : undefined;

  return (
    <div className="space-y-5">
      {error ? <Alert tone="error">{error}</Alert> : null}

      <Card>
        <CardHeader
          title="Build a flexible plan"
          hint="Priced from volume and real cost. Hidden from public pricing and from tier recommendations."
        />
        <div className="p-5">
          {hospitals.length === 0 ? (
            <EmptyState title="No hospitals yet" hint="Onboard one first." />
          ) : (
            <CustomPlanBuilder
              hospitals={hospitals}
              tiers={ladder}
              paisePerMessage={rate.paise}
              rateSource={rate.source}
            />
          )}
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Bespoke plans"
          hint="Every custom tier, including superseded revisions"
        />
        {custom.length === 0 ? (
          <EmptyState
            title="None yet"
            hint="Custom plans appear here once created."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-ink-200 text-left text-xs uppercase tracking-wide text-ink-500">
                  <th className="px-5 py-2.5 font-medium">Plan</th>
                  <th className="px-5 py-2.5 font-medium">Code</th>
                  <th className="px-5 py-2.5 text-right font-medium">Patients/day</th>
                  <th className="px-5 py-2.5 text-right font-medium">Monthly</th>
                  <th className="px-5 py-2.5 text-right font-medium">Annual</th>
                  <th className="px-5 py-2.5 text-right font-medium">Branch / Doc / Staff</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-200">
                {custom.map((plan) => (
                  <tr key={plan.code}>
                    <td className="px-5 py-3 font-medium text-ink-900">{plan.name}</td>
                    <td className="numeric px-5 py-3 text-xs text-ink-500">{plan.code}</td>
                    <td className="numeric px-5 py-3 text-right text-ink-700">
                      {plan.patientsPerDay}
                    </td>
                    <td className="numeric px-5 py-3 text-right text-ink-900">
                      {rupees(plan.monthlyPricePaise)}
                    </td>
                    <td className="numeric px-5 py-3 text-right text-ink-700">
                      {rupees(plan.annualPricePaise)}
                    </td>
                    <td className="numeric px-5 py-3 text-right text-ink-600">
                      {plan.maxBranches ?? '∞'} / {plan.maxDoctors ?? '∞'} /{' '}
                      {plan.maxStaffLogins ?? '∞'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="border-t border-ink-200 px-5 py-3 text-xs leading-relaxed text-ink-500">
          A bespoke plan is an ordinary tier row marked inactive, which is what keeps it off
          the public pricing page and out of tier recommendations. Repricing a hospital
          creates a new revision rather than editing the old one — a superseded subscription
          still points at the tier it was sold on, and rewriting it would change the terms of
          a closed agreement. Assign one from the{' '}
          <Link href="/admin/hospitals" className="underline underline-offset-2">
            account page
          </Link>
          .
        </p>
      </Card>
    </div>
  );
}
