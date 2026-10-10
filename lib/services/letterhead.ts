import { and, asc, eq } from 'drizzle-orm';
import { withTenant } from '@/lib/db';
import { auditLogs, branches, doctors, hospitals } from '@/lib/db/schema';
import { parseDoctorLetterhead, parseHospitalLetterhead, type Letterhead } from '@/lib/domain/letterhead';

/** The text letterhead (lib/domain/letterhead.ts): read for printing, edited in Settings → Letterhead. */

export type LetterheadSettings = {
  hospitalName: string;
  registrationNo: string | null;
  phones: string | null;
  branches: { id: string; name: string; address: string | null }[];
  doctors: {
    id: string;
    name: string;
    qualification: string | null;
    registrationNo: string | null;
    onLetterhead: boolean;
    hasLogin: boolean;
    active: boolean;
  }[];
};

export async function getLetterheadSettings(hospitalId: string): Promise<LetterheadSettings> {
  return withTenant(hospitalId, async (tx) => {
    const [[hospital], branchRows, doctorRows] = await Promise.all([
      tx
        .select({ name: hospitals.name, registrationNo: hospitals.registrationNo, phones: hospitals.letterheadPhones })
        .from(hospitals)
        .where(eq(hospitals.id, hospitalId)),
      tx
        .select({ id: branches.id, name: branches.name, address: branches.address })
        .from(branches)
        .where(and(eq(branches.hospitalId, hospitalId), eq(branches.active, true)))
        .orderBy(asc(branches.name)),
      tx
        .select({
          id: doctors.id,
          name: doctors.name,
          qualification: doctors.qualification,
          registrationNo: doctors.registrationNo,
          onLetterhead: doctors.onLetterhead,
          userId: doctors.userId,
          active: doctors.active,
        })
        .from(doctors)
        .where(eq(doctors.hospitalId, hospitalId))
        .orderBy(asc(doctors.name)),
    ]);
    return {
      hospitalName: hospital.name,
      registrationNo: hospital.registrationNo,
      phones: hospital.phones,
      branches: branchRows,
      doctors: doctorRows.map(({ userId, ...doctor }) => ({ ...doctor, hasLogin: userId !== null })),
    };
  });
}

/** What prints at the top of a sheet for a patient of this branch. */
export async function getLetterhead(hospitalId: string, branchId: string | null): Promise<Letterhead> {
  const settings = await getLetterheadSettings(hospitalId);
  const branch = settings.branches.find((b) => b.id === branchId) ?? settings.branches[0] ?? null;
  return {
    hospitalName: settings.hospitalName,
    branchName: settings.branches.length > 1 ? (branch?.name ?? null) : null,
    address: branch?.address ?? null,
    phones: settings.phones,
    registrationNo: settings.registrationNo,
    doctors: settings.doctors
      .filter((d) => d.onLetterhead && d.active)
      .map(({ name, qualification, registrationNo }) => ({ name, qualification, registrationNo })),
  };
}

export async function updateHospitalLetterhead(args: {
  hospitalId: string;
  registrationNo?: string;
  phones?: string;
  actorUserId: string;
}): Promise<void> {
  const input = parseHospitalLetterhead(args);
  await withTenant(args.hospitalId, async (tx) => {
    await tx
      .update(hospitals)
      .set({ registrationNo: input.registrationNo, letterheadPhones: input.phones, updatedAt: new Date() })
      .where(eq(hospitals.id, args.hospitalId));
    await tx.insert(auditLogs).values({
      hospitalId: args.hospitalId,
      actorUserId: args.actorUserId,
      action: 'letterhead.hospital_updated',
      objectType: 'hospital',
      objectId: args.hospitalId,
      metadata: input,
    });
  });
}

export async function updateDoctorLetterhead(args: {
  hospitalId: string;
  doctorId: string;
  qualification?: string;
  registrationNo?: string;
  onLetterhead?: boolean;
  actorUserId: string;
}): Promise<void> {
  const input = parseDoctorLetterhead(args);
  await withTenant(args.hospitalId, async (tx) => {
    const updated = await tx
      .update(doctors)
      .set(input)
      .where(and(eq(doctors.id, args.doctorId), eq(doctors.hospitalId, args.hospitalId)))
      .returning({ id: doctors.id });
    if (updated.length === 0) throw new Error('doctor not found');
    await tx.insert(auditLogs).values({
      hospitalId: args.hospitalId,
      actorUserId: args.actorUserId,
      action: 'letterhead.doctor_updated',
      objectType: 'doctor',
      objectId: args.doctorId,
      metadata: input,
    });
  });
}
