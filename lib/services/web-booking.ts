import { and, asc, eq, gte, lte, sql } from 'drizzle-orm';
import { withTenant } from '@/lib/db';
import {
  appointments,
  branches,
  doctorDayStates,
  doctors,
  hospitals,
  notificationOutbox,
  patients,
  queueEvents,
} from '@/lib/db/schema';
import { generatePublicToken } from '@/lib/security/tokens';
import { formatTimeIn, serviceDateIn } from '@/lib/domain/time';
import type { Locale } from '@/lib/i18n/patient';
import { getProvider } from '@/lib/notify/provider';

export type TimeSlot = {
  timeStr: string;
  datetimeIso: string;
  available: boolean;
};

export type DoctorBookingDetails = {
  doctor: {
    id: string;
    name: string;
    specialty: string | null;
    defaultConsultMinutes: number;
  };
  branch: {
    id: string;
    name: string;
    address: string | null;
  };
  hospital: {
    id: string;
    name: string;
    timezone: string;
  };
  serviceDate: string;
  slots: TimeSlot[];
};

/**
 * Returns doctor info, hospital branch details, and available slots for booking.
 */
export async function getDoctorBookingDetails(args: {
  hospitalId: string;
  doctorId: string;
}): Promise<DoctorBookingDetails | null> {
  return withTenant(args.hospitalId, async (tx) => {
    const [row] = await tx
      .select({
        doctorId: doctors.id,
        doctorName: doctors.name,
        doctorSpecialty: doctors.specialty,
        doctorConsultMinutes: doctors.defaultConsultMinutes,
        branchId: branches.id,
        branchName: branches.name,
        branchAddress: branches.address,
        hospitalId: hospitals.id,
        hospitalName: hospitals.name,
        timezone: hospitals.timezone,
      })
      .from(doctors)
      .innerJoin(branches, eq(branches.id, doctors.branchId))
      .innerJoin(hospitals, eq(hospitals.id, doctors.hospitalId))
      .where(and(eq(doctors.id, args.doctorId), eq(doctors.active, true)));

    if (!row) return null;

    const timezone = row.timezone ?? 'Asia/Kolkata';
    const now = new Date();
    const serviceDate = serviceDateIn(timezone, now);

    // Existing scheduled appointments for this doctor today
    const existing = await tx
      .select({
        scheduledSlotAt: appointments.scheduledSlotAt,
      })
      .from(appointments)
      .where(
        and(
          eq(appointments.doctorId, args.doctorId),
          eq(appointments.serviceDate, serviceDate),
          sql`${appointments.scheduledSlotAt} is not null`,
          sql`${appointments.status} not in ('CANCELLED', 'NO_SHOW')`,
        ),
      );

    const bookedTimes = new Set(
      existing
        .map((e) => e.scheduledSlotAt?.toISOString())
        .filter((iso): iso is string => Boolean(iso)),
    );

    // Generate standard slots for today: morning session (10:00 to 13:00) and evening session (16:00 to 20:00)
    // using the doctor's default consultation interval (or 20 mins)
    const slotInterval = Math.max(row.doctorConsultMinutes || 15, 15);
    const slots: TimeSlot[] = [];

    const slotHours = [
      { startH: 10, startM: 0, endH: 13, endM: 0 },
      { startH: 16, startM: 0, endH: 20, endM: 0 },
    ];

    const todayDateParts = serviceDate.split('-').map(Number); // [YYYY, MM, DD]

    for (const session of slotHours) {
      let curMinutes = session.startH * 60 + session.startM;
      const endMinutes = session.endH * 60 + session.endM;

      while (curMinutes < endMinutes) {
        const h = Math.floor(curMinutes / 60);
        const m = curMinutes % 60;

        // Construct slot date in UTC based on Kolkata (+05:30) offset
        const slotDate = new Date(
          Date.UTC(todayDateParts[0], todayDateParts[1] - 1, todayDateParts[2], h - 5, m - 30),
        );

        const iso = slotDate.toISOString();
        const timeStr = formatTimeIn(timezone, slotDate);
        // Only mark available if it's at least 15 minutes in the future and not already booked
        const isPast = slotDate.getTime() < now.getTime() + 10 * 60 * 1000;
        const available = !isPast && !bookedTimes.has(iso);

        slots.push({
          timeStr,
          datetimeIso: iso,
          available,
        });

        curMinutes += slotInterval;
      }
    }

    return {
      doctor: {
        id: row.doctorId,
        name: row.doctorName,
        specialty: row.doctorSpecialty,
        defaultConsultMinutes: row.doctorConsultMinutes,
      },
      branch: {
        id: row.branchId,
        name: row.branchName,
        address: row.branchAddress,
      },
      hospital: {
        id: row.hospitalId,
        name: row.hospitalName,
        timezone,
      },
      serviceDate,
      slots,
    };
  });
}

/**
 * Creates an appointment for a scheduled slot and notifies the doctor/hospital.
 */
export async function bookScheduledSlot(args: {
  hospitalId: string;
  doctorId: string;
  patientName: string;
  phoneE164: string;
  slotDatetimeIso: string;
  locale?: Locale;
}) {
  const slotDate = new Date(args.slotDatetimeIso);
  if (isNaN(slotDate.getTime())) {
    throw new Error('Invalid slot date');
  }

  const now = new Date();

  return withTenant(args.hospitalId, async (tx) => {
    const [doctor] = await tx
      .select({
        id: doctors.id,
        name: doctors.name,
        branchId: doctors.branchId,
        hospitalId: doctors.hospitalId,
      })
      .from(doctors)
      .where(and(eq(doctors.id, args.doctorId), eq(doctors.active, true)));

    if (!doctor) {
      throw new Error('Doctor not found or inactive');
    }

    const [hospital] = await tx
      .select({
        id: hospitals.id,
        name: hospitals.name,
        timezone: hospitals.timezone,
        ownerPhoneE164: hospitals.ownerPhoneE164,
      })
      .from(hospitals)
      .where(eq(hospitals.id, args.hospitalId));

    const timezone = hospital?.timezone ?? 'Asia/Kolkata';
    const serviceDate = serviceDateIn(timezone, slotDate);

    // Upsert patient
    const [patient] = await tx
      .insert(patients)
      .values({
        hospitalId: args.hospitalId,
        phoneE164: args.phoneE164,
        name: args.patientName.trim(),
        locale: args.locale ?? 'en',
        whatsappOptInAt: now,
      })
      .onConflictDoUpdate({
        target: [patients.hospitalId, patients.phoneE164],
        set: {
          name: args.patientName.trim(),
          updatedAt: now,
          whatsappOptInAt: sql`coalesce(${patients.whatsappOptInAt}, excluded.whatsapp_opt_in_at)`,
        },
      })
      .returning();

    // Lock and get lastTokenNumber
    const [existingDay] = await tx
      .select()
      .from(doctorDayStates)
      .where(
        and(
          eq(doctorDayStates.doctorId, doctor.id),
          eq(doctorDayStates.serviceDate, serviceDate),
        ),
      )
      .for('update');

    let tokenNumber = 1;
    if (existingDay) {
      tokenNumber = existingDay.lastTokenNumber + 1;
      await tx
        .update(doctorDayStates)
        .set({ lastTokenNumber: tokenNumber, updatedAt: now })
        .where(eq(doctorDayStates.id, existingDay.id));
    } else {
      await tx.insert(doctorDayStates).values({
        hospitalId: args.hospitalId,
        doctorId: doctor.id,
        serviceDate,
        lastTokenNumber: tokenNumber,
        scheduledStartAt: slotDate,
      });
    }

    const publicToken = generatePublicToken();
    const publicTokenExpiresAt = new Date(slotDate.getTime() + 18 * 60 * 60 * 1000);

    const [appointment] = await tx
      .insert(appointments)
      .values({
        hospitalId: args.hospitalId,
        branchId: doctor.branchId,
        doctorId: doctor.id,
        patientId: patient.id,
        serviceDate,
        tokenNumber,
        status: 'WAITING',
        source: 'whatsapp',
        publicToken,
        publicTokenExpiresAt,
        scheduledSlotAt: slotDate,
        enqueuedAt: now,
      })
      .returning();

    const slotTimeFormatted = formatTimeIn(timezone, slotDate);

    // Record queue event
    await tx.insert(queueEvents).values({
      hospitalId: args.hospitalId,
      appointmentId: appointment.id,
      doctorId: doctor.id,
      action: 'enqueue',
      fromStatus: 'CREATED',
      toStatus: 'WAITING',
      actorUserId: null,
      metadata: {
        scheduledSlotAt: slotDate.toISOString(),
        slotTime: slotTimeFormatted,
        source: 'web_slot_booking',
      },
    });

    // Notify doctor / hospital owner if a phone number is configured
    const provider = getProvider();
    if (hospital?.ownerPhoneE164) {
      try {
        await provider.sendText({
          phoneNumberId: 'system',
          toPhoneE164: hospital.ownerPhoneE164,
          body: `📅 New appointment scheduled: ${patient.name} (${patient.phoneE164}) with Dr. ${doctor.name} today at ${slotTimeFormatted}.`,
        });
      } catch (err) {
        console.warn('Failed to send doctor notification:', err);
      }
    }

    // Queue confirmation link for patient
    await tx
      .insert(notificationOutbox)
      .values({
        hospitalId: args.hospitalId,
        appointmentId: appointment.id,
        patientId: patient.id,
        milestone: 'queue_link',
        templateCode: 'queue_link',
        locale: patient.locale ?? 'en',
        payload: { tokenNumber, publicToken, slotTime: slotTimeFormatted },
      })
      .onConflictDoNothing();

    return {
      appointment,
      tokenNumber,
      publicToken,
      slotTimeFormatted,
      doctorName: doctor.name,
      patientName: patient.name,
    };
  });
}
