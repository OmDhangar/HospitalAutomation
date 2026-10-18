import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import { withTenant } from '@/lib/db';
import { getAdminDb } from '@/lib/db/admin';
import { testOrders } from '@/lib/db/schema';
import { ESCALATE_AFTER_MS } from '@/lib/domain/test-orders';

/**
 * The clock of test follow-up (IPD sheets plan C4a, D-LABCLOCK, D-LABFU).
 *
 * Kept apart from lib/services/test-orders.ts so the desk's payment code can
 * start a "from payment" clock without importing the ordering code (which
 * itself uses the billing helpers).
 */

/**
 * The desk has taken payment for this visit: every test of it that was not
 * yet paid is stamped paid now, which starts the clock of a test whose service
 * point counts from payment. Its own clinical transaction, after the payment's:
 * a stamp that fails leaves the payment standing and is logged.
 */
export async function markTestOrdersPaid(args: { hospitalId: string; encounterId: string; now?: Date }): Promise<number> {
  const now = args.now ?? new Date();
  try {
    const rows = await withTenant(
      args.hospitalId,
      (tx) =>
        tx
          .update(testOrders)
          .set({
            paidAt: now,
            dueAt: sql`case when ${testOrders.clockFrom} = 'payment'
              then ${now.toISOString()}::timestamptz + make_interval(mins => ${testOrders.clockMinutes}::int)
              else ${testOrders.dueAt} end`,
          })
          .where(and(eq(testOrders.encounterId, args.encounterId), isNull(testOrders.paidAt), ne(testOrders.status, 'cancelled')))
          .returning({ id: testOrders.id }),
      { clinical: true },
    );
    return rows.length;
  } catch (error) {
    console.error('[tests] could not stamp tests paid', args.encounterId, error);
    return 0;
  }
}

/**
 * The sweep: stamps on each order the moment its "not arrived" task was
 * raised, and the moment it went to the admin because nobody called within 15
 * minutes. The screens work the same from the times alone; the stamps put each
 * moment in the evidence log (as a change made by the system).
 */
export async function raiseTestFollowUps(now: Date = new Date()): Promise<{ raised: number; escalated: number }> {
  const db = getAdminDb();
  const at = now.toISOString();
  const raised = await db.execute<{ id: string }>(sql`
    update test_orders set task_raised_at = ${at}::timestamptz
    where status = 'ordered' and task_raised_at is null and due_at is not null and due_at <= ${at}::timestamptz
      and not exists (select 1 from test_follow_up_calls c where c.order_id = test_orders.id and c.called_at >= test_orders.due_at)
    returning id
  `);
  const escalated = await db.execute<{ id: string }>(sql`
    update test_orders set escalated_at = ${at}::timestamptz
    where status = 'ordered' and escalated_at is null and task_raised_at is not null
      and due_at <= ${at}::timestamptz - make_interval(secs => ${ESCALATE_AFTER_MS / 1000})
      and not exists (select 1 from test_follow_up_calls c where c.order_id = test_orders.id and c.called_at >= test_orders.due_at)
    returning id
  `);
  return { raised: raised.length, escalated: escalated.length };
}
