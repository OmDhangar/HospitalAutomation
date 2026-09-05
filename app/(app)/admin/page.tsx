import { Card, CardHeader, EmptyState, Stat, cn } from '@/components/ui';
import { requireSession } from '@/lib/auth/session';
import {
  MESSAGE_RATIO_ALERT,
  MESSAGE_RATIO_BREACH,
  MESSAGE_RATIO_BUDGET,
  type RatioStatus,
} from '@/lib/domain/pricing';
import { getPortfolioHealth, getRecentFailures } from '@/lib/services/platform';

export const metadata = { title: 'Platform · OPD Queue' };

const rupees = (paise: number) =>
  `₹${Math.round(paise / 100).toLocaleString('en-IN')}`;

const RATIO_STYLES: Record<RatioStatus, string> = {
  unknown: 'bg-ink-100 text-ink-500 ring-ink-200',
  ok: 'bg-emerald-50 text-emerald-800 ring-emerald-200',
  alert: 'bg-amber-50 text-amber-900 ring-amber-200',
  breach: 'bg-rose-50 text-rose-800 ring-rose-200',
};

export default async function AdminPage() {
  const session = await requireSession();

  if (!session.isPlatformAdmin) {
    return (
      <Card>
        <EmptyState
          title="Not available"
          hint="This page is for platform operators, not hospital staff."
        />
      </Card>
    );
  }

  const [portfolio, failures] = await Promise.all([
    getPortfolioHealth(),
    getRecentFailures(),
  ]);

  const totals = portfolio.reduce(
    (acc, row) => ({
      appointments: acc.appointments + row.completedAppointments,
      messages: acc.messages + row.messagesSent,
      revenue: acc.revenue + (row.monthlyPricePaise ?? 0),
      messagingCost: acc.messagingCost + row.messagingCostPaise,
    }),
    { appointments: 0, messages: 0, revenue: 0, messagingCost: 0 },
  );

  const portfolioRatio =
    totals.appointments > 0 ? totals.messages / totals.appointments : null;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-lg font-semibold text-ink-900">Platform</h1>
        <p className="mt-0.5 text-sm text-ink-500">
          {portfolio.length} active {portfolio.length === 1 ? 'hospital' : 'hospitals'} · this
          month
        </p>
      </div>

      <Card>
        <CardHeader
          title="Portfolio"
          hint={`Budget is ${MESSAGE_RATIO_BUDGET.toFixed(1)} messages per completed appointment`}
        />
        <dl className="grid grid-cols-2 divide-x divide-y divide-ink-200 sm:grid-cols-4 [&>*]:border-ink-200">
          <Stat label="MRR" value={rupees(totals.revenue)} tone="brand" />
          <Stat
            label="Messaging cost"
            value={rupees(totals.messagingCost)}
            hint="estimated, this month"
          />
          <Stat label="Appointments" value={totals.appointments.toLocaleString('en-IN')} />
          <Stat
            label="Messages / appt"
            value={portfolioRatio === null ? '—' : portfolioRatio.toFixed(2)}
            tone={
              portfolioRatio !== null && portfolioRatio >= MESSAGE_RATIO_ALERT
                ? 'warn'
                : 'default'
            }
            hint={`alert at ${MESSAGE_RATIO_ALERT}, breaker at ${MESSAGE_RATIO_BREACH}`}
          />
        </dl>
      </Card>

      <Card>
        <CardHeader
          title="By hospital"
          hint="The ratio is the margin canary — watch it before anything else"
        />
        {portfolio.length === 0 ? (
          <EmptyState title="No active hospitals" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-ink-200 text-left text-xs uppercase tracking-wide text-ink-500">
                  <th className="px-5 py-2.5 font-medium">Hospital</th>
                  <th className="px-5 py-2.5 font-medium">Plan</th>
                  <th className="px-5 py-2.5 text-right font-medium">Appts</th>
                  <th className="px-5 py-2.5 text-right font-medium">Messages</th>
                  <th className="px-5 py-2.5 text-right font-medium">Per appt</th>
                  <th className="px-5 py-2.5 text-right font-medium">Contribution</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-200">
                {portfolio.map((row) => {
                  const overQuota =
                    row.includedAppointments !== null &&
                    row.completedAppointments > row.includedAppointments;

                  return (
                    <tr key={row.hospitalId}>
                      <td className="px-5 py-3 font-medium text-ink-900">{row.name}</td>
                      <td className="px-5 py-3 capitalize text-ink-600">
                        {row.planCode?.replace('_', ' ') ?? '—'}
                      </td>
                      <td className="numeric px-5 py-3 text-right text-ink-700">
                        {row.completedAppointments.toLocaleString('en-IN')}
                        {row.includedAppointments ? (
                          <span
                            className={cn(
                              'ml-1 text-xs',
                              overQuota ? 'text-amber-700' : 'text-ink-400',
                            )}
                          >
                            /{row.includedAppointments.toLocaleString('en-IN')}
                          </span>
                        ) : null}
                      </td>
                      <td className="numeric px-5 py-3 text-right text-ink-700">
                        {row.messagesSent.toLocaleString('en-IN')}
                      </td>
                      <td className="px-5 py-3 text-right">
                        <span
                          className={cn(
                            'numeric inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ring-inset',
                            RATIO_STYLES[row.status],
                          )}
                        >
                          {row.ratio === null ? '—' : row.ratio.toFixed(2)}
                        </span>
                      </td>
                      <td className="numeric px-5 py-3 text-right font-medium text-ink-900">
                        {row.contributionPaise === null
                          ? '—'
                          : rupees(row.contributionPaise)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card>
        <CardHeader
          title="Delivery problems"
          hint="Failed after retries, or dropped by the circuit breaker"
        />
        {failures.length === 0 ? (
          <EmptyState title="Nothing failing" hint="Every queued message was delivered." />
        ) : (
          <ul className="divide-y divide-ink-200">
            {failures.map((failure) => (
              <li key={failure.id} className="px-5 py-3">
                <div className="flex items-baseline justify-between gap-3">
                  <p className="text-sm font-medium text-ink-900">{failure.hospitalName}</p>
                  <p className="text-xs text-ink-400">
                    {failure.createdAt.toLocaleString('en-IN')}
                  </p>
                </div>
                <p className="mt-0.5 text-xs text-ink-500">
                  {failure.milestone} · {failure.attempts} attempts
                </p>
                {failure.failedReason ? (
                  <p className="mt-1 text-xs text-rose-700">{failure.failedReason}</p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
