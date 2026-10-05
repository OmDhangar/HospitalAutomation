import { and, eq } from 'drizzle-orm';
import type { Tx } from '@/lib/db';
import { doctorDayStates } from '@/lib/db/schema';

/**
 * Creates the doctor-day row if today is its first appointment, then takes a
 * row-level lock on it.
 *
 * Every queue and capacity mutation goes through here first. Concurrent
 * writers serialise on this single row, which is what makes two receptionists
 * pressing Next at the same moment, two patients taking the last token, or a
 * check-in racing a call, safe without any application-level locking.
 */
export async function lockDoctorDay(
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

export type DoctorDayState = Awaited<ReturnType<typeof lockDoctorDay>>;
