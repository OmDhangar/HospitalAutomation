import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Button, Card, CardHeader, EmptyState, cn } from '@/components/ui';
import { requireModule } from '@/lib/auth/modules';
import { requireSession } from '@/lib/auth/session';
import { can } from '@/lib/domain/permissions';
import { addDays, chartDayOf, chartDayWindow, isChartDay } from '@/lib/domain/tpr';
import { getReconciliation, listLocations } from '@/lib/services/stock';

export const metadata = { title: 'Reconcile · Stock' };

/**
 * One store's reconciliation over a period (IPD sheets plan B4b, §7.3): per
 * batch, opening + in − out − given − wasted ± adjustments = closing, from
 * the ledger alone. Days run 8 am to 8 am, like the counts. Doses from the
 * treatment card and the paper register's figure are kept apart.
 */
export default async function ReconcilePage({ params, searchParams }: PageProps<'/ipd/stock/store/[id]/reconcile'>) {
  const session = await requireSession();
  await requireModule(session, 'stock');
  if (!can(session.role, 'stock.view')) notFound();
  const { id } = await params;
  const query = await searchParams;
  const location = (await listLocations(session.hospitalId, { includeInactive: true })).find((l) => l.id === id);
  if (!location) notFound();

  const today = chartDayOf(new Date(), session.timezone);
  const toDay = typeof query.to === 'string' && isChartDay(query.to) && query.to <= today ? query.to : today;
  const fromDay = typeof query.from === 'string' && isChartDay(query.from) && query.from <= toDay ? query.from : addDays(toDay, -6);
  const recon = await getReconciliation({
    hospitalId: session.hospitalId,
    locationId: id,
    from: chartDayWindow(fromDay, session.timezone).from,
    to: chartDayWindow(toDay, session.timezone).to,
  });
  const time = (date: Date) =>
    new Intl.DateTimeFormat('en-IN', { timeZone: session.timezone, day: '2-digit', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true }).format(date);
  const sum = (key: keyof (typeof recon.rows)[number]) => recon.rows.reduce((n, r) => n + (r[key] as number), 0);

  return (
    <div className="space-y-4 pb-10">
      <Link href={`/ipd/stock/store/${id}`} className="inline-flex min-h-11 items-center text-sm text-ink-500 hover:text-ink-800">
        ← {location.name}
      </Link>
      <div>
        <h1 className="text-xl font-bold text-ink-900">Reconcile {location.name}</h1>
        <p className="text-sm text-ink-600">
          Opening + received − sent − given − wasted ± adjustments and count differences = closing, per batch, from the books. Days run 8 am to 8 am.
        </p>
      </div>

      <form className="flex flex-wrap items-end gap-2" method="get">
        <label className="block text-sm font-medium text-ink-700">
          From (8 am)
          <input type="date" name="from" defaultValue={fromDay} max={today} className="mt-1 block h-11 rounded-lg border-0 px-3 text-sm ring-1 ring-inset ring-ink-300" />
        </label>
        <label className="block text-sm font-medium text-ink-700">
          To (next 8 am)
          <input type="date" name="to" defaultValue={toDay} max={today} className="mt-1 block h-11 rounded-lg border-0 px-3 text-sm ring-1 ring-inset ring-ink-300" />
        </label>
        <Button type="submit" variant="secondary" className="h-11">
          Show
        </Button>
      </form>

      <Card>
        <CardHeader title="By batch" hint={`${recon.rows.length} batch${recon.rows.length === 1 ? '' : 'es'}`} />
        {recon.rows.length === 0 ? (
          <EmptyState title="Nothing held or moved in this period" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[56rem] text-sm">
              <thead>
                <tr className="border-b border-ink-200 text-right text-xs uppercase tracking-wide text-ink-500">
                  <th className="px-4 py-2 text-left sm:px-5">Medicine · batch</th>
                  <th className="px-2 py-2">Opening</th>
                  <th className="px-2 py-2">Received</th>
                  <th className="px-2 py-2">From stores</th>
                  <th className="px-2 py-2">Sent / returned</th>
                  <th className="px-2 py-2">Given (card)</th>
                  <th className="px-2 py-2">Given (register)</th>
                  <th className="px-2 py-2">Wasted</th>
                  <th className="px-2 py-2">Put back</th>
                  <th className="px-2 py-2">Adjusted</th>
                  <th className="px-2 py-2">Count diff.</th>
                  <th className="px-4 py-2 sm:px-5">Closing</th>
                </tr>
              </thead>
              <tbody>
                {recon.rows.map((r) => (
                  <tr key={r.batchId} className="numeric border-b border-ink-100 text-right">
                    <td className="px-4 py-2.5 text-left sm:px-5">
                      <span className="block font-semibold text-ink-900">{r.label}</span>
                      <span className="block text-xs text-ink-500">
                        Batch {r.batchNo} · exp {r.expiryDate}
                      </span>
                    </td>
                    <td className="px-2 py-2.5">{r.opening}</td>
                    <Cell value={r.received} />
                    <Cell value={r.transferredIn} />
                    <Cell value={r.sentOut + r.returned} out />
                    <Cell value={r.givenMar} out />
                    <Cell value={r.givenRegister} out />
                    <Cell value={r.wasted} out />
                    <Cell value={r.putBack} />
                    <Cell value={r.adjusted} signed />
                    <Cell value={r.countDifference} signed />
                    <td className="px-4 py-2.5 font-bold text-ink-900 sm:px-5">{r.closing}</td>
                  </tr>
                ))}
                <tr className="numeric text-right font-semibold text-ink-900">
                  <td className="px-4 py-2.5 text-left sm:px-5">All batches ({recon.rows[0]?.unit ?? 'units'})</td>
                  <td className="px-2 py-2.5">{sum('opening')}</td>
                  <td className="px-2 py-2.5">{sum('received')}</td>
                  <td className="px-2 py-2.5">{sum('transferredIn')}</td>
                  <td className="px-2 py-2.5">{sum('sentOut') + sum('returned')}</td>
                  <td className="px-2 py-2.5">{sum('givenMar')}</td>
                  <td className="px-2 py-2.5">{sum('givenRegister')}</td>
                  <td className="px-2 py-2.5">{sum('wasted')}</td>
                  <td className="px-2 py-2.5">{sum('putBack')}</td>
                  <td className="px-2 py-2.5">{sum('adjusted')}</td>
                  <td className="px-2 py-2.5">{sum('countDifference')}</td>
                  <td className="px-4 py-2.5 sm:px-5">{sum('closing')}</td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card>
        <CardHeader title="Counts in this period" hint="Approved counts; each difference is in the Count diff. column above" />
        {recon.counts.length === 0 ? (
          <EmptyState title="No approved count in this period" />
        ) : (
          <ul className="divide-y divide-ink-100">
            {recon.counts.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-sm sm:px-5">
                <span>
                  {time(c.submittedAt)} · counted by {c.countedByName ?? 'staff'}, approved by {c.approvedByName ?? 'staff'} ·{' '}
                  {c.differences === 0 ? 'matched the books' : <strong className="text-rose-700">{c.differences} difference{c.differences === 1 ? '' : 's'}</strong>}
                </span>
                <Link href={`/ipd/stock/count/${c.id}`} className="inline-flex min-h-11 items-center font-semibold text-brand-700 hover:underline">
                  Count →
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function Cell({ value, out, signed }: { value: number; out?: boolean; signed?: boolean }) {
  if (!value) return <td className="px-2 py-2.5 text-ink-300">·</td>;
  const text = signed ? `${value > 0 ? '+' : ''}${value}` : out ? `−${value}` : `+${value}`;
  return <td className={cn('px-2 py-2.5', out || (signed && value < 0) ? 'text-rose-700' : 'text-emerald-700')}>{text}</td>;
}
