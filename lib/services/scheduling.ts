import { and, asc, eq, gte, lte, sql } from 'drizzle-orm';
import { withTenant, type Tx } from '@/lib/db';
import {
  appointments,
  doctorIntervalBlocks,
  doctors,
  doctorScheduleExceptions,
  doctorSchedules,
  doctorSlotOverrides,
  hospitals,
} from '@/lib/db/schema';
import {
  dayStartAt,
  runsOwnList,
  slotNumber,
  takesSlots,
  toDaySessions,
  validateSessions,
  type DaySession,
  type SessionConfig,
} from '@/lib/domain/sessions';
import { formatTimeIn, serviceDateIn, zonedTimeToUtc } from '@/lib/domain/time';
import { clearDoctorCache } from './hospital';

export type GeneratedSlot = {
  timeStr: string; // e.g. "10:00 AM"
  time24: string; // e.g. "10:00"
  datetimeIso: string; // UTC ISO string for booking
  available: boolean;
  reason?: string | null; // e.g. "Booked", "Lunch", "Emergency", "Personal", "Disabled"
  /**
   * S-number when the slot belongs to a session that runs its own list (a
   * slot-only session on a split day). Null: booking it issues a live-queue
   * token, as single-session days always have.
   */
  slotNumber: number | null;
};

export type DoctorScheduleSettings = {
  doctorId: string;
  doctorName: string;
  specialty: string | null;
  startTime: string; // "10:00"
  endTime: string; // "17:00"
  slotMinutes: number; // 5, 10, 15, 20, 30, 45, 60 — clamped to 5..120 when generating
  breakStartTime: string | null; // "13:00"
  breakEndTime: string | null; // "14:00"
  mode: 'queue' | 'slot' | 'both';
  /**
   * Every session of the day, earliest first. The flat fields above mirror
   * the first session, for callers that only know about one.
   */
  sessions: SessionConfig[];
};

/** Hours a doctor with no schedule at all is offered at, as before sessions existed. */
const DEFAULT_SESSION: Omit<SessionConfig, 'slotMinutes'> = {
  mode: 'both',
  startTime: '10:00',
  endTime: '17:00',
  breakStartTime: '13:00',
  breakEndTime: '14:00',
};

const hhmm = (t: string | null | undefined) => (t ? t.slice(0, 5) : null);

type ScheduleRow = {
  weekday: number;
  mode: 'queue' | 'slot' | 'both';
  startTime: string;
  endTime: string;
  slotMinutes: number;
  breakStartTime: string | null;
  breakEndTime: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
};

const toSessionConfig = (row: ScheduleRow): SessionConfig => ({
  mode: row.mode,
  startTime: hhmm(row.startTime)!,
  endTime: hhmm(row.endTime)!,
  slotMinutes: row.slotMinutes,
  // A cleared break stays cleared. It used to come back as 13:00-14:00.
  breakStartTime: hhmm(row.breakStartTime),
  breakEndTime: hhmm(row.breakEndTime),
});

const byStart = (a: SessionConfig, b: SessionConfig) => a.startTime.localeCompare(b.startTime);

async function loadScheduleRows(tx: Tx, doctorId: string): Promise<ScheduleRow[]> {
  return tx
    .select({
      weekday: doctorSchedules.weekday,
      mode: doctorSchedules.mode,
      startTime: doctorSchedules.startTime,
      endTime: doctorSchedules.endTime,
      slotMinutes: doctorSchedules.slotMinutes,
      breakStartTime: doctorSchedules.breakStartTime,
      breakEndTime: doctorSchedules.breakEndTime,
      effectiveFrom: doctorSchedules.effectiveFrom,
      effectiveTo: doctorSchedules.effectiveTo,
    })
    .from(doctorSchedules)
    .where(eq(doctorSchedules.doctorId, doctorId))
    .orderBy(asc(doctorSchedules.createdAt));
}

/**
 * The rows that make up one service date, in order of authority: those in
 * effect for that weekday, then any for that weekday, then whichever weekday
 * was written first (the settings screen writes the same hours to all seven).
 */
function rowsForDate(rows: ScheduleRow[], serviceDate: string): ScheduleRow[] {
  if (rows.length === 0) return [];
  const weekday = new Date(`${serviceDate}T12:00:00Z`).getUTCDay();
  const inEffect = rows.filter(
    (row) => row.effectiveFrom <= serviceDate && (row.effectiveTo === null || row.effectiveTo >= serviceDate),
  );
  const forWeekday = inEffect.filter((row) => row.weekday === weekday);
  if (forWeekday.length > 0) return forWeekday;
  const anyForWeekday = rows.filter((row) => row.weekday === weekday);
  if (anyForWeekday.length > 0) return anyForWeekday;
  return rows.filter((row) => row.weekday === rows[0].weekday);
}

/**
 * The doctor's sessions on one service date, earliest first; empty when the
 * doctor is closed that day or has no schedule.
 *
 * A one-off exception wins over the weekly schedule: `closed` empties the day,
 * and changed hours move the live-queue session (or the only one).
 */
export async function loadDaySessionsInTx(
  tx: Tx,
  args: { doctorId: string; serviceDate: string; timezone: string },
): Promise<DaySession[]> {
  const [[exception], rows] = await Promise.all([
    tx
      .select({
        closed: doctorScheduleExceptions.closed,
        startTime: doctorScheduleExceptions.startTime,
        endTime: doctorScheduleExceptions.endTime,
      })
      .from(doctorScheduleExceptions)
      .where(
        and(
          eq(doctorScheduleExceptions.doctorId, args.doctorId),
          eq(doctorScheduleExceptions.serviceDate, args.serviceDate),
        ),
      )
      .limit(1),
    loadScheduleRows(tx, args.doctorId),
  ]);
  if (exception?.closed) return [];

  const configs = rowsForDate(rows, args.serviceDate).map(toSessionConfig).sort(byStart);
  if (exception?.startTime) {
    const target = configs.find((c) => c.mode !== 'slot') ?? configs[0];
    if (target) {
      target.startTime = hhmm(exception.startTime)!;
      if (exception.endTime) target.endTime = hhmm(exception.endTime)!;
    } else {
      // Hours given for a doctor with no weekly schedule: that is the day.
      configs.push({
        mode: 'queue',
        startTime: hhmm(exception.startTime)!,
        endTime: hhmm(exception.endTime) ?? '23:59',
        slotMinutes: 10,
      });
    }
  }
  return toDaySessions(configs, args.serviceDate, args.timezone);
}

export type IntervalBlockItem = {
  id: string;
  serviceDate: string;
  startTime: string;
  endTime: string;
  reason: string | null;
};

export type SlotOverrideItem = {
  id: string;
  serviceDate: string;
  slotTime: string;
  isAvailable: boolean;
  reason: string | null;
};

// Converts "HH:MM" or "HH:MM:SS" string into minutes since midnight
export function timeStringToMinutes(t: string): number {
  const parts = t.split(':').map(Number);
  return (parts[0] || 0) * 60 + (parts[1] || 0);
}

// Format minutes since midnight into 12-hour "hh:mm AM/PM"
export function minutesToFormattedTime(totalMinutes: number): string {
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  const period = h >= 12 ? 'PM' : 'AM';
  const displayH = h % 12 === 0 ? 12 : h % 12;
  const displayM = m < 10 ? `0${m}` : `${m}`;
  return `${displayH}:${displayM} ${period}`;
}

// Format minutes since midnight into 24-hour "HH:MM"
export function minutesTo24HTime(totalMinutes: number): string {
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  const displayH = h < 10 ? `0${h}` : `${h}`;
  const displayM = m < 10 ? `0${m}` : `${m}`;
  return `${displayH}:${displayM}`;
}

/**
 * Calculates raw time slots for a given time range and slot interval (in minutes).
 */
export function generateRawSlots(args: {
  startTime: string;
  endTime: string;
  slotMinutes: number;
  breakStartTime?: string | null;
  breakEndTime?: string | null;
}): Array<{ time24: string; timeFormatted: string; startMinutes: number; isBreak: boolean }> {
  const startM = timeStringToMinutes(args.startTime);
  const endM = timeStringToMinutes(args.endTime);
  const breakStartM = args.breakStartTime ? timeStringToMinutes(args.breakStartTime) : null;
  const breakEndM = args.breakEndTime ? timeStringToMinutes(args.breakEndTime) : null;

  const interval = Math.max(5, Math.min(args.slotMinutes, 120));
  const slots: Array<{
    time24: string;
    timeFormatted: string;
    startMinutes: number;
    isBreak: boolean;
  }> = [];

  let current = startM;
  while (current + interval <= endM) {
    let isBreak = false;
    if (breakStartM !== null && breakEndM !== null && breakStartM < breakEndM) {
      // Slot falls inside break if it starts inside break interval
      if (current >= breakStartM && current < breakEndM) {
        isBreak = true;
      }
    }

    slots.push({
      time24: minutesTo24HTime(current),
      timeFormatted: minutesToFormattedTime(current),
      startMinutes: current,
      isBreak,
    });

    current += interval;
  }

  return slots;
}

/** The doctor's weekly session template, as the settings screen edits it. */
function scheduleSettings(
  doc: { id: string; name: string; specialty: string | null; defaultConsultMinutes: number | null },
  rows: ScheduleRow[],
): DoctorScheduleSettings {
  const template = rows.length > 0 ? rows.filter((r) => r.weekday === rows[0].weekday) : [];
  const sessions = template.map(toSessionConfig).sort(byStart);
  const first: SessionConfig = sessions[0] ?? {
    ...DEFAULT_SESSION,
    slotMinutes: doc.defaultConsultMinutes ?? 15,
  };
  return {
    doctorId: doc.id,
    doctorName: doc.name,
    specialty: doc.specialty,
    startTime: first.startTime,
    endTime: first.endTime,
    slotMinutes: first.slotMinutes,
    breakStartTime: first.breakStartTime ?? null,
    breakEndTime: first.breakEndTime ?? null,
    mode: first.mode,
    sessions: sessions.length > 0 ? sessions : [first],
  };
}

/**
 * Retrieves doctor schedule settings for a given hospital & doctor.
 */
export async function getDoctorScheduleConfig(args: {
  hospitalId: string;
  doctorId: string;
}): Promise<DoctorScheduleSettings | null> {
  return withTenant(args.hospitalId, async (tx) => {
    const [doc] = await tx
      .select({
        id: doctors.id,
        name: doctors.name,
        specialty: doctors.specialty,
        defaultConsultMinutes: doctors.defaultConsultMinutes,
      })
      .from(doctors)
      .where(and(eq(doctors.id, args.doctorId), eq(doctors.active, true)));

    if (!doc) return null;
    return scheduleSettings(doc, await loadScheduleRows(tx, args.doctorId));
  });
}

/** Refused schedule input; the message is safe to show the owner. */
export class ScheduleValidationError extends Error {
  constructor(readonly errors: string[]) {
    super(errors.join(' '));
    this.name = 'ScheduleValidationError';
  }
}

/**
 * Saves the doctor's weekly sessions, the same for every weekday.
 *
 * Pass `sessions` for a split day, e.g. a live queue 12:00-19:00 and booked
 * slots 20:00-22:00. The single-session fields remain for older callers and
 * describe a one-session day.
 */
export async function saveDoctorScheduleConfig(args: {
  hospitalId: string;
  doctorId: string;
  sessions?: SessionConfig[];
  startTime?: string;
  endTime?: string;
  slotMinutes?: number;
  breakStartTime?: string | null;
  breakEndTime?: string | null;
  mode?: 'queue' | 'slot' | 'both';
}) {
  const sessions: SessionConfig[] = (
    args.sessions ?? [
      {
        mode: args.mode ?? 'slot',
        startTime: args.startTime ?? '',
        endTime: args.endTime ?? '',
        slotMinutes: args.slotMinutes ?? 15,
        breakStartTime: args.breakStartTime || null,
        breakEndTime: args.breakEndTime || null,
      },
    ]
  ).map((x) => ({ ...x, breakStartTime: x.breakStartTime || null, breakEndTime: x.breakEndTime || null }));

  const errors = validateSessions(sessions);
  if (errors.length > 0) throw new ScheduleValidationError(errors);

  const today = new Date().toISOString().slice(0, 10);
  return withTenant(args.hospitalId, async (tx) => {
    // Delete existing weekly schedule for doctor and re-insert
    await tx.delete(doctorSchedules).where(eq(doctorSchedules.doctorId, args.doctorId));

    // One row per session per weekday (0 to 6).
    const values = [0, 1, 2, 3, 4, 5, 6].flatMap((dow) =>
      sessions.map((session) => ({
        hospitalId: args.hospitalId,
        doctorId: args.doctorId,
        weekday: dow,
        mode: session.mode,
        startTime: session.startTime,
        endTime: session.endTime,
        slotMinutes: session.slotMinutes,
        breakStartTime: session.breakStartTime ?? null,
        breakEndTime: session.breakEndTime ?? null,
        effectiveFrom: today,
      })),
    );

    await tx.insert(doctorSchedules).values(values);

    // The consultation time estimates fall back on: the live queue's slot length.
    const consult = (sessions.find((x) => x.mode !== 'slot') ?? sessions[0]).slotMinutes;
    await tx
      .update(doctors)
      .set({ defaultConsultMinutes: consult })
      .where(eq(doctors.id, args.doctorId));
    // The doctor list carries each doctor's booking mode; it must not lag the new sessions.
    clearDoctorCache(args.hospitalId);
  });
}

/**
 * Toggle individual slot override state (enable/disable specific slot).
 */
export async function toggleSlotOverride(args: {
  hospitalId: string;
  doctorId: string;
  serviceDate: string;
  slotTime: string; // "10:20"
  isAvailable: boolean;
  reason?: string | null;
}) {
  return withTenant(args.hospitalId, async (tx) => {
    const formattedTime = args.slotTime.length === 5 ? `${args.slotTime}:00` : args.slotTime;

    const [existing] = await tx
      .select()
      .from(doctorSlotOverrides)
      .where(
        and(
          eq(doctorSlotOverrides.doctorId, args.doctorId),
          eq(doctorSlotOverrides.serviceDate, args.serviceDate),
          eq(doctorSlotOverrides.slotTime, formattedTime),
        ),
      );

    if (existing) {
      await tx
        .update(doctorSlotOverrides)
        .set({ isAvailable: args.isAvailable, reason: args.reason ?? null })
        .where(eq(doctorSlotOverrides.id, existing.id));
    } else {
      await tx.insert(doctorSlotOverrides).values({
        hospitalId: args.hospitalId,
        doctorId: args.doctorId,
        serviceDate: args.serviceDate,
        slotTime: formattedTime,
        isAvailable: args.isAvailable,
        reason: args.reason ?? null,
      });
    }
  });
}

/**
 * Add emergency or temporary unavailability interval block.
 */
/**
 * Blocks a window WITHOUT touching anyone already booked inside it.
 *
 * Almost never what you want. This stops new bookings landing in the window
 * and does nothing else: patients already holding slots inside it keep a live
 * appointment, are told nothing, and travel to the hospital for a doctor who
 * has gone.
 *
 * Use `blockIntervalAndNotify` in lib/services/disruption.ts instead, which
 * cancels those bookings, messages the patients to rebook, and hands the ones
 * already in the waiting room to reception. This remains only for setting up
 * a window on a day with no bookings yet — a planned absence entered in
 * advance — where there is genuinely nobody to notify.
 */
export async function addIntervalBlock(args: {
  hospitalId: string;
  doctorId: string;
  serviceDate: string;
  startTime: string; // "13:00"
  endTime: string; // "14:30"
  reason?: string;
}) {
  return withTenant(args.hospitalId, async (tx) => {
    const sTime = args.startTime.length === 5 ? `${args.startTime}:00` : args.startTime;
    const eTime = args.endTime.length === 5 ? `${args.endTime}:00` : args.endTime;

    const [row] = await tx
      .insert(doctorIntervalBlocks)
      .values({
        hospitalId: args.hospitalId,
        doctorId: args.doctorId,
        serviceDate: args.serviceDate,
        startTime: sTime,
        endTime: eTime,
        reason: args.reason ?? 'Emergency / Temporary Unavailability',
        active: true,
      })
      .returning();

    return row;
  });
}

/**
 * Remove an interval block.
 */
export async function removeIntervalBlock(args: {
  hospitalId: string;
  doctorId: string;
  blockId: string;
}) {
  return withTenant(args.hospitalId, async (tx) => {
    await tx
      .delete(doctorIntervalBlocks)
      .where(
        and(
          eq(doctorIntervalBlocks.id, args.blockId),
          eq(doctorIntervalBlocks.doctorId, args.doctorId),
        ),
      );
  });
}

/**
 * Computes all generated appointment slots for a doctor on a specific date,
 * respecting working hours, break times, interval blocks, manual slot overrides, and existing bookings.
 */
export async function getDoctorSlotsForDate(args: {
  hospitalId: string;
  doctorId: string;
  serviceDate: string; // "YYYY-MM-DD"
  now?: Date;
}): Promise<{
  config: DoctorScheduleSettings;
  /** The day's sessions, earliest first. */
  sessions: DaySession[];
  slots: GeneratedSlot[];
  intervalBlocks: IntervalBlockItem[];
  overrides: SlotOverrideItem[];
  totalAvailable: number;
  onlineOpensAt?: Date | null;
  isOnlineOpen?: boolean;
}> {
  return withTenant(args.hospitalId, async (tx) => {
    // 1. Fetch doctor & hospital info
    const [doc] = await tx
      .select({
        id: doctors.id,
        name: doctors.name,
        specialty: doctors.specialty,
        defaultConsultMinutes: doctors.defaultConsultMinutes,
        onlineOpensMinutesBefore: doctors.onlineOpensMinutesBefore,
        timezone: hospitals.timezone,
      })
      .from(doctors)
      .innerJoin(hospitals, eq(hospitals.id, doctors.hospitalId))
      .where(and(eq(doctors.id, args.doctorId), eq(doctors.active, true)));

    if (!doc) {
      throw new Error('Doctor not found or inactive');
    }

    const timezone = doc.timezone ?? 'Asia/Kolkata';

    // 2. The day's sessions, or the classic default for a doctor with no schedule
    const rows = await loadScheduleRows(tx, args.doctorId);
    const config = scheduleSettings(doc, rows);
    const daySessions =
      rows.length > 0
        ? await loadDaySessionsInTx(tx, { doctorId: args.doctorId, serviceDate: args.serviceDate, timezone })
        : toDaySessions([config.sessions[0]], args.serviceDate, timezone);

    // 3. Fetch active interval blocks for date
    const rawBlocks = await tx
      .select()
      .from(doctorIntervalBlocks)
      .where(
        and(
          eq(doctorIntervalBlocks.doctorId, args.doctorId),
          eq(doctorIntervalBlocks.serviceDate, args.serviceDate),
          eq(doctorIntervalBlocks.active, true),
        ),
      );

    const intervalBlocks: IntervalBlockItem[] = rawBlocks.map((b) => ({
      id: b.id,
      serviceDate: b.serviceDate,
      startTime: b.startTime.slice(0, 5),
      endTime: b.endTime.slice(0, 5),
      reason: b.reason,
    }));

    // 4. Fetch slot overrides for date
    const rawOverrides = await tx
      .select()
      .from(doctorSlotOverrides)
      .where(
        and(
          eq(doctorSlotOverrides.doctorId, args.doctorId),
          eq(doctorSlotOverrides.serviceDate, args.serviceDate),
        ),
      );

    const overrides: SlotOverrideItem[] = rawOverrides.map((o) => ({
      id: o.id,
      serviceDate: o.serviceDate,
      slotTime: o.slotTime.slice(0, 5),
      isAvailable: o.isAvailable,
      reason: o.reason,
    }));

    const overridesMap = new Map<string, SlotOverrideItem>();
    overrides.forEach((o) => overridesMap.set(o.slotTime, o));

    // 5. Fetch booked appointments for date
    const existingApps = await tx
      .select({ scheduledSlotAt: appointments.scheduledSlotAt })
      .from(appointments)
      .where(
        and(
          eq(appointments.doctorId, args.doctorId),
          eq(appointments.serviceDate, args.serviceDate),
          sql`${appointments.scheduledSlotAt} is not null`,
          sql`${appointments.status} not in ('COMPLETED', 'CANCELLED', 'NO_SHOW', 'EXPIRED')`,
        ),
      );

    const bookedISOs = new Set(
      existingApps
        .map((a) => a.scheduledSlotAt?.toISOString())
        .filter((iso): iso is string => Boolean(iso)),
    );

    // 6. Generate raw slots. A split day offers slots only from the sessions
    // that take bookings; a single-session day keeps generating them from its
    // hours whatever the mode, as it always has.
    const bookable = daySessions.length > 1 ? daySessions.filter(takesSlots) : daySessions;
    const rawSlots = bookable.flatMap((session) =>
      generateRawSlots({
        startTime: session.startTime,
        endTime: session.endTime,
        slotMinutes: session.slotMinutes,
        breakStartTime: session.breakStartTime,
        breakEndTime: session.breakEndTime,
      }).map((slot) => ({ ...slot, ownList: runsOwnList(daySessions, session) })),
    );

    const now = args.now ?? new Date();
    const isToday = args.serviceDate === serviceDateIn(timezone, now);

    let onlineOpensAt: Date | null = null;
    let isOnlineOpen = true;

    if (isToday) {
      // A doctor with no schedule has no start time, so online is always open.
      const scheduledStartAt = rows.length > 0 ? dayStartAt(daySessions) : null;

      if (scheduledStartAt) {
        const opensMin = doc.onlineOpensMinutesBefore ?? 120;
        onlineOpensAt = new Date(scheduledStartAt.getTime() - opensMin * 60_000);
        isOnlineOpen = now.getTime() >= onlineOpensAt.getTime();
      }
    }

    const slots: GeneratedSlot[] = [];

    for (const s of rawSlots) {
      const slotMinutes = s.startMinutes;
      // In the hospital's timezone; this used to hard-code +05:30.
      const slotDate = zonedTimeToUtc(args.serviceDate, s.time24, timezone);
      const datetimeIso = slotDate.toISOString();

      let available = true;
      let reason: string | null = null;

      // Check if slot falls in a lunch/break
      if (s.isBreak) {
        available = false;
        reason = 'Lunch Break';
      }

      // Check interval blocks (e.g. Emergency 13:00 - 14:30)
      if (available) {
        for (const block of intervalBlocks) {
          const bStart = timeStringToMinutes(block.startTime);
          const bEnd = timeStringToMinutes(block.endTime);
          if (slotMinutes >= bStart && slotMinutes < bEnd) {
            available = false;
            reason = block.reason || 'Blocked Interval';
            break;
          }
        }
      }

      // Check manual slot override
      const override = overridesMap.get(s.time24);
      if (override) {
        if (!override.isAvailable) {
          available = false;
          reason = override.reason || 'Disabled';
        } else {
          // Explicitly re-enabled by doctor
          available = true;
          reason = null;
        }
      }

      // Check if already booked
      if (available && bookedISOs.has(datetimeIso)) {
        available = false;
        reason = 'Booked';
      }

      // Check past time if for today
      if (available && isToday && slotDate.getTime() < now.getTime()) {
        available = false;
        reason = 'Past Time';
      }

      // Check if same-day online booking is not open yet
      if (available && isToday && !isOnlineOpen && onlineOpensAt) {
        available = false;
        reason = `Online booking opens at ${formatTimeIn(timezone, onlineOpensAt)}`;
      }

      slots.push({
        timeStr: s.timeFormatted,
        time24: s.time24,
        datetimeIso,
        available,
        reason,
        slotNumber: s.ownList ? slotNumber(daySessions, slotDate) : null,
      });
    }

    const totalAvailable = slots.filter((s) => s.available).length;

    return {
      config,
      sessions: daySessions,
      slots,
      intervalBlocks,
      overrides,
      totalAvailable,
      onlineOpensAt,
      isOnlineOpen,
    };
  });
}

/**
 * The doctor's scheduled start for one service date — the single answer to
 * "when was OPD meant to begin?", used by the ETA and the online booking
 * window.
 *
 * An explicit start on the doctor-day row wins; otherwise the start of the
 * day's live-queue session (or its first session, on a slot-only day), with
 * one-off exceptions applied. Null when the doctor has no schedule at all, or
 * is closed that day — callers then behave as they did before start times
 * existed.
 */
export async function resolveScheduledStartInTx(
  tx: Tx,
  args: {
    doctorId: string;
    serviceDate: string;
    timezone: string;
    dayOverride?: Date | null;
  },
): Promise<Date | null> {
  if (args.dayOverride) return args.dayOverride;
  return dayStartAt(await loadDaySessionsInTx(tx, args));
}
