import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Card, CardHeader, EmptyState, cn } from '@/components/ui';
import { requireModule } from '@/lib/auth/modules';
import { requireSession } from '@/lib/auth/session';
import { can } from '@/lib/domain/permissions';
import { LEDGER_KIND_LABELS, LOCATION_KINDS, type LedgerKind } from '@/lib/domain/stock';
import { serviceDateIn } from '@/lib/domain/time';
import { getOnHand, listLocations, listMovements } from '@/lib/services/stock';

export const metadata = { title: 'Store · Stock' };

/** One store: what it holds by batch (first expiry first) and its last 50 movements, who made each and when. */
export default async function StorePage({ params }: PageProps<'/ipd/stock/store/[id]'>) {
  const session = await requireSession();
  await requireModule(session, 'stock');
  if (!can(session.role, 'stock.view')) notFound();
  const { id } = await params;
  const location = (await listLocations(session.hospitalId, { includeInactive: true })).find((l) => l.id === id);
  if (!location) notFound();
  const [onHand, movements] = await Promise.all([
    getOnHand(session.hospitalId, id, serviceDateIn(session.timezone)),
    listMovements(session.hospitalId, id),
  ]);
  const showHistory = can(session.role, 'acct.view') && !session.readOnly;
  const time = (date: Date) =>
    new Intl.DateTimeFormat('en-IN', { timeZone: session.timezone, day: '2-digit', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true }).format(date);

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <Link href="/ipd/stock" className="inline-flex min-h-11 items-center text-sm text-ink-500 hover:text-ink-800">
        ← Stock
      </Link>
      <div>
        <h1 className="text-xl font-bold text-ink-900">{location.name}</h1>
        <p className="text-sm text-ink-600">
          {LOCATION_KINDS[location.kind]}
          {location.wardName ? ` · ${location.wardName}` : ''} · {location.branchName}
          {location.active ? '' : ' · closed'}
        </p>
      </div>

      <Card>
        <CardHeader title="Held now" hint="From the books. The daily count checks them against the shelf." />
        {onHand.length === 0 ? (
          <EmptyState title="Nothing held" />
        ) : (
          <ul className="divide-y divide-ink-100">
            {onHand.map((b) => (
              <li key={b.batchId} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm sm:px-5">
                <span className="min-w-0">
                  <span className="block font-semibold text-ink-900">{b.label}</span>
                  <span className="numeric block text-ink-600">
                    Batch {b.batchNo} · exp {b.expiryDate}
                    {b.expiry !== 'ok' ? (
                      <span className={cn('ml-1 font-semibold', b.expiry === 'expired' ? 'text-rose-700' : 'text-amber-800')}>
                        {b.expiry === 'expired' ? 'EXPIRED' : 'expires soon'}
                      </span>
                    ) : null}
                  </span>
                </span>
                <span className="numeric shrink-0 text-lg font-bold text-ink-900">
                  {b.quantity} <span className="text-sm font-normal text-ink-500">{b.unit}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <CardHeader title="Movements" hint="Newest first. Nothing here can be edited; a mistake is put right by an approved adjustment." />
        {movements.length === 0 ? (
          <EmptyState title="No movements yet" />
        ) : (
          <ul className="divide-y divide-ink-100">
            {movements.map((m) => (
              <li key={m.id} className="flex items-start justify-between gap-3 px-4 py-2.5 text-sm sm:px-5">
                <span className="min-w-0">
                  <span className="block">
                    <strong>{LEDGER_KIND_LABELS[m.kind as LedgerKind] ?? m.kind}</strong> · {m.label} · batch {m.batchNo}
                    {m.source === 'manual_register' ? <span className="ml-1 text-xs text-ink-500">(from the paper register)</span> : null}
                  </span>
                  <span className="block text-ink-500">
                    {m.recordedByName ?? 'staff'} · {time(m.recordedAt)}
                    {m.countId ? (
                      <Link href={`/ipd/stock/count/${m.countId}`} className="ml-2 font-semibold text-brand-700 hover:underline">
                        count
                      </Link>
                    ) : null}
                    {m.transferId ? (
                      <Link href={`/ipd/stock/transfer/${m.transferId}`} className="ml-2 font-semibold text-brand-700 hover:underline">
                        delivery
                      </Link>
                    ) : null}
                    {showHistory ? (
                      <Link href={`/accountability/record/stock_movement/${m.id}`} className="ml-2 font-semibold text-ink-500 hover:text-brand-800 hover:underline">
                        History
                      </Link>
                    ) : null}
                  </span>
                </span>
                <span className={cn('numeric shrink-0 font-bold', m.quantity < 0 ? 'text-rose-700' : 'text-emerald-700')}>
                  {m.quantity > 0 ? '+' : ''}
                  {m.quantity}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
