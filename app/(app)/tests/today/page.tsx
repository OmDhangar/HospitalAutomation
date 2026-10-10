import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AutoRefresh } from '@/components/auto-refresh';
import { Alert, Button, Card, CardHeader, EmptyState, cn } from '@/components/ui';
import { requireModule } from '@/lib/auth/modules';
import { requireSession } from '@/lib/auth/session';
import { can } from '@/lib/domain/permissions';
import { formatIndianPhone } from '@/lib/domain/phone';
import { CALL_OUTCOMES, ORDER_STATUSES } from '@/lib/domain/test-orders';
import { formatTimeIn, serviceDateIn } from '@/lib/domain/time';
import { getTestDay } from '@/lib/services/test-orders';
import { cancelTestAction } from '../actions';

export const metadata = { title: 'Tests today' };

const fmtDate = (date: string) =>
  new Date(`${date}T00:00:00`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });

const shiftDate = (date: string, days: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/**
 * The admin's Today screen (IPD sheets plan C4a): per lab, the day from
 * ordered to report added, the "not arrived" tasks raised and the ones that
 * reached the admin; per person, who called and who marked what; and the
 * pending list — every test still open — to clear before the day ends.
 */
export default async function TestsTodayPage({ searchParams }: PageProps<'/tests/today'>) {
  const session = await requireSession();
  await requireModule(session, 'test_follow_up');
  if (!can(session.role, 'tests.oversee')) notFound();
  const query = await searchParams;
  const now = new Date();
  const today = serviceDateIn(session.timezone, now);
  const day = await getTestDay({ hospitalId: session.hospitalId, date: typeof query.date === 'string' ? query.date : undefined, now });
  const isToday = day.date === today;
  const canCancel = can(session.role, 'tests.order') && !session.readOnly;

  const th = 'px-2 py-2 text-right text-xs font-semibold text-ink-500 first:pl-4 first:text-left last:pr-4 sm:first:pl-5';
  const td = 'px-2 py-2 text-right tabular-nums first:pl-4 first:text-left last:pr-4 sm:first:pl-5';

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      {isToday ? <AutoRefresh seconds={60} /> : null}
      <Link href="/tests" className="inline-flex min-h-11 items-center text-sm text-ink-500 hover:text-ink-800">
        ← Tests
      </Link>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-ink-900">Tests · {isToday ? 'today' : fmtDate(day.date)}</h1>
          <p className="text-sm text-ink-600">Every lab and room, who followed up, and what is still pending.</p>
        </div>
        <nav className="flex gap-2" aria-label="Day">
          <Link href={`/tests/today?date=${shiftDate(day.date, -1)}`} className="inline-flex min-h-11 items-center rounded-lg px-3 text-sm font-medium ring-1 ring-inset ring-ink-300 hover:bg-ink-50">
            ← Previous day
          </Link>
          {!isToday ? (
            <Link href="/tests/today" className="inline-flex min-h-11 items-center rounded-lg px-3 text-sm font-medium ring-1 ring-inset ring-ink-300 hover:bg-ink-50">
              Today
            </Link>
          ) : null}
        </nav>
      </div>
      {typeof query.saved === 'string' ? <Alert tone="success">{query.saved}</Alert> : null}
      {typeof query.error === 'string' ? <Alert tone="error">{query.error}</Alert> : null}
      {day.escalatedOpen > 0 ? (
        <Alert tone="error">
          <strong>
            {day.escalatedOpen} patient{day.escalatedOpen === 1 ? '' : 's'} not arrived and nobody called within 15 minutes.
          </strong>{' '}
          They are marked red in the pending list below.
        </Alert>
      ) : null}

      <Card>
        <CardHeader title="By lab or room" hint={`Tests ordered ${isToday ? 'today' : 'that day'}`} />
        {day.points.length === 0 ? (
          <EmptyState title="No lab or room set up" hint="Add them under Settings → Tests and labs." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="border-b border-ink-100">
                <tr>
                  <th className={th}>Lab / room</th>
                  <th className={th}>Ordered</th>
                  <th className={th}>Arrived</th>
                  <th className={th}>Done</th>
                  <th className={th}>Report</th>
                  <th className={th}>Not coming</th>
                  <th className={th}>Pending</th>
                  <th className={th}>Tasks</th>
                  <th className={th}>To admin</th>
                  <th className={th}>Calls</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {day.points.map(({ id, name, summary: s }) => (
                  <tr key={id}>
                    <td className={cn(td, 'font-semibold text-ink-900')}>
                      <Link href={`/tests/${id}`} className="underline-offset-2 hover:underline">
                        {name}
                      </Link>
                    </td>
                    <td className={td}>{s.ordered}</td>
                    <td className={td}>{s.arrived}</td>
                    <td className={td}>{s.done}</td>
                    <td className={td}>{s.reported}</td>
                    <td className={td}>{s.notComing}</td>
                    <td className={cn(td, s.pending > 0 && 'font-semibold text-amber-800')}>{s.pending}</td>
                    <td className={td}>{s.tasksRaised}</td>
                    <td className={cn(td, s.escalated > 0 && 'font-semibold text-red-700')}>{s.escalated}</td>
                    <td className={td}>{s.calls}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card>
        <CardHeader title="By person" hint="Calls made and what each marked" />
        {day.people.length === 0 ? (
          <EmptyState title="Nobody has called or marked a test yet" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[480px] text-sm">
              <thead className="border-b border-ink-100">
                <tr>
                  <th className={th}>Person</th>
                  <th className={th}>Calls</th>
                  <th className={th}>Reached</th>
                  <th className={th}>Arrivals</th>
                  <th className={th}>Tests done</th>
                  <th className={th}>Reports</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {day.people.map((p) => (
                  <tr key={p.userId}>
                    <td className={cn(td, 'font-semibold text-ink-900')}>{p.name}</td>
                    <td className={td}>{p.calls}</td>
                    <td className={td}>{p.reached}</td>
                    <td className={td}>{p.arrivalsMarked}</td>
                    <td className={td}>{p.testsDone}</td>
                    <td className={td}>{p.reportsAdded}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card>
        <CardHeader
          title="Pending"
          hint={day.pending.length === 0 ? 'Nothing pending' : `${day.pending.length} test${day.pending.length === 1 ? '' : 's'} still open, oldest first per lab`}
        />
        {day.pending.length === 0 ? (
          <EmptyState title="Every test ordered is finished or closed" />
        ) : (
          <ul className="divide-y divide-ink-100 text-sm">
            {day.pending.map((r) => {
              const escalated = r.status === 'ordered' && r.escalatedAt;
              return (
                <li key={r.id} className={cn('flex flex-wrap items-start justify-between gap-2 px-4 py-3 sm:px-5', escalated && 'bg-red-50')}>
                  <div className="min-w-0">
                    <p>
                      <strong className="text-ink-900">{r.patientName}</strong> · {r.testName}
                      <span className="text-ink-500"> · {r.servicePointName} · {r.setting.toUpperCase()}</span>
                    </p>
                    <p className="text-xs text-ink-600">
                      {ORDER_STATUSES[r.status]}
                      {escalated ? ' · raised to admin' : ''} · ordered {serviceDateIn(session.timezone, r.orderedAt) === day.date ? formatTimeIn(session.timezone, r.orderedAt) : r.orderedAt.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}
                      {r.lastCall ? ` · last call ${formatTimeIn(session.timezone, r.lastCall.at)}: ${CALL_OUTCOMES[r.lastCall.outcome]} (${r.lastCall.by ?? 'staff'})` : r.status === 'ordered' ? ' · not called' : ''}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {r.status === 'ordered' ? (
                      <a href={`tel:${r.phone}`} className="inline-flex min-h-11 items-center rounded-lg px-3 font-medium text-brand-700 ring-1 ring-inset ring-brand-200 hover:bg-brand-50">
                        Call {formatIndianPhone(r.phone)}
                      </a>
                    ) : null}
                    {canCancel && (r.status === 'ordered' || r.status === 'arrived') ? (
                      <form action={cancelTestAction}>
                        <input type="hidden" name="orderId" value={r.id} />
                        <input type="hidden" name="back" value="today" />
                        <input type="hidden" name="reason" value="Cancelled by the owner" />
                        <Button type="submit" variant="ghost" size="sm" className="h-11">
                          Cancel test
                        </Button>
                      </form>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}
