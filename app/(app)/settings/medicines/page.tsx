import Link from 'next/link';
import { Alert, Button, Card, CardHeader, EmptyState, Field, Input, cn } from '@/components/ui';
import { requireSession } from '@/lib/auth/session';
import { formatRupees } from '@/lib/domain/billing';
import { can } from '@/lib/domain/permissions';
import { STARTER_MEDICINES } from '@/lib/domain/starter-medicines';
import { listCatalogue, type CatalogueFilter, type CatalogueRow } from '@/lib/services/medicines';
import {
  addStarterMedicinesAction,
  createMedicineAction,
  setMedicinePricesAction,
  toggleMedicineAction,
  updateMedicineAction,
} from './actions';

export const metadata = { title: 'Medicines · Settings' };

const FILTERS: { value: CatalogueFilter; label: string }[] = [
  { value: 'all', label: 'In use' },
  { value: 'unpriced', label: 'No price yet' },
  { value: 'inactive', label: 'Removed' },
];

/**
 * The hospital's medicine list: what doctors can prescribe, and what the
 * billing desk will charge for each.
 *
 * Prices live only here. A doctor who adds a missing medicine from the
 * prescription screen adds it without a price, and it shows up under "No price
 * yet" for the owner to fill in. Changing a price never alters a bill already
 * issued, and removing a medicine never alters an old prescription.
 */
export default async function MedicinesPage({ searchParams }: PageProps<'/settings/medicines'>) {
  const session = await requireSession();
  const params = await searchParams;

  if (!can(session.role, 'medicines.manage')) {
    return (
      <Card>
        <EmptyState title="Owners only" hint="Ask the hospital owner to update the medicine list." />
      </Card>
    );
  }

  const q = typeof params.q === 'string' ? params.q : '';
  // "Set prices": every unpriced medicine with a box, and one Save.
  const pricing = params.mode === 'prices';
  const filter: CatalogueFilter = pricing
    ? 'unpriced'
    : params.filter === 'unpriced' || params.filter === 'inactive'
      ? params.filter
      : 'all';
  const { rows, counts } = await listCatalogue({ hospitalId: session.hospitalId, query: q, filter });
  const countFor: Record<CatalogueFilter, number> = {
    all: counts.total,
    unpriced: counts.unpriced,
    inactive: counts.inactive,
  };
  const linkFor = (next: CatalogueFilter) => {
    const query = new URLSearchParams();
    if (next !== 'all') query.set('filter', next);
    if (q) query.set('q', q);
    const text = query.toString();
    return `/settings/medicines${text ? `?${text}` : ''}`;
  };

  return (
    <div className="space-y-5">
      <div>
        <Link href="/settings" className="text-sm text-ink-500 hover:text-ink-800">
          ← Settings
        </Link>
        <h1 className="mt-1 text-xl font-bold text-ink-900">Medicines</h1>
        <p className="mt-0.5 text-sm text-ink-500">
          What doctors can prescribe, and what the billing desk charges for each.
        </p>
      </div>

      {typeof params.error === 'string' ? <Alert tone="error">{params.error}</Alert> : null}
      {typeof params.saved === 'string' ? <Alert tone="success">{params.saved}</Alert> : null}

      {counts.total === 0 && counts.inactive === 0 ? (
        <Card>
          <div className="flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="font-semibold text-ink-900">Start with {STARTER_MEDICINES.length} common medicines</p>
              <p className="text-sm text-ink-600">
                Paracetamol, antibiotics, antacids, IV fluids and more — added without prices, so
                doctors can prescribe them today. Add prices for the ones you stock.
              </p>
            </div>
            <form action={addStarterMedicinesAction}>
              <Button type="submit" variant="primary">
                Add common medicines
              </Button>
            </form>
          </div>
        </Card>
      ) : counts.unpriced > 0 && !pricing ? (
        <Card>
          <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5">
            <p className="text-sm text-ink-700">
              <span className="numeric font-semibold text-amber-800">{counts.unpriced}</span> medicine
              {counts.unpriced === 1 ? ' has' : 's have'} no price yet. They can be prescribed and
              recorded on the ward; they are billed once priced.
            </p>
            <Link href={`/settings/medicines?mode=prices${q ? `&q=${encodeURIComponent(q)}` : ''}`}>
              <Button variant="primary" size="lg" className="w-full sm:w-auto">
                Set prices
              </Button>
            </Link>
          </div>
        </Card>
      ) : null}

      {pricing ? (
        <Card>
          <CardHeader
            title="Set prices"
            hint="One box per medicine without a price. Blank boxes are skipped."
            action={
              <Link href="/settings/medicines" className="text-sm font-medium text-brand-700 hover:underline">
                Done
              </Link>
            }
          />
          {rows.length === 0 ? (
            <EmptyState title="Every medicine has a price" />
          ) : (
            <form action={setMedicinePricesAction}>
              <input type="hidden" name="_mode" value="prices" />
              <input type="hidden" name="_q" value={q} />
              <ul className="divide-y divide-ink-200">
                {rows.slice(0, 50).map((row) => (
                  <li key={row.id} className="flex items-center justify-between gap-3 px-4 py-2.5 sm:px-5">
                    <label htmlFor={`price-${row.id}`} className="min-w-0">
                      <span className="block truncate font-medium text-ink-900">{row.label}</span>
                      <span className="text-xs text-ink-500">per {row.unit}</span>
                    </label>
                    <span className="flex shrink-0 items-center gap-1.5">
                      <span className="text-sm text-ink-500">₹</span>
                      <Input
                        id={`price-${row.id}`}
                        name={`price:${row.id}`}
                        inputMode="decimal"
                        placeholder="0.00"
                        className="numeric h-12 w-28 text-right"
                      />
                    </span>
                  </li>
                ))}
              </ul>
              <div className="sticky bottom-0 flex flex-col gap-2 border-t border-ink-200 bg-white px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:flex-row sm:items-center sm:justify-between sm:px-5">
                <p className="text-xs text-ink-500">
                  {rows.length > 50 ? 'Showing the first 50; save to see the rest.' : 'Bills already issued keep their old price.'}
                </p>
                <Button type="submit" variant="primary" size="lg" className="w-full sm:w-auto">
                  Save prices
                </Button>
              </div>
            </form>
          )}
        </Card>
      ) : null}

      {pricing ? null : (
      <>
      <Card>
        <CardHeader title="Add a medicine" />
        <form action={createMedicineAction} className="grid grid-cols-2 gap-3 p-4 sm:grid-cols-4 sm:p-5">
          <input type="hidden" name="_q" value={q} />
          <input type="hidden" name="_filter" value={filter} />
          <div className="col-span-2">
            <Field label="Name">
              <Input name="name" required placeholder="Paracetamol" />
            </Field>
          </div>
          <Field label="Strength">
            <Input name="strength" placeholder="500 mg" />
          </Field>
          <Field label="Form">
            <Input name="form" placeholder="tablet" />
          </Field>
          <div className="col-span-2">
            <Field label="Generic name" hint="Optional. Doctors can search by it.">
              <Input name="genericName" placeholder="—" />
            </Field>
          </div>
          <Field label="Sold per" hint="What one unit on a bill means">
            <Input name="unit" placeholder="tablet" />
          </Field>
          <Field label="Price (₹)" hint="Blank = not priced yet">
            <Input name="price" inputMode="decimal" placeholder="2.00" />
          </Field>
          <Field label="Tax %" hint="Blank = none">
            <Input name="tax" inputMode="decimal" placeholder="0" />
          </Field>
          <div className="col-span-2 flex items-end sm:col-span-3 sm:justify-end">
            <Button type="submit" variant="primary">
              Add medicine
            </Button>
          </div>
        </form>
      </Card>

      <Card>
        <div className="flex flex-col gap-3 border-b border-ink-200 p-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
          <nav className="flex gap-1.5">
            {FILTERS.map((option) => (
              <Link
                key={option.value}
                href={linkFor(option.value)}
                className={cn(
                  'rounded-lg px-3 py-1.5 text-sm font-medium',
                  filter === option.value
                    ? 'bg-brand-600 text-white'
                    : 'bg-ink-100 text-ink-700 hover:bg-ink-200',
                )}
              >
                {option.label} ({countFor[option.value]})
              </Link>
            ))}
          </nav>
          <form className="flex gap-2">
            {filter !== 'all' ? <input type="hidden" name="filter" value={filter} /> : null}
            <Input name="q" defaultValue={q} placeholder="Search medicines" className="py-1.5" />
            <Button type="submit" size="sm" variant="secondary">
              Search
            </Button>
          </form>
        </div>

        {rows.length === 0 ? (
          <EmptyState
            title={q ? 'No medicines match' : filter === 'unpriced' ? 'Every medicine has a price' : 'Nothing here'}
            hint={q ? 'Try a shorter search.' : undefined}
          />
        ) : (
          <ul className="divide-y divide-ink-200">
            {rows.map((row) => (
              <MedicineRow key={row.id} row={row} q={q} filter={filter} />
            ))}
          </ul>
        )}
      </Card>

      </>
      )}

      {counts.total > 0 && !pricing ? (
        <form action={addStarterMedicinesAction} className="text-right">
          <input type="hidden" name="_q" value={q} />
          <input type="hidden" name="_filter" value={filter} />
          <button type="submit" className="text-sm text-ink-500 underline hover:text-ink-800">
            Add any missing common medicines
          </button>
        </form>
      ) : null}
    </div>
  );
}

/**
 * One medicine. The price is editable in place because it is what the owner
 * changes most; everything else sits behind "Edit details". Both forms post
 * every field, so a save never clears a value that was not on screen.
 */
function MedicineRow({ row, q, filter }: { row: CatalogueRow; q: string; filter: CatalogueFilter }) {
  const price = row.sellingPricePaise === null ? '' : (row.sellingPricePaise / 100).toFixed(2);
  const tax = row.taxRateBp ? String(row.taxRateBp / 100) : '';
  const keep = (
    <>
      <input type="hidden" name="medicineId" value={row.id} />
      <input type="hidden" name="_q" value={q} />
      <input type="hidden" name="_filter" value={filter} />
    </>
  );

  return (
    <li className={cn('space-y-2 p-4 sm:px-5', !row.active && 'bg-ink-50/60')}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="font-semibold text-ink-900">{row.label}</p>
          <p className="text-xs text-ink-500">
            {row.genericName ? `${row.genericName} · ` : ''}
            {row.sellingPricePaise === null ? (
              <span className="font-semibold text-amber-800">No price yet</span>
            ) : (
              <>
                {formatRupees(row.sellingPricePaise)} per {row.unit}
                {row.taxRateBp ? ` + ${row.taxRateBp / 100}% tax` : ''}
              </>
            )}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {row.active ? (
            <form action={updateMedicineAction} className="flex items-center gap-2">
              {keep}
              <input type="hidden" name="name" value={row.name} />
              <input type="hidden" name="genericName" value={row.genericName ?? ''} />
              <input type="hidden" name="strength" value={row.strength ?? ''} />
              <input type="hidden" name="form" value={row.form ?? ''} />
              <input type="hidden" name="unit" value={row.unit} />
              <input type="hidden" name="tax" value={tax} />
              <span className="text-sm text-ink-500">₹</span>
              <Input
                name="price"
                defaultValue={price}
                inputMode="decimal"
                aria-label={`Price of ${row.label}`}
                placeholder="Price"
                className="w-24 py-1.5"
              />
              <Button type="submit" size="sm" variant="secondary">
                Save
              </Button>
            </form>
          ) : null}
          <form action={toggleMedicineAction}>
            {keep}
            <input type="hidden" name="active" value={row.active ? 'false' : 'true'} />
            <Button type="submit" size="sm" variant="ghost">
              {row.active ? 'Remove' : 'Restore'}
            </Button>
          </form>
        </div>
      </div>

      {row.active ? (
        <details className="text-sm">
          <summary className="cursor-pointer text-xs text-ink-500 hover:text-ink-800">Edit details</summary>
          <form action={updateMedicineAction} className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {keep}
            <div className="col-span-2">
              <Field label="Name">
                <Input name="name" defaultValue={row.name} required />
              </Field>
            </div>
            <Field label="Strength">
              <Input name="strength" defaultValue={row.strength ?? ''} />
            </Field>
            <Field label="Form">
              <Input name="form" defaultValue={row.form ?? ''} />
            </Field>
            <div className="col-span-2">
              <Field label="Generic name">
                <Input name="genericName" defaultValue={row.genericName ?? ''} />
              </Field>
            </div>
            <Field label="Sold per">
              <Input name="unit" defaultValue={row.unit} />
            </Field>
            <Field label="Price (₹)">
              <Input name="price" defaultValue={price} inputMode="decimal" />
            </Field>
            <Field label="Tax %">
              <Input name="tax" defaultValue={tax} inputMode="decimal" />
            </Field>
            <div className="col-span-2 flex items-end sm:col-span-3 sm:justify-end">
              <Button type="submit" size="sm" variant="primary">
                Save details
              </Button>
            </div>
          </form>
        </details>
      ) : null}
    </li>
  );
}
