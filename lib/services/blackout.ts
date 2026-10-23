/**
 * Blackout & Multi-Day Holiday Shutdown Service (ADR-040).
 *
 * Manages calendar shutdowns and blackouts for hospitals, branches, and doctors.
 * Handles deterministic locking, state machine cancellations, audit logging,
 * voiding of draft consultation charges, and Meta-approved WhatsApp outbox notices.
 */

import { and, desc, eq, gte, isNull, lte, or, inArray } from 'drizzle-orm';
import { withTenant, type Tx } from '@/lib/db';
import {
  appointments,
  auditLogs,
  billItems,
  blackoutPeriods,
  branches,
  doctors,
  hospitals,
  notificationOutbox,
  patients,
  queueEvents,
} from '@/lib/db/schema';
import { canCancel } from '@/lib/domain/queue';
import { serviceDateIn } from '@/lib/domain/time';
import { lockDoctorDay } from '@/lib/services/doctor-day';

export interface BlackoutDisruptionPreview {
  totalAppointments: number;
  willCancel: number;
  inConsultationOrDone: number;
  messageCount: number;
}

export interface BlackoutPeriodItem {
  id: string;
  hospitalId: string;
  branchId: string | null;
  branchName: string | null;
  doctorId: string | null;
  doctorName: string | null;
  startDate: string;
  endDate: string;
  reopenDate: string;
  reason: string;
  publicReason: string | null;
  createdByUserId: string | null;
  cancelledAt: Date | null;
  cancelledByUserId: string | null;
  createdAt: Date;
}

async function loadHospitalTimezoneInTx(tx: Tx, hospitalId: string): Promise<string> {
  const [row] = await tx
    .select({ timezone: hospitals.timezone })
    .from(hospitals)
    .where(eq(hospitals.id, hospitalId));
  return row?.timezone ?? 'Asia/Kolkata';
}

function isAppointmentCancellable(status: string, serviceDate: string, today: string): boolean {
  if (serviceDate === today) {
    // For a blackout starting today, CALLED patients are right now (walking in / waiting room).
    // They must NOT be cancelled. Cancel CREATED, CONFIRMED, WAITING, SKIPPED, HELD.
    return ['CREATED', 'CONFIRMED', 'WAITING', 'SKIPPED', 'HELD'].includes(status) && canCancel(status as any);
  }
  // Future dates: cancel CREATED, CONFIRMED, WAITING.
  return ['CREATED', 'CONFIRMED', 'WAITING'].includes(status) && canCancel(status as any);
}

function isInConsultationOrDone(status: string): boolean {
  return ['CALLED', 'IN_CONSULTATION', 'COMPLETED'].includes(status);
}

/**
 * Previews the patient and appointment impact of a proposed blackout window.
 */
export async function previewBlackoutDisruption(args: {
  hospitalId: string;
  branchId?: string | null;
  doctorId?: string | null;
  startDate: string;
  endDate: string;
  timezone?: string;
  now?: Date;
}): Promise<BlackoutDisruptionPreview> {
  if (args.startDate > args.endDate) {
    throw new Error('Start date cannot be after end date');
  }

  return withTenant(args.hospitalId, async (tx) => {
    const timezone = args.timezone ?? (await loadHospitalTimezoneInTx(tx, args.hospitalId));
    const now = args.now ?? new Date();
    const today = serviceDateIn(timezone, now);

    const conditions = [
      eq(appointments.hospitalId, args.hospitalId),
      gte(appointments.serviceDate, args.startDate),
      lte(appointments.serviceDate, args.endDate),
    ];

    if (args.doctorId) {
      conditions.push(eq(appointments.doctorId, args.doctorId));
    }
    if (args.branchId) {
      conditions.push(eq(appointments.branchId, args.branchId));
    }

    const rows = await tx
      .select({
        id: appointments.id,
        status: appointments.status,
        serviceDate: appointments.serviceDate,
        phoneE164: patients.phoneE164,
        whatsappOptInAt: patients.whatsappOptInAt,
      })
      .from(appointments)
      .innerJoin(patients, eq(patients.id, appointments.patientId))
      .where(and(...conditions));

    let willCancel = 0;
    let inConsultationOrDone = 0;
    let messageCount = 0;

    for (const row of rows) {
      if (isAppointmentCancellable(row.status, row.serviceDate, today)) {
        willCancel++;
        if (row.phoneE164 && row.whatsappOptInAt) {
          messageCount++;
        }
      } else if (isInConsultationOrDone(row.status)) {
        inConsultationOrDone++;
      }
    }

    return {
      totalAppointments: rows.length,
      willCancel,
      inConsultationOrDone,
      messageCount,
    };
  });
}

/**
 * Creates a blackout period and processes cancellations for all affected appointments.
 * Serializes today's intake via doctorDay row locks, records queue_events,
 * voids un-voided consultation draft bill items, and enqueues WhatsApp cancellation notices.
 */
export async function createBlackoutPeriodAndNotify(args: {
  hospitalId: string;
  branchId?: string | null;
  doctorId?: string | null;
  startDate: string;
  endDate: string;
  reopenDate: string;
  reason: string;
  publicReason?: string | null;
  actorUserId?: string | null;
  now?: Date;
  timezone?: string;
}): Promise<{ blackoutId: string; cancelledCount: number; notifiedCount: number }> {
  if (args.startDate > args.endDate) {
    throw new Error('Start date cannot be after end date');
  }
  if (args.reopenDate <= args.endDate) {
    throw new Error('Reopen date must be after end date');
  }

  const now = args.now ?? new Date();

  return withTenant(args.hospitalId, async (tx) => {
    const timezone = args.timezone ?? (await loadHospitalTimezoneInTx(tx, args.hospitalId));
    const today = serviceDateIn(timezone, now);

    // 1. Overlapping active blackout validation (NB4)
    const overlapConditions = [
      eq(blackoutPeriods.hospitalId, args.hospitalId),
      isNull(blackoutPeriods.cancelledAt),
      lte(blackoutPeriods.startDate, args.endDate),
      gte(blackoutPeriods.endDate, args.startDate),
    ];

    if (args.doctorId) {
      overlapConditions.push(
        or(isNull(blackoutPeriods.doctorId), eq(blackoutPeriods.doctorId, args.doctorId))!,
      );
    }
    if (args.branchId) {
      overlapConditions.push(
        or(isNull(blackoutPeriods.branchId), eq(blackoutPeriods.branchId, args.branchId))!,
      );
    }

    const [existingOverlap] = await tx
      .select({ id: blackoutPeriods.id, startDate: blackoutPeriods.startDate, endDate: blackoutPeriods.endDate })
      .from(blackoutPeriods)
      .where(and(...overlapConditions))
      .limit(1);

    if (existingOverlap) {
      throw new Error(
        `An active blackout period already covers part of this date range (${existingOverlap.startDate} to ${existingOverlap.endDate})`,
      );
    }

    // 2. Multi-doctor today lock serialization (NB5, NB-NEW-2, NB-NEW-3)
    if (args.startDate <= today && args.endDate >= today) {
      let targetDoctorIds: string[] = [];
      if (args.doctorId) {
        targetDoctorIds = [args.doctorId];
      } else {
        const docConditions = [
          eq(doctors.hospitalId, args.hospitalId),
          eq(doctors.active, true),
        ];
        if (args.branchId) {
          docConditions.push(eq(doctors.branchId, args.branchId));
        }
        const docRows = await tx.select({ id: doctors.id }).from(doctors).where(and(...docConditions));
        targetDoctorIds = docRows.map((d) => d.id);
      }

      // Sort deterministically to eliminate deadlock risk across concurrent blackout creations
      const sortedDoctorIds = [...targetDoctorIds].sort();
      for (const docId of sortedDoctorIds) {
        await lockDoctorDay(tx, { hospitalId: args.hospitalId, doctorId: docId, serviceDate: today });
      }
    }

    // 3. Insert blackout_periods record
    const [blackout] = await tx
      .insert(blackoutPeriods)
      .values({
        hospitalId: args.hospitalId,
        branchId: args.branchId ?? null,
        doctorId: args.doctorId ?? null,
        startDate: args.startDate,
        endDate: args.endDate,
        reopenDate: args.reopenDate,
        reason: args.reason,
        publicReason: args.publicReason ?? null,
        createdByUserId: args.actorUserId ?? null,
      })
      .returning({ id: blackoutPeriods.id });

    // 4. Fetch candidate appointments for update
    const apptConditions = [
      eq(appointments.hospitalId, args.hospitalId),
      gte(appointments.serviceDate, args.startDate),
      lte(appointments.serviceDate, args.endDate),
    ];
    if (args.doctorId) {
      apptConditions.push(eq(appointments.doctorId, args.doctorId));
    }
    if (args.branchId) {
      apptConditions.push(eq(appointments.branchId, args.branchId));
    }

    const candidates = await tx
      .select({
        id: appointments.id,
        doctorId: appointments.doctorId,
        patientId: appointments.patientId,
        status: appointments.status,
        serviceDate: appointments.serviceDate,
        tokenNumber: appointments.tokenNumber,
        doctorName: doctors.name,
        patientPhone: patients.phoneE164,
        patientOptInAt: patients.whatsappOptInAt,
        patientLocale: patients.locale,
      })
      .from(appointments)
      .innerJoin(doctors, eq(doctors.id, appointments.doctorId))
      .innerJoin(patients, eq(patients.id, appointments.patientId))
      .where(and(...apptConditions))
      .for('update');

    let cancelledCount = 0;
    let notifiedCount = 0;

    for (const appt of candidates) {
      if (!isAppointmentCancellable(appt.status, appt.serviceDate, today)) {
        continue;
      }

      // Update appointment status to CANCELLED
      await tx
        .update(appointments)
        .set({ status: 'CANCELLED', updatedAt: now })
        .where(eq(appointments.id, appt.id));

      // Audit transition in queue_events
      await tx.insert(queueEvents).values({
        hospitalId: args.hospitalId,
        appointmentId: appt.id,
        doctorId: appt.doctorId,
        action: 'cancel',
        fromStatus: appt.status,
        toStatus: 'CANCELLED',
        actorUserId: args.actorUserId ?? null,
        metadata: {
          reason: 'blackout',
          blackout_id: blackout.id,
          public_reason: args.publicReason ?? null,
        },
      });

      // Void any un-voided draft consultation bill items (NH4)
      await tx
        .update(billItems)
        .set({
          voidedAt: now,
          voidedByUserId: args.actorUserId ?? null,
          voidReason: 'blackout',
        })
        .where(
          and(
            eq(billItems.hospitalId, args.hospitalId),
            eq(billItems.appointmentId, appt.id),
            isNull(billItems.voidedAt),
          ),
        );

      // Enqueue Meta-approved WhatsApp cancellation notice if opted-in
      if (appt.patientPhone && appt.patientOptInAt) {
        const appointmentDateFormatted = new Intl.DateTimeFormat('en-IN', {
          timeZone: timezone,
          day: 'numeric',
          month: 'short',
        }).format(new Date(`${appt.serviceDate}T12:00:00Z`));

        await tx
          .insert(notificationOutbox)
          .values({
            hospitalId: args.hospitalId,
            appointmentId: appt.id,
            patientId: appt.patientId,
            milestone: 'appointment_cancelled:blackout',
            templateCode: 'appointment_cancelled',
            locale: (appt.patientLocale as any) ?? 'en',
            payload: {
              doctorName: appt.doctorName,
              doctorId: appt.doctorId,
              appointmentDate: appointmentDateFormatted,
            },
          })
          .onConflictDoNothing();

        notifiedCount++;
      }

      cancelledCount++;
    }

    // 5. Write audit log
    await tx.insert(auditLogs).values({
      hospitalId: args.hospitalId,
      actorUserId: args.actorUserId ?? null,
      action: 'blackout.created',
      objectType: 'blackout_period',
      objectId: blackout.id,
      metadata: {
        startDate: args.startDate,
        endDate: args.endDate,
        reopenDate: args.reopenDate,
        reason: args.reason,
        publicReason: args.publicReason ?? null,
        cancelledCount,
        notifiedCount,
        doctorId: args.doctorId ?? null,
        branchId: args.branchId ?? null,
      },
    });

    return {
      blackoutId: blackout.id,
      cancelledCount,
      notifiedCount,
    };
  });
}

/**
 * Revokes / cancels an active blackout period.
 * Does not resurrect cancelled appointments. Immediately re-enables intake.
 */
export async function cancelBlackoutPeriod(args: {
  hospitalId: string;
  blackoutId: string;
  actorUserId?: string | null;
  now?: Date;
}): Promise<void> {
  const now = args.now ?? new Date();

  return withTenant(args.hospitalId, async (tx) => {
    const [updated] = await tx
      .update(blackoutPeriods)
      .set({
        cancelledAt: now,
        cancelledByUserId: args.actorUserId ?? null,
        updatedAt: now,
      })
      .where(
        and(
          eq(blackoutPeriods.hospitalId, args.hospitalId),
          eq(blackoutPeriods.id, args.blackoutId),
          isNull(blackoutPeriods.cancelledAt),
        ),
      )
      .returning({ id: blackoutPeriods.id });

    if (!updated) {
      return;
    }

    await tx.insert(auditLogs).values({
      hospitalId: args.hospitalId,
      actorUserId: args.actorUserId ?? null,
      action: 'blackout.cancelled',
      objectType: 'blackout_period',
      objectId: args.blackoutId,
      metadata: {
        cancelledAt: now.toISOString(),
      },
    });
  });
}

/**
 * Lists blackout periods for a hospital, ordered newest first.
 */
export async function listBlackoutPeriods(args: {
  hospitalId: string;
  branchId?: string | null;
  doctorId?: string | null;
}): Promise<BlackoutPeriodItem[]> {
  return withTenant(args.hospitalId, async (tx) => {
    const conditions = [eq(blackoutPeriods.hospitalId, args.hospitalId)];

    if (args.branchId) {
      conditions.push(or(isNull(blackoutPeriods.branchId), eq(blackoutPeriods.branchId, args.branchId))!);
    }
    if (args.doctorId) {
      conditions.push(or(isNull(blackoutPeriods.doctorId), eq(blackoutPeriods.doctorId, args.doctorId))!);
    }

    const rows = await tx
      .select({
        id: blackoutPeriods.id,
        hospitalId: blackoutPeriods.hospitalId,
        branchId: blackoutPeriods.branchId,
        branchName: branches.name,
        doctorId: blackoutPeriods.doctorId,
        doctorName: doctors.name,
        startDate: blackoutPeriods.startDate,
        endDate: blackoutPeriods.endDate,
        reopenDate: blackoutPeriods.reopenDate,
        reason: blackoutPeriods.reason,
        publicReason: blackoutPeriods.publicReason,
        createdByUserId: blackoutPeriods.createdByUserId,
        cancelledAt: blackoutPeriods.cancelledAt,
        cancelledByUserId: blackoutPeriods.cancelledByUserId,
        createdAt: blackoutPeriods.createdAt,
      })
      .from(blackoutPeriods)
      .leftJoin(branches, eq(branches.id, blackoutPeriods.branchId))
      .leftJoin(doctors, eq(doctors.id, blackoutPeriods.doctorId))
      .where(and(...conditions))
      .orderBy(desc(blackoutPeriods.startDate), desc(blackoutPeriods.createdAt));

    return rows;
  });
}
