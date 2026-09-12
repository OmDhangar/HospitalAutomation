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
  const tStart = performance.now();
  return withTenant(args.hospitalId, async (tx) => {
    const t0 = performance.now();
    const optedIn = args.whatsappOptIn ?? true;
    const publicToken = generatePublicToken();
    const publicTokenExpiresAt = new Date(now.getTime() + 18 * 60 * 60 * 1000);

    const nowIso = now.toISOString();
    const publicTokenExpiresAtIso = publicTokenExpiresAt.toISOString();
    const whatsappOptInAtIso = optedIn ? nowIso : null;

    const [row] = await tx.execute<{
      appt_id: string;
      appt_hospital_id: string;
      appt_branch_id: string;
      appt_doctor_id: string;
      appt_patient_id: string;
      appt_service_date: string;
      appt_token_number: number;
      appt_status: AppointmentStatus;
      appt_priority: number;
      appt_source: typeof appointments.$inferSelect['source'];
      appt_public_token: string;
      appt_public_token_expires_at: Date;
      appt_enqueued_at: Date | null;
      appt_scheduled_slot_at: Date | null;
      appt_called_at: Date | null;
      appt_consult_started_at: Date | null;
      appt_completed_at: Date | null;
      appt_created_at: Date;
      appt_updated_at: Date;
      patient_id: string;
      patient_hospital_id: string;
      patient_phone_e164: string;
      patient_name: string;
      patient_age: number | null;
      patient_gender: string | null;
      patient_locale: typeof patients.$inferSelect['locale'];
      patient_whatsapp_opt_in_at: Date | null;
      patient_created_at: Date;
      patient_updated_at: Date;
    }>(sql`
      with
        day_state as (
          insert into doctor_day_states (hospital_id, doctor_id, service_date, paused, last_token_number)
          values (${args.hospitalId}::uuid, ${args.doctorId}::uuid, ${serviceDate}, false, 1)
          on conflict (doctor_id, service_date)
          do update set
            last_token_number = doctor_day_states.last_token_number + 1,
            updated_at = ${nowIso}::timestamptz
          returning id, last_token_number
        ),
        upserted_patient as (
          insert into patients (hospital_id, phone_e164, name, age, gender, locale, whatsapp_opt_in_at)
          values (
            ${args.hospitalId}::uuid,
            ${args.patient.phoneE164},
            ${args.patient.name},
            ${args.patient.age ?? null},
            ${args.patient.gender ?? null},
            ${args.patient.locale ?? 'en'},
            ${whatsappOptInAtIso ? sql`${whatsappOptInAtIso}::timestamptz` : sql`NULL`}
          )
          on conflict (hospital_id, phone_e164, name)
          do update set
            name = ${args.patient.name},
            age = coalesce(${args.patient.age ?? null}, patients.age),
            gender = coalesce(${args.patient.gender ?? null}, patients.gender),
            whatsapp_opt_in_at = case 
              when ${optedIn} then coalesce(patients.whatsapp_opt_in_at, excluded.whatsapp_opt_in_at)
              else patients.whatsapp_opt_in_at
            end,
            updated_at = ${nowIso}::timestamptz
          returning *
        ),
        inserted_appt as (
          insert into appointments (
            hospital_id, branch_id, doctor_id, patient_id, service_date,
            token_number, status, source, public_token, public_token_expires_at, enqueued_at
          )
          select
            ${args.hospitalId}::uuid,
            ${args.branchId}::uuid,
            ${args.doctorId}::uuid,
            upserted_patient.id,
            ${serviceDate},
            day_state.last_token_number,
            'WAITING',
            ${args.source ?? 'walk_in'},
            ${publicToken},
            ${publicTokenExpiresAtIso}::timestamptz,
            ${nowIso}::timestamptz
          from upserted_patient, day_state
          returning *
        ),
        inserted_event as (
          insert into queue_events (
            hospital_id, appointment_id, doctor_id, action, from_status, to_status, actor_user_id
          )
          select
            ${args.hospitalId}::uuid,
            inserted_appt.id,
            ${args.doctorId}::uuid,
            'enqueue',
            'CREATED',
            'WAITING',
            ${args.actorUserId ? sql`${args.actorUserId}::uuid` : sql`NULL`}
          from inserted_appt
        ),
        inserted_outbox as (
          insert into notification_outbox (
            hospital_id, appointment_id, patient_id, milestone, template_code, locale, payload
          )
          select
            ${args.hospitalId}::uuid,
            inserted_appt.id,
            upserted_patient.id,
            'queue_link',
            'queue_link',
            coalesce(upserted_patient.locale, 'en'),
            jsonb_build_object('tokenNumber', inserted_appt.token_number, 'publicToken', inserted_appt.public_token)
          from inserted_appt, upserted_patient
          where upserted_patient.whatsapp_opt_in_at is not null
          on conflict do nothing
        )
      select
        inserted_appt.id as appt_id,
        inserted_appt.hospital_id as appt_hospital_id,
        inserted_appt.branch_id as appt_branch_id,
        inserted_appt.doctor_id as appt_doctor_id,
        inserted_appt.patient_id as appt_patient_id,
        inserted_appt.service_date as appt_service_date,
        inserted_appt.token_number as appt_token_number,
        inserted_appt.status as appt_status,
        inserted_appt.priority as appt_priority,
        inserted_appt.source as appt_source,
        inserted_appt.public_token as appt_public_token,
        inserted_appt.public_token_expires_at as appt_public_token_expires_at,
        inserted_appt.enqueued_at as appt_enqueued_at,
        inserted_appt.scheduled_slot_at as appt_scheduled_slot_at,
        inserted_appt.called_at as appt_called_at,
        inserted_appt.consult_started_at as appt_consult_started_at,
        inserted_appt.completed_at as appt_completed_at,
        inserted_appt.created_at as appt_created_at,
        inserted_appt.updated_at as appt_updated_at,
        upserted_patient.id as patient_id,
        upserted_patient.hospital_id as patient_hospital_id,
        upserted_patient.phone_e164 as patient_phone_e164,
        upserted_patient.name as patient_name,
        upserted_patient.age as patient_age,
        upserted_patient.gender as patient_gender,
        upserted_patient.locale as patient_locale,
        upserted_patient.whatsapp_opt_in_at as patient_whatsapp_opt_in_at,
        upserted_patient.created_at as patient_created_at,
        upserted_patient.updated_at as patient_updated_at
      from inserted_appt, upserted_patient;
    `);

    const tEnd = performance.now();
    console.log(
      `[PERF:createWalkIn:CTE] singleRoundtripQuery: ${(tEnd - t0).toFixed(1)}ms | ` +
      `overall: ${(tEnd - tStart).toFixed(1)}ms`
    );

    if (!row) {
      throw new Error('Failed to create walk-in appointment');
    }

    const appointment: typeof appointments.$inferSelect = {
      id: row.appt_id,
      hospitalId: row.appt_hospital_id,
      branchId: row.appt_branch_id,
      doctorId: row.appt_doctor_id,
      patientId: row.appt_patient_id,
      serviceDate: row.appt_service_date,
      tokenNumber: Number(row.appt_token_number),
      status: row.appt_status,
      priority: Number(row.appt_priority),
      source: row.appt_source,
      publicToken: row.appt_public_token,
      publicTokenExpiresAt: new Date(row.appt_public_token_expires_at),
      scheduledSlotAt: row.appt_scheduled_slot_at ? new Date(row.appt_scheduled_slot_at) : null,
      enqueuedAt: row.appt_enqueued_at ? new Date(row.appt_enqueued_at) : null,
      calledAt: row.appt_called_at ? new Date(row.appt_called_at) : null,
      consultStartedAt: row.appt_consult_started_at ? new Date(row.appt_consult_started_at) : null,
      completedAt: row.appt_completed_at ? new Date(row.appt_completed_at) : null,
      createdAt: new Date(row.appt_created_at),
      updatedAt: new Date(row.appt_updated_at),
    };

    const patient: typeof patients.$inferSelect = {
      id: row.patient_id,
      hospitalId: row.patient_hospital_id,
      phoneE164: row.patient_phone_e164,
      name: row.patient_name,
      age: row.patient_age !== null && row.patient_age !== undefined ? Number(row.patient_age) : null,
      gender: row.patient_gender,
      locale: row.patient_locale,
      whatsappOptInAt: row.patient_whatsapp_opt_in_at ? new Date(row.patient_whatsapp_opt_in_at) : null,
      createdAt: new Date(row.patient_created_at),
      updatedAt: new Date(row.patient_updated_at),
    };

    return {
      appointment,
      patient,
      tokenNumber: appointment.tokenNumber,
      publicToken: appointment.publicToken,
    };
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

/** Toggles doctor pause on the active day state. */
export async function setDoctorPaused(args: {
  hospitalId: string;
  doctorId: string;
  timezone: string;
  paused: boolean;
  reason?: string | null;
  actorUserId?: string | null;
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
    now?: Date;
    fullHistoryDurations?: boolean;
  },
): Promise<QueueSnapshot | null> {
  // All 4 queries are completely independent — run in parallel in 1 network roundtrip
  const [doctorRows, dayRows, rows, durations] = await Promise.all([
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
    loadDayAppointments(tx, { doctorId: args.doctorId, serviceDate: args.serviceDate }),
    args.fullHistoryDurations
      ? loadConsultDurations(tx, args.doctorId)
      : loadConsultDurationsForDate(tx, args.doctorId, args.serviceDate),
  ]);

  const doctor = doctorRows[0];
  if (!doctor) return null;
  const day = dayRows[0];

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
