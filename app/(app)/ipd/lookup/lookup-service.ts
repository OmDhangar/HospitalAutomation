import { withTenant } from '@/lib/db';
import { admissions, patients } from '@/lib/db/schema';
import { and, desc, eq, inArray } from 'drizzle-orm';

export interface ResolveLookupRedirectArgs {
  hospitalId: string;
  uhid?: string | null;
  patientId?: string | null;
}

export async function resolveLookupRedirect(
  args: ResolveLookupRedirectArgs,
): Promise<string> {
  const { hospitalId, uhid, patientId } = args;

  if (!uhid && !patientId) {
    return '/ipd?error=Missing+lookup+identifier';
  }

  return withTenant(hospitalId, async (tx) => {
    let patientRecord: { id: string } | undefined;

    if (patientId) {
      const [p] = await tx
        .select({ id: patients.id })
        .from(patients)
        .where(and(eq(patients.hospitalId, hospitalId), eq(patients.id, patientId)))
        .limit(1);
      patientRecord = p;
    } else if (uhid) {
      const [p] = await tx
        .select({ id: patients.id })
        .from(patients)
        .where(and(eq(patients.hospitalId, hospitalId), eq(patients.mrn, uhid.trim())))
        .limit(1);
      patientRecord = p;
    }

    if (!patientRecord) {
      return '/ipd?error=Patient+not+found';
    }

    // Find active admission for this patient
    const [activeAdmission] = await tx
      .select({ id: admissions.id })
      .from(admissions)
      .where(
        and(
          eq(admissions.hospitalId, hospitalId),
          eq(admissions.patientId, patientRecord.id),
          inArray(admissions.status, ['awaiting_bed', 'admitted', 'discharge_ready']),
        ),
      )
      .orderBy(desc(admissions.admittedAt), desc(admissions.createdAt))
      .limit(1);

    if (activeAdmission) {
      return `/ipd/patients/${activeAdmission.id}/summary`;
    }

    // Fallback to latest admission if readmitted or discharged
    const [latestAdmission] = await tx
      .select({ id: admissions.id })
      .from(admissions)
      .where(
        and(
          eq(admissions.hospitalId, hospitalId),
          eq(admissions.patientId, patientRecord.id),
        ),
      )
      .orderBy(desc(admissions.createdAt))
      .limit(1);

    if (latestAdmission) {
      return `/ipd/patients/${latestAdmission.id}/summary`;
    }

    return '/ipd?error=No+admission+records+found+for+patient';
  });
}
