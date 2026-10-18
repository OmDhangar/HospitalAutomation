import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Alert, Button, Card, CardHeader, EmptyState, cn } from '@/components/ui';
import { requireModule } from '@/lib/auth/modules';
import { requireSession } from '@/lib/auth/session';
import { can } from '@/lib/domain/permissions';
import { LOCATION_KINDS, RISK_KINDS } from '@/lib/domain/stock';
import { listBranches } from '@/lib/services/auth';
import { listWardSetup } from '@/lib/services/ipd-config';
import { listLocations, listMedicinesForStock, listRiskClasses } from '@/lib/services/stock';
import { createLocationAction, createRiskClassAction, setLocationActiveAction, setMedicineRiskClassAction, setRiskClassWitnessAction } from './actions';

export const metadata = { title: 'Stock · Settings' };

const field = 'mt-1 block h-11 w-full rounded-lg border-0 bg-white px-3 text-sm ring-1 ring-inset ring-ink-300';

/**
 * Settings → Stock (IPD sheets plan B4a): the stores (main store, a store per
 * ward, crash carts), the risk classes and how often each is counted, and
 * which medicines belong to them. Decision D-RISK: NDPS ENDs held,
 * psychotropics in stock, and 5–10 high-value items; the hospital finalises.
 */
export default async function StockSettingsPage({ searchParams }: PageProps<'/settings/stock'>) {
  const session = await requireSession();
  await requireModule(session, 'stock');
  if (!can(session.role, 'stock.configure')) notFound();
  const query = await searchParams;
  const q = typeof query.q === 'string' ? query.q.trim().toLowerCase() : '';

  const [locations, classes, medicines, branches, wards] = await Promise.all([
    listLocations(session.hospitalId, { includeInactive: true }),
    listRiskClasses(session.hospitalId),
    listMedicinesForStock(session.hospitalId),
    listBranches(session.hospitalId),
    listWardSetup(session.hospitalId),
  ]);
  const inClass = medicines.filter((m) => m.riskClassId);
  const shown = (q ? medicines.filter((m) => m.label.toLowerCase().includes(q)) : inClass).slice(0, 60);

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <Link href="/settings" className="inline-flex min-h-11 items-center text-sm text-ink-500 hover:text-ink-800">
        ← Settings
      </Link>
      <div>
        <h1 className="text-xl font-bold text-ink-900">Stock</h1>
        <p className="text-sm text-ink-600">Where risk-class medicines are kept, which medicines are risk-class, and how often they are counted.</p>
      </div>
      {typeof query.saved === 'string' ? <Alert tone="success">{query.saved}</Alert> : null}
      {typeof query.error === 'string' ? <Alert tone="error">{query.error}</Alert> : null}

      <Card>
        <CardHeader title="Stores" hint="Every place risk-class stock is kept. A store that still holds stock cannot be closed." />
        {locations.length > 0 ? (
          <ul className="divide-y divide-ink-100">
            {locations.map((l) => (
              <li key={l.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-sm sm:px-5">
                <span className={cn(!l.active && 'text-ink-400')}>
                  <strong>{l.name}</strong> · {LOCATION_KINDS[l.kind]}
                  {l.wardName ? ` · ${l.wardName}` : ''} · {l.branchName}
                  {l.active ? '' : ' · closed'}
                </span>
                <form action={setLocationActiveAction}>
                  <input type="hidden" name="locationId" value={l.id} />
                  <input type="hidden" name="active" value={String(!l.active)} />
                  <Button type="submit" variant="ghost" size="sm" className="h-11">
                    {l.active ? 'Close' : 'Reopen'}
                  </Button>
                </form>
              </li>
            ))}
          </ul>
        ) : null}
        <form action={createLocationAction} className="grid gap-3 border-t border-ink-100 p-4 sm:grid-cols-4 sm:p-5">
          <label className="block text-sm font-medium text-ink-700 sm:col-span-2">
            Name
            <input name="name" required maxLength={60} placeholder="e.g. Main store, Ward A cupboard" className={field} />
          </label>
          <label className="block text-sm font-medium text-ink-700">
            Kind
            <select name="kind" defaultValue={locations.some((l) => l.kind === 'main_store') ? 'ward_store' : 'main_store'} className={field}>
              {Object.entries(LOCATION_KINDS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm font-medium text-ink-700">
            Branch
            <select name="branchId" defaultValue={session.branchId ?? branches[0]?.id} className={field}>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm font-medium text-ink-700 sm:col-span-2">
            Ward (for a ward store)
            <select name="wardId" defaultValue="" className={field}>
              <option value="">—</option>
              {wards.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </label>
          <div className="flex items-end sm:col-span-2">
            <Button type="submit" variant="primary" className="h-11 w-full">
              Add store
            </Button>
          </div>
        </form>
      </Card>

      <Card>
        <CardHeader title="Risk classes" hint="Daily classes are counted every morning at shift change; weekly ones once a week." />
        {classes.length > 0 ? (
          <ul className="divide-y divide-ink-100">
            {classes.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-sm sm:px-5">
                <span>
                  <strong>{c.name}</strong> · {RISK_KINDS[c.kind]} · counted {c.countEvery} · {c.medicines} medicine{c.medicines === 1 ? '' : 's'}
                  {c.kind === 'ndps' || c.witnessAtGive ? ' · witness at every give' : ''}
                </span>
                {c.kind !== 'ndps' ? (
                  <form action={setRiskClassWitnessAction}>
                    <input type="hidden" name="riskClassId" value={c.id} />
                    <input type="hidden" name="witnessAtGive" value={String(!c.witnessAtGive)} />
                    <Button type="submit" variant="ghost" size="sm" className="h-11">
                      {c.witnessAtGive ? 'No witness at give' : 'Witness at every give'}
                    </Button>
                  </form>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
        <form action={createRiskClassAction} className="grid gap-3 border-t border-ink-100 p-4 sm:grid-cols-4 sm:p-5">
          <label className="block text-sm font-medium text-ink-700 sm:col-span-2">
            Name
            <input name="name" required maxLength={60} placeholder="e.g. Narcotics (NDPS)" className={field} />
          </label>
          <label className="block text-sm font-medium text-ink-700">
            Kind
            <select name="kind" defaultValue="ndps" className={field}>
              {Object.entries(RISK_KINDS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm font-medium text-ink-700">
            Counted
            <select name="countEvery" defaultValue="daily" className={field}>
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
            </select>
          </label>
          <div className="sm:col-span-4">
            <Button type="submit" variant="primary" className="h-11">
              Add risk class
            </Button>
          </div>
        </form>
      </Card>

      <Card>
        <CardHeader title="Medicines in a risk class" hint={q ? 'Search results' : 'Search the medicine list to add one'} />
        <form method="get" className="flex gap-2 px-4 pb-3 sm:px-5">
          <input name="q" defaultValue={q} placeholder="Search medicines, e.g. morphine" className="h-11 flex-1 rounded-lg border-0 px-3 text-sm ring-1 ring-inset ring-ink-300" />
          <Button type="submit" variant="secondary" className="h-11">
            Search
          </Button>
        </form>
        {classes.length === 0 ? (
          <EmptyState title="Add a risk class first" />
        ) : shown.length === 0 ? (
          <EmptyState title={q ? 'No medicine matches' : 'No medicine is in a risk class yet'} hint={q ? 'Medicines are added under Settings → Medicines.' : undefined} />
        ) : (
          <ul className="divide-y divide-ink-100 border-t border-ink-100">
            {shown.map((m) => (
              <li key={m.id}>
                <form action={setMedicineRiskClassAction} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 text-sm sm:px-5">
                  <input type="hidden" name="medicineId" value={m.id} />
                  <input type="hidden" name="q" value={q} />
                  <span className="min-w-0 font-semibold text-ink-900">{m.label}</span>
                  <span className="flex gap-2">
                    <select name="riskClassId" defaultValue={m.riskClassId ?? ''} aria-label={`Risk class of ${m.label}`} className="h-11 rounded-lg border-0 bg-white px-2 text-sm ring-1 ring-inset ring-ink-300">
                      <option value="">Not risk-class</option>
                      {classes.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                    <Button type="submit" variant="secondary" size="sm" className="h-11">
                      Save
                    </Button>
                  </span>
                </form>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
