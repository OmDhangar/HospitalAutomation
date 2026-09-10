import { and, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { getDb, withTenant, type Tx } from '@/lib/db';
import {
  appointments,
  doctorDayStates,
  doctors,
  notificationOutbox,
  patients,
  queueEvents,
} from '@/lib/db/schema';
import { estimateEta, type EtaEstimate } from '@/lib/domain/eta';
import {
  applyAction,
  callNext,
  isActive,
  orderQueue,
  patientsAhead,
} from '@/lib/domain/queue';
import { currentDelayMinutes, serviceDateIn } from '@/lib/domain/time';
import type { AppointmentStatus, QueueAction, QueueEntry } from '@/lib/domain/types';
import { generatePublicToken } from '@/lib/security/tokens';

/** Notify a patient once they are this close to the front. */
export const MILESTONE_AHEAD = 4;
const MILESTONE_KIND = `queue_ahead_${MILESTONE_AHEAD}`;
const CONSULT_SAMPLE_SIZE = 50;

export type QueueRow = {
  appointmentId: string;
  tokenNumber: number;
  status: AppointmentStatus;
  priority: number;
  patientName: string;
  patientAge?: number | null;
  patientId: string;
  enqueuedAt: Date | null;
  calledAt: Date | null;
  scheduledSlotAt?: Date | null;
};

export type QueueSnapshot = {
  doctorId: string;
  doctorName: string;
  serviceDate: string;
  paused: boolean;
  pausedReason: string | null;
  currentToken: number | null;
  waitingCount: number;
  completedCount: number;
  rows: QueueRow[];
  /** Skipped and held patients: out of the line, but recoverable. */
  parked: QueueRow[];
  medianConsultMinutes: number | null;
  delayMinutes: number;
};

/* ------------------------------------------------------------- internals */

const toQueueEntry = (row: {
  id: string;
  tokenNumber: number;
  status: AppointmentStatus;
  priority: number;
  enqueuedAt: Date | null;
  createdAt: Date;
}): QueueEntry => ({
  appointmentId: row.id,
  tokenNumber: row.tokenNumber,
  status: row.status,
  priority: row.priority,
  // Falling back to createdAt keeps ordering total even for rows that were
  // never explicitly enqueued.
  enqueuedAt: row.enqueuedAt ?? row.createdAt,
});

/**
 * Creates the doctor-day row if today is its first appointment, then takes a
 * row-level lock on it.
 *
 * Every queue mutation goes through here first. Concurrent writers serialise on
 * this single row, which is what makes two receptionists pressing Next at the
 * same moment safe without any application-level locking.
 */
async function lockDoctorDay(
  tx: Tx,
  args: { hospitalId: string; doctorId: string; serviceDate: string },
) {
  await tx
    .insert(doctorDayStates)
    .values({
      hospitalId: args.hospitalId,
      doctorId: args.doctorId,
      serviceDate: args.serviceDate,
    })
    .onConflictDoNothing();

  const [state] = await tx
    .select()
    .from(doctorDayStates)
    .where(
      and(
        eq(doctorDayStates.doctorId, args.doctorId),
        eq(doctorDayStates.serviceDate, args.serviceDate),
      ),
    )
    .for('update');

  return state;
}

async function loadDayAppointments(
  tx: Tx,
  args: { doctorId: string; serviceDate: string },
) {
  return tx
    .select({
      id: appointments.id,
      tokenNumber: appointments.tokenNumber,
      status: appointments.status,
      priority: appointments.priority,
      enqueuedAt: appointments.enqueuedAt,
      calledAt: appointments.calledAt,
      createdAt: appointments.createdAt,
      patientId: appointments.patientId,
      patientName: patients.name,
      patientAge: patients.age,
      whatsappOptInAt: patients.whatsappOptInAt,
      scheduledSlotAt: appointments.scheduledSlotAt,
    })
    .from(appointments)
    .innerJoin(patients, eq(patients.id, appointments.patientId))
    .where(
      and(
        eq(appointments.doctorId, args.doctorId),
        eq(appointments.serviceDate, args.serviceDate),
      ),
    );
}

/** Observed consultation lengths, most recent last, for the ETA model. */
async function loadConsultDurations(tx: Tx, doctorId: string): Promise<number[]> {
  const rows = await tx
    .select({
      minutes: sql<number>`
        extract(epoch from (${appointments.completedAt} - ${appointments.consultStartedAt})) / 60
      `,
    })
    .from(appointments)
    .where(
      and(
        eq(appointments.doctorId, doctorId),
        eq(appointments.status, 'COMPLETED'),
        isNotNull(appointments.consultStartedAt),
        isNotNull(appointments.completedAt),
      ),
    )
    .orderBy(desc(appointments.completedAt))
    .limit(CONSULT_SAMPLE_SIZE);

  return rows
    .map((row) => Number(row.minutes))
    // A consultation cannot take zero minutes or three hours; clock skew and
    // forgotten Complete clicks would otherwise poison the median.
    .filter((minutes) => Number.isFinite(minutes) && minutes > 0 && minutes < 180)
    .reverse();
}

/**
 * Dashboard-optimized variant: scoped to a single service date.
 *
 * On the dashboard, the queue resets daily and all patients are handled
 * within the day, so we only need today's durations for the ETA model.
 * This avoids scanning the entire appointment history.
 */
async function loadConsultDurationsForDate(
  tx: Tx,
  doctorId: string,
  serviceDate: string,
): Promise<number[]> {
  const rows = await tx
    .select({
      minutes: sql<number>`
        extract(epoch from (${appointments.completedAt} - ${appointments.consultStartedAt})) / 60
      `,
    })
    .from(appointments)
    .where(
      and(
        eq(appointments.doctorId, doctorId),
        eq(appointments.serviceDate, serviceDate),
        eq(appointments.status, 'COMPLETED'),
        isNotNull(appointments.consultStartedAt),
        isNotNull(appointments.completedAt),
      ),
    )
    .orderBy(desc(appointments.completedAt))
    .limit(CONSULT_SAMPLE_SIZE);

  return rows
    .map((row) => Number(row.minutes))
    .filter((minutes) => Number.isFinite(minutes) && minutes > 0 && minutes < 180)
    .reverse();
}

/**
 * Writes one state change: the appointment row, its timestamps, and the audit
 * event, together, inside the caller's transaction.
 */
async function writeTransition(
  tx: Tx,
  args: {
    hospitalId: string;
    doctorId: string;
    appointmentId: string;
    action: QueueAction;
    from: AppointmentStatus;
    to: AppointmentStatus;
    actorUserId?: string | null;
    metadata?: Record<string, unknown>;
    now: Date;
    calledAt?: Date | null;
  },
) {
  const patch: Partial<typeof appointments.$inferInsert> = {
    status: args.to,
    updatedAt: args.now,
  };

  switch (args.action) {
    case 'enqueue':
    case 'recall':
    case 'resume':
      // A recalled or resumed patient rejoins at the back of the current line.
      // Predictable beats clever; reception can use a priority insert when
      // someone genuinely should be seen next.
      patch.enqueuedAt = args.now;
      break;
    case 'call':
      patch.calledAt = args.now;
      break;
    case 'start_consultation':
      patch.consultStartedAt = args.now;
      break;
    case 'complete':
      patch.completedAt = args.now;
      // Completing straight from CALLED skips IN_CONSULTATION, which would
      // leave the ETA model without a duration. Treat the call time as the
      // start so the sample is still usable.
      if (args.from === 'CALLED') patch.consultStartedAt = args.calledAt ?? args.now;
      break;
    default:
      break;
  }

  await tx.update(appointments).set(patch).where(eq(appointments.id, args.appointmentId));

  await tx.insert(queueEvents).values({
    hospitalId: args.hospitalId,
    appointmentId: args.appointmentId,
    doctorId: args.doctorId,
    action: args.action,
    fromStatus: args.from,
    toStatus: args.to,
    actorUserId: args.actorUserId ?? null,
    metadata: args.metadata,
  });
}

/**
 * Queues a milestone nudge for anyone who has come within MILESTONE_AHEAD of
 * the front.
 *
 * There is no "have we already sent this?" check, deliberately. The unique
 * index on (appointment_id, milestone) makes a second insert a no-op, so
 * de-duplication survives retries, crashes and concurrent writers in a way that
 * application-level bookkeeping would not.
 */
async function enqueueMilestones(
  tx: Tx,
  args: {
    hospitalId: string;
    entries: QueueEntry[];
    rows: Awaited<ReturnType<typeof loadDayAppointments>>;
    doctorName: string;
  },
) {
  const byId = new Map(args.rows.map((row) => [row.id, row]));
  const ordered = orderQueue(args.entries);

  const due = ordered
    .map((entry, index) => ({ entry, ahead: index }))
    .filter(({ entry, ahead }) => entry.status === 'WAITING' && ahead <= MILESTONE_AHEAD);

  for (const { entry, ahead } of due) {
    const row = byId.get(entry.appointmentId);
    if (!row) continue;
    // Same consent rule as the token link.
    if (!row.whatsappOptInAt) continue;

    await tx
      .insert(notificationOutbox)
      .values({
        hospitalId: args.hospitalId,
        appointmentId: entry.appointmentId,
        patientId: row.patientId,
        milestone: MILESTONE_KIND,
        templateCode: 'queue_milestone',
        locale: 'en',
        payload: {
          patientsAhead: ahead,
          tokenNumber: entry.tokenNumber,
          doctorName: args.doctorName,
        },
      })
      .onConflictDoNothing();
  }
}

/* ---------------------------------------------------------------- commands */

export async function createWalkIn(args: {
  hospitalId: string;
  branchId: string;
  doctorId: string;
  timezone: string;
  patient: {
    phoneE164: string;
    name: string;
    age?: number | null;
    gender?: string | null;
    locale?: 'mr' | 'hi' | 'en';
  };
  actorUserId?: string | null;
  source?: 'walk_in' | 'reception' | 'whatsapp';
  /**
   * Whether the patient agreed to WhatsApp updates.
   *
   * Without consent we still issue a token and the printed QR still works —
   * they simply do not get messaged. Consent is the hospital's to collect (they
   * are the Data Fiduciary), but the record of it has to live here, because
   * this is where the decision to send is made.
   */
  whatsappOptIn?: boolean;
  now?: Date;
}) {
  const now = args.now ?? new Date();
  const serviceDate = serviceDateIn(args.timezone, now);

  return withTenant(args.hospitalId, async (tx) => {
    const day = await lockDoctorDay(tx, {
      hospitalId: args.hospitalId,
      doctorId: args.doctorId,
      serviceDate,
    });

    const optedIn = args.whatsappOptIn ?? true;

    const [patient] = await tx
      .insert(patients)
      .values({
        hospitalId: args.hospitalId,
        phoneE164: args.patient.phoneE164,
        name: args.patient.name,
        age: args.patient.age ?? null,
        gender: args.patient.gender ?? null,
        locale: args.patient.locale,
        whatsappOptInAt: optedIn ? now : null,
      })
      .onConflictDoUpdate({
        target: [patients.hospitalId, patients.phoneE164, patients.name],
        set: {
          name: args.patient.name,
          age: args.patient.age !== undefined ? args.patient.age : patients.age,
          gender: args.patient.gender !== undefined ? args.patient.gender : patients.gender,
          updatedAt: now,
          /**
           * Consent is recorded once and not silently re-dated on every visit.
           * `excluded` is the row we tried to insert, so this keeps any earlier
           * timestamp and otherwise takes the new one — with no bound Date in a
           * raw fragment, which postgres.js cannot type without a column to
           * infer from.
           */
          ...(optedIn
            ? {
                whatsappOptInAt: sql`coalesce(${patients.whatsappOptInAt}, excluded.whatsapp_opt_in_at)`,
              }
            : {}),
        },
      })
      .returning();

    const tokenNumber = day.lastTokenNumber + 1;
    const publicToken = generatePublicToken();

    const [appointment] = await tx
      .insert(appointments)
      .values({
        hospitalId: args.hospitalId,
        branchId: args.branchId,
        doctorId: args.doctorId,
        patientId: patient.id,
        serviceDate,
        tokenNumber,
        status: 'WAITING',
        source: args.source ?? 'walk_in',
        publicToken,
        // The link dies a few hours after the session, so a forwarded message
        // cannot be used to watch a queue days later.
        publicTokenExpiresAt: new Date(now.getTime() + 18 * 60 * 60 * 1000),
        enqueuedAt: now,
      })
      .returning();

    await tx
      .update(doctorDayStates)
      .set({ lastTokenNumber: tokenNumber, updatedAt: now })
      .where(eq(doctorDayStates.id, day.id));

    await tx.insert(queueEvents).values({
      hospitalId: args.hospitalId,
      appointmentId: appointment.id,
      doctorId: args.doctorId,
      action: 'enqueue',
      fromStatus: 'CREATED',
      toStatus: 'WAITING',
      actorUserId: args.actorUserId ?? null,
    });

    // No consent, no message. The token and the printed QR still work.
    if (patient.whatsappOptInAt) {
      await tx
        .insert(notificationOutbox)
        .values({
          hospitalId: args.hospitalId,
          appointmentId: appointment.id,
          patientId: patient.id,
          milestone: 'queue_link',
          templateCode: 'queue_link',
          locale: patient.locale ?? 'en',
          payload: { tokenNumber, publicToken },
        })
        .onConflictDoNothing();
    }

    return { appointment, patient, tokenNumber, publicToken };
  });
}

/** One-click Next: complete whoever is with the doctor, call the next waiting. */
export async function advanceQueue(args: {
  hospitalId: string;
  doctorId: string;
  timezone: string;
  actorUserId?: string | null;
  now?: Date;
}) {
  const now = args.now ?? new Date();
  const serviceDate = serviceDateIn(args.timezone, now);

  return withTenant(args.hospitalId, async (tx) => {
    await lockDoctorDay(tx, {
      hospitalId: args.hospitalId,
      doctorId: args.doctorId,
      serviceDate,
    });

    const rows = await loadDayAppointments(tx, { doctorId: args.doctorId, serviceDate });
    const transitions = callNext(rows.map(toQueueEntry));

    for (const transition of transitions) {
      const row = rows.find((r) => r.id === transition.appointmentId)!;
      await writeTransition(tx, {
        hospitalId: args.hospitalId,
        doctorId: args.doctorId,
        appointmentId: transition.appointmentId,
        action: transition.action,
        from: transition.from,
        to: transition.to,
        actorUserId: args.actorUserId,
        calledAt: row.calledAt,
        now,
      });
    }

    if (transitions.length > 0) {
      const [doctor] = await tx
        .select({ name: doctors.name })
        .from(doctors)
        .where(eq(doctors.id, args.doctorId));

      const updated = rows.map((row) => {
        const transition = transitions.find((t) => t.appointmentId === row.id);
        return transition ? { ...row, status: transition.to } : row;
      });

      await enqueueMilestones(tx, {
        hospitalId: args.hospitalId,
        entries: updated.map(toQueueEntry),
        rows: updated,
        doctorName: doctor?.name ?? '',
      });
    }

    return transitions;
  });
}

/** Skip, hold, recall, resume, complete, cancel, mark no-show. */
export async function applyQueueAction(args: {
  hospitalId: string;
  appointmentId: string;
  action: QueueAction;
  timezone: string;
  actorUserId?: string | null;
  now?: Date;
}) {
  const now = args.now ?? new Date();

  return withTenant(args.hospitalId, async (tx) => {
    const [current] = await tx
      .select({
        id: appointments.id,
        status: appointments.status,
        doctorId: appointments.doctorId,
        serviceDate: appointments.serviceDate,
        calledAt: appointments.calledAt,
      })
      .from(appointments)
      .where(eq(appointments.id, args.appointmentId));

    if (!current) throw new Error('Appointment not found');

    await lockDoctorDay(tx, {
      hospitalId: args.hospitalId,
      doctorId: current.doctorId,
      serviceDate: current.serviceDate,
    });

    // Re-read under the lock: the status may have moved while we waited.
    const [fresh] = await tx
      .select({ status: appointments.status, calledAt: appointments.calledAt })
      .from(appointments)
      .where(eq(appointments.id, args.appointmentId));

    const to = applyAction(fresh.status, args.action);

    await writeTransition(tx, {
      hospitalId: args.hospitalId,
      doctorId: current.doctorId,
      appointmentId: args.appointmentId,
      action: args.action,
      from: fresh.status,
      to,
      actorUserId: args.actorUserId,
      calledAt: fresh.calledAt,
      now,
    });

    return { from: fresh.status, to };
  });
}

/** Explicit priority insert, so an out-of-order patient enters the model. */
export async function setPriority(args: {
  hospitalId: string;
  appointmentId: string;
  priority: number;
  actorUserId?: string | null;
}) {
  return withTenant(args.hospitalId, async (tx) => {
    await tx
      .update(appointments)
      .set({ priority: args.priority, updatedAt: new Date() })
      .where(eq(appointments.id, args.appointmentId));

    const [row] = await tx
      .select({ doctorId: appointments.doctorId, status: appointments.status })
      .from(appointments)
      .where(eq(appointments.id, args.appointmentId));

    await tx.insert(queueEvents).values({
      hospitalId: args.hospitalId,
      appointmentId: args.appointmentId,
      doctorId: row.doctorId,
      action: 'enqueue',
      fromStatus: row.status,
      toStatus: row.status,
      actorUserId: args.actorUserId ?? null,
      metadata: { priority: args.priority, reason: 'priority_insert' },
    });
  });
}

export async function setDoctorPaused(args: {
  hospitalId: string;
  doctorId: string;
  timezone: string;
  paused: boolean;
  reason?: string | null;
  now?: Date;
}) {
  const now = args.now ?? new Date();
  const serviceDate = serviceDateIn(args.timezone, now);

  return withTenant(args.hospitalId, async (tx) => {
    const day = await lockDoctorDay(tx, {
      hospitalId: args.hospitalId,
      doctorId: args.doctorId,
      serviceDate,
    });

    await tx
      .update(doctorDayStates)
      .set({
        paused: args.paused,
        pausedReason: args.paused ? (args.reason ?? null) : null,
        sessionStartedAt: day.sessionStartedAt ?? (args.paused ? null : now),
        updatedAt: now,
      })
      .where(eq(doctorDayStates.id, day.id));
  });
}

/* ----------------------------------------------------------------- queries */

/**
 * Queue snapshot that runs inside an already-open transaction.
 *
 * By default uses the date-scoped `loadConsultDurationsForDate` which is
 * much faster on the dashboard (the queue resets daily). Pass
 * `fullHistoryDurations: true` to scan across all time instead — useful
 * for reports or the public patient view.
 */
export async function getQueueSnapshotInTx(
  tx: Tx,
  args: {
    doctorId: string;
    serviceDate: string;
    now: Date;
    fullHistoryDurations?: boolean;
  },
): Promise<QueueSnapshot | null> {
  // doctor + dayState are independent — fetch in parallel
  const [doctorRows, dayRows] = await Promise.all([
    tx
      .select({ id: doctors.id, name: doctors.name })
      .from(doctors)
      .where(eq(doctors.id, args.doctorId)),
    tx
      .select()
      .from(doctorDayStates)
      .where(
        and(
          eq(doctorDayStates.doctorId, args.doctorId),
          eq(doctorDayStates.serviceDate, args.serviceDate),
        ),
      ),
  ]);

  const doctor = doctorRows[0];
  if (!doctor) return null;
  const day = dayRows[0];

  // appointments + durations are independent — fetch in parallel
  const [rows, durations] = await Promise.all([
    loadDayAppointments(tx, { doctorId: args.doctorId, serviceDate: args.serviceDate }),
    args.fullHistoryDurations
      ? loadConsultDurations(tx, args.doctorId)
      : loadConsultDurationsForDate(tx, args.doctorId, args.serviceDate),
  ]);

  const ordered = orderQueue(rows.map(toQueueEntry));
  const byId = new Map(rows.map((row) => [row.id, row]));

  const serving = ordered.find(
    (e) => e.status === 'CALLED' || e.status === 'IN_CONSULTATION',
  );

  return {
    doctorId: doctor.id,
    doctorName: doctor.name,
    serviceDate: args.serviceDate,
    paused: day?.paused ?? false,
    pausedReason: day?.pausedReason ?? null,
    currentToken: serving?.tokenNumber ?? null,
    waitingCount: ordered.filter((e) => e.status === 'WAITING').length,
    completedCount: rows.filter((r) => r.status === 'COMPLETED').length,
    medianConsultMinutes: durations.length > 0 ? durations[Math.floor(durations.length / 2)] : null,
    delayMinutes: currentDelayMinutes({
      scheduledStartAt: day?.scheduledStartAt ?? null,
      sessionStartedAt: day?.sessionStartedAt ?? null,
      now: args.now,
    }),
    rows: ordered.map((entry) => {
      const row = byId.get(entry.appointmentId)!;
      return {
        appointmentId: entry.appointmentId,
        tokenNumber: entry.tokenNumber,
        status: entry.status,
        priority: entry.priority,
        patientName: row.patientName,
        patientAge: row.patientAge,
        patientId: row.patientId,
        enqueuedAt: row.enqueuedAt,
        calledAt: row.calledAt,
        scheduledSlotAt: row.scheduledSlotAt,
      };
    }),
    parked: rows
      .filter((row) => row.status === 'SKIPPED' || row.status === 'HELD')
      .sort((a, b) => a.tokenNumber - b.tokenNumber)
      .map((row) => ({
        appointmentId: row.id,
        tokenNumber: row.tokenNumber,
        status: row.status,
        priority: row.priority,
        patientName: row.patientName,
        patientAge: row.patientAge,
        patientId: row.patientId,
        enqueuedAt: row.enqueuedAt,
        calledAt: row.calledAt,
        scheduledSlotAt: row.scheduledSlotAt,
      })),
  };
}

export async function getQueueSnapshot(args: {
  hospitalId: string;
  doctorId: string;
  timezone: string;
  now?: Date;
}): Promise<QueueSnapshot | null> {
  const now = args.now ?? new Date();
  const serviceDate = serviceDateIn(args.timezone, now);

  return withTenant(args.hospitalId, (tx) =>
    getQueueSnapshotInTx(tx, {
      doctorId: args.doctorId,
      serviceDate,
      now,
      fullHistoryDurations: true,
    }),
  );
}

export type PublicQueueView = {
  status: AppointmentStatus;
  tokenNumber: number;
  doctorName: string;
  patientFirstName: string;
  currentToken: number | null;
  patientsAhead: number | null;
  paused: boolean;
  eta: EtaEstimate | null;
  timezone: string;
  locale: 'mr' | 'hi' | 'en';
  lastUpdatedAt: Date;
  expired: boolean;
};

/**
 * Everything the patient PWA is allowed to know, and nothing else.
 *
 * Other patients are never named, only counted. The response is a read model:
 * the PWA has no idea what a doctor-day state is and cannot mutate anything.
 */
export async function getPublicQueueView(
  publicToken: string,
  now: Date = new Date(),
): Promise<PublicQueueView | null> {
  const [resolved] = await getDb().execute<{ hospital_id: string | null }>(
    sql`select public.resolve_public_token(${publicToken}) as hospital_id`,
  );
  const hospitalId = resolved?.hospital_id;
  if (!hospitalId) return null;

  return withTenant(hospitalId, async (tx) => {
    const [appointment] = await tx
      .select({
        id: appointments.id,
        status: appointments.status,
        tokenNumber: appointments.tokenNumber,
        doctorId: appointments.doctorId,
        serviceDate: appointments.serviceDate,
        expiresAt: appointments.publicTokenExpiresAt,
        patientName: patients.name,
        patientLocale: patients.locale,
        doctorName: doctors.name,
        defaultConsultMinutes: doctors.defaultConsultMinutes,
      })
      .from(appointments)
      .innerJoin(patients, eq(patients.id, appointments.patientId))
      .innerJoin(doctors, eq(doctors.id, appointments.doctorId))
      .where(eq(appointments.publicToken, publicToken));

    if (!appointment) return null;

    const [day] = await tx
      .select()
      .from(doctorDayStates)
      .where(
        and(
          eq(doctorDayStates.doctorId, appointment.doctorId),
          eq(doctorDayStates.serviceDate, appointment.serviceDate),
        ),
      );

    const rows = await loadDayAppointments(tx, {
      doctorId: appointment.doctorId,
      serviceDate: appointment.serviceDate,
    });
    const entries = rows.map(toQueueEntry);
    const ordered = orderQueue(entries);
    const ahead = patientsAhead(entries, appointment.id);
    const serving = ordered.find(
      (e) => e.status === 'CALLED' || e.status === 'IN_CONSULTATION',
    );

    const expired = appointment.expiresAt.getTime() < now.getTime();
    const durations = await loadConsultDurations(tx, appointment.doctorId);

    return {
      status: appointment.status,
      tokenNumber: appointment.tokenNumber,
      doctorName: appointment.doctorName,
      // First name only: a forwarded link should not expose a full identity.
      patientFirstName: appointment.patientName.split(' ')[0] ?? '',
      currentToken: serving?.tokenNumber ?? null,
      patientsAhead: ahead,
      paused: day?.paused ?? false,
      timezone: 'Asia/Kolkata',
      locale: appointment.patientLocale ?? 'en',
      lastUpdatedAt: now,
      expired,
      eta:
        ahead === null || expired || (day?.paused ?? false)
          ? null
          : estimateEta({
              patientsAhead: ahead,
              consultDurations: durations,
              currentDelayMinutes: currentDelayMinutes({
                scheduledStartAt: day?.scheduledStartAt ?? null,
                sessionStartedAt: day?.sessionStartedAt ?? null,
                now,
              }),
              fallbackConsultMinutes: appointment.defaultConsultMinutes,
              now,
            }),
    };
  });
}

/** Every doctor's queue for one branch, for the dashboard and the TV display. */
export async function getBranchSnapshots(args: {
  hospitalId: string;
  branchId: string;
  timezone: string;
  now?: Date;
}): Promise<QueueSnapshot[]> {
  const doctorRows = await withTenant(args.hospitalId, (tx) =>
    tx
      .select({ id: doctors.id })
      .from(doctors)
      .where(and(eq(doctors.branchId, args.branchId), eq(doctors.active, true))),
  );

  const snapshots = await Promise.all(
    doctorRows.map((doctor) =>
      getQueueSnapshot({
        hospitalId: args.hospitalId,
        doctorId: doctor.id,
        timezone: args.timezone,
        now: args.now,
      }),
    ),
  );

  return snapshots.filter((snapshot): snapshot is QueueSnapshot => snapshot !== null);
}

export { isActive };
