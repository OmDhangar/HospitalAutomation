import Link from 'next/link';
import { Alert, Button, Card, CardHeader, EmptyState } from '@/components/ui';
import { requireModule } from '@/lib/auth/modules';
import { requireSession } from '@/lib/auth/session';
import { can } from '@/lib/domain/permissions';
import { serviceDateIn } from '@/lib/domain/time';
import { getOnHand, listLocations } from '@/lib/services/stock';
import { sendTransferAction } from '../actions';

export const metadata = { title: 'Send · Stock' };

const select = 'mt-1 block h-12 w-full rounded-lg border-0 bg-white px-3 text-base ring-1 ring-inset ring-ink-300';

/**
 * Send stock from one store to another (IPD sheets plan B4a). It leaves the
 * sender at once and joins the receiver when the receiver takes it in.
 * Batches are listed first expiry first, as they should leave the shelf.
 */
export default async function SendPage({ searchParams }: PageProps<'/ipd/stock/send'>) {
  const session = await requireSession();
  await requireModule(session, 'stock', 'write');
  const query = await searchParams;
  if (!can(session.role, 'stock.move') || session.readOnly) {
    return (
      <Card>
        <EmptyState title="Not available" hint="Your login cannot move stock." />
      </Card>
    );
  }
  const locations = await listLocations(session.hospitalId);
  const from = typeof query.from === 'string' && locations.some((l) => l.id === query.from) ? query.from : null;
  const onHand = from ? await getOnHand(session.hospitalId, from, serviceDateIn(session.timezone)) : [];

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <Link href="/ipd/stock" className="inline-flex min-h-11 items-center text-sm text-ink-500 hover:text-ink-800">
        ← Stock
      </Link>
      <h1 className="text-xl font-bold text-ink-900">Send to a store</h1>
      {typeof query.error === 'string' ? <Alert tone="error">{query.error}</Alert> : null}

      <form method="get" className="flex items-end gap-2 rounded-xl bg-white p-4 ring-1 ring-ink-200 sm:p-5">
        <label className="block flex-1 text-sm font-medium text-ink-700">
          From
          <select name="from" defaultValue={from ?? ''} className={select}>
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

      {from ? (
        onHand.length === 0 ? (
          <Card>
            <EmptyState title="Nothing to send" hint="This store holds no risk-class stock." />
          </Card>
        ) : (
          <form action={sendTransferAction} className="space-y-4">
            <input type="hidden" name="fromLocationId" value={from} />
            <input type="hidden" name="clientId" value={crypto.randomUUID()} />
            <label className="block rounded-xl bg-white p-4 text-sm font-medium text-ink-700 ring-1 ring-ink-200 sm:p-5">
              To
              <select name="toLocationId" required defaultValue="" className={select}>
                <option value="" disabled>
                  Choose a store
                </option>
                {locations
                  .filter((l) => l.id !== from)
                  .map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
              </select>
            </label>
            <Card>
              <CardHeader title="How many of each" hint="First expiry first. Leave empty what you are not sending." />
              <ul className="divide-y divide-ink-100">
                {onHand.map((b) => (
                  <li key={b.batchId} className="flex items-center justify-between gap-3 px-4 py-3 sm:px-5">
                    <label htmlFor={`qty_${b.batchId}`} className="min-w-0">
                      <span className="block font-semibold text-ink-900">{b.label}</span>
                      <span className="numeric block text-sm text-ink-600">
                        Batch {b.batchNo} · exp {b.expiryDate} · {b.quantity} here
                        {b.expiry === 'expired' ? <span className="ml-1 font-semibold text-rose-700">EXPIRED</span> : null}
                      </span>
                    </label>
                    <input
                      id={`qty_${b.batchId}`}
                      name={`qty_${b.batchId}`}
                      inputMode="numeric"
                      className="numeric h-12 w-24 rounded-lg border-0 px-3 text-right text-xl font-semibold ring-1 ring-inset ring-ink-300"
                    />
                  </li>
                ))}
              </ul>
            </Card>
            <Button type="submit" variant="primary" size="lg" className="w-full">
              Send
            </Button>
          </form>
        )
      ) : null}
    </div>
  );
}
