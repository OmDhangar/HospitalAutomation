import Link from 'next/link';
import { Card, CardHeader, EmptyState, Input, Stat, cn } from '@/components/ui';
import { requirePlatformAdmin } from '@/lib/auth/platform';
import {
  ACCOUNT_STANDINGS,
  STANDING_LABEL,
  type AccountStanding,
} from '@/lib/domain/platform-account';
import { listAccounts, summarise } from '@/lib/services/platform-accounts';
import { StandingPill, TermLabel, rupees } from '../ui';

export const metadata = { title: 'Accounts · Platform' };

/**
 * Every account, worst first.
 *
 * Search and filter are a plain GET form rather than client state: the result
 * is a URL an operator can bookmark or paste into a message, and there is no
 * interaction here that justifies shipping JavaScript for it.
 */
export default async function AccountsPage({ searchParams }: PageProps<'/admin/hospitals'>) {
  await requirePlatformAdmin();
  const params = await searchParams;

  const search = typeof params.q === 'string' ? params.q : '';
  const rawStanding = typeof params.standing === 'string' ? params.standing : '';
  const standing = ACCOUNT_STANDINGS.find((value) => value === rawStanding) as
    | AccountStanding
    | undefined;

  // Summarised over everything, filtered for display: a total that changes
  // when you type in the search box is not a total.
  const all = await listAccounts();
  const totals = summarise(all);

  const searchLower = search.trim().toLowerCase();
  const accounts = all.filter((account) => {
    if (searchLower && !`${account.name} ${account.slug}`.toLowerCase().includes(searchLower)) {
      return false;
    }
    return !standing || account.standing === standing;
  });

  return (
    <div className="space-y-5">
      <Card>
        <dl className="grid grid-cols-2 divide-x divide-y divide-ink-200 sm:grid-cols-4 [&>*]:border-ink-200">
          <Stat label="Hospitals" value={totals.hospitals.toLocaleString('en-IN')} />
          <Stat
            label="Active"
            value={totals.active.toLocaleString('en-IN')}
            hint={`${totals.hospitals - totals.active} switched off`}
          />
          <Stat
            label="Need attention"
            value={totals.needingAttention.toLocaleString('en-IN')}
            tone={totals.needingAttention > 0 ? 'warn' : 'default'}
          />
          <Stat label="MRR" value={rupees(totals.mrrPaise)} tone="brand" hint="annual spread over twelve" />
        </dl>
      </Card>

      <Card>
        <CardHeader
          title="Accounts"
          hint={`${accounts.length} of ${all.length} shown`}
        />

        <form className="flex flex-wrap items-end gap-3 border-b border-ink-200 bg-ink-50/50 p-4">
          <label className="min-w-[14rem] flex-1">
            <span className="mb-1.5 block text-xs font-medium text-ink-600">Search</span>
            <Input name="q" defaultValue={search} placeholder="Hospital name or slug" />
          </label>
          <label>
            <span className="mb-1.5 block text-xs font-medium text-ink-600">Standing</span>
            <select
              name="standing"
              defaultValue={standing ?? ''}
              className="h-[42px] rounded-lg border-0 bg-white px-3 text-sm text-ink-900 ring-1 ring-inset ring-ink-300 focus:ring-2 focus:ring-inset focus:ring-brand-600 focus:outline-none"
            >
              <option value="">Any</option>
              {ACCOUNT_STANDINGS.map((value) => (
                <option key={value} value={value}>
                  {STANDING_LABEL[value]}
                </option>
              ))}
            </select>
          </label>
          <button
            type="submit"
            className="h-[42px] rounded-lg bg-brand-600 px-4 text-sm font-medium text-white hover:bg-brand-700"
          >
            Apply
          </button>
          {search || standing ? (
            <Link
              href="/admin/hospitals"
              className="h-[42px] px-2 text-sm leading-[42px] text-ink-500 hover:text-ink-800"
            >
              Clear
            </Link>
          ) : null}
        </form>

        {accounts.length === 0 ? (
          <EmptyState
            title="Nothing matches"
            hint={all.length === 0 ? 'No hospitals onboarded yet.' : 'Try a different search.'}
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-ink-200 text-left text-xs uppercase tracking-wide text-ink-500">
                  <th className="px-5 py-2.5 font-medium">Hospital</th>
                  <th className="px-5 py-2.5 font-medium">Standing</th>
                  <th className="px-5 py-2.5 font-medium">Plan</th>
                  <th className="px-5 py-2.5 font-medium">Renews</th>
                  <th className="px-5 py-2.5 text-right font-medium">MRR</th>
                  <th className="px-5 py-2.5 text-right font-medium">Branch / Doc / Staff</th>
                  <th className="px-5 py-2.5 text-right font-medium">Appts</th>
                  <th className="px-5 py-2.5 text-right font-medium">Msgs</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-200">
                {accounts.map((account) => (
                  <tr key={account.hospitalId} className="hover:bg-ink-50/60">
                    <td className="px-5 py-3">
                      <Link
                        href={`/admin/hospitals/${account.hospitalId}`}
                        className="font-medium text-ink-900 underline-offset-2 hover:underline"
                      >
                        {account.name}
                      </Link>
                      <p className="mt-0.5 text-xs text-ink-400">
                        {account.slug}
                        {account.hasWhatsAppNumber ? null : ' · no WhatsApp number'}
                      </p>
                    </td>
                    <td className="px-5 py-3">
                      <StandingPill standing={account.standing} />
                    </td>
                    <td className="px-5 py-3 text-ink-600">
                      <span className="capitalize">
                        {account.planName ?? account.planTierCode?.replace(/_/g, ' ') ?? '—'}
                      </span>
                      {account.billingCycle ? (
                        <span className="ml-1 text-xs text-ink-400">{account.billingCycle}</span>
                      ) : null}
                    </td>
                    <td className="px-5 py-3">
                      <TermLabel
                        endsAt={account.term.endsAt}
                        bucket={account.term.bucket}
                        daysRemaining={account.term.daysRemaining}
                      />
                    </td>
                    <td className="numeric px-5 py-3 text-right text-ink-900">
                      {account.mrrPaise > 0 ? rupees(account.mrrPaise) : '—'}
                    </td>
                    <td className="numeric px-5 py-3 text-right text-ink-600">
                      {account.entitlements.map((axis, index) => (
                        <span key={axis.kind}>
                          {index > 0 ? <span className="text-ink-300"> / </span> : null}
                          <span className={cn(axis.atLimit && 'font-semibold text-amber-700')}>
                            {axis.used}
                            <span className="text-ink-400">
                              {axis.limit === null ? '' : `·${axis.limit}`}
                            </span>
                          </span>
                        </span>
                      ))}
                    </td>
                    <td className="numeric px-5 py-3 text-right text-ink-700">
                      {account.appointmentsUsed.toLocaleString('en-IN')}
                    </td>
                    <td className="numeric px-5 py-3 text-right text-ink-700">
                      {account.messagesUsed.toLocaleString('en-IN')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="border-t border-ink-200 px-5 py-3 text-xs text-ink-500">
          Appointments and messages are this calendar month, so the column is comparable
          across hospitals. Each hospital&rsquo;s own billing period is on its detail page.
        </p>
      </Card>
    </div>
  );
}
