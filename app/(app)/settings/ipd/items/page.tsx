import Link from 'next/link';
import { Alert, Button, Card, CardHeader, EmptyState, Field, Input, cn } from '@/components/ui';
import { CsvImport } from '@/components/ipd/csv-import';
import { requireSession } from '@/lib/auth/session';
import { formatRupees } from '@/lib/domain/billing';
import {
  CHARGE_ITEM_KINDS,
  CHARGE_ITEM_KIND_LABELS,
  isChargeItemKind,
  type ChargeItemKind,
} from '@/lib/domain/ipd-config';
import { can } from '@/lib/domain/permissions';
import { STARTER_CHARGE_ITEMS } from '@/lib/domain/starter-charge-items';
import {
  listChargeItems,
  type ChargeItemFilter,
  type ChargeItemRow,
} from '@/lib/services/ipd-config';
import {
  addStarterChargeItemsAction,
  createChargeItemAction,
  importChargeItemsAction,
  setChargeItemPricesAction,
  toggleChargeItemAction,
  updateChargeItemAction,
} from '../actions';

export const metadata = { title: 'IPD items and prices · Settings' };

const FILTERS: { value: ChargeItemFilter; label: string }[] = [
  { value: 'all', label: 'In use' },
  { value: 'unpriced', label: 'No price yet' },
  { value: 'inactive', label: 'Removed' },
];

const SELECT_CLASS =
  'block w-full rounded-lg border-0 bg-white px-3 py-2.5 text-sm text-ink-900 ring-1 ring-inset ring-ink-300 focus:ring-2 focus:ring-inset focus:ring-brand-600 focus:outline-none cursor-pointer';

/** "Set prices" shows this many rows per page, so one Save is never huge. */
const PRICE_PAGE_SIZE = 50;

/**
 * Settings → IPD → Items and prices (IPD plan §5.7, §5.8).
 *
 * Everything a nurse records that is not a medicine. A new hospital starts
 * with the common items already here, unpriced; the owner's job is the "Set
 * prices" view — one box per item, one Save. Nurses never see any of this:
 * an unpriced item is recorded normally and billed once it is priced.
 */
export default async function IpdItemsPage({ searchParams }: PageProps<'/settings/ipd/items'>) {
  const session = await requireSession();
  const params = await searchParams;

  if (!can(session.role, 'billing.price')) {
    return (
      <Card>
        <EmptyState title="Owners only" hint="Only the hospital owner sets what items cost." />
      </Card>
    );
  }

  const q = typeof params.q === 'string' ? params.q : '';
  const pricing = params.mode === 'prices';
  const filter: ChargeItemFilter = pricing
    ? 'unpriced'
    : params.filter === 'unpriced' || params.filter === 'inactive'
      ? params.filter
      : 'all';
  const kind: ChargeItemKind | null =
    typeof params.kind === 'string' && isChargeItemKind(params.kind) ? params.kind : null;

  const { rows, counts } = await listChargeItems({ hospitalId: session.hospitalId, query: q, filter, kind });
  const countFor: Record<ChargeItemFilter, number> = {
    all: counts.total,
    unpriced: counts.unpriced,
    inactive: counts.inactive,
  };
  const linkFor = (next: { filter?: ChargeItemFilter; kind?: ChargeItemKind | null; mode?: string }) => {
    const query = new URLSearchParams();
    const nextFilter = next.filter ?? filter;
    const nextKind = next.kind === undefined ? kind : next.kind;
    if (next.mode) query.set('mode', next.mode);
    else if (nextFilter !== 'all') query.set('filter', nextFilter);
    if (nextKind) query.set('kind', nextKind);
    if (q) query.set('q', q);
    const text = query.toString();
    return `/settings/ipd/items${text ? `?${text}` : ''}`;
  };

  return (
    <div className="space-y-5">
      <div>
        <Link href="/settings/ipd" className="text-sm text-ink-500 hover:text-ink-800">
          ← Wards and beds
        </Link>
        <h1 className="mt-1 text-xl font-bold text-ink-900">IPD items and prices</h1>
        <p className="mt-0.5 text-sm text-ink-500">
          What nurses record at the bedside, and what each costs. Medicines have{' '}
          <Link href="/settings/medicines" className="font-medium text-brand-700 underline">
            their own list
          </Link>
          .
        </p>
      </div>

      {typeof params.error === 'string' ? <Alert tone="error">{params.error}</Alert> : null}
      {typeof params.saved === 'string' ? <Alert tone="success">{params.saved}</Alert> : null}

      {counts.total === 0 && counts.inactive === 0 ? (
        <Card>
          <div className="flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="font-semibold text-ink-900">
                Start with {STARTER_CHARGE_ITEMS.length} common items
              </p>
              <p className="text-sm text-ink-600">
                Syringes, cannulas, dressings, nebulisation, oxygen, common tests and room charges —
                added without prices. Then set the prices on one screen.
              </p>
            </div>
            <form action={addStarterChargeItemsAction}>
              <Button type="submit" variant="primary" size="lg">
                Add common items
              </Button>
            </form>
          </div>
        </Card>
      ) : counts.unpriced > 0 && !pricing ? (
        <Card>
          <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5">
            <p className="text-sm text-ink-700">
              <span className="numeric font-semibold text-amber-800">{counts.unpriced}</span> item
              {counts.unpriced === 1 ? ' has' : 's have'} no price yet. Nurses can still record them;
              they are billed once priced.
            </p>
            <Link href={linkFor({ mode: 'prices' })}>
              <Button variant="primary" size="lg" className="w-full sm:w-auto">
                Set prices
              </Button>
            </Link>
          </div>
        </Card>
      ) : null}

      <Card>
        <div className="space-y-3 border-b border-ink-200 p-4 sm:px-5">
          <div className="flex flex-wrap gap-1.5">
            {pricing ? (
              <Link
                href={linkFor({ filter: 'all', mode: '' })}
                className="rounded-full bg-ink-100 px-3 py-1.5 text-sm font-medium text-ink-700 hover:bg-ink-200"
              >
                ← Back to the list
              </Link>
            ) : (
              FILTERS.map((option) => (
                <Link
                  key={option.value}
                  href={linkFor({ filter: option.value })}
                  className={cn(
                    'rounded-full px-3 py-1.5 text-sm font-medium',
                    filter === option.value
                      ? 'bg-brand-600 text-white'
                      : 'bg-ink-100 text-ink-700 hover:bg-ink-200',
                  )}
                >
                  {option.label} <span className="numeric opacity-80">{countFor[option.value]}</span>
                </Link>
              ))
            )}
          </div>
          <div className="flex flex-wrap gap-1.5">
            <KindChip href={linkFor({ kind: null, mode: pricing ? 'prices' : undefined })} active={kind === null}>
              All kinds
            </KindChip>
            {CHARGE_ITEM_KINDS.map((value) => (
              <KindChip
                key={value}
                href={linkFor({ kind: value, mode: pricing ? 'prices' : undefined })}
                active={kind === value}
              >
                {CHARGE_ITEM_KIND_LABELS[value]}
              </KindChip>
            ))}
          </div>
          <form className="flex gap-2">
            {pricing ? <input type="hidden" name="mode" value="prices" /> : null}
            {!pricing && filter !== 'all' ? <input type="hidden" name="filter" value={filter} /> : null}
            {kind ? <input type="hidden" name="kind" value={kind} /> : null}
            <Input name="q" defaultValue={q} placeholder="Search items" className="py-2" />
            <Button type="submit">Search</Button>
          </form>
        </div>

        {pricing ? (
          <SetPricesForm rows={rows.slice(0, PRICE_PAGE_SIZE)} q={q} kind={kind} more={rows.length > PRICE_PAGE_SIZE} />
        ) : rows.length === 0 ? (
          <EmptyState
            title={q ? 'No items match' : filter === 'unpriced' ? 'Every item has a price' : 'Nothing here'}
            hint={q ? 'Try a shorter search.' : undefined}
          />
        ) : (
          <ul className="divide-y divide-ink-200">
            {rows.map((row) => (
              <ItemRow key={row.id} row={row} q={q} filter={filter} kind={kind} />
            ))}
          </ul>
        )}
      </Card>

      {!pricing ? (
        <>
          <Card>
            <CardHeader title="Add an item" />
            <form action={createChargeItemAction} className="grid grid-cols-2 gap-3 p-4 sm:grid-cols-6 sm:p-5">
              <div className="col-span-2 sm:col-span-2">
                <Field label="Name">
                  <Input name="name" required placeholder="Syringe 5 ml" />
                </Field>
              </div>
              <Field label="Kind">
                <select name="kind" className={SELECT_CLASS} defaultValue={kind ?? 'consumable'}>
                  {CHARGE_ITEM_KINDS.map((value) => (
                    <option key={value} value={value}>
                      {CHARGE_ITEM_KIND_LABELS[value]}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Unit">
                <Input name="unit" placeholder="syringe" />
              </Field>
              <Field label="Price (₹)">
                <Input name="price" inputMode="decimal" placeholder="Blank = later" />
              </Field>
              <Field label="Tax %">
                <Input name="tax" inputMode="decimal" placeholder="0" />
              </Field>
              <label className="col-span-2 flex items-center gap-2 text-sm text-ink-700 sm:col-span-4">
                <input type="checkbox" name="isTest" className="size-4 accent-brand-600" />
                This is a lab or imaging test (a service the doctor can order)
              </label>
              <div className="col-span-2 sm:col-span-2 sm:text-right">
                <Button type="submit" variant="primary" className="w-full sm:w-auto">
                  Add item
                </Button>
              </div>
            </form>
          </Card>

          <Card>
            <CardHeader
              title="Import a price list"
              hint="Existing names get the new price; new names are added."
            />
            <div className="p-4 sm:p-5">
              <CsvImport action={importChargeItemsAction} />
            </div>
          </Card>

          {counts.total > 0 ? (
            <form action={addStarterChargeItemsAction} className="text-right">
              <button type="submit" className="text-sm text-ink-500 underline hover:text-ink-800">
                Add any missing common items
              </button>
            </form>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function KindChip({ href, active, children }: { href: string; active: boolean; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className={cn(
        'rounded-md px-2.5 py-1 text-xs font-medium ring-1 ring-inset',
        active ? 'bg-brand-50 text-brand-800 ring-brand-300' : 'bg-white text-ink-600 ring-ink-200 hover:bg-ink-50',
      )}
    >
      {children}
    </Link>
  );
}

/**
 * One box per unpriced item and a single Save: the fastest way through a
 * fresh starter list. A blank box is skipped, never saved as free.
 */
function SetPricesForm({
  rows,
  q,
  kind,
  more,
}: {
  rows: ChargeItemRow[];
  q: string;
  kind: ChargeItemKind | null;
  more: boolean;
}) {
  if (rows.length === 0) {
    return <EmptyState title="Every item has a price" hint="New items added at the bedside will appear here." />;
  }
  return (
    <form action={setChargeItemPricesAction}>
      <input type="hidden" name="_mode" value="prices" />
      <input type="hidden" name="_q" value={q} />
      <input type="hidden" name="_kind" value={kind ?? ''} />
      <ul className="divide-y divide-ink-200">
        {rows.map((row) => (
          <li key={row.id} className="flex items-center justify-between gap-3 px-4 py-2.5 sm:px-5">
            <label htmlFor={`price-${row.id}`} className="min-w-0">
              <span className="block truncate font-medium text-ink-900">{row.name}</span>
              <span className="text-xs text-ink-500">
                {row.isTest ? 'Test' : CHARGE_ITEM_KIND_LABELS[row.kind]} · per {row.unit}
              </span>
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
          Blank boxes are skipped.{more ? ` Showing the first ${PRICE_PAGE_SIZE}; save to see the rest.` : ''}
        </p>
        <Button type="submit" variant="primary" size="lg" className="w-full sm:w-auto">
          Save prices
        </Button>
      </div>
    </form>
  );
}

function ItemRow({
  row,
  q,
  filter,
  kind,
}: {
  row: ChargeItemRow;
  q: string;
  filter: ChargeItemFilter;
  kind: ChargeItemKind | null;
}) {
  const price = row.sellingPricePaise === null ? '' : (row.sellingPricePaise / 100).toFixed(2);
  const tax = row.taxRateBp ? String(row.taxRateBp / 100) : '';
  const keep = (
    <>
      <input type="hidden" name="chargeItemId" value={row.id} />
      <input type="hidden" name="_q" value={q} />
      <input type="hidden" name="_filter" value={filter} />
      <input type="hidden" name="_kind" value={kind ?? ''} />
    </>
  );

  return (
    <li className={cn('space-y-2 p-4 sm:px-5', !row.active && 'bg-ink-50/60')}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="font-semibold text-ink-900">{row.name}</p>
          <p className="text-xs text-ink-500">
            {row.isTest ? 'Test' : CHARGE_ITEM_KIND_LABELS[row.kind]} ·{' '}
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
            <form action={updateChargeItemAction} className="flex items-center gap-2">
              {keep}
              <input type="hidden" name="name" value={row.name} />
              <input type="hidden" name="kind" value={row.kind} />
              <input type="hidden" name="unit" value={row.unit} />
              <input type="hidden" name="tax" value={tax} />
              {row.isTest ? <input type="hidden" name="isTest" value="on" /> : null}
              <span className="text-sm text-ink-500">₹</span>
              <Input
                name="price"
                defaultValue={price}
                inputMode="decimal"
                aria-label={`Price of ${row.name}`}
                placeholder="Price"
                className="w-24 py-1.5"
              />
              <Button type="submit" size="sm" variant="secondary">
                Save
              </Button>
            </form>
          ) : null}
          <form action={toggleChargeItemAction}>
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
          <form action={updateChargeItemAction} className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-5">
            {keep}
            <div className="col-span-2">
              <Field label="Name">
                <Input name="name" required defaultValue={row.name} />
              </Field>
            </div>
            <Field label="Kind">
              <select name="kind" className={SELECT_CLASS} defaultValue={row.kind}>
                {CHARGE_ITEM_KINDS.map((value) => (
                  <option key={value} value={value}>
                    {CHARGE_ITEM_KIND_LABELS[value]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Unit">
              <Input name="unit" defaultValue={row.unit} />
            </Field>
            <Field label="Tax %">
              <Input name="tax" defaultValue={tax} inputMode="decimal" />
            </Field>
            <input type="hidden" name="price" value={price} />
            <label className="col-span-2 flex items-center gap-2 text-sm text-ink-700 sm:col-span-3">
              <input type="checkbox" name="isTest" defaultChecked={row.isTest} className="size-4 accent-brand-600" />
              Lab or imaging test
            </label>
            <div className="col-span-2">
              <Button type="submit">Save details</Button>
            </div>
          </form>
        </details>
      ) : null}
    </li>
  );
}
