import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { withTenant } from '@/lib/db';
import {
  admissions,
  bedAssignments,
  beds,
  branches,
  doctors,
  encounterPayers,
  encounters,
  patientConsents,
  patientContacts,
  patientPayments,
  patients,
  wards,
} from '@/lib/db/schema';
import { compareBedLabels } from '@/lib/domain/ipd-config';
import type { AdmissionStatus } from '@/lib/domain/admission';

export class BedCleaningInProgressError extends Error {
  constructor(message = 'Bed is currently undergoing housekeeping sanitization. Mark as cleaned before assigning.') {
    super(message);
    this.name = 'BedCleaningInProgressError';
  }
}

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
  urgency?: 'emergency' | 'same_day' | 'planned' | null;
  advisedWardKind?: 'general' | 'special' | 'hdu' | 'icu' | null;
  estimatedStayDays?: number | null;
  receptionNotes?: string | null;
  bed: { id: string; label: string; wardId: string; wardName: string } | null;
};

const urgencyRank: Record<string, number> = {
  emergency: 0,
  same_day: 1,
  planned: 2,
};

export function sortAwaitingBedByUrgency(patients: CensusPatient[]): CensusPatient[] {
  return [...patients].sort((a, b) => {
    const rankA = urgencyRank[a.urgency ?? 'same_day'] ?? 1;
    const rankB = urgencyRank[b.urgency ?? 'same_day'] ?? 1;
    if (rankA !== rankB) return rankA - rankB;
    return new Date(a.requestedAt).getTime() - new Date(b.requestedAt).getTime();
  });
}

export type CensusBed = {
  id: string;
  label: string;
  status: 'vacant' | 'occupied' | 'cleaning' | 'maintenance';
  occupant: CensusPatient | null;
  cleanedAt?: Date | null;
};

export async function assertBedAvailableForAdmission(
  hospitalId: string,
  bedId: string,
  executorDb?: any,
): Promise<void> {
  const check = (bed: any) => {
    if (!bed) throw new Error('Bed not found');
    if (bed.status === 'cleaning') {
      throw new BedCleaningInProgressError(
        `Bed ${bed.label} is currently in cleaning status. Housekeeping must sanitize and mark bed cleaned before admitting a patient.`,
      );
    }
  };

  if (executorDb?.query?.beds) {
    const bed = await executorDb.query.beds.findFirst({
      where: and(eq(beds.id, bedId), eq(beds.hospitalId, hospitalId)),
    });
    check(bed);
  } else {
    await withTenant(hospitalId, async (tx) => {
      const bed = await tx.query.beds.findFirst({
        where: and(eq(beds.id, bedId), eq(beds.hospitalId, hospitalId)),
      });
      check(bed);
    });
  }
}

export async function markBedCleaned(
  hospitalId: string,
  bedId: string,
  userId?: string,
  executorDb?: any,
): Promise<{ ok: boolean }> {
  const now = new Date();
  const updateData = {
    status: 'vacant' as const,
    cleanedAt: now,
    cleanedByUserId: userId ?? null,
  };

  if (executorDb) {
    await executorDb
      .update(beds)
      .set(updateData)
      .where(and(eq(beds.id, bedId), eq(beds.hospitalId, hospitalId)));
    return { ok: true };
  }

  return withTenant(hospitalId, async (tx) => {
    await tx
      .update(beds)
      .set(updateData)
      .where(and(eq(beds.id, bedId), eq(beds.hospitalId, hospitalId)));
    return { ok: true };
  });
}

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
            urgency: admissions.urgency,
            advisedWardKind: admissions.advisedWardKind,
            estimatedStayDays: admissions.estimatedStayDays,
            receptionNotes: admissions.receptionNotes,
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
          .select({
            id: beds.id,
            wardId: beds.wardId,
            label: beds.label,
            sortOrder: beds.sortOrder,
            status: beds.status,
            cleanedAt: beds.cleanedAt,
          })
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
          .map((bed) => {
            const occupant = occupantByBed.get(bed.id) ?? null;
            const effectiveStatus: CensusBed['status'] = occupant
              ? 'occupied'
              : (bed.status ?? 'vacant');
            return {
              id: bed.id,
              label: bed.label,
              status: effectiveStatus,
              occupant,
              cleanedAt: bed.cleanedAt,
            };
          });
        return {
          ...ward,
          beds: wardBeds,
          occupied: wardBeds.filter((bed) => bed.occupant).length,
        };
      });

      return {
        awaitingBed: sortAwaitingBedByUrgency(patientsList.filter((p) => p.status === 'awaiting_bed')),
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

export type AdmissionSummary = {
  admissionId: string;
  encounterId: string;
  patientId: string;
  branchId: string;
  status: AdmissionStatus;
  /** The IPD No.; null until the first bed (0041). */
  ipdNumber: number | null;
  patientName: string;
  /** The hospital's record number, the "Patient ID" on sheets; null until identity backfill (0040). */
  mrn: string | null;
  age: number | null;
  gender: string | null;
  phoneE164: string;
  address: string | null;
  doctorId: string;
  doctorName: string;
  doctorUserId: string | null;
  reason: string | null;
  requestedAt: Date;
  admittedAt: Date | null;
  dischargeReadyAt: Date | null;
  dischargedAt: Date | null;
  vitalsFrequency: string | null;
  bed: { id: string; label: string; wardId: string; wardName: string } | null;
  payer: {
    kind: 'self' | 'insurer' | 'tpa' | 'corporate';
    payerName: string | null;
    policyNumber: string | null;
    preauthAmountPaise: number | null;
    approvedAmountPaise: number | null;
  } | null;
  urgency?: 'emergency' | 'same_day' | 'planned' | null;
  advisedWardKind?: 'general' | 'special' | 'hdu' | 'icu' | null;
  estimatedStayDays?: number | null;
  receptionNotes?: string | null;
  qid?: string | null;
  admissionNumber?: string | null;
  arrivedAt?: Date | null;
  isMlc?: boolean;
  mlcNumber?: string | null;
  mlcCategory?: string | null;
  policeStationName?: string | null;
  policeIntimatedAt?: Date | null;
  policeIntimationMode?: string | null;
  constableName?: string | null;
  constableBuckleNo?: string | null;
  attendant?: {
    name: string;
    relation: string;
    phoneE164: string | null;
    address?: string | null;
  } | null;
  deposit?: {
    amountPaise: number;
    receiptNumber?: string | null;
    method: string;
    paidAt: Date;
  } | null;
  consent?: {
    templateId?: string | null;
    status: string;
    signatureType: string;
    signerName: string;
    signerRelationship: string;
    obtainedAt: Date;
    doctorConfirmed: boolean;
  } | null;
};

/**
 * One admission with everything its header and actions need. Not found
 * (including another hospital's id) is null, which the page shows as 404.
 */
export async function getAdmissionSummary(
  hospitalId: string,
  admissionId: string,
): Promise<AdmissionSummary | null> {
  if (!/^[0-9a-f-]{36}$/i.test(admissionId)) return null;
  return withTenant(
    hospitalId,
    async (tx) => {
      const [row] = await tx
        .select({
          admissionId: admissions.id,
          encounterId: admissions.encounterId,
          patientId: admissions.patientId,
          branchId: admissions.branchId,
          status: admissions.status,
          ipdNumber: admissions.ipdNumber,
          patientName: patients.name,
          mrn: patients.mrn,
          qid: patients.qid,
          age: patients.age,
          gender: patients.gender,
          phoneE164: patients.phoneE164,
          address: patients.address,
          doctorId: doctors.id,
          doctorName: doctors.name,
          doctorUserId: doctors.userId,
          reason: admissions.reason,
          urgency: admissions.urgency,
          advisedWardKind: admissions.advisedWardKind,
          estimatedStayDays: admissions.estimatedStayDays,
          receptionNotes: admissions.receptionNotes,
          requestedAt: admissions.requestedAt,
          admittedAt: admissions.admittedAt,
          dischargeReadyAt: admissions.dischargeReadyAt,
          dischargedAt: admissions.dischargedAt,
          vitalsFrequency: admissions.vitalsFrequency,
          admissionNumber: admissions.admissionNumber,
          arrivedAt: admissions.arrivedAt,
          isMlc: admissions.isMlc,
          mlcNumber: admissions.mlcNumber,
          mlcCategory: admissions.mlcCategory,
          policeStationName: admissions.policeStationName,
          policeIntimatedAt: admissions.policeIntimatedAt,
          policeIntimationMode: admissions.policeIntimationMode,
          constableName: admissions.constableName,
          constableBuckleNo: admissions.constableBuckleNo,
        })
        .from(admissions)
        .innerJoin(patients, eq(patients.id, admissions.patientId))
        .innerJoin(doctors, eq(doctors.id, admissions.admittingDoctorId))
        .where(eq(admissions.id, admissionId));
      if (!row) return null;

      const [[bed], [payer], [attendant], [deposit], [consent]] = await Promise.all([
        tx
          .select({ id: beds.id, label: beds.label, wardId: wards.id, wardName: wards.name })
          .from(bedAssignments)
          .innerJoin(beds, eq(beds.id, bedAssignments.bedId))
          .innerJoin(wards, eq(wards.id, beds.wardId))
          .where(eq(bedAssignments.admissionId, admissionId))
          .orderBy(sql`${bedAssignments.toAt} is null desc`, sql`${bedAssignments.fromAt} desc`)
          .limit(1),
        tx
          .select({
            kind: encounterPayers.kind,
            payerName: encounterPayers.payerName,
            policyNumber: encounterPayers.policyNumber,
            preauthAmountPaise: encounterPayers.preauthAmountPaise,
            approvedAmountPaise: encounterPayers.approvedAmountPaise,
          })
          .from(encounterPayers)
          .where(and(eq(encounterPayers.encounterId, row.encounterId), isNull(encounterPayers.voidedAt))),
        tx
          .select({
            name: patientContacts.name,
            relation: patientContacts.relation,
            phoneE164: patientContacts.phoneE164,
            address: patientContacts.address,
          })
          .from(patientContacts)
          .where(eq(patientContacts.patientId, row.patientId))
          .orderBy(desc(patientContacts.isEmergencyContact), desc(patientContacts.createdAt))
          .limit(1),
        tx
          .select({
            amountPaise: patientPayments.amountPaise,
            receiptNumber: sql<string | null>`coalesce(${patientPayments.reference}, ${patientPayments.id}::text)`,
            method: patientPayments.method,
            paidAt: patientPayments.receivedAt,
          })
          .from(patientPayments)
          .where(and(eq(patientPayments.encounterId, row.encounterId), isNull(patientPayments.voidedAt)))
          .orderBy(desc(patientPayments.receivedAt))
          .limit(1),
        tx
          .select({
            templateId: patientConsents.templateId,
            status: patientConsents.status,
            signatureType: patientConsents.method,
            signerName: patientConsents.signatoryNameSnapshot,
            signerRelationship: patientConsents.signatoryRelationSnapshot,
            obtainedAt: patientConsents.signedAt,
            doctorConfirmed: sql<boolean>`${patientConsents.explainedByDoctorId} is not null`,
          })
          .from(patientConsents)
          .where(eq(patientConsents.admissionId, admissionId))
          .orderBy(desc(patientConsents.createdAt))
          .limit(1),
      ]);
      return {
        ...row,
        bed: bed ?? null,
        payer: payer ?? null,
        attendant: attendant ?? null,
        deposit: deposit ?? null,
        consent: consent ?? null,
      };
    },
    { clinical: true },
  );
}

/** Free, in-use beds of a branch, by ward, for the admission sheet and transfers. */
export async function listFreeBeds(args: {
  hospitalId: string;
  branchId: string;
}): Promise<{ wardId: string; wardName: string; beds: { id: string; label: string }[] }[]> {
  return withTenant(args.hospitalId, async (tx) => {
    const rows = await tx
      .select({
        wardId: wards.id,
        wardName: wards.name,
        wardSort: wards.sortOrder,
        bedId: beds.id,
        bedLabel: beds.label,
        bedSort: beds.sortOrder,
      })
      .from(beds)
      .innerJoin(wards, eq(wards.id, beds.wardId))
      .where(
        and(
          eq(beds.active, true),
          eq(wards.active, true),
          eq(wards.branchId, args.branchId),
          sql`not exists (select 1 from ${bedAssignments} ba where ba.bed_id = ${beds.id} and ba.to_at is null)`,
        ),
      )
      .orderBy(asc(wards.sortOrder), asc(wards.name), asc(beds.sortOrder));

    const byWard = new Map<string, { wardId: string; wardName: string; beds: { id: string; label: string }[] }>();
    for (const row of rows) {
      const ward = byWard.get(row.wardId) ?? { wardId: row.wardId, wardName: row.wardName, beds: [] };
      ward.beds.push({ id: row.bedId, label: row.bedLabel });
      byWard.set(row.wardId, ward);
    }
    for (const ward of byWard.values()) ward.beds.sort((a, b) => compareBedLabels(a.label, b.label));
    return [...byWard.values()];
  });
}

/** Patients on file with this phone, for the emergency admission's search. Not clinical. */
export async function findPatientsByPhone(
  hospitalId: string,
  phoneE164: string,
): Promise<{ id: string; name: string; age: number | null; gender: string | null; address: string | null }[]> {
  return withTenant(hospitalId, (tx) =>
    tx
      .select({
        id: patients.id,
        name: patients.name,
        age: patients.age,
        gender: patients.gender,
        address: patients.address,
      })
      .from(patients)
      .where(and(eq(patients.phoneE164, phoneE164), isNull(patients.mergedIntoId)))
      .orderBy(asc(patients.name))
      .limit(10),
  );
}
