'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Button, Card, Field, Input } from '@/components/ui';
import { TabbedSection } from '@/components/tabbed-section';
import type { AuditEventGroup } from '@/lib/domain/audit';
import type { AccountPayment, AccountUser } from '@/lib/services/platform-accounts';
import { ActivityFeed } from './activity-feed';
import { PaymentsPanel } from './payments-panel';
import { PlanHistoryPanel } from './plan-history-panel';

const SELECT_CLASS =
  'block w-full rounded-lg border-0 bg-white px-3 py-2 text-sm text-ink-900 ' +
  'ring-1 ring-inset ring-ink-300 focus:ring-2 focus:ring-inset focus:ring-brand-600 focus:outline-none';

export function ActivityPanel({
  activeTab = 'activity',
  activeCategory = 'all',
  activeActor = 'all',
  searchQuery = '',
  auditGroups,
  users,
  payments,
  history,
  timezone = 'Asia/Kolkata',
}: {
  activeTab?: string;
  activeCategory?: string;
  activeActor?: string;
  searchQuery?: string;
  auditGroups: AuditEventGroup[];
  users: AccountUser[];
  payments: AccountPayment[];
  history: Array<{
    id: string;
    planTierCode: string;
    billingCycle: string;
    status: string;
    pricePaise: number;
    startsAt: Date;
    endsAt: Date;
    changeReason?: string | null;
    supersededAt?: Date | null;
  }>;
  timezone?: string;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const handleTabChange = (tabId: string) => {
    const sp = new URLSearchParams(searchParams?.toString() ?? '');
    sp.set('tab', tabId);
    router.replace(`?${sp.toString()}`, { scroll: false });
  };

  // Extract unique actor names from users
  const actorNames = Array.from(
    new Set(users.map((u) => u.name).filter(Boolean)),
  ).sort();

  const tabs = [
    { id: 'activity', label: 'Activity' },
    { id: 'payments', label: 'Payments', count: payments.length },
    { id: 'history', label: 'Plan history', count: history.length },
  ];

  return (
    <Card className="p-5">
      <TabbedSection
        tabs={tabs}
        activeId={activeTab}
        onChange={handleTabChange}
      >
        {activeTab === 'payments' ? (
          <div className="mt-4">
            <PaymentsPanel payments={payments} />
          </div>
        ) : activeTab === 'history' ? (
          <div className="mt-4">
            <PlanHistoryPanel history={history} />
          </div>
        ) : (
          <div className="mt-4 space-y-5">
            {/* Filter Form */}
            <form
              method="get"
              className="flex flex-wrap items-end gap-3 border-b border-ink-100 pb-4"
            >
              <input type="hidden" name="tab" value="activity" />

              <div className="w-36">
                <Field label="Category">
                  <select
                    name="category"
                    defaultValue={activeCategory}
                    className={SELECT_CLASS}
                  >
                    <option value="all">All</option>
                    <option value="auth">Auth</option>
                    <option value="session">Session</option>
                    <option value="billing">Billing</option>
                    <option value="subscription">Subscription</option>
                    <option value="support">Support</option>
                    <option value="config">Config</option>
                    <option value="destructive">Destructive</option>
                  </select>
                </Field>
              </div>

              <div className="w-48">
                <Field label="Actor">
                  <select
                    name="actor"
                    defaultValue={activeActor}
                    className={SELECT_CLASS}
                  >
                    <option value="all">All people</option>
                    {actorNames.map((name) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>

              <div className="min-w-[12rem] flex-1">
                <Field label="Search">
                  <Input
                    name="q"
                    defaultValue={searchQuery}
                    placeholder="Search action or keyword…"
                    className="py-2 text-sm"
                  />
                </Field>
              </div>

              <div>
                <Button type="submit" variant="secondary" size="md">
                  Apply
                </Button>
              </div>
            </form>

            {/* Feed */}
            <ActivityFeed groups={auditGroups} timezone={timezone} />
          </div>
        )}
      </TabbedSection>
    </Card>
  );
}
