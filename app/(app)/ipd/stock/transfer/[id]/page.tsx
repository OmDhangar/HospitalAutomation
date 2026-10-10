import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Alert, Button, Card, CardHeader } from '@/components/ui';
import { requireModule } from '@/lib/auth/modules';
import { requireSession } from '@/lib/auth/session';
import { can } from '@/lib/domain/permissions';
import { getTransfer } from '@/lib/services/stock';
import { receiveTransferAction } from '../../actions';

export const metadata = { title: 'Delivery · Stock' };

/** One delivery between stores: take it in, line by line, or see what arrived (IPD sheets plan B4a). */
export default async function TransferPage({ params, searchParams }: PageProps<'/ipd/stock/transfer/[id]'>) {
  const session = await requireSession();
  await requireModule(session, 'stock');
  if (!can(session.role, 'stock.view')) notFound();
  const { id } = await params;
  const query = await searchParams;
  const transfer = await getTransfer(session.hospitalId, id);
  if (!transfer) notFound();
  const canTake = transfer.status === 'in_transit' && can(session.role, 'stock.move') && !session.readOnly;
  const time = (date: Date) =>
    new Intl.DateTimeFormat('en-IN', { timeZone: session.timezone, day: '2-digit', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true }).format(date);

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <Link href="/ipd/stock" className="inline-flex min-h-11 items-center text-sm text-ink-500 hover:text-ink-800">
        ← Stock
      </Link>
      {typeof query.error === 'string' ? <Alert tone="error">{query.error}</Alert> : null}
      <div>
        <h1 className="text-xl font-bold text-ink-900">
          {transfer.fromName} → {transfer.toName}
        </h1>
        <p className="text-sm text-ink-600">
          Sent {time(transfer.sentAt)} by {transfer.sentByName ?? 'staff'}
          {transfer.receivedAt ? ` · taken in ${time(transfer.receivedAt)} by ${transfer.receivedByName ?? 'staff'}` : ' · on the way'}
        </p>
      </div>
      <form action={receiveTransferAction} className="space-y-4">
        <input type="hidden" name="transferId" value={transfer.id} />
        <Card>
          <CardHeader
            title={canTake ? 'What arrived' : 'Lines'}
            hint={
              canTake
                ? 'Count what you received. If something is missing, enter the smaller number: it is recorded as lost on the way.'
                : undefined
            }
          />
          <ul className="divide-y divide-ink-100">
            {transfer.lines.map((line) => (
              <li key={line.id} className="flex items-center justify-between gap-3 px-4 py-3 sm:px-5">
                <label htmlFor={`got_${line.id}`} className="min-w-0">
                  <span className="block font-semibold text-ink-900">{line.label}</span>
                  <span className="numeric block text-sm text-ink-600">
                    Batch {line.batchNo} · exp {line.expiryDate} · {line.sent} sent
                    {line.received !== null && line.received < line.sent ? (
                      <span className="ml-1 font-semibold text-rose-700">· {line.sent - line.received} missing</span>
                    ) : null}
                  </span>
                </label>
                {canTake ? (
                  <input
                    id={`got_${line.id}`}
                    name={`got_${line.id}`}
                    inputMode="numeric"
                    defaultValue={line.sent}
                    className="numeric h-12 w-24 rounded-lg border-0 px-3 text-right text-xl font-semibold ring-1 ring-inset ring-ink-300"
                  />
                ) : (
                  <span className="numeric text-lg font-semibold">{line.received ?? '—'}</span>
                )}
              </li>
            ))}
          </ul>
        </Card>
        {canTake ? (
          <Button type="submit" variant="primary" size="lg" className="w-full">
            Take into {transfer.toName}
          </Button>
        ) : null}
      </form>
    </div>
  );
}
