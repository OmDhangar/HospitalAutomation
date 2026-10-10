import Link from 'next/link';
import { Alert, Button, Card, EmptyState } from '@/components/ui';
import { requireModule } from '@/lib/auth/modules';
import { requireSession } from '@/lib/auth/session';
import { can } from '@/lib/domain/permissions';
import { ADJUST_REASONS } from '@/lib/domain/stock';
import { serviceDateIn } from '@/lib/domain/time';
import { getOnHand, listLocations } from '@/lib/services/stock';
import { requestAdjustmentAction } from '../actions';

export const metadata = { title: 'Adjust · Stock' };

const field = 'mt-1 block h-12 w-full rounded-lg border-0 bg-white px-3 text-base ring-1 ring-inset ring-ink-300';

/**
 * Stock that leaves or turns up outside a count: expired, broken, returned to
 * the supplier, found (IPD sheets plan B4a). Asked here; a second person
 * approves it on the stock page before anything moves.
 */
export default async function AdjustPage({ searchParams }: PageProps<'/ipd/stock/adjust'>) {
  const session = await requireSession();
  await requireModule(session, 'stock', 'write');
  const query = await searchParams;
  if (!can(session.role, 'stock.move') || session.readOnly) {
    return (
      <Card>
        <EmptyState title="Not available" hint="Your login cannot adjust stock." />
      </Card>
    );
  }
  const locations = await listLocations(session.hospitalId);
  const location = typeof query.location === 'string' && locations.some((l) => l.id === query.location) ? query.location : null;
  const onHand = location ? await getOnHand(session.hospitalId, location, serviceDateIn(session.timezone)) : [];

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <Link href="/ipd/stock" className="inline-flex min-h-11 items-center text-sm text-ink-500 hover:text-ink-800">
        ← Stock
      </Link>
      <h1 className="text-xl font-bold text-ink-900">Expired, broken, returned or found</h1>
      <p className="text-sm text-ink-600">Nothing moves until a second person approves it.</p>
      {typeof query.error === 'string' ? <Alert tone="error">{query.error}</Alert> : null}

      <form method="get" className="flex items-end gap-2 rounded-xl bg-white p-4 ring-1 ring-ink-200 sm:p-5">
        <label className="block flex-1 text-sm font-medium text-ink-700">
          Store
          <select name="location" defaultValue={location ?? ''} className={field}>
            <option value="" disabled>
              Choose a store
            </option>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </label>
        <Button type="submit" variant="secondary" className="h-12">
          Show stock
        </Button>
      </form>

      {location ? (
        onHand.length === 0 ? (
          <Card>
            <EmptyState title="Nothing held here" hint="To record stock that turned up in an empty store, count the store instead and add the batch you found." />
          </Card>
        ) : (
          <form action={requestAdjustmentAction} className="grid gap-3 rounded-xl bg-white p-4 ring-1 ring-ink-200 sm:grid-cols-2 sm:p-5">
            <input type="hidden" name="locationId" value={location} />
            <input type="hidden" name="clientId" value={crypto.randomUUID()} />
            <label className="block text-sm font-medium text-ink-700 sm:col-span-2">
              Medicine and batch
              <select name="batchId" required defaultValue="" className={field}>
                <option value="" disabled>
                  Choose
                </option>
                {onHand.map((b) => (
                  <option key={b.batchId} value={b.batchId}>
                    {b.label} · batch {b.batchNo} · exp {b.expiryDate} · {b.quantity} here
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-sm font-medium text-ink-700">
              Why
              <select name="reasonCode" required defaultValue="" className={field}>
                <option value="" disabled>
                  Choose
                </option>
                {Object.entries(ADJUST_REASONS).map(([code, reason]) => (
                  <option key={code} value={code}>
                    {reason.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-sm font-medium text-ink-700">
              Take out or add
              <select name="direction" defaultValue="out" className={field}>
                <option value="out">Take out</option>
                <option value="in">Add</option>
              </select>
            </label>
            <label className="block text-sm font-medium text-ink-700">
              How many
              <input name="quantity" required inputMode="numeric" className={field} />
            </label>
            <label className="block text-sm font-medium text-ink-700">
              Note
              <input name="reasonText" maxLength={200} placeholder="e.g. ampoule broke while drawing" className={field} />
            </label>
            <Button type="submit" variant="primary" size="lg" className="sm:col-span-2">
              Ask for approval
            </Button>
          </form>
        )
      ) : null}
    </div>
  );
}
