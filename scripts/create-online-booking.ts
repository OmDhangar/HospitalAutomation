import 'dotenv/config';
import { getAdminDb, closeAdminDb } from '@/lib/db/admin';
import { doctors, hospitals, appointments, doctorDayStates, patients } from '@/lib/db/schema';
import { eq, ilike, and } from 'drizzle-orm';
import { getDoctorBookingDetails, bookScheduledSlot } from '@/lib/services/web-booking';
import { getPublicQueueView, getQueueSnapshot } from '@/lib/services/queue';
import { serviceDateIn } from '@/lib/domain/time';

/**
 * Creates an online appointment booking on the local database for testing.
 *
 * Usage:
 *   npx tsx scripts/create-online-booking.ts [doctor_search] [patient_name] [phone] [slot_time]
 *
 * Examples:
 *   npx tsx scripts/create-online-booking.ts
 *   npx tsx scripts/create-online-booking.ts "Amit" "Rahul Sharma" "+919876543210"
 *   npx tsx scripts/create-online-booking.ts "Amit" "Pooja Verma" "+919876543211" "9:40 PM"
 */
async function main() {
  const doctorQuery = process.argv[2] || 'Amit';
  const patientName = process.argv[3] || 'Test Patient (Online)';
  const phoneE164 = process.argv[4] || '+919876543210';
  const requestedSlotTime = process.argv[5] || null;

  const db = getAdminDb();

  // Find doctor
  const [doc] = await db
    .select({
      id: doctors.id,
      name: doctors.name,
      specialty: doctors.specialty,
      hospitalId: doctors.hospitalId,
      branchId: doctors.branchId,
      dailyTokenQuota: doctors.dailyTokenQuota,
      walkInReserved: doctors.walkInReserved,
      onlineOpensMinutesBefore: doctors.onlineOpensMinutesBefore,
      walkInReleaseMinutes: doctors.walkInReleaseMinutes,
      defaultConsultMinutes: doctors.defaultConsultMinutes,
      active: doctors.active,
    })
    .from(doctors)
    .where(and(ilike(doctors.name, `%${doctorQuery}%`), eq(doctors.active, true)))
    .limit(1);

  if (!doc) {
    console.error(`No active doctor found matching "${doctorQuery}".`);
    const all = await db.select({ name: doctors.name }).from(doctors).where(eq(doctors.active, true));
    console.log('Available active doctors:', all.map((d) => d.name));
    process.exit(1);
  }

  const [hospital] = await db.select().from(hospitals).where(eq(hospitals.id, doc.hospitalId));
  const timezone = hospital?.timezone ?? 'Asia/Kolkata';
  const serviceDate = serviceDateIn(timezone, new Date());

  console.log(`\n======================================================`);
  console.log(`DOCTOR: ${doc.name} (${doc.specialty ?? 'General'})`);
  console.log(`Hospital: ${hospital?.name ?? 'Unknown'} | Date: ${serviceDate}`);
  console.log(`Quota: ${doc.dailyTokenQuota ?? 'None'} (Reserved Walk-in: ${doc.walkInReserved})`);
  console.log(`======================================================`);

  const bookingDetails = await getDoctorBookingDetails({
    hospitalId: doc.hospitalId,
    doctorId: doc.id,
    serviceDate,
  });

  if (!bookingDetails || bookingDetails.slots.length === 0) {
    console.error(`No booking schedules found for ${doc.name} on ${serviceDate}.`);
    process.exit(1);
  }

  const availableSlots = bookingDetails.slots.filter((s) => s.available);
  console.log(`\nTotal slots today: ${bookingDetails.slots.length}`);
  console.log(`Available slots (${availableSlots.length}):`, availableSlots.map((s) => s.timeStr).join(', '));

  if (availableSlots.length === 0) {
    console.error('All slots for today are currently booked or past.');
    process.exit(1);
  }

  let chosenSlot = availableSlots[0];
  if (requestedSlotTime) {
    const match = availableSlots.find((s) => s.timeStr.toLowerCase() === requestedSlotTime.toLowerCase());
    if (match) {
      chosenSlot = match;
    } else {
      console.warn(`Requested slot "${requestedSlotTime}" not available. Using first available: ${chosenSlot.timeStr}`);
    }
  }

  console.log(`\nBooking slot: ${chosenSlot.timeStr} (${chosenSlot.datetimeIso})`);
  console.log(`Patient: ${patientName} | Phone: ${phoneE164}`);

  const bookingResult = await bookScheduledSlot({
    hospitalId: doc.hospitalId,
    doctorId: doc.id,
    patientName,
    patientAge: 30,
    gender: 'M',
    phoneE164,
    slotDatetimeIso: chosenSlot.datetimeIso,
    locale: 'en',
  });

  console.log(`\n======================================================`);
  console.log(`BOOKING CONFIRMED`);
  console.log(`======================================================`);
  console.log(`Token Number: #${bookingResult.tokenNumber} (Pool: ${bookingResult.appointment.quotaPool})`);
  console.log(`Scheduled Slot: ${bookingResult.slotTimeFormatted}`);
  console.log(`Status: ${bookingResult.appointment.status}`);
  console.log(`Appointment ID: ${bookingResult.appointment.id}`);

  console.log(`\nPatient Live Queue URL: http://localhost:3000/q/${bookingResult.publicToken}`);
  console.log(`Doctor Booking Page: http://localhost:3000/book?doctor=${doc.id}&hospital=${doc.hospitalId}`);
  console.log(`Hospital Dashboard: http://localhost:3000/dashboard`);

  // Inspect Public Queue View
  const publicView = await getPublicQueueView(bookingResult.publicToken);
  if (publicView) {
    console.log(`\n--- Queue Status for Patient ---`);
    console.log(`Patients Ahead: ${publicView.patientsAhead}`);
    console.log(`ETA State: ${publicView.etaState}`);
    if (publicView.eta) {
      console.log(`Estimated Window: ${publicView.eta.windowStart.toLocaleTimeString()} - ${publicView.eta.windowEnd.toLocaleTimeString()}`);
    }
    console.log(`Arrival Check-In: ${publicView.status === 'ARRIVED' ? 'Arrived' : 'Pending (can check in via URL)'}`);
  }

  await closeAdminDb();
}

main().catch(async (err) => {
  console.error('\nError creating booking:', err);
  await closeAdminDb();
  process.exit(1);
});
