import { and, asc, eq, gte, lte, sql } from 'drizzle-orm';
import { withTenant } from '@/lib/db';
import {
  appointments,
  doctorIntervalBlocks,
  doctors,
  doctorSchedules,
  doctorSlotOverrides,
  hospitals,
} from '@/lib/db/schema';

export type GeneratedSlot = {
  timeStr: string; // e.g. "10:00 AM"
  time24: string; // e.g. "10:00"
  datetimeIso: string; // UTC ISO string for booking
  available: boolean;
  reason?: string | null; // e.g. "Booked", "Lunch", "Emergency", "Personal", "Disabled"
};

export type DoctorScheduleSettings = {
  doctorId: string;
  doctorName: string;
  specialty: string | null;
  startTime: string; // "10:00"
  endTime: string; // "17:00"
  slotMinutes: number; // 10, 15, 20, 30, 45, 60
  breakStartTime: string | null; // "13:00"
  breakEndTime: string | null; // "14:00"
  mode: 'queue' | 'slot' | 'both';
};

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

    const [sched] = await tx
      .select({
        startTime: doctorSchedules.startTime,
        endTime: doctorSchedules.endTime,
        slotMinutes: doctorSchedules.slotMinutes,
        breakStartTime: doctorSchedules.breakStartTime,
        breakEndTime: doctorSchedules.breakEndTime,
        mode: doctorSchedules.mode,
      })
      .from(doctorSchedules)
      .where(eq(doctorSchedules.doctorId, args.doctorId))
      .orderBy(asc(doctorSchedules.createdAt))
      .limit(1);

    return {
      doctorId: doc.id,
      doctorName: doc.name,
      specialty: doc.specialty,
      startTime: sched?.startTime ? sched.startTime.slice(0, 5) : '10:00',
      endTime: sched?.endTime ? sched.endTime.slice(0, 5) : '17:00',
      slotMinutes: sched?.slotMinutes ?? doc.defaultConsultMinutes ?? 15,
      breakStartTime: sched?.breakStartTime ? sched.breakStartTime.slice(0, 5) : '13:00',
      breakEndTime: sched?.breakEndTime ? sched.breakEndTime.slice(0, 5) : '14:00',
      mode: (sched?.mode as 'queue' | 'slot' | 'both') ?? 'slot',
    };
  });
}

/**
 * Updates or creates doctor weekly schedule configuration.
 */
export async function saveDoctorScheduleConfig(args: {
  hospitalId: string;
  doctorId: string;
  startTime: string;
  endTime: string;
  slotMinutes: number;
  breakStartTime?: string | null;
  breakEndTime?: string | null;
  mode?: 'queue' | 'slot' | 'both';
}) {
  const today = new Date().toISOString().slice(0, 10);
  return withTenant(args.hospitalId, async (tx) => {
    // Delete existing weekly schedule for doctor and re-insert
    await tx.delete(doctorSchedules).where(eq(doctorSchedules.doctorId, args.doctorId));

    // Insert for all weekdays (0 to 6)
    const values = [0, 1, 2, 3, 4, 5, 6].map((dow) => ({
      hospitalId: args.hospitalId,
      doctorId: args.doctorId,
      weekday: dow,
      mode: args.mode ?? 'slot',
      startTime: args.startTime,
      endTime: args.endTime,
      slotMinutes: args.slotMinutes,
      breakStartTime: args.breakStartTime || null,
      breakEndTime: args.breakEndTime || null,
      effectiveFrom: today,
    }));

    await tx.insert(doctorSchedules).values(values);

    // Also update doctors.defaultConsultMinutes
    await tx
      .update(doctors)
      .set({ defaultConsultMinutes: args.slotMinutes })
      .where(eq(doctors.id, args.doctorId));
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
}): Promise<{
  config: DoctorScheduleSettings;
  slots: GeneratedSlot[];
  intervalBlocks: IntervalBlockItem[];
  overrides: SlotOverrideItem[];
  totalAvailable: number;
}> {
  return withTenant(args.hospitalId, async (tx) => {
    // 1. Fetch doctor & hospital info
    const [doc] = await tx
      .select({
        id: doctors.id,
        name: doctors.name,
        specialty: doctors.specialty,
        defaultConsultMinutes: doctors.defaultConsultMinutes,
        timezone: hospitals.timezone,
      })
      .from(doctors)
      .innerJoin(hospitals, eq(hospitals.id, doctors.hospitalId))
      .where(and(eq(doctors.id, args.doctorId), eq(doctors.active, true)));

    if (!doc) {
      throw new Error('Doctor not found or inactive');
    }

    const timezone = doc.timezone ?? 'Asia/Kolkata';

    // 2. Fetch weekly schedule or defaults
    const [sched] = await tx
      .select({
        startTime: doctorSchedules.startTime,
        endTime: doctorSchedules.endTime,
        slotMinutes: doctorSchedules.slotMinutes,
        breakStartTime: doctorSchedules.breakStartTime,
        breakEndTime: doctorSchedules.breakEndTime,
        mode: doctorSchedules.mode,
      })
      .from(doctorSchedules)
      .where(eq(doctorSchedules.doctorId, args.doctorId))
      .orderBy(asc(doctorSchedules.createdAt))
      .limit(1);

    const config: DoctorScheduleSettings = {
      doctorId: doc.id,
      doctorName: doc.name,
      specialty: doc.specialty,
      startTime: sched?.startTime ? sched.startTime.slice(0, 5) : '10:00',
      endTime: sched?.endTime ? sched.endTime.slice(0, 5) : '17:00',
      slotMinutes: sched?.slotMinutes ?? doc.defaultConsultMinutes ?? 15,
      breakStartTime: sched?.breakStartTime ? sched.breakStartTime.slice(0, 5) : '13:00',
      breakEndTime: sched?.breakEndTime ? sched.breakEndTime.slice(0, 5) : '14:00',
      mode: (sched?.mode as 'queue' | 'slot' | 'both') ?? 'slot',
    };

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
          sql`${appointments.status} not in ('CANCELLED', 'NO_SHOW')`,
        ),
      );

    const bookedISOs = new Set(
      existingApps
        .map((a) => a.scheduledSlotAt?.toISOString())
        .filter((iso): iso is string => Boolean(iso)),
    );

    // 6. Generate base raw slots
    const rawSlots = generateRawSlots({
      startTime: config.startTime,
      endTime: config.endTime,
      slotMinutes: config.slotMinutes,
      breakStartTime: config.breakStartTime,
      breakEndTime: config.breakEndTime,
    });

    const dateParts = args.serviceDate.split('-').map(Number); // YYYY, MM, DD
    const now = new Date();

    const slots: GeneratedSlot[] = [];

    for (const s of rawSlots) {
      const slotMinutes = s.startMinutes;
      const h = Math.floor(slotMinutes / 60);
      const m = slotMinutes % 60;

      // Construct UTC date matching local timezone offset (Asia/Kolkata is +05:30)
      const slotDate = new Date(
        Date.UTC(dateParts[0], dateParts[1] - 1, dateParts[2], h - 5, m - 30),
      );
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
      if (available && slotDate.getTime() < now.getTime()) {
        available = false;
        reason = 'Past Time';
      }

      slots.push({
        timeStr: s.timeFormatted,
        time24: s.time24,
        datetimeIso,
        available,
        reason,
      });
    }

    const totalAvailable = slots.filter((s) => s.available).length;

    return {
      config,
      slots,
      intervalBlocks,
      overrides,
      totalAvailable,
    };
  });
}
