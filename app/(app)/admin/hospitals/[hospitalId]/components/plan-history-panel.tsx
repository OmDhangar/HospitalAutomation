import { EmptyState, cn } from '@/components/ui';
import { rupees, shortDate } from '../../../ui';

export function PlanHistoryPanel({
  history,
}: {
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
}) {
  if (history.length === 0) {
    return (
      <EmptyState
        title="No subscription history"
        hint="Subscription terms and changes will appear here."
      />
    );
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-ink-200 bg-white shadow-xs">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-ink-200 text-left text-xs uppercase tracking-wide text-ink-500">
            <th className="px-5 py-3 font-medium">Tier</th>
            <th className="px-5 py-3 font-medium">Cycle</th>
            <th className="px-5 py-3 font-medium">Status</th>
            <th className="px-5 py-3 text-right font-medium">Price</th>
            <th className="px-5 py-3 font-medium">Term</th>
            <th className="px-5 py-3 font-medium">Why</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-ink-100">
          {history.map((row) => (
            <tr
              key={row.id}
              className={cn(
                'hover:bg-ink-50/50',
                row.supersededAt === null && 'bg-brand-50/30 font-medium',
              )}
            >
              <td className="px-5 py-3 capitalize text-ink-900">
                {row.planTierCode.replace(/_/g, ' ')}
                {row.supersededAt === null && (
                  <span className="ml-2 rounded bg-brand-100 px-1.5 py-0.5 text-[11px] font-semibold text-brand-800">
                    Current
                  </span>
                )}
              </td>
              <td className="px-5 py-3 capitalize text-ink-600">
                {row.billingCycle}
              </td>
              <td className="px-5 py-3 capitalize text-ink-600">
                {row.status}
              </td>
              <td className="numeric px-5 py-3 text-right text-ink-900">
                {rupees(row.pricePaise)}
              </td>
              <td className="px-5 py-3 text-xs text-ink-600">
                {shortDate(row.startsAt)} – {shortDate(row.endsAt)}
              </td>
              <td className="px-5 py-3 text-xs text-ink-500">
                {row.changeReason ?? '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
