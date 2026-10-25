import { EmptyState, cn } from '@/components/ui';
import { dateTime, rupees } from '../../../ui';
import type { AccountPayment } from '@/lib/services/platform-accounts';

export function PaymentsPanel({ payments }: { payments: AccountPayment[] }) {
  if (payments.length === 0) {
    return (
      <EmptyState
        title="No payments recorded"
        hint="Renewals and upgrades will appear here."
      />
    );
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-ink-200 bg-white shadow-xs">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-ink-200 text-left text-xs uppercase tracking-wide text-ink-500">
            <th className="px-5 py-3 font-medium">Date</th>
            <th className="px-5 py-3 font-medium">Purpose</th>
            <th className="px-5 py-3 font-medium">Status</th>
            <th className="px-5 py-3 text-right font-medium">Amount</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-ink-100">
          {payments.map((payment) => (
            <tr key={payment.id} className="hover:bg-ink-50/50">
              <td className="px-5 py-3 text-xs text-ink-500">
                {dateTime(payment.paidAt ?? payment.createdAt)}
              </td>
              <td className="px-5 py-3 font-medium text-ink-900 capitalize">
                {payment.purpose.replace(/_/g, ' ')}
                {payment.failureReason && (
                  <p className="mt-0.5 text-xs text-rose-600 font-normal">
                    {payment.failureReason}
                  </p>
                )}
              </td>
              <td className="px-5 py-3">
                <span
                  className={cn(
                    'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset',
                    payment.status === 'paid'
                      ? 'bg-emerald-50 text-emerald-800 ring-emerald-200'
                      : payment.status === 'failed'
                        ? 'bg-rose-50 text-rose-800 ring-rose-200'
                        : 'bg-ink-100 text-ink-600 ring-ink-200',
                  )}
                >
                  {payment.status.charAt(0).toUpperCase() + payment.status.slice(1)}
                </span>
              </td>
              <td className="numeric px-5 py-3 text-right font-medium text-ink-900">
                {rupees(payment.amountPaise + payment.taxPaise)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
