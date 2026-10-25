import { Card, CardHeader, EmptyState } from '@/components/ui';
import { DefinitionRow, TermLabel, rupees, shortDate } from '../../../ui';
import type { AccountRow } from '@/lib/services/platform-accounts';
import type { PlanAccess } from '@/lib/domain/subscription';

export function PlanSummaryCard({
  account,
  currentTerm,
  access,
}: {
  account: AccountRow;
  currentTerm?: {
    id: string;
    planTierCode: string;
    billingCycle: string;
    status: string;
    pricePaise: number;
    startsAt: Date;
    endsAt: Date;
  } | null;
  access?: PlanAccess;
}) {
  return (
    <Card>
      <CardHeader title="Current plan" />

      {currentTerm ? (
        <dl className="divide-y divide-ink-200">
          <DefinitionRow term="Tier">
            <span className="capitalize">
              {account.planName ?? currentTerm.planTierCode.replace(/_/g, ' ')}
            </span>
          </DefinitionRow>
          <DefinitionRow term="Cycle">
            <span className="capitalize">{currentTerm.billingCycle}</span>
          </DefinitionRow>
          <DefinitionRow term="Price">
            {rupees(currentTerm.pricePaise)}
            <span className="ml-1 text-xs text-ink-500">
              / {currentTerm.billingCycle === 'annual' ? 'year' : 'month'}
            </span>
          </DefinitionRow>
          <DefinitionRow term="MRR">
            {rupees(account.mrrPaise)}{' '}
            <span className="text-xs text-ink-500">(normalised monthly)</span>
          </DefinitionRow>
          <DefinitionRow term="Status">
            <span className="capitalize">{currentTerm.status}</span>
            {access && access.state !== 'open' && (
              <span
                className={
                  access.state === 'grace'
                    ? 'ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800'
                    : 'ml-2 rounded-full bg-rose-100 px-2 py-0.5 text-xs font-semibold text-rose-800'
                }
              >
                {access.state === 'grace'
                  ? `Lapsed · locks ${shortDate(access.locksAt)}`
                  : `Staff locked out (${access.reason})`}
              </span>
            )}
          </DefinitionRow>
          <DefinitionRow term="Term">
            {shortDate(currentTerm.startsAt)} →{' '}
            <TermLabel
              endsAt={account.term.endsAt}
              bucket={account.term.bucket}
              daysRemaining={account.term.daysRemaining}
            />
          </DefinitionRow>
        </dl>
      ) : (
        <EmptyState
          title="No subscription"
          hint="This hospital was onboarded but never put on a plan."
        />
      )}
    </Card>
  );
}
