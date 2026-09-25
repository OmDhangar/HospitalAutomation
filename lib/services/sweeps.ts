import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import { getAdminDb } from '@/lib/db/admin';
import { appointments, queueEvents } from '@/lib/db/schema';
import { expireStalePaymentLinks } from './payments';
import { expireLapsedSubscriptions } from './subscriptions';

/**
 * The housekeeping nobody was running.
 *
 * `expireLapsedSubscriptions` and `expireStalePaymentLinks` were written and
 * then never called from anywhere, and the `expire` queue action was never
 * wired at all. Each is individually small; together they meant a database
 * that only ever accumulated: subscriptions active years past their end date,
 * dead payment links still offered, and yesterday's waiting patients still
 * WAITING today.
 *
 * All of it is idempotent, so the outbox tick can call it as often as it runs.
 */

/**
 * Closes off appointments left open when a clinic simply went home.
 *
 * A queue is scoped to a service date, so an appointment still WAITING on a
 * past date will never be called — nobody is looking at yesterday's queue. Left
 * alone those rows sit there permanently, and because reports count by status
 * they quietly corrupt every no-show and completion figure the hospital is
 * shown.
 *
 * EXPIRED rather than NO_SHOW, deliberately. A no-show is a claim that the
 * patient failed to arrive, which is a thing to say about a person and may
 * simply be untrue — the doctor may have run out of time. EXPIRED says only
 * that the day ended with this unresolved, which is all that is actually known.
 */
export async function expireStaleAppointments(now: Date = new Date()): Promise<number> {
  const db = getAdminDb();

  // Date arithmetic in the database: service_date is a date, and comparing it
  // to a JS timestamp would drag the server's timezone into a decision that
  // has nothing to do with it.
  const rows = await db
    .update(appointments)
    .set({ status: 'EXPIRED', updatedAt: now })
    .where(
      and(
        inArray(appointments.status, ['CREATED', 'CONFIRMED', 'ARRIVED', 'WAITING', 'HELD', 'SKIPPED']),
        lt(appointments.serviceDate, sql`(${now}::timestamptz at time zone 'Asia/Kolkata')::date`),
      ),
    )
    .returning({
      id: appointments.id,
      hospitalId: appointments.hospitalId,
      doctorId: appointments.doctorId,
      status: appointments.status,
    });

  // Queue history stays complete: an appointment that changes status without
  // an event is a gap in the only record that answers "what happened to me".
  for (const row of rows) {
    await db.insert(queueEvents).values({
      hospitalId: row.hospitalId,
      appointmentId: row.id,
      doctorId: row.doctorId,
      action: 'expire',
      // The row already carries the new status, so the previous one is not
      // readable here. Recorded as the closest honest description.
      fromStatus: 'WAITING',
      toStatus: 'EXPIRED',
      actorUserId: null,
      metadata: { reason: 'service_date_passed', swept_at: now.toISOString() },
    });
  }

  return rows.length;
}

export type SweepResult = {
  appointmentsExpired: number;
  subscriptionsExpired: number;
  paymentLinksExpired: number;
};

/**
 * Runs every sweep, reporting rather than throwing.
 *
 * One failing sweep must not stop the others — and must never take down the
 * outbox drain it shares a tick with, because a patient not receiving their
 * token is a worse outcome than a stale row surviving another minute.
 */
export async function runSweeps(now: Date = new Date()): Promise<SweepResult> {
  const result: SweepResult = {
    appointmentsExpired: 0,
    subscriptionsExpired: 0,
    paymentLinksExpired: 0,
  };

  try {
    result.appointmentsExpired = await expireStaleAppointments(now);
  } catch (error) {
    console.error('[sweeps] appointment expiry failed', error);
  }

  try {
    result.subscriptionsExpired = await expireLapsedSubscriptions(now);
  } catch (error) {
    console.error('[sweeps] subscription expiry failed', error);
  }

  try {
    // Only meaningful once the payments table exists; a deployment that has
    // not migrated yet logs and carries on rather than failing the tick.
    await expireStalePaymentLinks(now);
  } catch (error) {
    console.error('[sweeps] payment link expiry failed', error);
  }

  const total =
    result.appointmentsExpired + result.subscriptionsExpired + result.paymentLinksExpired;
  if (total > 0) {
    console.log('[sweeps] completed', JSON.stringify(result));
  }

  return result;
}

/** Re-exported so callers have one import for scheduled housekeeping. */
export { expireLapsedSubscriptions, expireStalePaymentLinks };

/** Kept for the rare case a single hospital needs sweeping by hand. */
export async function expireStaleAppointmentsForHospital(
  hospitalId: string,
  now: Date = new Date(),
): Promise<number> {
  const db = getAdminDb();
  const rows = await db
    .update(appointments)
    .set({ status: 'EXPIRED', updatedAt: now })
    .where(
      and(
        eq(appointments.hospitalId, hospitalId),
        inArray(appointments.status, ['CREATED', 'CONFIRMED', 'ARRIVED', 'WAITING', 'HELD', 'SKIPPED']),
        lt(appointments.serviceDate, sql`(${now}::timestamptz at time zone 'Asia/Kolkata')::date`),
      ),
    )
    .returning({ id: appointments.id });

  return rows.length;
}
