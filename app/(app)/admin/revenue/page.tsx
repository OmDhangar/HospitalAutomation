import Link from 'next/link';
import { Alert, Button, Card, CardHeader, EmptyState, Field, Input, Stat, cn } from '@/components/ui';
import { requirePlatformAdmin } from '@/lib/auth/platform';
import {
  listPlatformPayments,
  listProviderInvoices,
  resolvePaisePerMessage,
} from '@/lib/services/platform';
import { listAccounts, summarise } from '@/lib/services/platform-accounts';
import { dateTime, rupees, shortDate } from '../ui';
import { recordInvoiceAction } from './actions';

export const metadata = { title: 'Revenue · Platform' };

const PAYMENT_TONE: Record<string, string> = {
  paid: 'text-emerald-700',
  failed: 'text-rose-700',
  refunded: 'text-violet-700',
};

export default async function RevenuePage({ searchParams }: PageProps<'/admin/revenue'>) {
  await requirePlatformAdmin();
  const params = await searchParams;

  const [accounts, payments, invoices, rate] = await Promise.all([
    listAccounts(),
    listPlatformPayments(),
    listProviderInvoices(),
    resolvePaisePerMessage(),
  ]);

  const totals = summarise(accounts);

  const collected = payments
    .filter((payment) => payment.status === 'paid')
    .reduce((sum, payment) => sum + payment.amountPaise + payment.taxPaise, 0);

  const outstanding = payments
    .filter((payment) => payment.status === 'created' || payment.status === 'failed')
    .reduce((sum, payment) => sum + payment.amountPaise + payment.taxPaise, 0);

  const annualCount = accounts.filter((account) => account.billingCycle === 'annual').length;

  return (
    <div className="space-y-5">
      {params.done ? <Alert tone="success">Invoice recorded. Cost per message now reconciles against it.</Alert> : null}
      {params.error ? (
        <Alert tone="error">Check the month, message count and amount. Nothing was recorded.</Alert>
      ) : null}

      <Card>
        <dl className="grid grid-cols-2 divide-x divide-y divide-ink-200 sm:grid-cols-4 [&>*]:border-ink-200">
          <Stat label="MRR" value={rupees(totals.mrrPaise)} tone="brand" hint="annual spread over twelve" />
          <Stat
            label="Collected"
            value={rupees(collected)}
            hint={`across the last ${payments.length} attempts`}
          />
          <Stat
            label="Outstanding"
            value={rupees(outstanding)}
            tone={outstanding > 0 ? 'warn' : 'default'}
            hint="created or failed links"
          />
          <Stat
            label="Cost / message"
            value={`₹${(rate.paise / 100).toFixed(4)}`}
            hint={rate.source === 'invoice' ? `from ${rate.month} invoice` : 'estimate — record an invoice'}
          />
        </dl>
      </Card>

      <div className="grid gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Collection attempts" hint="Every payment link across the portfolio, newest first" />
          {payments.length === 0 ? (
            <EmptyState title="No payments yet" />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-ink-200 text-left text-xs uppercase tracking-wide text-ink-500">
                    <th className="px-5 py-2.5 font-medium">Hospital</th>
                    <th className="px-5 py-2.5 font-medium">Purpose</th>
                    <th className="px-5 py-2.5 font-medium">Status</th>
                    <th className="px-5 py-2.5 text-right font-medium">Amount</th>
                    <th className="px-5 py-2.5 font-medium">When</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-200">
                  {payments.map((payment) => (
                    <tr key={payment.id}>
                      <td className="px-5 py-2.5">
                        <Link
                          href={`/admin/hospitals/${payment.hospitalId}`}
                          className="font-medium text-ink-900 underline-offset-2 hover:underline"
                        >
                          {payment.hospitalName}
                        </Link>
                      </td>
                      <td className="px-5 py-2.5 capitalize text-ink-600">
                        {payment.purpose.replace(/_/g, ' ')}
                      </td>
                      <td className="px-5 py-2.5">
                        <span
                          className={cn(
                            'text-xs font-medium',
                            PAYMENT_TONE[payment.status] ?? 'text-ink-500',
                          )}
                        >
                          {payment.status}
                        </span>
                        {payment.failureReason ? (
                          <span className="ml-1 text-xs text-ink-400">
                            {payment.failureReason}
                          </span>
                        ) : null}
                      </td>
                      <td className="numeric px-5 py-2.5 text-right text-ink-900">
                        {rupees(payment.amountPaise + payment.taxPaise)}
                      </td>
                      <td className="px-5 py-2.5 text-xs text-ink-500">
                        {dateTime(payment.paidAt ?? payment.createdAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <div className="space-y-5">
          <Card>
            <CardHeader
              title="Record a provider invoice"
              hint="What Meta actually charged, per month"
            />
            <form action={recordInvoiceAction} className="space-y-3 p-5">
              <Field label="Billed month">
                <Input type="month" name="periodMonth" required className="py-2.5 text-sm" />
              </Field>
              <Field label="Messages billed">
                <Input
                  type="number"
                  name="messagesBilled"
                  min={0}
                  required
                  placeholder="184320"
                  className="py-2.5 text-sm"
                />
              </Field>
              <Field label="Amount (₹)" hint="Total on the invoice, including tax">
                <Input
                  type="number"
                  name="amountRupees"
                  min={0}
                  step="0.01"
                  required
                  placeholder="26726.40"
                  className="py-2.5 text-sm"
                />
              </Field>
              <Field label="Note" hint="Optional">
                <Input name="notes" placeholder="Rate dropped at 100k" className="py-2.5 text-sm" />
              </Field>
              <Button type="submit" variant="primary" className="w-full">
                Record invoice
              </Button>
              <p className="text-xs leading-relaxed text-ink-500">
                Recording the real invoice is what turns every contribution figure on the
                overview from a guess into a reconciliation. Re-recording a month replaces
                it rather than adding a second row.
              </p>
            </form>
          </Card>

          <Card>
            <CardHeader title="Provider invoices" hint="Newest first" />
            {invoices.length === 0 ? (
              <EmptyState title="None recorded" hint="Cost per message is an estimate until one is." />
            ) : (
              <ul className="divide-y divide-ink-200">
                {invoices.map((invoice) => (
                  <li key={invoice.id} className="flex items-baseline justify-between gap-3 px-5 py-2.5">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-ink-900">
                        {shortDate(new Date(`${invoice.periodMonth}T00:00:00Z`))}
                      </p>
                      <p className="text-xs text-ink-500">
                        {invoice.messagesBilled.toLocaleString('en-IN')} messages · ₹
                        {(invoice.amountPaise / invoice.messagesBilled / 100).toFixed(4)}/msg
                      </p>
                    </div>
                    <span className="numeric shrink-0 text-sm text-ink-900">
                      {rupees(invoice.amountPaise)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <CardHeader title="Mix" />
            <dl className="divide-y divide-ink-200">
              <div className="flex items-baseline justify-between px-5 py-2.5">
                <dt className="text-xs uppercase tracking-wide text-ink-500">Annual</dt>
                <dd className="text-sm text-ink-900">{annualCount}</dd>
              </div>
              <div className="flex items-baseline justify-between px-5 py-2.5">
                <dt className="text-xs uppercase tracking-wide text-ink-500">Monthly</dt>
                <dd className="text-sm text-ink-900">
                  {accounts.filter((a) => a.billingCycle === 'monthly').length}
                </dd>
              </div>
              <div className="flex items-baseline justify-between px-5 py-2.5">
                <dt className="text-xs uppercase tracking-wide text-ink-500">No plan</dt>
                <dd className="text-sm text-ink-900">
                  {accounts.filter((a) => a.billingCycle === null).length}
                </dd>
              </div>
            </dl>
          </Card>
        </div>
      </div>
    </div>
  );
}
