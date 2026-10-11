import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Button, Card, CardHeader, EmptyState, cn } from '@/components/ui';
import { requireModule } from '@/lib/auth/modules';
import { requireSession } from '@/lib/auth/session';
import { can } from '@/lib/domain/permissions';
import { addDays, chartDayOf, chartDayWindow, isChartDay } from '@/lib/domain/tpr';
import { getDoseRegister } from '@/lib/services/mar';
import { listMedicinesForStock } from '@/lib/services/stock';

export const metadata = { title: 'Patient-wise register · Stock' };

/**
 * The patient-wise account of one risk-class medicine (IPD sheets plan B4b):
 * every give and waste from the treatment card, with the patient, batch,
 * store, who gave it and who witnessed. Laid out like the NDPS patient-wise
 * register (Form 3E); the exact statutory format is still to be confirmed
 * (D-DRUG), so it is marked as a draft. Names patients: clinical staff only.
 */
export default async function RegisterPage({ searchParams }: PageProps<'/ipd/stock/register'>) {
  const session = await requireSession();
  await requireModule(session, 'stock');
  if (!can(session.role, 'stock.view') || !can(session.role, 'ipd.view')) notFound();
  const query = await searchParams;
  const medicines = await listMedicinesForStock(session.hospitalId, { riskOnly: true });
  const medicine = medicines.find((m) => m.id === query.medicine) ?? medicines[0] ?? null;

  const today = chartDayOf(new Date(), session.timezone);
  const toDay = typeof query.to === 'string' && isChartDay(query.to) && query.to <= today ? query.to : today;
  const fromDay = typeof query.from === 'string' && isChartDay(query.from) && query.from <= toDay ? query.from : addDays(toDay, -6);
  const rows = medicine
    ? await getDoseRegister({
        hospitalId: session.hospitalId,
        medicineId: medicine.id,
        from: chartDayWindow(fromDay, session.timezone).from,
        to: chartDayWindow(toDay, session.timezone).to,
      })
    : [];
  const time = (date: Date) =>
    new Intl.DateTimeFormat('en-IN', { timeZone: session.timezone, day: '2-digit', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true }).format(date);
  const live = rows.filter((r) => !r.voided);
  const given = live.filter((r) => r.kind === 'give').reduce((n, r) => n + r.units, 0);
  const wasted = live.filter((r) => r.kind === 'waste' && r.witnessedBy).reduce((n, r) => n + r.units, 0);

  return (
    <div className="space-y-4 pb-10">
      <Link href="/ipd/stock" className="inline-flex min-h-11 items-center text-sm text-ink-500 hover:text-ink-800">
        ← Stock
      </Link>
      <div>
        <h1 className="text-xl font-bold text-ink-900">Patient-wise register</h1>
        <p className="text-sm text-ink-600">
          Every dose and waste of a risk-class medicine from the treatment card. <strong>Draft layout</strong>: the statutory register format is still
          being confirmed.
        </p>
      </div>

      {medicines.length === 0 ? (
        <Card>
          <EmptyState title="No risk-class medicines" hint="The owner marks them under Settings → Stock." />
        </Card>
      ) : (
        <>
          <form className="flex flex-wrap items-end gap-2" method="get">
            <label className="block min-w-0 text-sm font-medium text-ink-700">
              Medicine
              <select name="medicine" defaultValue={medicine?.id} className="mt-1 block h-11 max-w-full rounded-lg border-0 px-3 text-sm ring-1 ring-inset ring-ink-300">
                {medicines.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            </label>
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
            <CardHeader
              title={medicine?.label ?? ''}
              hint={`${given} ${medicine?.unit ?? 'units'} given · ${wasted} wasted (witnessed) · struck-out rows shown crossed out`}
            />
            {rows.length === 0 ? (
              <EmptyState title="Nothing given or wasted in this period" />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[52rem] text-sm">
                  <thead>
                    <tr className="border-b border-ink-200 text-left text-xs uppercase tracking-wide text-ink-500">
                      <th className="px-4 py-2 sm:px-5">When</th>
                      <th className="px-2 py-2">Patient · IPD No.</th>
                      <th className="px-2 py-2">Given / wasted</th>
                      <th className="px-2 py-2 text-right">Units</th>
                      <th className="px-2 py-2">Batch</th>
                      <th className="px-2 py-2">Store</th>
                      <th className="px-2 py-2">By</th>
                      <th className="px-4 py-2 sm:px-5">Witness</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.id} className={cn('border-b border-ink-100 align-top', r.voided && 'text-ink-400')}>
                        <td className="numeric px-4 py-2.5 sm:px-5">{time(r.occurredAt)}</td>
                        <td className={cn('px-2 py-2.5', r.voided && 'line-through')}>
                          {r.patientName}
                          {r.ipdNumber ? <span className="numeric block text-xs text-ink-500">IPD {r.ipdNumber}</span> : null}
                        </td>
                        <td className="px-2 py-2.5">
                          <span className={cn(r.voided && 'line-through')}>
                            {r.kind === 'give' ? `Given${r.dose ? ` · ${r.dose}` : ''}` : `Wasted${r.amount ? ` · ${r.amount}` : ''}`}
                          </span>
                          {r.kind === 'waste' && !r.voided ? (
                            <span className="block text-xs text-ink-500">
                              {r.reason}
                              {r.note ? ` — “${r.note}”` : ''}
                            </span>
                          ) : null}
                          {r.voided ? <span className="block text-xs">Struck out: {r.note}</span> : null}
                          {r.stockStatus === 'short' && !r.voided ? <span className="block text-xs font-semibold text-amber-800">Not off stock yet</span> : null}
                        </td>
                        <td className="numeric px-2 py-2.5 text-right">{r.units}</td>
                        <td className="numeric px-2 py-2.5">{r.batches ?? '—'}</td>
                        <td className="px-2 py-2.5">{r.storeName ?? '—'}</td>
                        <td className="px-2 py-2.5">{r.recordedBy ?? 'staff'}</td>
                        <td className="px-4 py-2.5 sm:px-5">{r.witnessedBy ?? (r.kind === 'waste' && !r.voided ? <span className="text-amber-800">waiting</span> : '—')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
