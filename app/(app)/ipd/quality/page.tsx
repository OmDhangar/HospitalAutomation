import { notFound } from 'next/navigation';
import { Card, CardHeader, EmptyState, cn } from '@/components/ui';
import { requireModule } from '@/lib/auth/modules';
import { requireSession } from '@/lib/auth/session';
import { can } from '@/lib/domain/permissions';
import { getDueQuality } from '@/lib/services/due';

export const metadata = { title: 'Dose timing · IPD' };

const pct = (n: number, d: number) => (d === 0 ? '—' : `${Math.round((n / d) * 100)}%`);

/**
 * Dose timing over the last two weeks (IPD sheets plan B3b, §7.10 quality
 * metric): per ward, time-critical and other doses — on time, late, early,
 * not given (with a reason), missed (nothing recorded), the median delay, the
 * escalations raised (and in observe, those that would have been), and how
 * nurses rated the alert volume. From the hourly roll-ups; never computed live.
 */
export default async function DueQualityPage() {
  const session = await requireSession();
  await requireModule(session, 'mar');
  if (!can(session.role, 'ipd.dueQuality')) notFound();
  const { rollups, ratings } = await getDueQuality(session.hospitalId);
  const th = 'px-2 py-2 text-right text-xs font-semibold text-ink-500 first:pl-4 first:text-left';
  const td = 'px-2 py-2 text-right tabular-nums first:pl-4 first:text-left';

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <div>
        <h1 className="text-xl font-bold text-ink-900">Dose timing · last 14 days</h1>
        <p className="text-sm text-ink-600">A quality and staffing signal for each ward — not a judgement of any one nurse. Updated hourly.</p>
      </div>
      <Card>
        <CardHeader title="By ward" />
        {rollups.length === 0 ? (
          <EmptyState title="No due doses yet" hint="Figures appear once timed lines are on treatment cards." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead className="border-b border-ink-100">
                <tr>
                  <th className={th}>Ward</th>
                  <th className={th}>Doses</th>
                  <th className={th}>Due</th>
                  <th className={th}>On time</th>
                  <th className={th}>Late</th>
                  <th className={th}>Early</th>
                  <th className={th}>Not given</th>
                  <th className={th}>Missed</th>
                  <th className={th}>Median delay</th>
                  <th className={th}>Escalated</th>
                  <th className={th}>Alert volume</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {rollups.map((r) => {
                  const wardRatings = ratings.filter((x) => x.wardId === r.wardId);
                  const rated = (k: string) => wardRatings.find((x) => x.rating === k)?.n ?? 0;
                  return (
                    <tr key={`${r.wardId}-${r.timeCritical}`}>
                      <td className={cn(td, 'font-semibold')}>{r.wardName}</td>
                      <td className={td}>{r.timeCritical ? <span className="rounded bg-red-600 px-1.5 text-xs font-bold text-white">TC</span> : 'Other'}</td>
                      <td className={td}>{r.due}</td>
                      <td className={cn(td, 'font-semibold')}>{pct(r.onTime, r.due)}</td>
                      <td className={td}>{r.late}</td>
                      <td className={td}>{r.early}</td>
                      <td className={td}>{r.notGiven}</td>
                      <td className={cn(td, r.missed > 0 && 'font-semibold text-red-700')}>{r.missed}</td>
                      <td className={td}>{r.medianDelay === null ? '—' : `${r.medianDelay} min`}</td>
                      <td className={td}>{r.timeCritical ? `${r.escalated} (${r.wouldEscalate} would)` : '—'}</td>
                      <td className={td}>{r.timeCritical ? `${rated('too_many')} / ${rated('about_right')} / ${rated('too_few')}` : ''}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="px-4 pb-3 text-xs text-ink-500">Alert volume: too many / about right / too few, from the nurses’ once-a-shift answers.</p>
      </Card>
    </div>
  );
}
