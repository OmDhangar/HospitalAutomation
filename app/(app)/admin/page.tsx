import Link from 'next/link';
import { Card, CardHeader, EmptyState, Stat, cn } from '@/components/ui';
import { requirePlatformAdmin } from '@/lib/auth/platform';
import {
  MESSAGE_RATIO_ALERT,
  MESSAGE_RATIO_BREACH,
  MESSAGE_RATIO_BUDGET,
  type RatioStatus,
} from '@/lib/domain/pricing';
import { listActiveImpersonations } from '@/lib/services/impersonation';
import { listAccounts, summarise } from '@/lib/services/platform-accounts';
import { getPortfolioHealth, getRecentFailures, resolvePaisePerMessage } from '@/lib/services/platform';
import { listHospitalsAwaitingNumber } from '@/lib/services/whatsapp-numbers';
import { StandingPill, TermLabel, dateTime, rupees } from './ui';

export const metadata = { title: 'Platform · OPD Queue' };

const RATIO_STYLES: Record<RatioStatus, string> = {
  unknown: 'bg-ink-100 text-ink-500 ring-ink-200',
  ok: 'bg-emerald-50 text-emerald-800 ring-emerald-200',
  alert: 'bg-amber-50 text-amber-900 ring-amber-200',
  breach: 'bg-rose-50 text-rose-800 ring-rose-200',
};

/**
 * The triage screen.
 *
 * Deliberately not a summary of everything — it answers "what needs me today",
 * and anything that does not is a click away on its own tab. The margin table
 * stays here because the messages-per-appointment ratio is the number that
 * decides whether the business works at all.
 */
export default async function AdminPage() {
  await requirePlatformAdmin();

  const [accounts, portfolio, failures, rate, awaiting, impersonations] = await Promise.all([
    listAccounts(),
    getPortfolioHealth(),
    getRecentFailures(),
    resolvePaisePerMessage(),
    listHospitalsAwaitingNumber(),
    listActiveImpersonations(),
  ]);

  const totals = summarise(accounts);
  const attention = accounts.filter(
    (account) => account.standing !== 'healthy' && account.standing !== 'trial',
  );

  const messagingCost = portfolio.reduce((sum, row) => sum + row.messagingCostPaise, 0);
  const portfolioRatio =
    totals.appointments > 0 ? totals.messages / totals.appointments : null;

  return (
    <div className="space-y-5">
      <Card>
        <dl className="grid grid-cols-2 divide-x divide-y divide-ink-200 sm:grid-cols-5 [&>*]:border-ink-200">
          <Stat label="MRR" value={rupees(totals.mrrPaise)} tone="brand" hint="paying accounts only" />
          <Stat
            label="Messaging cost"
            value={rupees(messagingCost)}
            hint={
              rate.source === 'invoice'
                ? `₹${(rate.paise / 100).toFixed(4)}/msg, from ${rate.month}`
                : `estimated ₹${(rate.paise / 100).toFixed(4)}/msg`
            }
          />
          <Stat label="Hospitals" value={`${totals.active}/${totals.hospitals}`} hint="active of total" />
          <Stat
            label="Need attention"
            value={totals.needingAttention.toLocaleString('en-IN')}
            tone={totals.needingAttention > 0 ? 'warn' : 'default'}
          />
          <Stat
            label="Messages / appt"
            value={portfolioRatio === null ? '—' : portfolioRatio.toFixed(2)}
            tone={portfolioRatio !== null && portfolioRatio >= MESSAGE_RATIO_ALERT ? 'warn' : 'default'}
            hint={`budget ${MESSAGE_RATIO_BUDGET.toFixed(1)}, breaker ${MESSAGE_RATIO_BREACH}`}
          />
        </dl>
      </Card>

      {impersonations.length > 0 ? (
        <Card>
          <CardHeader
            title="Support sessions open right now"
            hint="Read-only, and logged in the customer's own audit trail"
          />
          <ul className="divide-y divide-ink-200">
            {impersonations.map((entry) => (
              <li
                key={`${entry.operatorEmail}-${entry.hospitalId}`}
                className="flex items-baseline justify-between gap-3 px-5 py-2.5"
              >
                <p className="text-sm text-ink-900">
                  <span className="font-medium">{entry.operatorName}</span> is inside{' '}
                  <Link
                    href={`/admin/hospitals/${entry.hospitalId}`}
                    className="underline underline-offset-2"
                  >
                    {entry.hospitalName}
                  </Link>
                </p>
                <p className="shrink-0 text-xs text-ink-500">
                  until {dateTime(entry.expiresAt)}
                </p>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <Card>
        <CardHeader
          title="Needs attention"
          hint="Suspended, expired, lapsing this week, over a plan limit, or never billed"
          action={
            <Link
              href="/admin/hospitals"
              className="text-xs font-medium text-ink-500 hover:text-ink-800"
            >
              All accounts →
            </Link>
          }
        />
        {attention.length === 0 ? (
          <EmptyState
            title="Every account is in good standing"
            hint="Nothing is suspended, lapsing or over its plan."
          />
        ) : (
          <ul className="divide-y divide-ink-200">
            {attention.map((account) => (
              <li key={account.hospitalId} className="flex flex-wrap items-center gap-3 px-5 py-3">
                <StandingPill standing={account.standing} />
                <Link
                  href={`/admin/hospitals/${account.hospitalId}`}
                  className="min-w-0 flex-1 truncate text-sm font-medium text-ink-900 underline-offset-2 hover:underline"
                >
                  {account.name}
                </Link>
                <span className="text-xs capitalize text-ink-500">
                  {account.planName ?? account.planTierCode?.replace(/_/g, ' ') ?? 'no plan'}
                </span>
                <TermLabel
                  endsAt={account.term.endsAt}
                  bucket={account.term.bucket}
                  daysRemaining={account.term.daysRemaining}
                />
                <span className="numeric w-20 text-right text-sm text-ink-700">
                  {account.mrrPaise > 0 ? rupees(account.mrrPaise) : '—'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <CardHeader
          title="Contribution by hospital"
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
                      <td className="px-5 py-3">
                        <Link
                          href={`/admin/hospitals/${row.hospitalId}`}
                          className="font-medium text-ink-900 underline-offset-2 hover:underline"
                        >
                          {row.name}
                        </Link>
                      </td>
                      <td className="px-5 py-3 text-ink-600">
                        <span className="capitalize">{row.planCode?.replace(/_/g, ' ') ?? '—'}</span>
                        {row.recommendedTierCode && row.recommendedTierCode !== row.planCode ? (
                          <span
                            className="ml-1.5 inline-flex rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium capitalize text-amber-900 ring-1 ring-inset ring-amber-200"
                            title="Their volume fits a different tier"
                          >
                            → {row.recommendedTierCode.replace(/_/g, ' ')}
                          </span>
                        ) : null}
                      </td>
                      <td className="numeric px-5 py-3 text-right text-ink-700">
                        {row.completedAppointments.toLocaleString('en-IN')}
                        {row.includedAppointments ? (
                          <span
                            className={cn('ml-1 text-xs', overQuota ? 'text-amber-700' : 'text-ink-400')}
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
                        {row.contributionPaise === null ? '—' : rupees(row.contributionPaise)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader
            title="Waiting on a WhatsApp number"
            hint="Paying for WhatsApp and unable to send anything"
            action={
              <Link href="/admin/whatsapp" className="text-xs font-medium text-ink-500 hover:text-ink-800">
                Assign →
              </Link>
            }
          />
          {awaiting.length === 0 ? (
            <EmptyState title="Every hospital has a number" />
          ) : (
            <ul className="divide-y divide-ink-200">
              {awaiting.map((hospital) => (
                <li key={hospital.id} className="px-5 py-2.5">
                  <Link
                    href={`/admin/hospitals/${hospital.id}`}
                    className="text-sm font-medium text-ink-900 underline-offset-2 hover:underline"
                  >
                    {hospital.name}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <CardHeader title="Delivery problems" hint="Failed after retries, or dropped by the breaker" />
          {failures.length === 0 ? (
            <EmptyState title="Nothing failing" hint="Every queued message was delivered." />
          ) : (
            <ul className="divide-y divide-ink-200">
              {failures.slice(0, 10).map((failure) => (
                <li key={failure.id} className="px-5 py-2.5">
                  <div className="flex items-baseline justify-between gap-3">
                    <p className="text-sm font-medium text-ink-900">{failure.hospitalName}</p>
                    <p className="shrink-0 text-xs text-ink-400">{dateTime(failure.createdAt)}</p>
                  </div>
                  <p className="text-xs text-ink-500">
                    {failure.milestone} · {failure.attempts} attempts
                  </p>
                  {failure.failedReason ? (
                    <p className="mt-0.5 text-xs text-rose-700">{failure.failedReason}</p>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
