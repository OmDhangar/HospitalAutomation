import { and, eq, lt, lte, sql } from 'drizzle-orm';
import { getAdminDb } from '@/lib/db/admin';
import { appointments, hospitals, queueEvents, rateLimitEvents } from '@/lib/db/schema';
import type { AppointmentStatus } from '@/lib/domain/types';
import { postBedDayCharges } from './bed-days';
import { expireStalePaymentLinks } from './payments';
import { resumeAppointment } from './queue';
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
 * Statuses that mean the patient was still waiting to be seen when the day
 * ended. CALLED and IN_CONSULTATION are deliberately not here: at closing time
 * those are almost always the doctor's last patient, who was seen but never
 * clicked past, and calling them a no-show would be false.
 */
const NOT_SEEN_STATUSES = ['CREATED', 'CONFIRMED', 'ARRIVED', 'WAITING', 'HELD', 'SKIPPED'] as const;

/**
 * Marks every appointment still waiting when its day ended as a no-show.
 *
 * A queue is scoped to a service date, so an appointment still WAITING on a
 * past date will never be called — nobody is looking at yesterday's queue.
 * The hospital's rule is that a patient not seen by the end of their day did
 * not show, so that is what they become, and the no-show figures in reports
 * count them.
 *
 * "End of day" is midnight in India: the sweep runs every minute, and from
 * 00:00 IST anything on an earlier date is closed.
 *
 * No WhatsApp message goes out. Marking a no-show by hand sends the patient an
 * "appointment cancelled" note; doing that for every leftover patient at
 * midnight would spend a message each to tell people, hours late, about a day
 * that is already over.
 */
export async function markStaleAppointmentsNoShow(
  now: Date = new Date(),
  options: { hospitalId?: string } = {},
): Promise<number> {
  const db = getAdminDb();
  const statuses = sql.join(
    NOT_SEEN_STATUSES.map((status) => sql`${status}`),
    sql`, `,
  );
  const hospitalFilter = options.hospitalId
    ? sql`and hospital_id = ${options.hospitalId}::uuid`
    : sql``;

  /**
   * One statement, returning each row's status from before the update, so the
   * queue event records what actually changed — the old version could not see
   * it and wrote WAITING for every row. Date arithmetic stays in the database:
   * service_date is a date, and comparing it to a JS timestamp would drag the
   * server's timezone into a decision that has nothing to do with it.
   * SKIP LOCKED leaves a row a receptionist is acting on right now for the
   * next tick instead of waiting on it.
   */
  const rows = await db.execute<{
    id: string;
    hospital_id: string;
    doctor_id: string;
    from_status: string;
  }>(sql`
    with stale as (
      select id, status
      from appointments
      where status::text in (${statuses})
        and service_date < (${now.toISOString()}::timestamptz at time zone 'Asia/Kolkata')::date
        ${hospitalFilter}
      for update skip locked
    )
    update appointments a
    set status = 'NO_SHOW', updated_at = ${now.toISOString()}::timestamptz
    from stale
    where a.id = stale.id
    returning a.id, a.hospital_id, a.doctor_id, stale.status::text as from_status
  `);

  // Queue history stays complete: an appointment that changes status without
  // an event is a gap in the only record that answers "what happened to me".
  if (rows.length > 0) {
    await db.insert(queueEvents).values(
      rows.map((row) => ({
        hospitalId: row.hospital_id,
        appointmentId: row.id,
        doctorId: row.doctor_id,
        action: 'mark_no_show' as const,
        fromStatus: row.from_status as AppointmentStatus,
        toStatus: 'NO_SHOW' as const,
        actorUserId: null,
        metadata: { reason: 'day_ended', swept_at: now.toISOString() },
      })),
    );
  }

  return rows.length;
}

/**
 * Moves HELD appointments whose scheduled resume time has arrived back to
 * WAITING.
 *
 * The doctor set a timer when they paused the appointment ("bring them back
 * in 15 minutes"). This sweep is that timer. It fires on every tick, so the
 * worst-case latency is one tick interval — the same as every other sweep.
 */
export async function resumePausedAppointments(now: Date = new Date()): Promise<number> {
  const db = getAdminDb();

  const due = await db
    .select({
      id: appointments.id,
      hospitalId: appointments.hospitalId,
      doctorId: appointments.doctorId,
      timezone: hospitals.timezone,
    })
    .from(appointments)
    .innerJoin(hospitals, eq(hospitals.id, appointments.hospitalId))
    .where(and(eq(appointments.status, 'HELD'), lte(appointments.resumeAt, now)));

  /**
   * One at a time through the same resume the desk uses, so a timed return
   * gets the same treatment as a manual one: the doctor-day lock, and the
   * late-return placement if their turn passed while they were away.
   */
  let resumed = 0;
  for (const row of due) {
    const result = await resumeAppointment({
      hospitalId: row.hospitalId,
      appointmentId: row.id,
      doctorId: row.doctorId,
      timezone: row.timezone,
      actorUserId: null,
      reason: 'scheduled_auto_resume',
      now,
    });
    if (result.outcome === 'resumed') resumed += 1;
  }

  return resumed;
}

export type SweepResult = {
  appointmentsMarkedNoShow: number;
  appointmentsResumed: number;
  subscriptionsExpired: number;
  paymentLinksExpired: number;
  /** IPD room charges posted (T1.10): one line per occupied bed per day. */
  bedDaysCharged: number;
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
    appointmentsMarkedNoShow: 0,
    appointmentsResumed: 0,
    subscriptionsExpired: 0,
    paymentLinksExpired: 0,
    bedDaysCharged: 0,
  };

  try {
    result.appointmentsMarkedNoShow = await markStaleAppointmentsNoShow(now);
  } catch (error) {
    console.error('[sweeps] end-of-day no-show sweep failed', error);
  }

  try {
    result.appointmentsResumed = await resumePausedAppointments(now);
  } catch (error) {
    console.error('[sweeps] appointment auto-resume failed', error);
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

  try {
    // Throttle counts only matter inside their window, the longest of which
    // is a day. Older rows are dead weight on the index every sign-in reads.
    await getAdminDb()
      .delete(rateLimitEvents)
      .where(lt(rateLimitEvents.createdAt, new Date(now.getTime() - 24 * 60 * 60 * 1000)));
  } catch (error) {
    console.error('[sweeps] throttle pruning failed', error);
  }

  try {
    // Idempotent: computes every day of every stay and adds only what is
    // missing, so running it each tick keeps the running bill current.
    result.bedDaysCharged = await postBedDayCharges(now);
  } catch (error) {
    console.error('[sweeps] bed-day charges failed', error);
  }

  const total =
    result.appointmentsMarkedNoShow + result.appointmentsResumed +
    result.subscriptionsExpired + result.paymentLinksExpired + result.bedDaysCharged;
  if (total > 0) {
    console.log('[sweeps] completed', JSON.stringify(result));
  }

  return result;
}

/** Re-exported so callers have one import for scheduled housekeeping. */
export { expireLapsedSubscriptions, expireStalePaymentLinks };

/** Kept for the rare case a single hospital needs sweeping by hand. */
export function markStaleAppointmentsNoShowForHospital(
  hospitalId: string,
  now: Date = new Date(),
): Promise<number> {
  return markStaleAppointmentsNoShow(now, { hospitalId });
}
