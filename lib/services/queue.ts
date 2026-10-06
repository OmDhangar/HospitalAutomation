import { and, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { getDb, withTenant, type Tx } from '@/lib/db';
import {
  appointments,
  auditLogs,
  doctorDayStates,
  doctors,
  hospitals,
  notificationOutbox,
  patients,
  queueEvents,
} from '@/lib/db/schema';
import type { CapacityChannel } from '@/lib/domain/capacity';
import { isCancellableByPatient } from '@/lib/domain/disruption';
import {
  estimateEta,
  isMeaningfulEtaShift,
  resolveEta,
  startDelayMinutes,
  type EtaEstimate,
  type EtaResult,
  type EtaState,
} from '@/lib/domain/eta';
import {
  applyAction,
  callNext,
  canTransition,
  isActive,
  isEligible,
  isLateReturn,
  lateFrontier,
  lateReturnAnchor,
  orderQueue,
  patientsAhead,
  priorityRank,
  projectedCallNumber,
} from '@/lib/domain/queue';
import { isMockPhone } from '@/lib/domain/phone';
import { formatTimeIn, serviceDateIn } from '@/lib/domain/time';
import type { AppointmentStatus, QueueAction, QueueContext, QueueEntry } from '@/lib/domain/types';
import { generatePublicToken } from '@/lib/security/tokens';
import { allocateTokenInTx, getDayCapacityInTx } from './capacity';
import { lockDoctorDay } from './doctor-day';
import { resolveScheduledStartInTx } from './scheduling';

/**
 * How close to their turn a patient is nudged, in minutes of estimated wait.
 *
 * Time, not position. "Four patients ahead" is a different amount of warning
 * for a dermatologist averaging four minutes and a cardiologist averaging
 * twenty — forty minutes early in one case and fifteen in the other. Ten
 * minutes is the same useful warning in both.
 *
 * Deliberately not a "your turn now" message. Almost every patient is already
 * present or has cancelled by then, so it would be a message per appointment
 * bought for nothing — and at roughly one rupee per patient across a
 * portfolio, the cheapest message is the one not sent.
 */
export const MILESTONE_WAIT_MINUTES = 10;

/**
 * A floor on position regardless of the estimate.
 *
 * Early in a session there are no completed consultations to measure, so the
 * estimate leans on a configured default that may be badly wrong. Whoever is
 * next gets told regardless.
 */
export const MILESTONE_AHEAD = 1;
const MILESTONE_KIND = 'queue_approaching';
const CONSULT_SAMPLE_SIZE = 50;

export type QueueRow = {
  appointmentId: string;
  tokenNumber: number;
  status: AppointmentStatus;
  priority: number;
  /** True if patient was admitted as an emergency. */
  isEmergency?: boolean;
  patientName: string;
  patientAge?: number | null;
  patientPhone?: string | null;
  patientId: string;
  enqueuedAt: Date | null;
  calledAt: Date | null;
  scheduledSlotAt?: Date | null;
  pausedAt?: Date | null;
  resumeAt?: Date | null;
    /** "Priority #n" among waiting priority patients. */
  priorityRank?: number | null;
  /** Placed after this token on returning late. */
  queueAfterToken?: number | null;
  quotaPool?: 'reserved' | 'shared' | 'extra' | null;
  /** Internal estimate for staff; from the same ordering Next uses. */
  patientsAhead?: number | null;
  etaAt?: Date | null;
  /**
   * Serving sequence: the number they were called with, or for a waiting
   * patient the number Next will give them. Null for held/skipped patients.
   */
  callNumber?: number | null;
};

export type QueueSnapshot = {
  doctorId: string;
  doctorName: string;
  serviceDate: string;
  paused: boolean;
  pausedReason: string | null;
  /** When the doctor's current break began, or null when not on a break. */
  breakStartedAt: Date | null;
  currentToken: number | null;
  /** Call number of whoever is with the doctor: what the room and the TV announce. */
  currentCallNumber: number | null;
  currentPatientName?: string | null;
  nextPatient?: { tokenNumber: number; patientName: string; callNumber: number | null } | null;
  waitingCount: number;
  completedCount: number;
  rows: QueueRow[];
  /** Skipped and held patients: out of the line, but recoverable. */
  parked: QueueRow[];
  /**
   * Seen today, most recent first. The queue is done with them; the desk
   * often is not, because many patients pay after the consultation.
   */
  completed: QueueRow[];
  medianConsultMinutes: number | null;
  delayMinutes: number;
  /** When OPD was meant to start today, from the doctor's schedule. */
  scheduledStartAt: Date | null;
  /** Set only by Start OPD. */
  sessionStartedAt: Date | null;
  etaState: EtaState;
  };

/* ------------------------------------------------------------- internals */

const toQueueEntry = (row: {
  id: string;
  tokenNumber: number;
  status: AppointmentStatus;
  priority: number;
  isEmergency?: boolean;
  enqueuedAt: Date | null;
  createdAt: Date;
  prioritySeq: number | null;
  calledAt: Date | null;
  queueAfterToken: number | null;
  rejoinSeq: number | null;
  callNumber: number | null;
}): QueueEntry => ({
  appointmentId: row.id,
  tokenNumber: row.tokenNumber,
  status: row.status,
  priority: row.priority,
  isEmergency: Boolean(row.isEmergency),
  // Falling back to createdAt keeps ordering total even for rows that were
  // never explicitly enqueued.
  enqueuedAt: row.enqueuedAt ?? row.createdAt,
  prioritySeq: row.prioritySeq,
  calledAt: row.calledAt,
  queueAfterToken: row.queueAfterToken,
  rejoinSeq: row.rejoinSeq,
  callNumber: row.callNumber,
});

/**
 * The doctor's hospital settings the queue order depends on, read through the
 * doctor so it works inside any tenant transaction.
 */
async function loadQueueSettings(
  tx: Tx,
  doctorId: string,
): Promise<{ ctx: QueueContext; timezone: string; doctorName: string; defaultConsultMinutes: number }> {
  const [row] = await tx
    .select({
      lateRejoinAfter: hospitals.lateRejoinAfterPatients,
      timezone: hospitals.timezone,
      doctorName: doctors.name,
      defaultConsultMinutes: doctors.defaultConsultMinutes,
    })
    .from(doctors)
    .innerJoin(hospitals, eq(hospitals.id, doctors.hospitalId))
    .where(eq(doctors.id, doctorId));
  return {
    ctx: { lateRejoinAfter: row?.lateRejoinAfter ?? 2 },
    timezone: row?.timezone ?? 'Asia/Kolkata',
    doctorName: row?.doctorName ?? '',
    defaultConsultMinutes: row?.defaultConsultMinutes ?? 10,
  };
}

/** Next number from the doctor-day counter that orders priority and late returns. Under the lock. */
async function nextQueueSeq(tx: Tx, doctorId: string, serviceDate: string): Promise<number> {
  const [row] = await tx
    .update(doctorDayStates)
    .set({ lastQueueSeq: sql`${doctorDayStates.lastQueueSeq} + 1` })
    .where(and(eq(doctorDayStates.doctorId, doctorId), eq(doctorDayStates.serviceDate, serviceDate)))
    .returning({ seq: doctorDayStates.lastQueueSeq });
  return row.seq;
}

/** Next call number for the doctor-day. Under the lock, so two Nexts never share one. */
async function nextCallNumber(tx: Tx, doctorId: string, serviceDate: string): Promise<number> {
  const [row] = await tx
    .update(doctorDayStates)
    .set({ lastCallNumber: sql`${doctorDayStates.lastCallNumber} + 1` })
    .where(and(eq(doctorDayStates.doctorId, doctorId), eq(doctorDayStates.serviceDate, serviceDate)))
    .returning({ n: doctorDayStates.lastCallNumber });
  return row.n;
}

/**
 * Where a patient goes when they become callable again — recalled after a
 * skip, resumed after a hold, or checking in. Must run under the doctor-day
 * lock, before their status/arrival is written.
 *
 * If their turn has already passed (token below the frontier) they go behind
 * the next N present patients; otherwise they keep their own token's place.
 * Only this patient's row is touched — no other token or position changes.
 * Returns what was decided, for the queue event.
 */
async function placeReturningPatient(
  tx: Tx,
  args: { doctorId: string; serviceDate: string; appointmentId: string },
): Promise<{ late: boolean; frontier: number; queueAfterToken: number | null; n: number }> {
  const [rows, settings] = await Promise.all([
    loadDayAppointments(tx, { doctorId: args.doctorId, serviceDate: args.serviceDate }),
    loadQueueSettings(tx, args.doctorId),
  ]);
  const entries = rows.map(toQueueEntry);
  const self = entries.find((entry) => entry.appointmentId === args.appointmentId);
  const frontier = lateFrontier(entries);
  if (!self) return { late: false, frontier, queueAfterToken: null, n: settings.ctx.lateRejoinAfter };

  const late = isLateReturn(entries, self);
  const anchor = late ? lateReturnAnchor(entries, self.appointmentId, settings.ctx) : null;
  const rejoinSeq = anchor !== null ? await nextQueueSeq(tx, args.doctorId, args.serviceDate) : null;

  await tx
    .update(appointments)
    .set({ queueAfterToken: anchor, rejoinSeq })
    .where(eq(appointments.id, args.appointmentId));

  return { late, frontier, queueAfterToken: anchor, n: settings.ctx.lateRejoinAfter };
}

const placementMetadata = (p: Awaited<ReturnType<typeof placeReturningPatient>>) => ({
  late_return: p.late,
  frontier: p.frontier,
  queue_after_token: p.queueAfterToken,
  rejoin_after_patients: p.n,
});

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
      isEmergency: appointments.isEmergency,
      enqueuedAt: appointments.enqueuedAt,
      calledAt: appointments.calledAt,
      createdAt: appointments.createdAt,
      pausedAt: appointments.pausedAt,
      resumeAt: appointments.resumeAt,
      patientId: appointments.patientId,
      patientName: patients.name,
      patientAge: patients.age,
      patientPhone: patients.phoneE164,
      whatsappOptInAt: patients.whatsappOptInAt,
      /** Needed so a nudge goes out in the language the patient chose. */
      locale: patients.locale,
      scheduledSlotAt: appointments.scheduledSlotAt,
      prioritySeq: appointments.prioritySeq,
      queueAfterToken: appointments.queueAfterToken,
      rejoinSeq: appointments.rejoinSeq,
      callNumber: appointments.callNumber,
      quotaPool: appointments.quotaPool,
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
    /** Issued by the caller from the doctor-day counter, for a `call`. */
    callNumber?: number | null;
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
      if (args.callNumber != null) patch.callNumber = args.callNumber;
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
    consultDurations: number[];
    fallbackConsultMinutes?: number;
    ctx: QueueContext;
    scheduledStartAt: Date | null;
    sessionStartedAt: Date | null;
    now: Date;
  },
) {
  const byId = new Map(args.rows.map((row) => [row.id, row]));
  const ordered = orderQueue(args.entries);

  for (const entry of ordered) {
    if (entry.status !== 'WAITING') continue;

    const row = byId.get(entry.appointmentId);
    if (!row) continue;
    // Same consent rule as the token link.
    if (!row.whatsappOptInAt) continue;

    // The same count the ETA shows: who Next would serve first. For a patient
    // not here yet it is the place they would take on arriving now.
    const index = patientsAhead(args.entries, entry.appointmentId, args.ctx);
    if (index === null) continue;

    const eta = resolveEta({
      patientsAhead: index,
      consultDurations: args.consultDurations,
      fallbackConsultMinutes: args.fallbackConsultMinutes,
      scheduledStartAt: args.scheduledStartAt,
      sessionStartedAt: args.sessionStartedAt,
      now: args.now,
    });

    // Position acts as a floor: with no measured durations yet the estimate is
    // a guess, and whoever is next should hear from us either way.
    const waitMinutes = eta.state === 'not_started' ? null : eta.waitMinutes;
    const due = (waitMinutes !== null && waitMinutes <= MILESTONE_WAIT_MINUTES) || index <= MILESTONE_AHEAD;
    if (!due) continue;

    await tx
      .insert(notificationOutbox)
      .values({
        hospitalId: args.hospitalId,
        appointmentId: entry.appointmentId,
        patientId: row.patientId,
        milestone: MILESTONE_KIND,
        templateCode: 'queue_milestone',
        // Was hardcoded to 'en', which sent Marathi and Hindi patients an
        // English message regardless of the language they had chosen.
        locale: row.locale ?? 'en',
        payload: {
          patientsAhead: index,
          tokenNumber: entry.tokenNumber,
          doctorName: args.doctorName,
          // The template's fourth variable. Omitting it rendered "Estimated
          // wait: ~ min." — and an empty parameter is a send Meta can reject
          // outright.
          waitMinutes: waitMinutes ?? index * (eta.basis.consultMinutes || 10),
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
    /** Optional free text. A blank here never erases an address on file. */
    address?: string | null;
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
  /**
   * The booking chat has already told the patient their token and link.
   *
   * A WhatsApp booking replies in the open chat, which is free. Queuing the
   * queue_link template as well sent the same news twice, and the template is
   * the one that costs money. The caller records the chat reply instead.
   */
  confirmationSentInChat?: boolean;
  /**
   * Issue an EXTRA token past the daily quota. Only for the owner, and only
   * once the quota is genuinely full — the capacity rules refuse it otherwise.
   */
  extraToken?: boolean;
  /** Admitted through emergency. Top queue priority and red alert display. */
  isEmergency?: boolean;
  now?: Date;
}) {
  const now = args.now ?? new Date();
  const serviceDate = serviceDateIn(args.timezone, now);
  const tStart = performance.now();
  const source = args.source ?? 'walk_in';
  const isEmergency = Boolean(args.isEmergency);
  const priority = isEmergency ? 100 : 0;
  const channel: CapacityChannel = args.extraToken
    ? 'extra'
    : source === 'whatsapp'
      ? 'online'
      : 'walk_in';
  return withTenant(args.hospitalId, async (tx) => {
    const t0 = performance.now();
    // Takes the doctor-day lock and applies the quota; throws CapacityError
    // when the day has no place for this patient.
    const allocated = await allocateTokenInTx(tx, {
      hospitalId: args.hospitalId,
      doctorId: args.doctorId,
      serviceDate,
      timezone: args.timezone,
      channel,
      now,
    });
    const prioritySeq = isEmergency ? await nextQueueSeq(tx, args.doctorId, serviceDate) : null;
    // A no-phone placeholder never opts in: nothing is ever sent to it.
    const optedIn = (args.whatsappOptIn ?? true) && !isMockPhone(args.patient.phoneE164);
    const queueLinkTemplate = !args.confirmationSentInChat;
    const publicToken = generatePublicToken();
    const publicTokenExpiresAt = new Date(now.getTime() + 18 * 60 * 60 * 1000);

    const nowIso = now.toISOString();
    const publicTokenExpiresAtIso = publicTokenExpiresAt.toISOString();
    const whatsappOptInAtIso = optedIn ? nowIso : null;

    const [row] = await tx.execute<{
      appt_quota_pool: 'reserved' | 'shared' | 'extra' | null;
      appt_id: string;
      appt_hospital_id: string;
      appt_branch_id: string;
      appt_doctor_id: string;
      appt_patient_id: string;
      appt_service_date: string;
      appt_token_number: number;
      appt_status: AppointmentStatus;
      appt_priority: number;
      appt_is_emergency: boolean;
      appt_priority_seq: number | null;
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
      patient_address: string | null;
      patient_locale: typeof patients.$inferSelect['locale'];
      patient_whatsapp_opt_in_at: Date | null;
      patient_created_at: Date;
      patient_updated_at: Date;
    }>(sql`
      with
        upserted_patient as (
          insert into patients (hospital_id, phone_e164, name, age, gender, address, locale, whatsapp_opt_in_at)
          values (
            ${args.hospitalId}::uuid,
            ${args.patient.phoneE164},
            ${args.patient.name},
            ${args.patient.age ?? null},
            ${args.patient.gender ?? null},
            ${args.patient.address ?? null},
            ${args.patient.locale ?? 'en'},
            ${whatsappOptInAtIso ? sql`${whatsappOptInAtIso}::timestamptz` : sql`NULL`}
          )
          on conflict (hospital_id, phone_e164, name)
          do update set
            name = ${args.patient.name},
            age = coalesce(${args.patient.age ?? null}, patients.age),
            gender = coalesce(${args.patient.gender ?? null}, patients.gender),
            address = coalesce(${args.patient.address ?? null}, patients.address),
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
            token_number, status, priority, is_emergency, priority_seq, source, public_token, public_token_expires_at, enqueued_at,
            quota_pool
          )
          select
            ${args.hospitalId}::uuid,
            ${args.branchId}::uuid,
            ${args.doctorId}::uuid,
            upserted_patient.id,
            ${serviceDate},
            ${allocated.tokenNumber}::int,
            'WAITING',
            ${priority}::smallint,
            ${isEmergency},
            ${prioritySeq ? sql`${prioritySeq}::int` : sql`NULL`},
            ${source},
            ${publicToken},
            ${publicTokenExpiresAtIso}::timestamptz,
            ${nowIso}::timestamptz,
            ${allocated.pool}
          from upserted_patient
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
        -- Who issued a token past the quota, and when, is worth keeping.
        inserted_audit as (
          insert into audit_logs (hospital_id, actor_user_id, action, object_type, object_id, metadata)
          select
            ${args.hospitalId}::uuid,
            ${args.actorUserId ? sql`${args.actorUserId}::uuid` : sql`NULL`},
            'capacity.extra_token.issued',
            'appointment',
            inserted_appt.id::text,
            jsonb_build_object('doctor_id', inserted_appt.doctor_id, 'service_date', inserted_appt.service_date,
                               'token_number', inserted_appt.token_number)
          from inserted_appt
          where inserted_appt.quota_pool = 'extra'
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
            and ${queueLinkTemplate}
          on conflict do nothing
        )
      select
        inserted_appt.quota_pool as appt_quota_pool,
        inserted_appt.id as appt_id,
        inserted_appt.hospital_id as appt_hospital_id,
        inserted_appt.branch_id as appt_branch_id,
        inserted_appt.doctor_id as appt_doctor_id,
        inserted_appt.patient_id as appt_patient_id,
        inserted_appt.service_date as appt_service_date,
        inserted_appt.token_number as appt_token_number,
        inserted_appt.status as appt_status,
        inserted_appt.priority as appt_priority,
        inserted_appt.is_emergency as appt_is_emergency,
        inserted_appt.priority_seq as appt_priority_seq,
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
        upserted_patient.address as patient_address,
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
      isEmergency: Boolean(row.appt_is_emergency),
      source: row.appt_source,
      publicToken: row.appt_public_token,
      publicTokenExpiresAt: new Date(row.appt_public_token_expires_at),
      scheduledSlotAt: row.appt_scheduled_slot_at ? new Date(row.appt_scheduled_slot_at) : null,
      enqueuedAt: row.appt_enqueued_at ? new Date(row.appt_enqueued_at) : null,
      calledAt: row.appt_called_at ? new Date(row.appt_called_at) : null,
      consultStartedAt: row.appt_consult_started_at ? new Date(row.appt_consult_started_at) : null,
      completedAt: row.appt_completed_at ? new Date(row.appt_completed_at) : null,
      pausedAt: null,
      resumeAt: null,
      prioritySeq: row.appt_priority_seq ? Number(row.appt_priority_seq) : null,
      queueAfterToken: null,
      rejoinSeq: null,
      callNumber: null,
      quotaPool: row.appt_quota_pool,
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
      address: row.patient_address,
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

export type AdvanceResult = {
  transitions: ReturnType<typeof callNext>;
};

/**
 * One-click Next: complete whoever is with the doctor, call the next waiting
 * patient — priority first (first-come first-served), then the queue order —
 * and give them the day's next call number. A patient who is not there is
 * put on hold by the desk. Never starts the session: that is Start OPD's job.
 */
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
    // Captured rather than discarded: the day row carries the scheduled and
    // actual session start, which is how the nudge knows the doctor is running
    // late and pushes its estimate out accordingly.
    const day = await lockDoctorDay(tx, {
      hospitalId: args.hospitalId,
      doctorId: args.doctorId,
      serviceDate,
    });

    const rows = await loadDayAppointments(tx, { doctorId: args.doctorId, serviceDate });
    const entries = rows.map(toQueueEntry);
    const transitions = callNext(entries);

    for (const transition of transitions) {
      const row = rows.find((r) => r.id === transition.appointmentId)!;
      // The day's serving sequence: the next number, whatever the token.
      const callNumber = transition.action === 'call' ? await nextCallNumber(tx, args.doctorId, serviceDate) : null;
      await writeTransition(tx, {
        hospitalId: args.hospitalId,
        doctorId: args.doctorId,
        appointmentId: transition.appointmentId,
        action: transition.action,
        from: transition.from,
        to: transition.to,
        actorUserId: args.actorUserId,
        calledAt: row.calledAt,
        callNumber,
        metadata: transition.action === 'call' ? { call_number: callNumber } : undefined,
        now,
      });
    }

    if (transitions.length > 0) {
      const settings = await loadQueueSettings(tx, args.doctorId);

      const updated = rows.map((row) => {
        const transition = transitions.find((t) => t.appointmentId === row.id);
        return transition
          ? { ...row, status: transition.to, calledAt: transition.action === 'call' ? now : row.calledAt }
          : row;
      });

      // The nudge is now time-based, so it needs the same evidence the
      // patient-facing ETA uses: what this doctor's consultations have
      // actually taken today, and how far behind the session is running.
      const durations = await loadConsultDurationsForDate(tx, args.doctorId, serviceDate);

      await enqueueMilestones(tx, {
        hospitalId: args.hospitalId,
        entries: updated.map(toQueueEntry),
        rows: updated,
        doctorName: settings.doctorName,
        consultDurations: durations,
        fallbackConsultMinutes: settings.defaultConsultMinutes,
        ctx: settings.ctx,
        scheduledStartAt: await resolveScheduledStartInTx(tx, {
          doctorId: args.doctorId,
          serviceDate,
          timezone: args.timezone,
          dayOverride: day?.scheduledStartAt ?? null,
        }),
        sessionStartedAt: day?.sessionStartedAt ?? null,
        now,
      });
    }

    return { transitions } satisfies AdvanceResult;
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

    // Coming back into the line: if their turn passed while they were away,
    // they go behind the next N waiting patients.
    const returning = args.action === 'recall' || args.action === 'resume';
    const placement = returning
      ? await placeReturningPatient(tx, {
          doctorId: current.doctorId,
          serviceDate: current.serviceDate,
          appointmentId: args.appointmentId,
        })
      : null;
    if (returning) {
      await tx
        .update(appointments)
        .set({ pausedAt: null, resumeAt: null })
        .where(eq(appointments.id, args.appointmentId));
    }

    await writeTransition(tx, {
      hospitalId: args.hospitalId,
      doctorId: current.doctorId,
      appointmentId: args.appointmentId,
      action: args.action,
      from: fresh.status,
      to,
      actorUserId: args.actorUserId,
      calledAt: fresh.calledAt,
      metadata: placement ? placementMetadata(placement) : undefined,
      now,
    });

    await notifyOutcome(tx, {
      hospitalId: args.hospitalId,
      appointmentId: args.appointmentId,
      doctorId: current.doctorId,
      serviceDate: current.serviceDate,
      action: args.action,
      timezone: args.timezone,
    });

    return { from: fresh.status, to };
  });
}

/**
 * Tells the patient when an action of reception's changes their day.
 *
 * Until now every one of these was silent. A skipped patient waited
 * indefinitely for a call that had already happened; a cancelled patient
 * travelled to an appointment that no longer existed. Neither is visible from
 * inside the product, which is exactly why both survived this long.
 *
 * Only the three outcomes a patient cannot otherwise discover are messaged.
 * `hold`, `recall`, `resume` and `complete` are deliberately silent: a held
 * patient is still in the queue and will be nudged when their turn nears, and
 * telling somebody their consultation finished is a message they can see for
 * themselves.
 */
async function notifyOutcome(
  tx: Tx,
  args: {
    hospitalId: string;
    appointmentId: string;
    doctorId: string;
    serviceDate: string;
    action: QueueAction;
    timezone: string;
  },
) {
  const template =
    args.action === 'skip'
      ? 'queue_skipped'
      : args.action === 'cancel' || args.action === 'mark_no_show'
        ? 'appointment_cancelled'
        : null;

  if (!template) return;

  const [row] = await tx
    .select({
      patientId: appointments.patientId,
      tokenNumber: appointments.tokenNumber,
      locale: patients.locale,
      optInAt: patients.whatsappOptInAt,
      doctorName: doctors.name,
    })
    .from(appointments)
    .innerJoin(patients, eq(patients.id, appointments.patientId))
    .innerJoin(doctors, eq(doctors.id, appointments.doctorId))
    .where(eq(appointments.id, args.appointmentId));

  // Same consent gate as every other patient message.
  if (!row?.optInAt) return;

  await tx
    .insert(notificationOutbox)
    .values({
      hospitalId: args.hospitalId,
      appointmentId: args.appointmentId,
      patientId: row.patientId,
      /**
       * Keyed to the action, not just the template. A patient can legitimately
       * be skipped and later cancelled, and both are worth telling them about;
       * the dedup index still stops either being sent twice.
       */
      milestone: `outcome:${args.action}`,
      templateCode: template,
      locale: row.locale ?? 'en',
      payload: {
        tokenNumber: row.tokenNumber,
        doctorName: row.doctorName,
        doctorId: args.doctorId,
        appointmentDate: new Intl.DateTimeFormat('en-IN', {
          timeZone: args.timezone,
          day: 'numeric',
          month: 'short',
        }).format(new Date(`${args.serviceDate}T12:00:00Z`)),
      },
    })
    .onConflictDoNothing();
}

export type PriorityResult = { priorityRank: number | null; prioritySeq: number | null; changed: boolean };

/**
 * Gives or removes priority. Priority patients are seen first-come
 * first-served by when priority was given: a newly prioritised patient never
 * jumps ahead of one prioritised earlier.
 *
 * The sequence comes from the doctor-day counter under the doctor-day lock, so
 * two staff pressing Priority at the same moment get different places.
 * Pressing it again on a patient who already has priority changes nothing —
 * a double-tap must not send them to the back of the priority line. The token
 * is never touched.
 */
export async function setPriority(args: {
  hospitalId: string;
  appointmentId: string;
  priority: number;
  actorUserId?: string | null;
  now?: Date;
}): Promise<PriorityResult> {
  const now = args.now ?? new Date();
  return withTenant(args.hospitalId, async (tx) => {
    const [current] = await tx
      .select({ doctorId: appointments.doctorId, serviceDate: appointments.serviceDate })
      .from(appointments)
      .where(eq(appointments.id, args.appointmentId));
    if (!current) throw new Error('Appointment not found');

    await lockDoctorDay(tx, {
      hospitalId: args.hospitalId,
      doctorId: current.doctorId,
      serviceDate: current.serviceDate,
    });

    const [row] = await tx
      .select({ status: appointments.status, priority: appointments.priority, prioritySeq: appointments.prioritySeq })
      .from(appointments)
      .where(eq(appointments.id, args.appointmentId));

    const wantPriority = args.priority > 0;
    const hasPriority = row.priority > 0;
    let prioritySeq = row.prioritySeq;
    let changed = false;

    if (wantPriority && !hasPriority) {
      prioritySeq = await nextQueueSeq(tx, current.doctorId, current.serviceDate);
      changed = true;
    } else if (!wantPriority && hasPriority) {
      prioritySeq = null;
      changed = true;
    } else if (wantPriority && hasPriority && prioritySeq === null) {
      // Legacy priority row: give it its place now so ordering is total.
      prioritySeq = await nextQueueSeq(tx, current.doctorId, current.serviceDate);
      changed = true;
    }

    if (changed) {
      await tx
        .update(appointments)
        .set({ priority: wantPriority ? args.priority : 0, prioritySeq, updatedAt: now })
        .where(eq(appointments.id, args.appointmentId));

      await tx.insert(queueEvents).values({
        hospitalId: args.hospitalId,
        appointmentId: args.appointmentId,
        doctorId: current.doctorId,
        action: 'enqueue',
        fromStatus: row.status,
        toStatus: row.status,
        actorUserId: args.actorUserId ?? null,
        metadata: {
          priority: wantPriority ? args.priority : 0,
          priority_seq: prioritySeq,
          reason: wantPriority ? 'priority_insert' : 'priority_removed',
        },
      });
    }

    const rows = await loadDayAppointments(tx, { doctorId: current.doctorId, serviceDate: current.serviceDate });
    return {
      priorityRank: priorityRank(rows.map(toQueueEntry), args.appointmentId),
      prioritySeq,
      changed,
    };
  });
}

/**
 * Marks or unmarks a patient as an emergency case.
 * Emergency patients are moved to the very front of the waiting line (ahead of standard priority).
 */
export async function setEmergency(args: {
  hospitalId: string;
  appointmentId: string;
  isEmergency: boolean;
  actorUserId?: string | null;
  now?: Date;
}): Promise<{ isEmergency: boolean; prioritySeq: number | null; changed: boolean }> {
  const now = args.now ?? new Date();
  return withTenant(args.hospitalId, async (tx) => {
    const [current] = await tx
      .select({ doctorId: appointments.doctorId, serviceDate: appointments.serviceDate })
      .from(appointments)
      .where(eq(appointments.id, args.appointmentId));
    if (!current) throw new Error('Appointment not found');

    await lockDoctorDay(tx, {
      hospitalId: args.hospitalId,
      doctorId: current.doctorId,
      serviceDate: current.serviceDate,
    });

    const [row] = await tx
      .select({
        status: appointments.status,
        isEmergency: appointments.isEmergency,
        priority: appointments.priority,
        prioritySeq: appointments.prioritySeq,
      })
      .from(appointments)
      .where(eq(appointments.id, args.appointmentId));

    const wantEmergency = args.isEmergency;
    const hasEmergency = Boolean(row.isEmergency);
    let prioritySeq = row.prioritySeq;
    let changed = false;

    if (wantEmergency && !hasEmergency) {
      prioritySeq = await nextQueueSeq(tx, current.doctorId, current.serviceDate);
      changed = true;
    } else if (!wantEmergency && hasEmergency) {
      if (row.priority <= 0) prioritySeq = null;
      changed = true;
    } else if (wantEmergency && hasEmergency && prioritySeq === null) {
      prioritySeq = await nextQueueSeq(tx, current.doctorId, current.serviceDate);
      changed = true;
    }

    if (changed) {
      await tx
        .update(appointments)
        .set({
          isEmergency: wantEmergency,
          priority: wantEmergency ? Math.max(row.priority, 100) : (row.priority >= 100 ? 0 : row.priority),
          prioritySeq,
          updatedAt: now,
        })
        .where(eq(appointments.id, args.appointmentId));

      await tx.insert(queueEvents).values({
        hospitalId: args.hospitalId,
        appointmentId: args.appointmentId,
        doctorId: current.doctorId,
        action: 'enqueue',
        fromStatus: row.status,
        toStatus: row.status,
        actorUserId: args.actorUserId ?? null,
        metadata: {
          is_emergency: wantEmergency,
          priority_seq: prioritySeq,
          reason: wantEmergency ? 'emergency_escalation' : 'emergency_cleared',
        },
      });
    }

    return {
      isEmergency: wantEmergency,
      prioritySeq,
      changed,
    };
  });
}

export type SessionResult = { sessionStartedAt: Date; alreadyStarted: boolean; delayMinutes: number };

/**
 * Start OPD: the one and only writer of `session_started_at`.
 *
 * Before it, patient estimates count from the scheduled start; after it, from
 * the real queue. Calling a patient or ending a break never starts the session
 * — a receptionist calling the first patient early is not the doctor arriving.
 * Idempotent: a second press keeps the first time.
 */
export async function startSession(args: {
  hospitalId: string;
  doctorId: string;
  timezone: string;
  actorUserId?: string | null;
  now?: Date;
}): Promise<SessionResult> {
  const now = args.now ?? new Date();
  const serviceDate = serviceDateIn(args.timezone, now);

  return withTenant(args.hospitalId, async (tx) => {
    const day = await lockDoctorDay(tx, { hospitalId: args.hospitalId, doctorId: args.doctorId, serviceDate });
    const scheduledStartAt = await resolveScheduledStartInTx(tx, {
      doctorId: args.doctorId,
      serviceDate,
      timezone: args.timezone,
      dayOverride: day.scheduledStartAt,
    });

    if (day.sessionStartedAt) {
      return {
        sessionStartedAt: day.sessionStartedAt,
        alreadyStarted: true,
        delayMinutes: startDelayMinutes({ scheduledStartAt, sessionStartedAt: day.sessionStartedAt, now }),
      };
    }

    // Unused reserved walk-in places join the shared pool from this moment
    // (derived from session_started_at); recorded here so the audit says so.
    const capacityBefore = await getDayCapacityInTx(tx, {
      doctorId: args.doctorId,
      serviceDate,
      timezone: args.timezone,
      now,
    });

    await tx
      .update(doctorDayStates)
      .set({ sessionStartedAt: now, updatedAt: now })
      .where(eq(doctorDayStates.id, day.id));

    const delayMinutes = startDelayMinutes({ scheduledStartAt, sessionStartedAt: now, now });
    await tx.insert(auditLogs).values({
      hospitalId: args.hospitalId,
      actorUserId: args.actorUserId ?? null,
      action: 'opd.session.started',
      objectType: 'doctor_day',
      objectId: day.id,
      metadata: {
        doctor_id: args.doctorId,
        service_date: serviceDate,
        scheduled_start_at: scheduledStartAt?.toISOString() ?? null,
        started_at: now.toISOString(),
        delay_minutes: delayMinutes,
        reserved_unused_released: capacityBefore?.reservedUnused ?? 0,
      },
    });

    await notifyLateStart(tx, {
      hospitalId: args.hospitalId,
      doctorId: args.doctorId,
      serviceDate,
      scheduledStartAt,
      startedAt: now,
      delayMinutes,
    });

    return { sessionStartedAt: now, alreadyStarted: false, delayMinutes };
  });
}

/**
 * Tells waiting patients the doctor started late — once, and only when it
 * actually moves their time.
 *
 * Event-driven: it runs when Start OPD records the real start, the moment the
 * new time is known. Nothing is sent while OPD is merely overdue — the patient
 * page shows "not started yet" then, and a message guessing a time would be a
 * promise we cannot keep. Each patient's planned estimate (from the scheduled
 * start) is compared with the live one; only a meaningful shift is messaged.
 * The outbox dedup on (appointment, milestone) makes a repeat impossible.
 */
async function notifyLateStart(
  tx: Tx,
  args: {
    hospitalId: string;
    doctorId: string;
    serviceDate: string;
    scheduledStartAt: Date | null;
    startedAt: Date;
    delayMinutes: number;
  },
) {
  if (!args.scheduledStartAt || args.delayMinutes <= 0) return;

  const [rows, settings, durations] = await Promise.all([
    loadDayAppointments(tx, { doctorId: args.doctorId, serviceDate: args.serviceDate }),
    loadQueueSettings(tx, args.doctorId),
    loadConsultDurationsForDate(tx, args.doctorId, args.serviceDate),
  ]);
  const entries = rows.map(toQueueEntry);
  const base = { consultDurations: durations, fallbackConsultMinutes: settings.defaultConsultMinutes };

  for (const row of rows) {
    if (row.status !== 'WAITING' || !row.whatsappOptInAt) continue;
    const ahead = patientsAhead(entries, row.id, settings.ctx);
    if (ahead === null) continue;

    const planned = estimateEta({
      ...base,
      patientsAhead: ahead,
      scheduledStartAt: args.scheduledStartAt,
      sessionStartedAt: null,
      now: new Date(Math.min(args.startedAt.getTime(), args.scheduledStartAt.getTime())),
    });
    const live = estimateEta({
      ...base,
      patientsAhead: ahead,
      scheduledStartAt: args.scheduledStartAt,
      sessionStartedAt: args.startedAt,
      now: args.startedAt,
    });
    if (!isMeaningfulEtaShift(planned, live)) continue;

    await tx
      .insert(notificationOutbox)
      .values({
        hospitalId: args.hospitalId,
        appointmentId: row.id,
        patientId: row.patientId,
        milestone: 'doctor_delayed',
        templateCode: 'doctor_delayed',
        locale: row.locale ?? 'en',
        payload: {
          tokenNumber: row.tokenNumber,
          doctorName: settings.doctorName,
          delayMinutes: args.delayMinutes,
          newTime: formatTimeIn(settings.timezone, live.windowStart),
          etaBasis: { patientsAhead: ahead, consultMinutes: live.basisConsultMinutes },
        },
      })
      .onConflictDoNothing();
  }
}

export class SessionNotStartedError extends Error {
  constructor() {
    super('Start OPD first. A break can only be taken once OPD has started.');
    this.name = 'SessionNotStartedError';
  }
}

/**
 * Starts or ends a doctor's break for the day.
 *
 * Ending a break also takes the break back out of whichever consultation was
 * open when it began. A doctor routinely steps out with a patient still CALLED
 * or IN_CONSULTATION — often one they have actually finished with but not yet
 * clicked past — and that patient is only completed after the break. Left
 * alone, their "consultation" spans the whole break: a 45-minute sample that
 * pushes the median, and with it every patient's estimate, up for the rest of
 * the day. Shifting the start forward by the length of the break keeps the
 * minutes the doctor really spent with them and drops the ones they did not.
 *
 * CALLED rows shift `calledAt`, because completing straight from CALLED uses
 * the call time as the consultation start. IN_CONSULTATION rows shift only
 * `consultStartedAt`, leaving `calledAt` as the true end of their wait.
 */
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

    // A break belongs to a session. Before Start OPD there is nothing to
    // pause, and ending a break must never be what starts the day.
    if (args.paused && !day.paused && !day.sessionStartedAt) throw new SessionNotStartedError();

    if (!args.paused && day.paused && day.pausedAt) {
      const breakStartedAt = day.pausedAt;
      const breakMs = now.getTime() - breakStartedAt.getTime();

      if (breakMs > 0) {
        const shift = sql`make_interval(secs => ${breakMs / 1000}::double precision)`;
        // Only timestamps from before the break moved: anything stamped during
        // it was real activity, not time the doctor was away.
        const breakIso = breakStartedAt.toISOString();
        await tx
          .update(appointments)
          .set({
            calledAt: sql`case
              when ${appointments.status} = 'CALLED' and ${appointments.calledAt} <= ${breakIso}::timestamptz
              then ${appointments.calledAt} + ${shift}
              else ${appointments.calledAt} end`,
            consultStartedAt: sql`case
              when ${appointments.status} = 'IN_CONSULTATION' and ${appointments.consultStartedAt} <= ${breakIso}::timestamptz
              then ${appointments.consultStartedAt} + ${shift}
              else ${appointments.consultStartedAt} end`,
            updatedAt: now,
          })
          .where(
            and(
              eq(appointments.doctorId, args.doctorId),
              eq(appointments.serviceDate, serviceDate),
              inArray(appointments.status, ['CALLED', 'IN_CONSULTATION']),
            ),
          );
      }
    }

    await tx
      .update(doctorDayStates)
      .set({
        paused: args.paused,
        pausedReason: args.paused ? (args.reason ?? null) : null,
        // Pressing "Start break" twice must not move the start of the break.
        pausedAt: args.paused ? (day.paused ? (day.pausedAt ?? now) : now) : null,
        updatedAt: now,
      })
      .where(eq(doctorDayStates.id, day.id));
  });
}

export type PauseResult =
  | { outcome: 'paused'; tokenNumber: number }
  | { outcome: 'invalid_status'; currentStatus: AppointmentStatus };

/**
 * Pauses an appointment by moving it to HELD.
 *
 * "Patient stepped out for a test" is the canonical example. The appointment
 * leaves the active queue so it is not called, but it keeps its slot, its
 * token, and its place in history. `resume` brings it back.
 *
 * An optional `resumeAfterMinutes` schedules automatic resumption. Without
 * it the doctor must resume manually. Either way the resume path is the same
 * `applyQueueAction({ action: 'resume' })`, so the scheduled resume and the
 * manual one are indistinguishable from the state machine's perspective.
 */
export async function pauseAppointment(args: {
  hospitalId: string;
  appointmentId: string;
  doctorId: string;
  timezone: string;
  resumeAfterMinutes?: number | null;
  reason?: string | null;
  actorUserId?: string | null;
  now?: Date;
}): Promise<PauseResult> {
  const now = args.now ?? new Date();
  const serviceDate = serviceDateIn(args.timezone, now);

  return withTenant(args.hospitalId, async (tx) => {
    await lockDoctorDay(tx, {
      hospitalId: args.hospitalId,
      doctorId: args.doctorId,
      serviceDate,
    });

    const [row] = await tx
      .select({ status: appointments.status, tokenNumber: appointments.tokenNumber })
      .from(appointments)
      .where(eq(appointments.id, args.appointmentId));

    if (!row) throw new Error('Appointment not found');

    if (!canTransition(row.status, 'hold')) {
      return { outcome: 'invalid_status' as const, currentStatus: row.status };
    }
    const toStatus = applyAction(row.status, 'hold');

    const resumeAt = args.resumeAfterMinutes
      ? new Date(now.getTime() + args.resumeAfterMinutes * 60_000)
      : null;

    await tx
      .update(appointments)
      .set({
        status: toStatus,
        pausedAt: now,
        resumeAt,
        updatedAt: now,
      })
      .where(eq(appointments.id, args.appointmentId));

    await tx.insert(queueEvents).values({
      hospitalId: args.hospitalId,
      appointmentId: args.appointmentId,
      doctorId: args.doctorId,
      action: 'hold',
      fromStatus: row.status,
      toStatus,
      actorUserId: args.actorUserId ?? null,
      metadata: {
        reason: args.reason ?? 'doctor_paused',
        ...(args.resumeAfterMinutes
          ? { resume_after_minutes: args.resumeAfterMinutes, resume_at: resumeAt!.toISOString() }
          : {}),
      },
    });

    return { outcome: 'paused' as const, tokenNumber: row.tokenNumber };
  });
}

export type ResumeResult =
  | { outcome: 'resumed'; tokenNumber: number }
  | { outcome: 'invalid_status'; currentStatus: AppointmentStatus }
  | { outcome: 'not_found' };

/**
 * Resumes a paused (HELD) appointment back into the waiting queue.
 *
 * Clears the pausedAt and resumeAt timestamps so the appointment no longer
 * shows as paused and the sweep does not try to resume it again.
 */
export async function resumeAppointment(args: {
  hospitalId: string;
  appointmentId: string;
  doctorId: string;
  timezone: string;
  actorUserId?: string | null;
  /** Recorded on the queue event; the timer sweep passes its own. */
  reason?: string;
  now?: Date;
}): Promise<ResumeResult> {
  const now = args.now ?? new Date();
  const serviceDate = serviceDateIn(args.timezone, now);

  return withTenant(args.hospitalId, async (tx) => {
    await lockDoctorDay(tx, {
      hospitalId: args.hospitalId,
      doctorId: args.doctorId,
      serviceDate,
    });

    const [row] = await tx
      .select({ status: appointments.status, tokenNumber: appointments.tokenNumber })
      .from(appointments)
      .where(eq(appointments.id, args.appointmentId));

    if (!row) return { outcome: 'not_found' as const };

    if (!canTransition(row.status, 'resume')) {
      return { outcome: 'invalid_status' as const, currentStatus: row.status };
    }
    const toStatus = applyAction(row.status, 'resume');

    const placement = await placeReturningPatient(tx, {
      doctorId: args.doctorId,
      serviceDate,
      appointmentId: args.appointmentId,
    });

    await tx
      .update(appointments)
      .set({
        status: toStatus,
        pausedAt: null,
        resumeAt: null,
        enqueuedAt: now,
        updatedAt: now,
      })
      .where(eq(appointments.id, args.appointmentId));

    await tx.insert(queueEvents).values({
      hospitalId: args.hospitalId,
      appointmentId: args.appointmentId,
      doctorId: args.doctorId,
      action: 'resume',
      fromStatus: row.status,
      toStatus,
      actorUserId: args.actorUserId ?? null,
      metadata: { reason: args.reason ?? 'resumed', ...placementMetadata(placement) },
    });

    return { outcome: 'resumed' as const, tokenNumber: row.tokenNumber };
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
  const t0 = performance.now();
  // All 4 queries run concurrently over the transaction connection
  const [
    { data: doctorRows, duration: tDoc },
    { data: dayRows, duration: tDay },
    { data: rows, duration: tAppts },
    { data: durations, duration: tDurs },
  ] = await Promise.all([
    (async () => {
      const s = performance.now();
      const res = await tx
        .select({ id: doctors.id, name: doctors.name })
        .from(doctors)
        .where(eq(doctors.id, args.doctorId));
      return { data: res, duration: performance.now() - s };
    })(),
    (async () => {
      const s = performance.now();
      const res = await tx
        .select()
        .from(doctorDayStates)
        .where(
          and(
            eq(doctorDayStates.doctorId, args.doctorId),
            eq(doctorDayStates.serviceDate, args.serviceDate),
          ),
        );
      return { data: res, duration: performance.now() - s };
    })(),
    (async () => {
      const s = performance.now();
      const res = await loadDayAppointments(tx, { doctorId: args.doctorId, serviceDate: args.serviceDate });
      return { data: res, duration: performance.now() - s };
    })(),
    (async () => {
      const s = performance.now();
      const res = await (args.fullHistoryDurations
        ? loadConsultDurations(tx, args.doctorId)
        : loadConsultDurationsForDate(tx, args.doctorId, args.serviceDate));
      return { data: res, duration: performance.now() - s };
    })(),
  ]);

  const tSnapshot = performance.now() - t0;
  console.log(
    `[PERF:queue:snapshot] doctor: ${tDoc.toFixed(1)}ms | dayState: ${tDay.toFixed(1)}ms | ` +
    `appts: ${tAppts.toFixed(1)}ms | durations: ${tDurs.toFixed(1)}ms | total: ${tSnapshot.toFixed(1)}ms`
  );

  const doctor = doctorRows[0];
  if (!doctor) return null;
  const day = dayRows[0];
  const now = args.now ?? new Date();

  const settings = await loadQueueSettings(tx, args.doctorId);
  const scheduledStartAt = await resolveScheduledStartInTx(tx, {
    doctorId: args.doctorId,
    serviceDate: args.serviceDate,
    timezone: settings.timezone,
    dayOverride: day?.scheduledStartAt ?? null,
  });
  const sessionStartedAt = day?.sessionStartedAt ?? null;

  const entries = rows.map(toQueueEntry);
  const ordered = orderQueue(entries);
  const byId = new Map(rows.map((row) => [row.id, row]));

  const serving = ordered.find(
    (e) => e.status === 'CALLED' || e.status === 'IN_CONSULTATION',
  );
  const servingRow = serving ? byId.get(serving.appointmentId) : null;
  const nextWaiting = ordered.find(isEligible);
  const nextWaitingRow = nextWaiting ? byId.get(nextWaiting.appointmentId) : null;
  const lastCallNumber = day?.lastCallNumber ?? 0;
  // Waiting and serving patients have a place in the call sequence; held and
  // skipped patients get one again when they are resumed.
  const callNumberFor = (entry: QueueEntry) =>
    isEligible(entry) || entry.status === 'CALLED' || entry.status === 'IN_CONSULTATION'
      ? projectedCallNumber(entries, entry.appointmentId, lastCallNumber, settings.ctx)
      : null;

  const etaFor = (appointmentId: string) => {
    const ahead = patientsAhead(entries, appointmentId, settings.ctx);
    if (ahead === null || day?.paused) return { ahead, etaAt: null };
    const eta = resolveEta({
      patientsAhead: ahead,
      consultDurations: durations,
      fallbackConsultMinutes: settings.defaultConsultMinutes,
      scheduledStartAt,
      sessionStartedAt,
      now,
    });
    return {
      ahead,
      etaAt: eta.state === 'not_started' ? null : new Date(now.getTime() + eta.waitMinutes * 60_000),
    };
  };

  return {
    doctorId: doctor.id,
    doctorName: doctor.name,
    serviceDate: args.serviceDate,
    paused: day?.paused ?? false,
    pausedReason: day?.pausedReason ?? null,
    breakStartedAt: day?.paused ? (day.pausedAt ?? null) : null,
    currentToken: serving?.tokenNumber ?? null,
    currentCallNumber: serving?.callNumber ?? null,
    currentPatientName: servingRow ? servingRow.patientName : null,
    nextPatient: nextWaitingRow
      ? {
          tokenNumber: nextWaitingRow.tokenNumber,
          patientName: nextWaitingRow.patientName,
          callNumber: nextWaiting ? callNumberFor(nextWaiting) : null,
        }
      : null,
    waitingCount: ordered.filter((e) => e.status === 'WAITING').length,
    completedCount: rows.filter((r) => r.status === 'COMPLETED').length,
    medianConsultMinutes: durations.length > 0 ? durations[Math.floor(durations.length / 2)] : null,
    delayMinutes: startDelayMinutes({ scheduledStartAt, sessionStartedAt, now }),
    scheduledStartAt,
    sessionStartedAt,
    etaState: resolveEta({
      patientsAhead: 0,
      consultDurations: durations,
      scheduledStartAt,
      sessionStartedAt,
      now,
    }).state,
    rows: ordered.map((entry) => {
      const row = byId.get(entry.appointmentId)!;
      const { ahead, etaAt } = etaFor(entry.appointmentId);
      return {
        ...toQueueRow(row),
        priorityRank: priorityRank(entries, entry.appointmentId),
        patientsAhead: ahead,
        etaAt,
        callNumber: callNumberFor(entry),
      };
    }),
    parked: rows
      .filter((row) => row.status === 'SKIPPED' || row.status === 'HELD')
      .sort((a, b) => a.tokenNumber - b.tokenNumber)
      .map(toQueueRow),
    completed: rows
      .filter((row) => row.status === 'COMPLETED')
      .sort((a, b) => b.tokenNumber - a.tokenNumber)
      .map(toQueueRow),
  };
}

const toQueueRow = (row: Awaited<ReturnType<typeof loadDayAppointments>>[number]): QueueRow => ({
  appointmentId: row.id,
  tokenNumber: row.tokenNumber,
  status: row.status,
  priority: row.priority,
  isEmergency: Boolean(row.isEmergency),
  patientName: row.patientName,
  patientAge: row.patientAge,
  patientPhone: row.patientPhone,
  patientId: row.patientId,
  enqueuedAt: row.enqueuedAt,
  calledAt: row.calledAt,
  scheduledSlotAt: row.scheduledSlotAt,
  pausedAt: row.pausedAt ?? null,
  resumeAt: row.resumeAt ?? null,
  queueAfterToken: row.queueAfterToken,
  quotaPool: row.quotaPool,
});

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
  /** The token issued at booking. Never changes, whatever the serving order does. */
  tokenNumber: number;
  doctorName: string;
  /** Set for a booked slot, null for a walk-in who simply joined the queue. */
  scheduledSlotAt: Date | null;
  /** Whether this appointment can still be cancelled by the patient. */
  cancellable: boolean;
  patientFirstName: string;
  currentToken: number | null;
  /** Call number now with the doctor: the serving order, not a token. */
  currentCallNumber: number | null;
  /**
   * This patient's call number: the one they were called with, or the one Next
   * will give them. Null while held or skipped. Tokens never change; this can.
   */
  callNumber: number | null;
  /**
   * Patients who will be seen first, counted on the order Next uses. For a
   * patient not here yet: the place they would take on arriving now.
   */
  patientsAhead: number | null;
  /** The doctor is on a break. */
  paused: boolean;
  /** When the doctor's current break began, when known. */
  breakStartedAt: Date | null;
  isAppointmentPaused: boolean;
  pausedAt: Date | null;
  resumeAt: Date | null;
  eta: EtaEstimate | null;
  /** `not_started`: the doctor is past their start time and OPD has not begun. */
  etaState: EtaState | null;
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
        scheduledSlotAt: appointments.scheduledSlotAt,
        expiresAt: appointments.publicTokenExpiresAt,
        pausedAt: appointments.pausedAt,
        resumeAt: appointments.resumeAt,
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

    const [rows, settings, durations] = await Promise.all([
      loadDayAppointments(tx, { doctorId: appointment.doctorId, serviceDate: appointment.serviceDate }),
      loadQueueSettings(tx, appointment.doctorId),
      loadConsultDurations(tx, appointment.doctorId),
    ]);
    const entries = rows.map(toQueueEntry);
    const ordered = orderQueue(entries);
    const ahead = patientsAhead(entries, appointment.id, settings.ctx);
    const serving = ordered.find(
      (e) => e.status === 'CALLED' || e.status === 'IN_CONSULTATION',
    );
    const scheduledStartAt = await resolveScheduledStartInTx(tx, {
      doctorId: appointment.doctorId,
      serviceDate: appointment.serviceDate,
      timezone: settings.timezone,
      dayOverride: day?.scheduledStartAt ?? null,
    });

    const expired = appointment.expiresAt.getTime() < now.getTime();
    const showEta =
      ahead !== null && !expired && !(day?.paused ?? false) && appointment.status !== 'HELD';
    const resolvedEta: EtaResult | null = showEta
      ? resolveEta({
          patientsAhead: ahead,
          consultDurations: durations,
          fallbackConsultMinutes: appointment.defaultConsultMinutes,
          scheduledStartAt,
          sessionStartedAt: day?.sessionStartedAt ?? null,
          now,
        })
      : null;

    return {
      status: appointment.status,
      tokenNumber: appointment.tokenNumber,
      doctorName: appointment.doctorName,
      scheduledSlotAt: appointment.scheduledSlotAt,
      cancellable: !expired && isCancellableByPatient(appointment.status),
      // First name only: a forwarded link should not expose a full identity.
      patientFirstName: appointment.patientName.split(' ')[0] ?? '',
      currentToken: serving?.tokenNumber ?? null,
      currentCallNumber: serving?.callNumber ?? null,
      callNumber:
        appointment.status === 'HELD' || appointment.status === 'SKIPPED'
          ? null
          : projectedCallNumber(entries, appointment.id, day?.lastCallNumber ?? 0, settings.ctx),
      patientsAhead: ahead,
      paused: day?.paused ?? false,
      breakStartedAt: day?.paused ? (day.pausedAt ?? null) : null,
      isAppointmentPaused: appointment.status === 'HELD',
      pausedAt: appointment.pausedAt ?? null,
      resumeAt: appointment.resumeAt ?? null,
      timezone: settings.timezone,
      locale: appointment.patientLocale ?? 'en',
      lastUpdatedAt: now,
      expired,
      eta: resolvedEta && resolvedEta.state !== 'not_started' ? resolvedEta : null,
      etaState: resolvedEta?.state ?? null,
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

export type PatientCancelResult =
  | { outcome: 'cancelled'; tokenNumber: number }
  | { outcome: 'already_cancelled' }
  | { outcome: 'too_late' }
  | { outcome: 'not_found' };

/**
 * Lets a patient call off their own appointment from the link they were sent.
 *
 * The public token is the whole credential, exactly as it is for viewing the
 * page — anyone holding the link can cancel, which is the right trust model
 * because the link went to the patient's own phone and forwarding it is their
 * decision. No session exists here and none should: requiring a login to
 * cancel is how you guarantee nobody does.
 *
 * Freeing the slot happens for free. `getDoctorSlotsForDate` already excludes
 * CANCELLED, so the time becomes bookable again the moment this commits —
 * which is the entire point. A cancellation ten minutes out is worth more to
 * the hospital than a no-show, and making it awkward produces no-shows rather
 * than attendance.
 */
export async function cancelByPublicToken(args: {
  publicToken: string;
  reason?: string | null;
  now?: Date;
}): Promise<PatientCancelResult> {
  const now = args.now ?? new Date();

  const [resolved] = await getDb().execute<{ hospital_id: string | null }>(
    sql`select public.resolve_public_token(${args.publicToken}) as hospital_id`,
  );
  const hospitalId = resolved?.hospital_id;
  if (!hospitalId) return { outcome: 'not_found' };

  return withTenant(hospitalId, async (tx) => {
    const [appointment] = await tx
      .select({
        id: appointments.id,
        status: appointments.status,
        tokenNumber: appointments.tokenNumber,
        doctorId: appointments.doctorId,
        serviceDate: appointments.serviceDate,
        expiresAt: appointments.publicTokenExpiresAt,
        patientId: appointments.patientId,
      })
      .from(appointments)
      .where(eq(appointments.publicToken, args.publicToken));

    if (!appointment) return { outcome: 'not_found' };

    // Idempotent: a double-tapped button, or a link opened twice, reports the
    // same thing rather than erroring at somebody who did nothing wrong.
    if (appointment.status === 'CANCELLED') return { outcome: 'already_cancelled' };

    if (
      appointment.expiresAt.getTime() < now.getTime() ||
      !isCancellableByPatient(appointment.status)
    ) {
      return { outcome: 'too_late' };
    }

    // Serialise against the dashboard: reception may be calling this very
    // token as the patient taps cancel, and the lock decides which wins.
    await lockDoctorDay(tx, {
      hospitalId,
      doctorId: appointment.doctorId,
      serviceDate: appointment.serviceDate,
    });

    const [fresh] = await tx
      .select({ status: appointments.status })
      .from(appointments)
      .where(eq(appointments.id, appointment.id));

    // Re-checked under the lock. The status may have moved while we waited,
    // and a patient must not cancel a consultation that has since started.
    if (fresh.status === 'CANCELLED') return { outcome: 'already_cancelled' };
    if (!isCancellableByPatient(fresh.status)) return { outcome: 'too_late' };

    await tx
      .update(appointments)
      .set({ status: 'CANCELLED', updatedAt: now })
      .where(eq(appointments.id, appointment.id));

    await tx.insert(queueEvents).values({
      hospitalId,
      appointmentId: appointment.id,
      doctorId: appointment.doctorId,
      action: 'cancel',
      fromStatus: fresh.status,
      toStatus: 'CANCELLED',
      // No staff member did this, and recording one would be a lie in the only
      // record that answers "who cancelled my appointment".
      actorUserId: null,
      metadata: {
        reason: 'patient_cancelled',
        source: 'public_link',
        ...(args.reason ? { patient_reason: args.reason } : {}),
      },
    });

    /**
     * No confirmation message is sent.
     *
     * The patient performed this action and is looking at the result on
     * screen. Telling them what they just did would be a billable message
     * spent on information they already have — and the whole reason
     * cancellation is worth encouraging is that it is cheaper than a no-show.
     */
    console.log(
      '[queue:patient_cancelled]',
      JSON.stringify({
        hospital_id: hospitalId,
        appointment_id: appointment.id,
        doctor_id: appointment.doctorId,
        token_number: appointment.tokenNumber,
        from_status: fresh.status,
      }),
    );

    return { outcome: 'cancelled', tokenNumber: appointment.tokenNumber };
  });
}

export type PatientResumeResult =
  | { outcome: 'resumed'; tokenNumber: number }
  | { outcome: 'not_paused' }
  | { outcome: 'not_found' }
  | { outcome: 'expired' };

/**
 * Lets a paused (HELD) patient rejoin the waiting line when they return.
 */
export async function resumeByPublicToken(args: {
  publicToken: string;
  now?: Date;
}): Promise<PatientResumeResult> {
  const now = args.now ?? new Date();

  const [resolved] = await getDb().execute<{ hospital_id: string | null }>(
    sql`select public.resolve_public_token(${args.publicToken}) as hospital_id`,
  );
  const hospitalId = resolved?.hospital_id;
  if (!hospitalId) return { outcome: 'not_found' };

  return withTenant(hospitalId, async (tx) => {
    const [appointment] = await tx
      .select({
        id: appointments.id,
        status: appointments.status,
        tokenNumber: appointments.tokenNumber,
        doctorId: appointments.doctorId,
        serviceDate: appointments.serviceDate,
        expiresAt: appointments.publicTokenExpiresAt,
      })
      .from(appointments)
      .where(eq(appointments.publicToken, args.publicToken));

    if (!appointment) return { outcome: 'not_found' };
    if (appointment.expiresAt.getTime() < now.getTime()) {
      return { outcome: 'expired' };
    }
    if (appointment.status !== 'HELD') {
      return { outcome: 'not_paused' };
    }

    await lockDoctorDay(tx, {
      hospitalId,
      doctorId: appointment.doctorId,
      serviceDate: appointment.serviceDate,
    });

    const [fresh] = await tx
      .select({ status: appointments.status })
      .from(appointments)
      .where(eq(appointments.id, appointment.id));

    if (fresh.status !== 'HELD') {
      return { outcome: 'not_paused' };
    }

    const placement = await placeReturningPatient(tx, {
      doctorId: appointment.doctorId,
      serviceDate: appointment.serviceDate,
      appointmentId: appointment.id,
    });

    await tx
      .update(appointments)
      .set({
        status: 'WAITING',
        pausedAt: null,
        resumeAt: null,
        enqueuedAt: now,
        updatedAt: now,
      })
      .where(eq(appointments.id, appointment.id));

    await tx.insert(queueEvents).values({
      hospitalId,
      appointmentId: appointment.id,
      doctorId: appointment.doctorId,
      action: 'resume',
      fromStatus: 'HELD',
      toStatus: 'WAITING',
      actorUserId: null,
      metadata: { reason: 'patient_self_resumed', ...placementMetadata(placement) },
    });

    return { outcome: 'resumed', tokenNumber: appointment.tokenNumber };
  });
}

