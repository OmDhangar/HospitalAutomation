import { and, asc, eq } from 'drizzle-orm';
import { withTenant } from '@/lib/db';
import { branches, doctors, hospitals } from '@/lib/db/schema';

export async function listDoctors(args: { hospitalId: string; branchId?: string | null }) {
  return withTenant(args.hospitalId, (tx) =>
    tx
      .select({
        id: doctors.id,
        name: doctors.name,
        specialty: doctors.specialty,
        branchId: doctors.branchId,
        branchName: branches.name,
        defaultConsultMinutes: doctors.defaultConsultMinutes,
      })
      .from(doctors)
      .innerJoin(branches, eq(branches.id, doctors.branchId))
      .where(
        args.branchId
          ? and(eq(doctors.active, true), eq(doctors.branchId, args.branchId))
          : eq(doctors.active, true),
      )
      .orderBy(asc(doctors.name)),
  );
}

export async function getHospital(hospitalId: string) {
  return withTenant(hospitalId, async (tx) => {
    const [row] = await tx.select().from(hospitals).where(eq(hospitals.id, hospitalId));
    return row ?? null;
  });
}

export async function createBranch(args: {
  hospitalId: string;
  name: string;
  address?: string;
}) {
  return withTenant(args.hospitalId, async (tx) => {
    const [row] = await tx
      .insert(branches)
      .values({ hospitalId: args.hospitalId, name: args.name, address: args.address })
      .returning();
    return row;
  });
}

export async function createDoctor(args: {
  hospitalId: string;
  branchId: string;
  name: string;
  specialty?: string;
  defaultConsultMinutes?: number;
}) {
  return withTenant(args.hospitalId, async (tx) => {
    const [row] = await tx
      .insert(doctors)
      .values({
        hospitalId: args.hospitalId,
        branchId: args.branchId,
        name: args.name,
        specialty: args.specialty,
        defaultConsultMinutes: args.defaultConsultMinutes ?? 10,
      })
      .returning();
    return row;
  });
}

/**
 * Connects a hospital to its WhatsApp number.
 *
 * `whatsappPhoneNumberId` is Meta's id for the number, not the number itself —
 * it is what inbound webhooks carry, and the only thing that tells us which
 * tenant a message belongs to.
 */
export async function updateWhatsAppSettings(args: {
  hospitalId: string;
  whatsappPhoneNumberId: string | null;
  ownerPhoneE164: string | null;
}) {
  return withTenant(args.hospitalId, (tx) =>
    tx
      .update(hospitals)
      .set({
        whatsappPhoneNumberId: args.whatsappPhoneNumberId,
        ownerPhoneE164: args.ownerPhoneE164,
        updatedAt: new Date(),
      })
      .where(eq(hospitals.id, args.hospitalId)),
  );
}

export async function setDoctorActive(args: {
  hospitalId: string;
  doctorId: string;
  active: boolean;
}) {
  return withTenant(args.hospitalId, (tx) =>
    tx.update(doctors).set({ active: args.active }).where(eq(doctors.id, args.doctorId)),
  );
}
