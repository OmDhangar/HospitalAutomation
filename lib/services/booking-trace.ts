import { and, asc, eq, inArray } from 'drizzle-orm';
import { withTenant } from '@/lib/db';
import { getAdminDb } from '@/lib/db/admin';
import {
  appointments,
  auditLogs,
  doctorDayStates,
  doctors,
  hospitals,
  notificationOutbox,
  patients,
  queueEvents,
  users,
  whatsappConversations,
} from '@/lib/db/schema';
import {
  capacityAt,
  describeOrigin,
  isOnline,
  traceVerdict,
  type BookingOrigin,
  type CapacityChange,
  type CapacitySettings,
  type TraceVerdict,
} from '@/lib/domain/booking-trace';
import { tokenLabel } from '@/lib/domain/queue';

export type TraceEvent = {
  at: Date;
  kind: 'queue' | 'message';
  /** "added to queue", "called", "WhatsApp: queue link"… */
  label: string;
  /** Staff name and login for desk actions; null for the system or the patient. */
  actor: string | null;
  detail: string | null;
};

export type TracedBooking = {
  appointmentId: string;
  doctorId: string;
  doctorName: string;
  tokenNumber: number;
  tokenLabel: string;
  status: string;
  quotaPool: 'reserved' | 'shared' | 'extra' | null;
  origin: BookingOrigin;
  online: boolean;
  createdAt: Date;
  /** Who created it: a staff member, or the patient themselves. */
  createdBy: string;
  scheduledSlotAt: Date | null;
  patientName: string;
  phoneE164: string;
  /** Last WhatsApp message received from this number, if it ever wrote to the hospital. */
  lastWhatsAppFromPatientAt: Date | null;
  /** The reserve in force when this booking was made, and how we know. */
  reserveAtBooking: number;
  reserveKnownFrom: 'change_log' | 'current';
  verdicts: TraceVerdict[];
  timeline: TraceEvent[];
};

export type CapacityHistoryEntry = {
  at: Date;
  doctorName: string;
  actor: string | null;
  before: CapacitySettings;
  after: CapacitySettings;
};

export type BookingTrace = {
  serviceDate: string;
  doctors: Array<{ id: string; name: string; walkInReserved: number; dailyTokenQuota: number | null }>;
  bookings: TracedBooking[];
  totals: { all: number; online: number; desk: number; faults: number };
  capacityHistory: CapacityHistoryEntry[];
  /** Per doctor: when OPD was started and when unused reserve was released by hand. */
  days: Array<{ doctorId: string; sessionStartedAt: Date | null; reservedReleasedAt: Date | null }>;
};

const ACTION_LABEL: Record<string, string> = {
  enqueue: 'added to the waiting line',
  confirm: 'booking confirmed',
  call: 'called',
  start_consultation: 'consultation started',
  complete: 'completed',
  skip: 'skipped',
  recall: 'recalled',
  hold: 'put on hold',
  resume: 'resumed',
  cancel: 'cancelled',
  mark_no_show: 'marked no-show',
  expire: 'expired',
  arrive: 'marked arrived',
};

const MESSAGE_LABEL: Record<string, string> = {
  queue_link: 'WhatsApp: queue link sent',
  conversation: 'WhatsApp chat: booking confirmed in the chat',
  queue_milestone: 'WhatsApp: "your turn is close"',
  appointment_confirmed: 'WhatsApp: appointment confirmation',
  slot_reminder: 'WhatsApp: slot reminder',
  queue_skipped: 'WhatsApp: skipped notice',
  appointment_cancelled: 'WhatsApp: cancellation notice',
  doctor_delayed: 'WhatsApp: doctor delayed notice',
};

const settingsFrom = (raw: unknown): CapacitySettings => {
  const r = (raw ?? {}) as Record<string, unknown>;
  const quota = r.dailyQuota ?? r.dailyTokenQuota ?? null;
  return {
    walkInReserved: Number(r.walkInReserved ?? 0) || 0,
    quota: quota === null || quota === undefined ? null : Number(quota),
  };
};

/** Hospitals for the platform console's picker. */
export async function listTraceHospitals(): Promise<Array<{ id: string; name: string; timezone: string }>> {
  const rows = await getAdminDb()
    .select({ id: hospitals.id, name: hospitals.name, timezone: hospitals.timezone })
    .from(hospitals)
    .orderBy(asc(hospitals.name));
  return rows.map((r) => ({ ...r, timezone: r.timezone ?? 'Asia/Kolkata' }));
}

/**
 * Every booking for one hospital-day, each with its origin, who created it,
 * the messages it caused, and a verdict on its token.
 *
 * Seven queries for the whole day, never one per booking: the page is opened
 * when something is disputed, and it should answer at once.
 */
export async function getBookingTrace(args: {
  hospitalId: string;
  serviceDate: string;
  doctorId?: string | null;
  tokenNumber?: number | null;
  /** Any part of the patient's phone number, digits only. */
  phoneDigits?: string | null;
}): Promise<BookingTrace> {
  return withTenant(args.hospitalId, async (tx) => {
    const doctorRows = await tx
      .select({
        id: doctors.id,
        name: doctors.name,
        walkInReserved: doctors.walkInReserved,
        dailyTokenQuota: doctors.dailyTokenQuota,
      })
      .from(doctors)
      .orderBy(asc(doctors.name));
    const doctorById = new Map(doctorRows.map((d) => [d.id, d]));

    const filters = [eq(appointments.serviceDate, args.serviceDate)];
    if (args.doctorId) filters.push(eq(appointments.doctorId, args.doctorId));
    if (args.tokenNumber) filters.push(eq(appointments.tokenNumber, args.tokenNumber));

    let rows = await tx
      .select({
        id: appointments.id,
        doctorId: appointments.doctorId,
        tokenNumber: appointments.tokenNumber,
        sessionKind: appointments.sessionKind,
        source: appointments.source,
        status: appointments.status,
        quotaPool: appointments.quotaPool,
        scheduledSlotAt: appointments.scheduledSlotAt,
        createdAt: appointments.createdAt,
        patientName: patients.name,
        phoneE164: patients.phoneE164,
      })
      .from(appointments)
      .innerJoin(patients, eq(patients.id, appointments.patientId))
      .where(and(...filters))
      .orderBy(asc(appointments.createdAt));

    const digits = args.phoneDigits?.replace(/\D/g, '');
    if (digits) rows = rows.filter((r) => r.phoneE164.replace(/\D/g, '').includes(digits));

    const ids = rows.map((r) => r.id);
    const phones = [...new Set(rows.map((r) => r.phoneE164))];
    const doctorIds = args.doctorId ? [args.doctorId] : doctorRows.map((d) => d.id);

    const [events, messages, conversations, changes, days] = await Promise.all([
      ids.length
        ? tx
            .select({
              appointmentId: queueEvents.appointmentId,
              action: queueEvents.action,
              createdAt: queueEvents.createdAt,
              metadata: queueEvents.metadata,
              actorName: users.name,
              actorEmail: users.email,
            })
            .from(queueEvents)
            .leftJoin(users, eq(users.id, queueEvents.actorUserId))
            .where(inArray(queueEvents.appointmentId, ids))
            .orderBy(asc(queueEvents.createdAt))
        : Promise.resolve([]),
      ids.length
        ? tx
            .select({
              appointmentId: notificationOutbox.appointmentId,
              templateCode: notificationOutbox.templateCode,
              status: notificationOutbox.status,
              createdAt: notificationOutbox.createdAt,
              sentAt: notificationOutbox.sentAt,
            })
            .from(notificationOutbox)
            .where(inArray(notificationOutbox.appointmentId, ids))
        : Promise.resolve([]),
      phones.length
        ? tx
            .select({ phoneE164: whatsappConversations.phoneE164, lastInboundAt: whatsappConversations.lastInboundAt })
            .from(whatsappConversations)
            .where(inArray(whatsappConversations.phoneE164, phones))
        : Promise.resolve([]),
      doctorIds.length
        ? tx
            .select({
              objectId: auditLogs.objectId,
              createdAt: auditLogs.createdAt,
              metadata: auditLogs.metadata,
              actorName: users.name,
            })
            .from(auditLogs)
            .leftJoin(users, eq(users.id, auditLogs.actorUserId))
            .where(and(eq(auditLogs.action, 'doctor.capacity.updated'), inArray(auditLogs.objectId, doctorIds)))
            .orderBy(asc(auditLogs.createdAt))
        : Promise.resolve([]),
      tx
        .select({
          doctorId: doctorDayStates.doctorId,
          sessionStartedAt: doctorDayStates.sessionStartedAt,
          reservedReleasedAt: doctorDayStates.reservedReleasedAt,
        })
        .from(doctorDayStates)
        .where(eq(doctorDayStates.serviceDate, args.serviceDate)),
    ]);

    const changesByDoctor = new Map<string, CapacityChange[]>();
    const capacityHistory: CapacityHistoryEntry[] = [];
    for (const c of changes) {
      if (!c.objectId) continue;
      const meta = (c.metadata ?? {}) as Record<string, unknown>;
      const change: CapacityChange = { at: c.createdAt, before: settingsFrom(meta.before), after: settingsFrom(meta.after) };
      changesByDoctor.set(c.objectId, [...(changesByDoctor.get(c.objectId) ?? []), change]);
      capacityHistory.push({
        ...change,
        doctorName: doctorById.get(c.objectId)?.name ?? 'Unknown doctor',
        actor: c.actorName ?? null,
      });
    }
    const lastInbound = new Map(conversations.map((c) => [c.phoneE164, c.lastInboundAt]));

    const bookings: TracedBooking[] = rows.map((row) => {
      const ownEvents = events.filter((e) => e.appointmentId === row.id);
      const ownMessages = messages.filter((m) => m.appointmentId === row.id);
      const confirmedInChat = ownMessages.some((m) => m.templateCode === 'conversation');
      const origin = describeOrigin({ source: row.source, scheduledSlotAt: row.scheduledSlotAt, confirmedInChat });
      const doctor = doctorById.get(row.doctorId);
      const reserve = capacityAt(
        changesByDoctor.get(row.doctorId) ?? [],
        { walkInReserved: doctor?.walkInReserved ?? 0, quota: doctor?.dailyTokenQuota ?? null },
        row.createdAt,
      );

      const first = ownEvents[0];
      const createdBy =
        first?.actorName
          ? `${first.actorName}${first.actorEmail ? ` (${first.actorEmail})` : ''}`
          : origin === 'web_slot'
            ? 'Patient, on the online booking page'
            : isOnline(origin)
              ? 'Patient, through WhatsApp'
              : 'System';

      const timeline: TraceEvent[] = [
        ...ownEvents.map((e) => ({
          at: e.createdAt,
          kind: 'queue' as const,
          label: ACTION_LABEL[e.action] ?? e.action,
          actor: e.actorName ?? null,
          detail: e.metadata && Object.keys(e.metadata).length ? JSON.stringify(e.metadata) : null,
        })),
        ...ownMessages.map((m) => ({
          at: m.sentAt ?? m.createdAt,
          kind: 'message' as const,
          label: MESSAGE_LABEL[m.templateCode] ?? `WhatsApp: ${m.templateCode}`,
          actor: null,
          detail: m.status,
        })),
      ].sort((a, b) => a.at.getTime() - b.at.getTime());

      return {
        appointmentId: row.id,
        doctorId: row.doctorId,
        doctorName: doctor?.name ?? 'Unknown doctor',
        tokenNumber: row.tokenNumber,
        tokenLabel: tokenLabel(row.sessionKind, row.tokenNumber),
        status: row.status,
        quotaPool: row.quotaPool,
        origin,
        online: isOnline(origin),
        createdAt: row.createdAt,
        createdBy,
        scheduledSlotAt: row.scheduledSlotAt,
        patientName: row.patientName,
        phoneE164: row.phoneE164,
        lastWhatsAppFromPatientAt: lastInbound.get(row.phoneE164) ?? null,
        reserveAtBooking: reserve.walkInReserved,
        reserveKnownFrom: reserve.source,
        verdicts: traceVerdict({
          origin,
          tokenNumber: row.tokenNumber,
          sessionKind: row.sessionKind,
          quotaPool: row.quotaPool,
          reserveAtBooking: reserve.walkInReserved,
          queueLinkSentToPhone: ownMessages.some((m) => m.templateCode === 'queue_link'),
        }),
        timeline,
      };
    });

    const online = bookings.filter((b) => b.online).length;
    return {
      serviceDate: args.serviceDate,
      doctors: doctorRows,
      bookings,
      totals: {
        all: bookings.length,
        online,
        desk: bookings.length - online,
        faults: bookings.filter((b) => b.verdicts.some((v) => v.level === 'fault')).length,
      },
      capacityHistory: capacityHistory.reverse(),
      days: days.filter((d) => doctorIds.includes(d.doctorId)),
    };
  });
}
