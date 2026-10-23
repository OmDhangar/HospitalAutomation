/**
 * Same-Day "Stop OPD" Intake Control.
 *
 * This service controls whether today's OPD intake is open or stopped for a
 * doctor or an entire branch.
 *
 * The Three States:
 *   - NULL: Open. Normal intake, tokens and slots are issued.
 *   - Past timestamp (stoppedAt <= now): Closed. Intake is shut.
 *   - Future timestamp (stoppedAt > now): Scheduled stop. Intake remains open
 *     right now, but will cut off at that timestamp.
 *
 * Today-Only Constraint:
 *   Stop OPD is strictly a same-day operational control scoped to the
 *   hospital's timezone. It allows reception, doctors, or administrators to close
 *   the door for the remainder of today without affecting future days.
 *   Multi-day closures with patient cancellations are handled separately.
 *
 * Intake Gating:
 *   - Walk-in gate: `now() >= stoppedAt`. A walk-in physically arrives now; if
 *     the stop has passed, the door is closed (unless emergency).
 *   - Slot-booking gate: `slotDatetime >= stoppedAt`. An appointment represents
 *     care delivered at the slot time. A 2:00 PM slot booked at 10:00 AM for a
 *     doctor whose OPD stops at 3:00 PM succeeds; a 4:00 PM slot booked at
 *     10:00 AM fails because the clinic will be closed when that appointment
 *     would take place.
 *
 * State Machine & Queue Integrity:
 *   Existing patients in the queue (WAITING, CALLED, IN_CONSULTATION, HELD,
 *   SKIPPED) are never cancelled or rescheduled by this stop. The queue continues
 *   to be called and completed normally.
 */

import { and, eq, inArray } from 'drizzle-orm';
import { withTenant, type Tx } from '@/lib/db';
import { auditLogs, doctorDayStates, doctors, hospitals } from '@/lib/db/schema';
import { serviceDateIn } from '@/lib/domain/time';

export interface OpdStopStatus {
  /** The effective timestamp on today's row. */
  stoppedAt: Date | null;
  /** Whether intake is currently closed (stoppedAt !== null && stoppedAt <= now). */
  isStopped: boolean;
  /** Whether a closure is scheduled for later today (stoppedAt !== null && stoppedAt > now). */
  scheduled: boolean;
  /** User who stopped OPD, if recorded. */
  stoppedByUserId: string | null;
}

/** 5 minutes grace for clock skew when specifying "now". */
const MAX_PAST_SKEW_MS = 5 * 60 * 1000;

async function loadHospitalTimezoneInTx(tx: Tx, hospitalId: string): Promise<string> {
  const [row] = await tx
    .select({ timezone: hospitals.timezone })
    .from(hospitals)
    .where(eq(hospitals.id, hospitalId));
  return row?.timezone ?? 'Asia/Kolkata';
}

/**
 * Internal variant running inside an existing transaction so caller gates
 * (like createWalkIn) do not open a second transaction.
 */
export async function getOpdStopStatusInTx(
  tx: Tx,
  args: {
    hospitalId: string;
    doctorId: string;
    serviceDate: string;
    now?: Date;
  },
): Promise<OpdStopStatus> {
  const [row] = await tx
    .select({
      opdStoppedAt: doctorDayStates.opdStoppedAt,
      opdStoppedByUserId: doctorDayStates.opdStoppedByUserId,
    })
    .from(doctorDayStates)
    .where(
      and(
        eq(doctorDayStates.hospitalId, args.hospitalId),
        eq(doctorDayStates.doctorId, args.doctorId),
        eq(doctorDayStates.serviceDate, args.serviceDate),
      ),
    );

  const now = args.now ?? new Date();
  const stoppedAt = row?.opdStoppedAt ?? null;
  const isStopped = stoppedAt !== null && stoppedAt.getTime() <= now.getTime();
  const scheduled = stoppedAt !== null && stoppedAt.getTime() > now.getTime();

  return {
    stoppedAt,
    isStopped,
    scheduled,
    stoppedByUserId: row?.opdStoppedByUserId ?? null,
  };
}

/**
 * Reads today's OPD stop status for a doctor.
 */
export async function getOpdStopStatus(args: {
  hospitalId: string;
  doctorId: string;
  serviceDate: string;
  now?: Date;
}): Promise<OpdStopStatus> {
  return withTenant(args.hospitalId, async (tx) => {
    return getOpdStopStatusInTx(tx, args);
  });
}

/**
 * Batch read of OPD stop status for multiple doctors on a date.
 * Avoids N+1 queries on dashboard views.
 */
export async function getBatchOpdStopStatus(args: {
  hospitalId: string;
  doctorIds: string[];
  serviceDate: string;
  now?: Date;
}): Promise<Record<string, OpdStopStatus>> {
  if (args.doctorIds.length === 0) return {};

  return withTenant(args.hospitalId, async (tx) => {
    const rows = await tx
      .select({
        doctorId: doctorDayStates.doctorId,
        opdStoppedAt: doctorDayStates.opdStoppedAt,
        opdStoppedByUserId: doctorDayStates.opdStoppedByUserId,
      })
      .from(doctorDayStates)
      .where(
        and(
          eq(doctorDayStates.hospitalId, args.hospitalId),
          inArray(doctorDayStates.doctorId, args.doctorIds),
          eq(doctorDayStates.serviceDate, args.serviceDate),
        ),
      );

    const now = args.now ?? new Date();
    const map: Record<string, OpdStopStatus> = {};
    const byDoctorId = new Map(rows.map((r) => [r.doctorId, r]));

    for (const docId of args.doctorIds) {
      const row = byDoctorId.get(docId);
      const stoppedAt = row?.opdStoppedAt ?? null;
      map[docId] = {
        stoppedAt,
        isStopped: stoppedAt !== null && stoppedAt.getTime() <= now.getTime(),
        scheduled: stoppedAt !== null && stoppedAt.getTime() > now.getTime(),
        stoppedByUserId: row?.opdStoppedByUserId ?? null,
      };
    }

    return map;
  });
}

/**
 * Stops OPD intake for a doctor today (immediately or scheduled for later today).
 */
export async function stopOpdForDoctor(args: {
  hospitalId: string;
  doctorId: string;
  serviceDate: string;
  stopAt: Date;
  actorUserId: string;
  reason?: string;
  now?: Date;
}): Promise<{ stoppedAt: Date }> {
  return withTenant(args.hospitalId, async (tx) => {
    const timezone = await loadHospitalTimezoneInTx(tx, args.hospitalId);
    const now = args.now ?? new Date();
    const today = serviceDateIn(timezone, now);

    if (args.serviceDate !== today) {
      throw new Error('Stop OPD is only available for today');
    }

    if (args.stopAt.getTime() < now.getTime() - MAX_PAST_SKEW_MS) {
      throw new Error('Stop time cannot be more than 5 minutes in the past');
    }

    if (serviceDateIn(timezone, args.stopAt) !== args.serviceDate) {
      throw new Error('Stop time must fall on today in the hospital timezone');
    }

    await tx
      .insert(doctorDayStates)
      .values({
        hospitalId: args.hospitalId,
        doctorId: args.doctorId,
        serviceDate: args.serviceDate,
        opdStoppedAt: args.stopAt,
        opdStoppedByUserId: args.actorUserId,
      })
      .onConflictDoUpdate({
        target: [doctorDayStates.doctorId, doctorDayStates.serviceDate],
        set: {
          opdStoppedAt: args.stopAt,
          opdStoppedByUserId: args.actorUserId,
          updatedAt: now,
        },
      });

    await tx.insert(auditLogs).values({
      hospitalId: args.hospitalId,
      actorUserId: args.actorUserId,
      action: 'opd.stop',
      objectType: 'doctor_day_state',
      objectId: `${args.doctorId}:${args.serviceDate}`,
      metadata: {
        stopAt: args.stopAt.toISOString(),
        reason: args.reason ?? null,
      },
    });

    return { stoppedAt: args.stopAt };
  });
}

/**
 * Reopens OPD intake for a doctor today.
 * If no doctor_day_states row exists yet, this is a no-op success.
 */
export async function reopenOpdForDoctor(args: {
  hospitalId: string;
  doctorId: string;
  serviceDate: string;
  actorUserId: string;
  reason?: string;
  now?: Date;
}): Promise<void> {
  return withTenant(args.hospitalId, async (tx) => {
    const timezone = await loadHospitalTimezoneInTx(tx, args.hospitalId);
    const now = args.now ?? new Date();
    const today = serviceDateIn(timezone, now);

    if (args.serviceDate !== today) {
      throw new Error('Reopen OPD is only available for today');
    }

    const [existing] = await tx
      .select({ id: doctorDayStates.id })
      .from(doctorDayStates)
      .where(
        and(
          eq(doctorDayStates.hospitalId, args.hospitalId),
          eq(doctorDayStates.doctorId, args.doctorId),
          eq(doctorDayStates.serviceDate, args.serviceDate),
        ),
      );

    if (!existing) {
      // Nothing to reopen — do not insert a row just to record nothing happened.
      return;
    }

    await tx
      .update(doctorDayStates)
      .set({
        opdStoppedAt: null,
        opdStoppedByUserId: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(doctorDayStates.hospitalId, args.hospitalId),
          eq(doctorDayStates.doctorId, args.doctorId),
          eq(doctorDayStates.serviceDate, args.serviceDate),
        ),
      );

    await tx.insert(auditLogs).values({
      hospitalId: args.hospitalId,
      actorUserId: args.actorUserId,
      action: 'opd.reopen',
      objectType: 'doctor_day_state',
      objectId: `${args.doctorId}:${args.serviceDate}`,
      metadata: {
        reason: args.reason ?? null,
      },
    });
  });
}

/**
 * Stops OPD intake for all active doctors in a branch today.
 * Executes all doctor upserts in a single transaction and writes ONE audit_logs row.
 */
export async function stopOpdForBranch(args: {
  hospitalId: string;
  branchId: string;
  serviceDate: string;
  stopAt: Date;
  actorUserId: string;
  reason?: string;
  now?: Date;
}): Promise<{ doctorCount: number }> {
  return withTenant(args.hospitalId, async (tx) => {
    const timezone = await loadHospitalTimezoneInTx(tx, args.hospitalId);
    const now = args.now ?? new Date();
    const today = serviceDateIn(timezone, now);

    if (args.serviceDate !== today) {
      throw new Error('Stop OPD is only available for today');
    }

    if (args.stopAt.getTime() < now.getTime() - MAX_PAST_SKEW_MS) {
      throw new Error('Stop time cannot be more than 5 minutes in the past');
    }

    if (serviceDateIn(timezone, args.stopAt) !== args.serviceDate) {
      throw new Error('Stop time must fall on today in the hospital timezone');
    }

    const branchDoctors = await tx
      .select({ id: doctors.id })
      .from(doctors)
      .where(
        and(
          eq(doctors.hospitalId, args.hospitalId),
          eq(doctors.branchId, args.branchId),
          eq(doctors.active, true),
        ),
      );

    for (const doc of branchDoctors) {
      await tx
        .insert(doctorDayStates)
        .values({
          hospitalId: args.hospitalId,
          doctorId: doc.id,
          serviceDate: args.serviceDate,
          opdStoppedAt: args.stopAt,
          opdStoppedByUserId: args.actorUserId,
        })
        .onConflictDoUpdate({
          target: [doctorDayStates.doctorId, doctorDayStates.serviceDate],
          set: {
            opdStoppedAt: args.stopAt,
            opdStoppedByUserId: args.actorUserId,
            updatedAt: now,
          },
        });
    }

    await tx.insert(auditLogs).values({
      hospitalId: args.hospitalId,
      actorUserId: args.actorUserId,
      action: 'opd.stop',
      objectType: 'branch',
      objectId: `${args.branchId}:${args.serviceDate}`,
      metadata: {
        branchId: args.branchId,
        doctorCount: branchDoctors.length,
        stopAt: args.stopAt.toISOString(),
        reason: args.reason ?? null,
      },
    });

    return { doctorCount: branchDoctors.length };
  });
}
