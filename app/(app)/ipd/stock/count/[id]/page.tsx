import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Alert, Button, Card, CardHeader, cn } from '@/components/ui';
import { AlertTriangleIcon } from '@/components/icons';
import { requireModule } from '@/lib/auth/modules';
import { requireSession } from '@/lib/auth/session';
import { can } from '@/lib/domain/permissions';
import { VARIANCE_REASONS, expiryStatus } from '@/lib/domain/stock';
import { serviceDateIn } from '@/lib/domain/time';
import { getCount, listMedicinesForStock } from '@/lib/services/stock';
import { approveCountAction, explainDifferenceAction, saveCountAction } from '../../actions';

export const metadata = { title: 'Count · Stock' };

const box =
  'numeric block h-12 w-24 rounded-lg border-0 px-3 text-right text-xl font-semibold ring-1 ring-inset ring-ink-300 focus:ring-2 focus:ring-brand-600 focus:outline-none';

/**
 * One blind count (IPD sheets plan B4a). While counting, the counter sees each
 * batch the store should hold — never how many — and types what is on the
 * shelf, plus "used since last count" from the paper drug register. After
 * submission the books, the use and the difference appear; each difference
 * needs a reason; someone else approves.
 */
export default async function CountPage({ params, searchParams }: PageProps<'/ipd/stock/count/[id]'>) {
  const session = await requireSession();
  await requireModule(session, 'stock');
  if (!can(session.role, 'stock.view')) notFound();
  const { id } = await params;
  const query = await searchParams;
  const count = await getCount(session.hospitalId, id);
  if (!count) notFound();

  const today = serviceDateIn(session.timezone);
  const counter = count.countedByUserId === session.userId;
  const writable = !session.readOnly;
  const counting = count.status === 'counting';
  const canFill = counting && counter && writable && can(session.role, 'stock.count');
  const canExplain = count.status === 'submitted' && writable && (counter || can(session.role, 'stock.approve'));
  const canApprove = count.status === 'submitted' && writable && !counter && can(session.role, 'stock.approve');
  const riskMedicines = canFill ? await listMedicinesForStock(session.hospitalId, { riskOnly: true }) : [];

  const medicines = [...new Map(count.lines.map((l) => [l.medicineId, { id: l.medicineId, label: l.label, unit: l.unit }])).values()];
  const time = (date: Date) =>
    new Intl.DateTimeFormat('en-IN', { timeZone: session.timezone, day: '2-digit', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true }).format(date);
  const unexplained = count.lines.filter((l) => (l.variance ?? 0) !== 0 && !l.reasonCode).length;

  return (
    <div className="mx-auto max-w-3xl space-y-4 pb-10">
      <Link href="/ipd/stock" className="inline-flex min-h-11 items-center text-sm text-ink-500 hover:text-ink-800">
        ← Stock
      </Link>
      {typeof query.saved === 'string' ? <Alert tone="success">{query.saved}</Alert> : null}
      {typeof query.error === 'string' ? <Alert tone="error">{query.error}</Alert> : null}

      <Card>
        <div className="p-4 sm:p-5">
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-500">
            {counting ? 'Counting' : count.status === 'submitted' ? 'Counted — waiting for approval' : count.status === 'approved' ? 'Approved' : 'Cancelled'}
          </p>
          <h1 className="text-xl font-bold text-ink-900">{count.locationName}</h1>
          <p className="text-sm text-ink-600">
            Counted by {count.countedByName ?? 'staff'} · started {time(count.startedAt)}
            {count.submittedAt ? ` · submitted ${time(count.submittedAt)}` : ''}
            {count.approvedAt ? ` · approved by ${count.approvedByName ?? 'staff'} ${time(count.approvedAt)}` : ''}
          </p>
          {count.countedByMover ? (
            <p className="mt-2 flex items-center gap-1.5 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900 ring-1 ring-amber-200">
              <AlertTriangleIcon className="size-4 shrink-0" />
              The counter moved stock in or out of this store since its last count.
            </p>
          ) : null}
          {count.movedDuringCount ? (
            <p className="mt-2 flex items-center gap-1.5 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900 ring-1 ring-amber-200">
              <AlertTriangleIcon className="size-4 shrink-0" />
              Stock moved in or out of this store while it was being counted. A recount may be wise.
            </p>
          ) : null}
        </div>
      </Card>

      {canFill ? (
        <form action={saveCountAction} className="space-y-4">
          <input type="hidden" name="countId" value={count.id} />
          <Card>
            <CardHeader title="What is on the shelf" hint="Count each batch. Type 0 if there is none. You will see the books after you submit." />
            {count.lines.length === 0 ? (
              <p className="px-4 pb-4 text-sm text-ink-600 sm:px-5">The books list nothing here. Add anything you find below.</p>
            ) : (
              <ul className="divide-y divide-ink-100">
                {count.lines.map((line) => (
                  <li key={line.batchId} className="flex items-center justify-between gap-3 px-4 py-3 sm:px-5">
                    <label htmlFor={`count_${line.batchId}`} className="min-w-0">
                      <span className="block font-semibold text-ink-900">{line.label}</span>
                      <span className="numeric block text-sm text-ink-600">
                        Batch {line.batchNo} · exp {line.expiryDate}
                        <ExpiryTag expiry={expiryStatus(line.expiryDate, today)} />
                      </span>
                    </label>
                    <span className="flex items-center gap-2">
                      <input
                        id={`count_${line.batchId}`}
                        name={`count_${line.batchId}`}
                        inputMode="numeric"
                        defaultValue={line.counted ?? ''}
                        aria-label={`${line.label} batch ${line.batchNo}: number counted`}
                        className={box}
                      />
                      <span className="w-14 text-sm text-ink-500">{line.unit}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {medicines.length > 0 ? (
            <Card>
              <CardHeader title="Used since the last count" hint="From the paper drug register, per medicine. Leave empty if none was used." />
              <ul className="divide-y divide-ink-100">
                {medicines.map((m) => (
                  <li key={m.id} className="flex items-center justify-between gap-3 px-4 py-3 sm:px-5">
                    <label htmlFor={`used_${m.id}`} className="font-semibold text-ink-900">
                      {m.label}
                    </label>
                    <span className="flex items-center gap-2">
                      <input id={`used_${m.id}`} name={`used_${m.id}`} inputMode="numeric" defaultValue={count.manualUse.get(m.id) ?? ''} className={box} />
                      <span className="w-14 text-sm text-ink-500">{m.unit}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}

          <details className="rounded-xl bg-white ring-1 ring-ink-200">
            <summary className="min-h-12 cursor-pointer px-4 py-3 text-sm font-semibold text-ink-800 sm:px-5">Found a batch that is not on the list?</summary>
            <div className="grid gap-3 border-t border-ink-100 p-4 sm:grid-cols-2 sm:p-5">
              <label className="block text-sm font-medium text-ink-700 sm:col-span-2">
                Medicine
                <select name="foundMedicineId" defaultValue="" className="mt-1 block h-12 w-full rounded-lg border-0 bg-white px-3 ring-1 ring-inset ring-ink-300">
                  <option value="">—</option>
                  {riskMedicines.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-sm font-medium text-ink-700">
                Batch number
                <input name="foundBatchNo" className="mt-1 block h-12 w-full rounded-lg border-0 px-3 uppercase ring-1 ring-inset ring-ink-300" />
              </label>
              <label className="block text-sm font-medium text-ink-700">
                Expiry (MM/YYYY)
                <input name="foundExpiry" placeholder="03/2027" className="mt-1 block h-12 w-full rounded-lg border-0 px-3 ring-1 ring-inset ring-ink-300" />
              </label>
              <label className="block text-sm font-medium text-ink-700">
                How many
                <input name="foundQuantity" inputMode="numeric" className="mt-1 block h-12 w-full rounded-lg border-0 px-3 ring-1 ring-inset ring-ink-300" />
              </label>
            </div>
          </details>

          <div className="flex flex-wrap gap-2">
            <Button type="submit" name="intent" value="save" variant="secondary" size="lg" className="flex-1">
              Save, keep counting
            </Button>
            <Button type="submit" name="intent" value="submit" variant="primary" size="lg" className="flex-1">
              Submit count
            </Button>
          </div>
          <Button type="submit" name="intent" value="cancel" variant="ghost" size="sm" className="text-ink-500">
            Cancel this count
          </Button>
        </form>
      ) : counting ? (
        <Card>
          <p className="p-4 text-sm text-ink-600 sm:p-5">
            {count.countedByName ?? 'Someone'} is counting this store. The numbers appear here once the count is submitted.
          </p>
        </Card>
      ) : (
        <>
          <Card>
            <CardHeader
              title="Shelf against the books"
              hint="Expected = books − used (from the register, earliest expiry first). Difference = counted − expected."
            />
            <div className="overflow-x-auto">
              <table className="w-full min-w-[34rem] text-sm">
                <thead>
                  <tr className="border-b border-ink-200 text-left text-xs uppercase tracking-wide text-ink-500">
                    <th className="px-4 py-2 sm:px-5">Medicine · batch</th>
                    <th className="px-2 py-2 text-right">Books</th>
                    <th className="px-2 py-2 text-right">Used</th>
                    <th className="px-2 py-2 text-right">Counted</th>
                    <th className="px-4 py-2 text-right sm:px-5">Difference</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-100">
                  {count.lines.map((line) => (
                    <tr key={line.batchId} className="align-top">
                      <td className="px-4 py-2.5 sm:px-5">
                        <span className="font-semibold text-ink-900">{line.label}</span>
                        <span className="numeric block text-xs text-ink-500">
                          Batch {line.batchNo} · exp {line.expiryDate}
                        </span>
                        {line.variance ? (
                          canExplain ? (
                            <form action={explainDifferenceAction} className="mt-2 flex flex-col gap-1.5 sm:flex-row">
                              <input type="hidden" name="countId" value={count.id} />
                              <input type="hidden" name="batchId" value={line.batchId} />
                              <select name="reasonCode" defaultValue={line.reasonCode ?? ''} required className="h-11 rounded-lg border-0 bg-white px-2 text-sm ring-1 ring-inset ring-ink-300">
                                <option value="" disabled>
                                  Why?
                                </option>
                                {Object.entries(VARIANCE_REASONS).map(([code, label]) => (
                                  <option key={code} value={code}>
                                    {label}
                                  </option>
                                ))}
                              </select>
                              <input name="reasonText" defaultValue={line.reasonText ?? ''} placeholder="What happened (optional)" className="h-11 flex-1 rounded-lg border-0 px-2 text-sm ring-1 ring-inset ring-ink-300" />
                              <Button type="submit" variant="secondary" size="sm" className="h-11">
                                Save
                              </Button>
                            </form>
                          ) : (
                            <span className="mt-1 block text-xs text-ink-600">
                              {line.reasonCode ? VARIANCE_REASONS[line.reasonCode] : 'No reason given'}
                              {line.reasonText ? ` — “${line.reasonText}”` : ''}
                            </span>
                          )
                        ) : null}
                      </td>
                      <td className="numeric px-2 py-2.5 text-right">{line.book}</td>
                      <td className="numeric px-2 py-2.5 text-right">{line.usedAllocated || ''}</td>
                      <td className="numeric px-2 py-2.5 text-right font-semibold">{line.counted}</td>
                      <td
                        className={cn(
                          'numeric px-4 py-2.5 text-right font-bold sm:px-5',
                          (line.variance ?? 0) < 0 ? 'text-rose-700' : (line.variance ?? 0) > 0 ? 'text-emerald-700' : 'text-ink-400',
                        )}
                      >
                        {line.variance ? `${line.variance > 0 ? '+' : ''}${line.variance}` : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {count.overUse.size > 0 ? (
              <p className="m-4 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900 ring-1 ring-amber-200 sm:m-5">
                The register says more was used than the books held:{' '}
                {[...count.overUse].map(([medicineId, extra]) => `${medicines.find((m) => m.id === medicineId)?.label ?? 'a medicine'} by ${extra}`).join(', ')}.
                Check for deliveries not taken in.
              </p>
            ) : null}
          </Card>

          {canApprove ? (
            <form action={approveCountAction} className="space-y-2">
              <input type="hidden" name="countId" value={count.id} />
              <Button type="submit" variant="primary" size="lg" className="w-full" disabled={unexplained > 0}>
                {unexplained > 0 ? `${unexplained} difference${unexplained === 1 ? ' needs' : 's need'} a reason first` : 'Approve this count'}
              </Button>
              <p className="text-xs text-ink-500">Approving posts the register’s use and each difference, so the books match the shelf.</p>
            </form>
          ) : count.status === 'submitted' ? (
            <p className="text-sm text-ink-600">
              {counter ? 'Someone else approves your count.' : 'A doctor or the owner approves this count.'}
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}

function ExpiryTag({ expiry }: { expiry: 'expired' | 'soon' | 'ok' }) {
  if (expiry === 'ok') return null;
  return (
    <span className={cn('ml-1.5 rounded px-1 text-xs font-semibold', expiry === 'expired' ? 'bg-rose-100 text-rose-800' : 'bg-amber-100 text-amber-900')}>
      {expiry === 'expired' ? 'EXPIRED' : 'expires soon'}
    </span>
  );
}
