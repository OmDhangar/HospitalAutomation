import { eq, sql } from 'drizzle-orm';
import type { Tx } from '@/lib/db';
import { appointments, encounters } from '@/lib/db/schema';

/**
 * The encounter is the spine of the patient record: one episode of care, which
 * the bill, the diagnoses, the notes and the prescriptions all hang off.
 *
 * It points at the queue appointment that started it; the appointment never
 * points back. That one-way link is what lets clinical and billing modules be
 * added without touching the queue, its state machine, or its notifications.
 *
 * Both billing (the Paid toggle) and the consultation screen open encounters,
 * which is why this lives in its own module rather than inside either.
 */

export type EncounterRow = typeof encounters.$inferSelect;

export class EncounterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EncounterError';
  }
}

/**
 * The encounter for a queue appointment, created on first use and locked for
 * the rest of the transaction.
 *
 * Creation is an insert that does nothing on conflict with the one-per-
 * appointment index, so two people opening the same visit at once both end up
 * with the same encounter. The row lock then serialises everything that
 * follows — the same way `doctor_day_states` serialises the queue.
 *
 * The appointment is read under row-level security, so an id from another
 * hospital is simply not found.
 */
export async function openEncounterForAppointmentInTx(
  tx: Tx,
  args: { appointmentId: string; actorUserId: string | null },
): Promise<EncounterRow> {
  const [appointment] = await tx
    .select({
      hospitalId: appointments.hospitalId,
      branchId: appointments.branchId,
      doctorId: appointments.doctorId,
      patientId: appointments.patientId,
    })
    .from(appointments)
    .where(eq(appointments.id, args.appointmentId));
  if (!appointment) throw new EncounterError('Appointment not found');

  await tx
    .insert(encounters)
    .values({
      hospitalId: appointment.hospitalId,
      branchId: appointment.branchId,
      patientId: appointment.patientId,
      appointmentId: args.appointmentId,
      attendingDoctorId: appointment.doctorId,
      origin: 'queue',
      openedByUserId: args.actorUserId,
    })
    .onConflictDoNothing({
      target: encounters.appointmentId,
      where: sql`appointment_id is not null`,
    });

  const [encounter] = await tx
    .select()
    .from(encounters)
    .where(eq(encounters.appointmentId, args.appointmentId))
    .for('update');
  return encounter;
}

/** An existing encounter by id, optionally locked. Not found reads the same as another hospital's. */
export async function getEncounterInTx(
  tx: Tx,
  encounterId: string,
  options: { lock?: boolean } = {},
): Promise<EncounterRow> {
  const query = tx.select().from(encounters).where(eq(encounters.id, encounterId));
  const [encounter] = options.lock ? await query.for('update') : await query;
  if (!encounter) throw new EncounterError('Visit not found');
  return encounter;
}
