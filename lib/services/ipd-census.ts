import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { withTenant } from '@/lib/db';
import {
  admissions,
  bedAssignments,
  beds,
  branches,
  doctors,
  encounters,
  patients,
  wards,
} from '@/lib/db/schema';
import { compareBedLabels } from '@/lib/domain/ipd-config';
import type { AdmissionStatus } from '@/lib/domain/admission';

/**
 * Who is where: the reads behind the IPD home, the ward grids and the OPD
 * dashboard's "IPD · awaiting bed" badges (IPD plan §5.2, task T1.5).
 *
 * Admissions are clinical, so these run with the clinical key. They return
 * names, beds and statuses — never anything recorded at the bedside.
 */

export type IpdStatus = Exclude<AdmissionStatus, 'cancelled' | 'discharged'>;

/** Live admission status per OPD appointment, for the dashboard. Absent = not shifted. */
export async function getIpdStatusesForAppointments(
  hospitalId: string,
  appointmentIds: readonly string[],
): Promise<Record<string, IpdStatus>> {
  if (appointmentIds.length === 0) return {};
  const rows = await withTenant(
    hospitalId,
    (tx) =>
      tx
        .select({ appointmentId: encounters.appointmentId, status: admissions.status })
        .from(admissions)
        .innerJoin(encounters, eq(encounters.id, admissions.encounterId))
        .where(
          and(
            inArray(encounters.appointmentId, [...appointmentIds]),
            inArray(admissions.status, ['awaiting_bed', 'admitted', 'discharge_ready']),
          ),
        ),
    { clinical: true },
  );
  const statuses: Record<string, IpdStatus> = {};
  for (const row of rows) {
    if (row.appointmentId) statuses[row.appointmentId] = row.status as IpdStatus;
  }
  return statuses;
}

export type CensusPatient = {
  admissionId: string;
  patientId: string;
  patientName: string;
  age: number | null;
  gender: string | null;
  phoneE164: string;
  doctorName: string;
  status: IpdStatus;
  requestedAt: Date;
  admittedAt: Date | null;
  dischargeReadyAt: Date | null;
  reason: string | null;
  bed: { id: string; label: string; wardId: string; wardName: string } | null;
};

export type CensusBed = {
  id: string;
  label: string;
  occupant: CensusPatient | null;
};

export type CensusWard = {
  id: string;
  name: string;
  branchId: string;
  beds: CensusBed[];
  occupied: number;
};

export type IpdCensus = {
  awaitingBed: CensusPatient[];
  dischargeReady: CensusPatient[];
  /** Everyone in a bed, including those marked ready. */
  inBed: CensusPatient[];
  wards: CensusWard[];
};

/**
 * The whole IPD at a glance for one branch (or every branch). One clinical
 * transaction, four queries in parallel; wards and beds are small.
 */
export async function getIpdCensus(args: {
  hospitalId: string;
  branchId?: string | null;
}): Promise<IpdCensus> {
  return withTenant(
    args.hospitalId,
    async (tx) => {
      const branchFilter = args.branchId ? eq(admissions.branchId, args.branchId) : undefined;
      const wardBranchFilter = args.branchId ? eq(wards.branchId, args.branchId) : undefined;

      const [liveRows, currentBeds, wardRows, bedRows] = await Promise.all([
        tx
          .select({
            admissionId: admissions.id,
            patientId: patients.id,
            patientName: patients.name,
            age: patients.age,
            gender: patients.gender,
            phoneE164: patients.phoneE164,
            doctorName: doctors.name,
            status: admissions.status,
            requestedAt: admissions.requestedAt,
            admittedAt: admissions.admittedAt,
            dischargeReadyAt: admissions.dischargeReadyAt,
            reason: admissions.reason,
          })
          .from(admissions)
          .innerJoin(patients, eq(patients.id, admissions.patientId))
          .innerJoin(doctors, eq(doctors.id, admissions.admittingDoctorId))
          .where(
            and(
              inArray(admissions.status, ['awaiting_bed', 'admitted', 'discharge_ready']),
              branchFilter,
            ),
          )
          .orderBy(asc(admissions.requestedAt)),
        tx
          .select({
            admissionId: bedAssignments.admissionId,
            bedId: beds.id,
            bedLabel: beds.label,
            wardId: wards.id,
            wardName: wards.name,
          })
          .from(bedAssignments)
          .innerJoin(beds, eq(beds.id, bedAssignments.bedId))
          .innerJoin(wards, eq(wards.id, beds.wardId))
          .where(isNull(bedAssignments.toAt)),
        tx
          .select({ id: wards.id, name: wards.name, branchId: wards.branchId })
          .from(wards)
          .innerJoin(branches, eq(branches.id, wards.branchId))
          .where(and(eq(wards.active, true), wardBranchFilter))
          .orderBy(asc(wards.sortOrder), asc(wards.name)),
        tx
          .select({ id: beds.id, wardId: beds.wardId, label: beds.label, sortOrder: beds.sortOrder })
          .from(beds)
          .where(eq(beds.active, true)),
      ]);

      const bedByAdmission = new Map(currentBeds.map((row) => [row.admissionId, row]));
      const patientsList: CensusPatient[] = liveRows.map((row) => {
        const bed = bedByAdmission.get(row.admissionId);
        return {
          ...row,
          status: row.status as IpdStatus,
          bed: bed ? { id: bed.bedId, label: bed.bedLabel, wardId: bed.wardId, wardName: bed.wardName } : null,
        };
      });
      const occupantByBed = new Map(
        patientsList.filter((p) => p.bed).map((p) => [p.bed!.id, p] as const),
      );

      const wardsList: CensusWard[] = wardRows.map((ward) => {
        const wardBeds = bedRows
          .filter((bed) => bed.wardId === ward.id)
          .sort((a, b) => a.sortOrder - b.sortOrder || compareBedLabels(a.label, b.label))
          .map((bed) => ({ id: bed.id, label: bed.label, occupant: occupantByBed.get(bed.id) ?? null }));
        return {
          ...ward,
          beds: wardBeds,
          occupied: wardBeds.filter((bed) => bed.occupant).length,
        };
      });

      return {
        awaitingBed: patientsList.filter((p) => p.status === 'awaiting_bed'),
        dischargeReady: patientsList.filter((p) => p.status === 'discharge_ready'),
        inBed: patientsList.filter((p) => p.status !== 'awaiting_bed'),
        wards: wardsList,
      };
    },
    { clinical: true },
  );
}

/** Live counts for nav badges and the doctor's "Admitted (4)" link. */
export async function countAdmittedForDoctorUser(hospitalId: string, userId: string): Promise<number> {
  const [row] = await withTenant(
    hospitalId,
    (tx) =>
      tx
        .select({ count: sql<number>`count(*)::int` })
        .from(admissions)
        .innerJoin(doctors, eq(doctors.id, admissions.admittingDoctorId))
        .where(
          and(eq(doctors.userId, userId), inArray(admissions.status, ['admitted', 'discharge_ready'])),
        ),
    { clinical: true },
  );
  return row?.count ?? 0;
}
