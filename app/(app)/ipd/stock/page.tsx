import Link from 'next/link';
import { Alert, Button, Card, CardHeader, EmptyState, cn } from '@/components/ui';
import { AlertTriangleIcon, CheckIcon, PillIcon } from '@/components/icons';
import { requireModule } from '@/lib/auth/modules';
import { requireSession } from '@/lib/auth/session';
import { can } from '@/lib/domain/permissions';
import { ADJUST_REASONS, LOCATION_KINDS, VARIANCE_REASONS } from '@/lib/domain/stock';
import { getStockOverview } from '@/lib/services/stock';
import { decideAdjustmentAction, startCountAction } from './actions';

export const metadata = { title: 'Stock · IPD' };

/**
 * Risk-class stock (IPD sheets plan B4a): every store, whether today's count
 * is done, what is on the way, what waits for a second person, and the last
 * seven days' differences. Read on demand, not polled.
 */
export default async function StockPage({ searchParams }: PageProps<'/ipd/stock'>) {
  const session = await requireSession();
  const states = await requireModule(session, 'stock');
  if (!can(session.role, 'stock.view')) {
    return (
      <Card>
        <EmptyState title="Not available" hint="Your login does not include stock." />
      </Card>
    );
  }
  const query = await searchParams;
  const overview = await getStockOverview({ hospitalId: session.hospitalId, timezone: session.timezone });
  const writable = !session.readOnly;
  const canMove = can(session.role, 'stock.move') && writable;
  const canCount = can(session.role, 'stock.count') && writable;
  const canApprove = can(session.role, 'stock.approve') && writable;
  const stage = states.get('stock')?.stage ?? 'observe';

  const time = (date: Date) =>
    new Intl.DateTimeFormat('en-IN', { timeZone: session.timezone, day: '2-digit', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true }).format(date);

  return (
    <div className="space-y-5">
      {typeof query.saved === 'string' ? <Alert tone="success">{query.saved}</Alert> : null}
      {typeof query.error === 'string' ? <Alert tone="error">{query.error}</Alert> : null}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="flex items-center gap-2 text-lg font-bold text-ink-900">
            <PillIcon className="size-5 text-brand-700" />
            Risk-class stock
          </h1>
          <p className="text-sm text-ink-600">Narcotics, psychotropics and other medicines the hospital counts every day.</p>
        </div>
        {canMove ? (
          <div className="flex flex-wrap gap-2">
            <Link href="/ipd/stock/receive">
              <Button variant="primary" size="sm" className="h-11">Receive from supplier</Button>
            </Link>
            <Link href="/ipd/stock/send">
              <Button variant="secondary" size="sm" className="h-11">Send to a store</Button>
            </Link>
            <Link href="/ipd/stock/adjust">
              <Button variant="secondary" size="sm" className="h-11">Expired, broken, found…</Button>
            </Link>
          </div>
        ) : null}
      </div>

      {overview.stores.length === 0 ? (
        <Card>
          <EmptyState title="No stores yet" hint="The owner adds the main store and ward stores, and the risk-class medicines, under Settings → Stock." />
        </Card>
      ) : (
        <section aria-labelledby="stores-heading" className="space-y-2">
          <h2 id="stores-heading" className="text-sm font-semibold uppercase tracking-wide text-ink-500">
            Stores and today’s count
          </h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {overview.stores.map((store) => {
              const mine = store.openCount?.countedByUserId === session.userId;
              return (
                <Card key={store.location.id}>
                  <div className="space-y-2 p-4">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <Link href={`/ipd/stock/store/${store.location.id}`} className="font-semibold text-ink-900 hover:text-brand-800 hover:underline">
                          {store.location.name}
                        </Link>
                        <p className="text-xs text-ink-500">
                          {LOCATION_KINDS[store.location.kind]}
                          {store.location.wardName ? ` · ${store.location.wardName}` : ''}
                        </p>
                      </div>
                      <CountBadge due={store.countDue} open={store.openCount?.status ?? null} empty={store.items === 0} />
                    </div>
                    <p className="text-sm text-ink-700">
                      {store.items === 0 ? 'Holds no risk-class stock' : `${store.items} medicine${store.items === 1 ? '' : 's'} · ${store.units} units`}
                    </p>
                    {store.expired + store.expiringSoon > 0 ? (
                      <p className="flex items-center gap-1 text-xs font-semibold text-amber-800">
                        <AlertTriangleIcon className="size-3.5" />
                        {store.expired > 0 ? `${store.expired} batch${store.expired === 1 ? '' : 'es'} expired` : ''}
                        {store.expired > 0 && store.expiringSoon > 0 ? ' · ' : ''}
                        {store.expiringSoon > 0 ? `${store.expiringSoon} expiring within 90 days` : ''}
                      </p>
                    ) : null}
                    <p className="text-xs text-ink-500">{store.lastCountAt ? `Last counted ${time(store.lastCountAt)}` : 'Never counted'}</p>
                    {store.arriving > 0 ? (
                      <p className="text-xs font-semibold text-brand-800">{store.arriving} deliver{store.arriving === 1 ? 'y' : 'ies'} on the way</p>
                    ) : null}
                    {store.openCount ? (
                      store.openCount.status === 'counting' ? (
                        <Link href={`/ipd/stock/count/${store.openCount.id}`} className="inline-flex min-h-11 items-center text-sm font-semibold text-brand-700 hover:underline">
                          {mine ? 'Continue your count →' : `Being counted by ${store.openCount.countedByName ?? 'staff'}`}
                        </Link>
                      ) : (
                        <Link href={`/ipd/stock/count/${store.openCount.id}`} className="inline-flex min-h-11 items-center text-sm font-semibold text-brand-700 hover:underline">
                          Counted — waiting for approval →
                        </Link>
                      )
                    ) : canCount && store.items > 0 ? (
                      <form action={startCountAction}>
                        <input type="hidden" name="locationId" value={store.location.id} />
                        <input type="hidden" name="clientId" value={crypto.randomUUID()} />
                        <Button type="submit" variant={store.countDue ? 'primary' : 'secondary'} size="sm" className="h-11 w-full">
                          Start a count
                        </Button>
                      </form>
                    ) : null}
                  </div>
                </Card>
              );
            })}
          </div>
          <p className="text-xs text-ink-500">
            A count is blind: the counter sees the books only after submitting, and someone else approves it.
            {stage === 'enforce'
              ? ' Whoever moved stock in or out of a store since its last count cannot count it.'
              : ' A count by someone who moved stock in or out of that store since its last count is marked, not blocked.'}
          </p>
        </section>
      )}

      {overview.inTransit.length > 0 ? (
        <Card>
          <CardHeader title="On the way" hint="Sent, not yet taken in by the receiving store" />
          <ul className="divide-y divide-ink-100">
            {overview.inTransit.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-sm sm:px-5">
                <span>
                  <strong>{t.fromName}</strong> → <strong>{t.toName}</strong> · {t.lines} line{t.lines === 1 ? '' : 's'} · sent {time(t.sentAt)} by {t.sentByName ?? 'staff'}
                </span>
                {canMove ? (
                  <Link href={`/ipd/stock/transfer/${t.id}`} className="inline-flex min-h-11 items-center font-semibold text-brand-700 hover:underline">
                    Take in →
                  </Link>
                ) : null}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {canApprove && (overview.toApprove.length > 0 || overview.adjustments.length > 0) ? (
        <Card>
          <CardHeader title="Waiting for a second person" hint="You cannot approve your own count or request" />
          <ul className="divide-y divide-ink-100">
            {overview.toApprove.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-sm sm:px-5">
                <span>
                  Count of <strong>{c.locationName}</strong> by {c.countedByName ?? 'staff'} · {time(c.submittedAt)} ·{' '}
                  {c.differences === 0 ? 'matches the books' : <strong className="text-rose-700">{c.differences} difference{c.differences === 1 ? '' : 's'}</strong>}
                  {c.countedByMover ? <Flag>counter had moved this stock</Flag> : null}
                  {c.movedDuringCount ? <Flag>stock moved during the count</Flag> : null}
                </span>
                <Link href={`/ipd/stock/count/${c.id}`} className="inline-flex min-h-11 items-center font-semibold text-brand-700 hover:underline">
                  {c.countedByUserId === session.userId ? 'View' : 'Review and approve →'}
                </Link>
              </li>
            ))}
            {overview.adjustments.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-sm sm:px-5">
                <span>
                  <strong>{a.label}</strong> batch {a.batchNo} · {a.locationName} ·{' '}
                  <strong className={a.quantity < 0 ? 'text-rose-700' : 'text-emerald-700'}>
                    {a.quantity > 0 ? '+' : ''}
                    {a.quantity}
                  </strong>{' '}
                  · {ADJUST_REASONS[a.reasonCode].label}
                  {a.reasonText ? ` — “${a.reasonText}”` : ''} · asked by {a.requestedByName ?? 'staff'}
                </span>
                {a.requestedByUserId === session.userId ? (
                  <span className="text-xs text-ink-500">Waiting for someone else</span>
                ) : (
                  <form action={decideAdjustmentAction} className="flex gap-2">
                    <input type="hidden" name="adjustmentId" value={a.id} />
                    <Button type="submit" name="decision" value="approve" variant="primary" size="sm" className="h-11">
                      Approve
                    </Button>
                    <Button type="submit" name="decision" value="reject" variant="secondary" size="sm" className="h-11">
                      Reject
                    </Button>
                  </form>
                )}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <Card>
        <CardHeader title="Differences in the last 7 days" hint="From approved counts, and deliveries that arrived short. A lead to look into, not a finding." />
        {overview.differences.length === 0 && overview.shortfalls.length === 0 ? (
          <p className="flex items-center gap-2 px-4 pb-4 text-sm text-emerald-800 sm:px-5">
            <CheckIcon className="size-4" />
            No differences.
          </p>
        ) : (
          <ul className="divide-y divide-ink-100">
            {overview.differences.map((d, i) => (
              <li key={`${d.countId}-${i}`} className="px-4 py-2.5 text-sm sm:px-5">
                <p>
                  <strong className={d.variance < 0 ? 'text-rose-700' : 'text-emerald-700'}>
                    {d.variance > 0 ? '+' : ''}
                    {d.variance}
                  </strong>{' '}
                  <strong>{d.label}</strong> batch {d.batchNo} · {d.locationName}
                  {d.countedByMover ? <Flag>counter had moved this stock</Flag> : null}
                </p>
                <p className="text-ink-600">
                  {d.reasonCode ? VARIANCE_REASONS[d.reasonCode] : 'No reason'}
                  {d.reasonText ? ` — “${d.reasonText}”` : ''} · counted by {d.countedByName ?? 'staff'}, approved by {d.approvedByName ?? 'staff'} · {time(d.approvedAt)} ·{' '}
                  <Link href={`/ipd/stock/count/${d.countId}`} className="font-semibold text-brand-700 hover:underline">
                    count
                  </Link>
                </p>
              </li>
            ))}
            {overview.shortfalls.map((s, i) => (
              <li key={`${s.transferId}-${i}`} className="px-4 py-2.5 text-sm sm:px-5">
                <p>
                  <strong className="text-rose-700">−{s.missing}</strong> <strong>{s.label}</strong> batch {s.batchNo} · lost between {s.fromName} and {s.toName}
                </p>
                <p className="text-ink-600">
                  Taken in {time(s.receivedAt)} ·{' '}
                  <Link href={`/ipd/stock/transfer/${s.transferId}`} className="font-semibold text-brand-700 hover:underline">
                    delivery
                  </Link>
                </p>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function CountBadge({ due, open, empty }: { due: boolean; open: 'counting' | 'submitted' | null; empty: boolean }) {
  const [text, tone] =
    open === 'counting'
      ? ['Counting', 'bg-brand-50 text-brand-800 ring-brand-200']
      : open === 'submitted'
        ? ['To approve', 'bg-amber-50 text-amber-900 ring-amber-200']
        : empty
          ? ['Nothing held', 'bg-ink-50 text-ink-600 ring-ink-200']
          : due
            ? ['Count due', 'bg-rose-50 text-rose-800 ring-rose-200']
            : ['Count done', 'bg-emerald-50 text-emerald-800 ring-emerald-200'];
  return <span className={cn('shrink-0 rounded px-1.5 py-0.5 text-xs font-semibold ring-1', tone)}>{text}</span>;
}

function Flag({ children }: { children: React.ReactNode }) {
  return <span className="ml-1.5 rounded bg-amber-50 px-1.5 py-0.5 text-xs font-semibold text-amber-900 ring-1 ring-amber-200">{children}</span>;
}
