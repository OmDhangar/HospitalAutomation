import Link from 'next/link';
import { Alert, Card, EmptyState } from '@/components/ui';
import { StockReceiveForm } from '@/components/ipd/stock-receive-form';
import { requireModule } from '@/lib/auth/modules';
import { requireSession } from '@/lib/auth/session';
import { can } from '@/lib/domain/permissions';
import { serviceDateIn } from '@/lib/domain/time';
import { listLocations, listMedicinesForStock } from '@/lib/services/stock';
import { receiveStockAction } from '../actions';

export const metadata = { title: 'Receive · Stock' };

/** Stock in from a supplier, against the invoice (IPD sheets plan B4a). The main store comes first. */
export default async function ReceivePage({ searchParams }: PageProps<'/ipd/stock/receive'>) {
  const session = await requireSession();
  await requireModule(session, 'stock', 'write');
  const query = await searchParams;
  if (!can(session.role, 'stock.move') || session.readOnly) {
    return (
      <Card>
        <EmptyState title="Not available" hint="Your login cannot receive stock." />
      </Card>
    );
  }
  const [locations, medicines] = await Promise.all([
    listLocations(session.hospitalId),
    listMedicinesForStock(session.hospitalId, { riskOnly: true }),
  ]);
  const ordered = [...locations].sort((a, b) => Number(b.kind === 'main_store') - Number(a.kind === 'main_store'));

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <Link href="/ipd/stock" className="inline-flex min-h-11 items-center text-sm text-ink-500 hover:text-ink-800">
        ← Stock
      </Link>
      <h1 className="text-xl font-bold text-ink-900">Receive from supplier</h1>
      {typeof query.error === 'string' ? <Alert tone="error">{query.error}</Alert> : null}
      {ordered.length === 0 || medicines.length === 0 ? (
        <Card>
          <EmptyState title="Set up first" hint="The owner adds stores and risk-class medicines under Settings → Stock." />
        </Card>
      ) : (
        <StockReceiveForm
          action={receiveStockAction}
          clientId={crypto.randomUUID()}
          today={serviceDateIn(session.timezone)}
          locations={ordered.map((l) => ({ id: l.id, name: l.name }))}
          medicines={medicines.map((m) => ({ id: m.id, label: m.label, unit: m.unit }))}
        />
      )}
    </div>
  );
}
