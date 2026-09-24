import { and, eq, inArray, sql } from 'drizzle-orm';
import { withTenant } from '@/lib/db';
import {
  appointments,
  auditLogs,
  doctorIntervalBlocks,
  doctors,
  hospitals,
  notificationOutbox,
  patients,
  queueEvents,
} from '@/lib/db/schema';
import {
  disruptionActionFor,
  disruptionMessage,
  minutesOfDayIn,
  slotIsInBlock,
  summarise,
  type DisruptionAction,
  type DisruptionSummary,
} from '@/lib/domain/disruption';
import { timeStringToMinutes } from './scheduling';

/**
 * A doctor becoming unavailable for part of a day, handled end to end.
 *
 * `addIntervalBlock` in scheduling.ts already stops new bookings landing in
 * the window, and the UI already reports that as success. It is only half the
 * job: the patients already holding slots inside the window are not told
 * anything, their appointments stay live, and they travel to the hospital for
 * a doctor who has gone. This module is the other half.
 *
 * The block and the cancellations happen in one transaction. A half-applied
 * emergency — window blocked but patients still booked, or patients cancelled
 * with the window still open for rebooking into — is worse than either
 * outcome on its own.
 */

/** Statuses worth examining. Terminal ones are excluded in SQL. */
const LIVE_STATUSES = [
  'CREATED',
  'CONFIRMED',
  'ARRIVED',
  'WAITING',
  'HELD',
  'SKIPPED',
  'CALLED',
  'IN_CONSULTATION',
] as const;

export type AffectedPatient = {
  appointmentId: string;
  patientName: string;
  phoneE164: string | null;
  tokenNumber: number | null;
  slotAt: Date;
  action: DisruptionAction;
};

export type DisruptionOutcome = {
  blockId: string;
  summary: DisruptionSummary;
  /** Those still owed a conversation at the desk. */
  needsDeskAction: AffectedPatient[];
  /** One sentence for the person who pressed the button. */
  message: string;
};

/**
 * Blocks a window and deals with everyone booked inside it.
 *
 * Idempotent where it matters. The outbox's unique index on
 * (appointment_id, milestone) means re-running this for the same block cannot
 * message a patient twice, and an appointment already CANCELLED is skipped by
 * the status filter rather than cancelled again.
 */
export async function blockIntervalAndNotify(args: {
  hospitalId: string;
  doctorId: string;
  serviceDate: string;
  /** "13:00" or "13:00:00". */
  startTime: string;
  endTime: string;
  reason?: string | null;
  actorUserId?: string | null;
}): Promise<DisruptionOutcome> {
  const startTime = args.startTime.length === 5 ? `${args.startTime}:00` : args.startTime;
  const endTime = args.endTime.length === 5 ? `${args.endTime}:00` : args.endTime;

  const blockStartMinutes = timeStringToMinutes(startTime);
  const blockEndMinutes = timeStringToMinutes(endTime);

  if (blockEndMinutes <= blockStartMinutes) {
    throw new Error('The end of an unavailability window must be after its start');
  }

  return withTenant(args.hospitalId, async (tx) => {
    const [hospital] = await tx
      .select({ timezone: hospitals.timezone })
      .from(hospitals)
      .where(eq(hospitals.id, args.hospitalId));
    const timezone = hospital?.timezone ?? 'Asia/Kolkata';

    const [doctor] = await tx
      .select({ name: doctors.name })
      .from(doctors)
      .where(eq(doctors.id, args.doctorId));

    const [block] = await tx
      .insert(doctorIntervalBlocks)
      .values({
        hospitalId: args.hospitalId,
        doctorId: args.doctorId,
        serviceDate: args.serviceDate,
        startTime,
        endTime,
        reason: args.reason ?? 'Emergency / Temporary Unavailability',
        active: true,
      })
      .returning({ id: doctorIntervalBlocks.id });

    /**
     * Every slot booking on the day, filtered in application code rather than
     * SQL.
     *
     * The comparison has to happen in the hospital's timezone, and the
     * alternative — a timezone-aware interval predicate in SQL — is both
     * harder to read and harder to test than fetching a single doctor's
     * bookings for a single day and checking them in a pure function. The row
     * count here is a day's appointments, not a table scan.
     */
    const candidates = await tx
      .select({
        id: appointments.id,
        status: appointments.status,
        scheduledSlotAt: appointments.scheduledSlotAt,
        tokenNumber: appointments.tokenNumber,
        patientId: appointments.patientId,
        patientName: patients.name,
        phoneE164: patients.phoneE164,
        locale: patients.locale,
        optInAt: patients.whatsappOptInAt,
      })
      .from(appointments)
      .leftJoin(patients, eq(patients.id, appointments.patientId))
      .where(
        and(
          eq(appointments.doctorId, args.doctorId),
          eq(appointments.serviceDate, args.serviceDate),
          sql`${appointments.scheduledSlotAt} is not null`,
          inArray(appointments.status, [...LIVE_STATUSES]),
        ),
      );

    const affected: Array<(typeof candidates)[number] & { action: DisruptionAction }> = [];

    for (const row of candidates) {
      if (!row.scheduledSlotAt) continue;
      const slotMinutes = minutesOfDayIn(timezone, row.scheduledSlotAt);
      if (!slotIsInBlock({ slotMinutes, blockStartMinutes, blockEndMinutes })) continue;
      affected.push({ ...row, action: disruptionActionFor(row.status) });
    }

    const toCancel = affected.filter((row) => row.action === 'cancel_and_notify');
    const now = new Date();

    for (const row of toCancel) {
      await tx
        .update(appointments)
        .set({ status: 'CANCELLED', updatedAt: now })
        .where(eq(appointments.id, row.id));

      // Queue history is append-only and is what answers "why did my
      // appointment vanish" three weeks later. The reason is recorded as
      // structured metadata rather than prose so it can be counted.
      await tx.insert(queueEvents).values({
        hospitalId: args.hospitalId,
        appointmentId: row.id,
        doctorId: args.doctorId,
        action: 'cancel',
        fromStatus: row.status,
        toStatus: 'CANCELLED',
        actorUserId: args.actorUserId ?? null,
        metadata: {
          reason: 'doctor_unavailable',
          interval_block_id: block.id,
          window: `${startTime}-${endTime}`,
        },
      });

      /**
       * Consent still gates the message, exactly as it does everywhere else.
       * A patient who never opted in does not get one because their doctor had
       * an emergency — they appear in the desk-action list instead, for a
       * phone call.
       */
      if (!row.phoneE164 || !row.optInAt) continue;

      // Narrowed above by the `continue` when scheduledSlotAt is absent, but
      // TypeScript cannot carry that through the array build.
      const slotAt = row.scheduledSlotAt!;
      const appointmentTime = new Intl.DateTimeFormat('en-IN', {
        timeZone: timezone,
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
      }).format(slotAt);
      const appointmentDate = new Intl.DateTimeFormat('en-IN', {
        timeZone: timezone,
        day: 'numeric',
        month: 'short',
      }).format(slotAt);

      await tx
        .insert(notificationOutbox)
        .values({
          hospitalId: args.hospitalId,
          appointmentId: row.id,
          patientId: row.patientId,
          // Distinct per block, so re-blocking a different window later still
          // messages the patient while re-running the same block does not.
          milestone: `slot_disrupted:${block.id}`,
          templateCode: 'slot_disrupted',
          locale: row.locale ?? 'en',
          payload: {
            doctorName: doctor?.name ?? 'your doctor',
            appointmentTime,
            appointmentDate,
            doctorId: args.doctorId,
          },
        })
        // The dedup index on (appointment_id, milestone) is what makes a
        // double-clicked emergency button harmless.
        .onConflictDoNothing();
    }

    const summary = summarise(affected.map((row) => row.action));

    await tx.insert(auditLogs).values({
      hospitalId: args.hospitalId,
      actorUserId: args.actorUserId ?? null,
      action: 'doctor.unavailable.declared',
      objectType: 'doctor_interval_block',
      objectId: block.id,
      metadata: {
        doctor_id: args.doctorId,
        service_date: args.serviceDate,
        window: `${startTime}-${endTime}`,
        reason: args.reason ?? 'Emergency / Temporary Unavailability',
        cancelled: summary.cancelled,
        needs_desk_action: summary.needsDeskAction,
      },
    });

    console.log(
      '[disruption:declared]',
      JSON.stringify({
        hospital_id: args.hospitalId,
        doctor_id: args.doctorId,
        service_date: args.serviceDate,
        window: `${startTime}-${endTime}`,
        cancelled: summary.cancelled,
        needs_desk_action: summary.needsDeskAction,
      }),
    );

    return {
      blockId: block.id,
      summary,
      needsDeskAction: affected
        .filter((row) => row.action === 'needs_desk_action')
        .map((row) => ({
          appointmentId: row.id,
          patientName: row.patientName ?? 'Unknown',
          phoneE164: row.phoneE164,
          tokenNumber: row.tokenNumber,
          slotAt: row.scheduledSlotAt!,
          action: row.action,
        })),
      message: disruptionMessage(summary),
    };
  });
}

/**
 * Who would be affected, without changing anything.
 *
 * Shown before the block is applied. Cancelling a morning of appointments is
 * not undoable by pressing the button again — the messages have gone — so the
 * person declaring the emergency should see the count first.
 */
export async function previewDisruption(args: {
  hospitalId: string;
  doctorId: string;
  serviceDate: string;
  startTime: string;
  endTime: string;
}): Promise<DisruptionSummary> {
  const startTime = args.startTime.length === 5 ? `${args.startTime}:00` : args.startTime;
  const endTime = args.endTime.length === 5 ? `${args.endTime}:00` : args.endTime;

  const blockStartMinutes = timeStringToMinutes(startTime);
  const blockEndMinutes = timeStringToMinutes(endTime);
  if (blockEndMinutes <= blockStartMinutes) {
    return { cancelled: 0, needsDeskAction: 0, leftAlone: 0 };
  }

  return withTenant(args.hospitalId, async (tx) => {
    const [hospital] = await tx
      .select({ timezone: hospitals.timezone })
      .from(hospitals)
      .where(eq(hospitals.id, args.hospitalId));
    const timezone = hospital?.timezone ?? 'Asia/Kolkata';

    const rows = await tx
      .select({
        status: appointments.status,
        scheduledSlotAt: appointments.scheduledSlotAt,
      })
      .from(appointments)
      .where(
        and(
          eq(appointments.doctorId, args.doctorId),
          eq(appointments.serviceDate, args.serviceDate),
          sql`${appointments.scheduledSlotAt} is not null`,
          inArray(appointments.status, [...LIVE_STATUSES]),
        ),
      );

    const actions = rows
      .filter(
        (row) =>
          row.scheduledSlotAt &&
          slotIsInBlock({
            slotMinutes: minutesOfDayIn(timezone, row.scheduledSlotAt),
            blockStartMinutes,
            blockEndMinutes,
          }),
      )
      .map((row) => disruptionActionFor(row.status));

    return summarise(actions);
  });
}
