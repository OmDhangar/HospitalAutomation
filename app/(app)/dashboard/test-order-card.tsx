'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useToast } from '@/components/toast';
import { Button, Card, CardHeader, cn } from '@/components/ui';
import { ORDER_STATUSES, type TestOrderStatus } from '@/lib/domain/test-orders';
import { cancelOpdTestDynamic, orderOpdTestsDynamic } from './test-order-actions';

export type OrderableTestOption = { id: string; name: string; servicePointName: string };
export type SentTest = { id: string; testName: string; servicePointName: string; status: TestOrderStatus };

/**
 * Send the patient in the room for tests (IPD sheets plan C4a). Tap the tests,
 * then Send: each goes on its lab's list, and on the visit's bill at its price
 * for the desk to collect. Below, what this visit was already sent for and
 * where each has got to. No prices here: this is the doctor's screen.
 */
export function TestOrderCard({
  appointmentId,
  tests,
  sent,
}: {
  appointmentId: string;
  tests: OrderableTestOption[];
  sent: SentTest[];
}) {
  const toast = useToast();
  const router = useRouter();
  const [picked, setPicked] = useState<string[]>([]);
  const [formKey, setFormKey] = useState(() => crypto.randomUUID());
  const [query, setQuery] = useState('');
  const [pending, startTransition] = useTransition();

  const already = new Set(sent.filter((s) => s.status !== 'cancelled').map((s) => s.testName));
  const q = query.trim().toLowerCase();
  const shown = (q ? tests.filter((t) => t.name.toLowerCase().includes(q)) : tests).slice(0, 24);

  const toggle = (id: string) => setPicked((now) => (now.includes(id) ? now.filter((x) => x !== id) : [...now, id]));

  const send = () =>
    startTransition(async () => {
      const res = await orderOpdTestsDynamic({ appointmentId, chargeItemIds: picked, formKey });
      if (!res.ok) {
        toast.error('Tests not sent', res.error);
        return;
      }
      toast.success(res.message);
      setPicked([]);
      setFormKey(crypto.randomUUID());
      router.refresh();
    });

  const cancel = (orderId: string, name: string) =>
    startTransition(async () => {
      const res = await cancelOpdTestDynamic({ orderId });
      if (!res.ok) toast.error('Not cancelled', res.error);
      else {
        toast.success(`${name} cancelled`);
        router.refresh();
      }
    });

  return (
    <Card>
      <CardHeader title="Send for tests" hint="The lab’s staff call the patient if they do not arrive in time." />
      <div className="space-y-3 p-4 sm:p-5">
        {tests.length > 12 ? (
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Find a test"
            aria-label="Find a test"
            className="block h-11 w-full rounded-lg border-0 bg-white px-3 text-sm ring-1 ring-inset ring-ink-300"
          />
        ) : null}
        <div className="flex flex-wrap gap-2" role="group" aria-label="Tests">
          {shown.map((t) => {
            const on = picked.includes(t.id);
            return (
              <button
                key={t.id}
                type="button"
                aria-pressed={on}
                onClick={() => toggle(t.id)}
                title={t.servicePointName}
                className={cn(
                  'min-h-11 rounded-full px-3.5 text-sm font-medium ring-1 ring-inset transition-colors',
                  on ? 'bg-brand-600 text-white ring-brand-600' : 'bg-white text-ink-800 ring-ink-300 hover:bg-ink-50',
                  already.has(t.name) && !on && 'opacity-60',
                )}
              >
                {t.name}
              </button>
            );
          })}
        </div>
        <Button type="button" variant="primary" className="h-11" disabled={picked.length === 0} isLoading={pending} onClick={send}>
          {picked.length === 0 ? 'Tap the tests' : `Send for ${picked.length} test${picked.length === 1 ? '' : 's'}`}
        </Button>

        {sent.length > 0 ? (
          <ul className="divide-y divide-ink-100 rounded-lg ring-1 ring-inset ring-ink-200">
            {sent.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                <span className={cn(s.status === 'cancelled' && 'text-ink-400 line-through')}>
                  <strong>{s.testName}</strong> <span className="text-ink-500">· {s.servicePointName}</span>
                </span>
                <span className="flex items-center gap-2">
                  <span
                    className={cn(
                      'rounded-full px-2 py-0.5 text-xs font-semibold',
                      s.status === 'ordered' ? 'bg-amber-100 text-amber-900' : s.status === 'reported' ? 'bg-emerald-100 text-emerald-900' : 'bg-ink-100 text-ink-700',
                    )}
                  >
                    {ORDER_STATUSES[s.status]}
                  </span>
                  {s.status === 'ordered' ? (
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => cancel(s.id, s.testName)}
                      className="min-h-11 rounded-lg px-2 text-xs font-medium text-ink-500 hover:bg-ink-100 hover:text-ink-900"
                    >
                      Cancel
                    </button>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </Card>
  );
}
