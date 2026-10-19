import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { withTenant } from '@/lib/db';
import {
  admissions,
  bedAssignments,
  beds,
  doctors,
  encounters,
  patientContacts,
  patients,
  users,
  wards,
} from '@/lib/db/schema';
import { logRecordAccessInTx } from '@/lib/services/record-access';
import { nameKey } from '@/lib/domain/patient-match';
import { normalizeIndianPhone } from '@/lib/domain/phone';
import { isValidQid, normalizeQid } from '@/lib/domain/uhid';
import { nextDocumentNumberInTx } from '@/lib/services/document-numbers';

export {
  detectSearchType,
  formatTempName,
  type ActiveStayInfo,
  type SearchMatchType,
  type SmartSearchResult,
} from '@/lib/domain/patient-search';

export async function searchPatientsSmart(args: {
  hospitalId: string;
  query: string;
  actorUserId: string;
  limit?: number;
}): Promise<SmartSearchResult[]> {
  const query = args.query.trim();
  if (!query) return [];
  const limit = Math.min(Math.max(args.limit ?? 10, 1), 25);
  const detected = detectSearchType(query);
  const normalizedPhone = normalizeIndianPhone(query);
  const digits = query.replace(/\D/g, '');
  const qid = normalizeQid(query);
  const key = nameKey(query);
  const mrn = query.toUpperCase().replace(/\s+/g, '');

  return withTenant(
    args.hospitalId,
    async (tx) => {
      // Direct tenant-scoped query matching phone, QID, MRN or name key
      const rows = await tx.execute<{
        id: string;
        name: string;
        age: number | null;
        gender: string | null;
        phone_e164: string;
        address: string | null;
        mrn: string | null;
        qid: string | null;
        admission_id: string | null;
        admission_number: string | null;
        ipd_number: number | null;
        admission_status: string | null;
        ward_name: string | null;
        bed_label: string | null;
        doctor_name: string | null;
        admitted_at: Date | null;
      }>(sql`
        select p.id,
               p.name,
               p.age,
               p.gender,
               p.phone_e164,
               p.address,
               p.mrn,
               p.qid,
               a.id as admission_id,
               a.admission_number,
               a.ipd_number,
               a.status as admission_status,
               w.name as ward_name,
               b.label as bed_label,
               doc.name as doctor_name,
               a.admitted_at
          from patients p
          left join admissions a
                 on a.patient_id = p.id
                and a.status in ('awaiting_bed', 'admitted', 'discharge_ready')
          left join bed_assignments ba
                 on ba.admission_id = a.id
                and ba.to_at is null
          left join beds b
                 on b.id = ba.bed_id
          left join wards w
                 on w.id = b.ward_id
          left join doctors doc
                 on doc.id = a.admitting_doctor_id
         where p.hospital_id = ${args.hospitalId}::uuid
           and p.merged_into_id is null
           and (
             (${qid}::text is not null and p.qid = ${qid})
             or (${mrn}::text is not null and p.mrn = ${mrn})
             or (${normalizedPhone}::text is not null and p.phone_e164 = ${normalizedPhone})
             or (${digits.length >= 6} and p.phone_e164 like '%' || ${digits} || '%')
             or (${key.length >= 2} and (
                   coalesce(p.name_key, public.qurio_name_key(p.name)) like ${key} || '%'
                   or coalesce(p.name_key, public.qurio_name_key(p.name)) like '% ' || ${key} || '%'
                 ))
           )
         order by (case when a.id is not null then 0 else 1 end),
                  p.updated_at desc
         limit ${limit}
      `);

      return rows.map((r) => ({
        id: r.id,
        name: r.name,
        age: r.age === null ? null : Number(r.age),
        gender: r.gender,
        phoneE164: r.phone_e164,
        address: r.address,
        mrn: r.mrn,
        qid: r.qid,
        matchType: detected,
        activeStay: r.admission_id
          ? {
              admissionId: r.admission_id,
              admissionNumber: r.admission_number,
              ipdNumber: r.ipd_number,
              status: r.admission_status as ActiveStayInfo['status'],
              wardName: r.ward_name,
              bedLabel: r.bed_label,
              doctorName: r.doctor_name ?? 'Attending Doctor',
              admittedAt: r.admitted_at,
            }
          : null,
      }));
    },
    { clinical: true },
  );
}

/** Logs when staff selects or views a patient profile from search for DPDP compliance. */
export async function logPatientSearchSelection(args: {
  hospitalId: string;
  patientId: string;
  actorUserId: string;
}): Promise<void> {
  await withTenant(
    args.hospitalId,
    async (tx) => {
      await logRecordAccessInTx(tx, {
        hospitalId: args.hospitalId,
        patientId: args.patientId,
        actorUserId: args.actorUserId,
        encounterId: null,
        action: 'view_admission',
        dedupeMinutes: 5,
      });
    },
    { clinical: true },
  );
}

/** Registers an unidentified patient in casualty/emergency with a temporary hospital MRN and NO global QID. */
export async function registerUnidentifiedPatient(args: {
  hospitalId: string;
  branchId: string;
  gender?: string | null;
  approxAge?: number | null;
  descriptiveNote?: string | null;
  actorUserId: string;
}): Promise<{ patientId: string; tempName: string; mrn: string }> {
  return withTenant(
    args.hospitalId,
    async (tx) => {
      const tempNumber = await nextDocumentNumberInTx(tx, {
        hospitalId: args.hospitalId,
        kind: 'temp_mrn',
      });
      const mrn = `TEMP-${tempNumber.formatted}`;
      const tempName = formatTempName({
        gender: args.gender,
        approxAge: args.approxAge,
        note: args.descriptiveNote,
      });

      const [patient] = await tx
        .insert(patients)
        .values({
          hospitalId: args.hospitalId,
          phoneE164: '+910000000000', // Unidentified sentinel
          name: tempName,
          age: args.approxAge,
          gender: args.gender,
          mrn,
          address: args.descriptiveNote ? `Found: ${args.descriptiveNote}` : null,
          locale: 'en',
        })
        .returning();

      return {
        patientId: patient.id,
        tempName: patient.name,
        mrn,
      };
    },
    { clinical: true },
  );
}

/** Merges an unidentified temporary patient record into a confirmed patient profile. */
export async function mergeUnidentifiedPatient(args: {
  hospitalId: string;
  tempPatientId: string;
  confirmedPatientId: string;
  actorUserId: string;
}): Promise<void> {
  if (args.tempPatientId === args.confirmedPatientId) return;

  await withTenant(
    args.hospitalId,
    async (tx) => {
      const now = new Date();
      // Re-point all clinical admissions and encounters
      await tx
        .update(admissions)
        .set({ patientId: args.confirmedPatientId, updatedAt: now })
        .where(eq(admissions.patientId, args.tempPatientId));

      await tx
        .update(encounters)
        .set({ patientId: args.confirmedPatientId, updatedAt: now })
        .where(eq(encounters.patientId, args.tempPatientId));

      // Mark the temp patient as merged
      await tx
        .update(patients)
        .set({
          mergedIntoId: args.confirmedPatientId,
          updatedAt: now,
        })
        .where(eq(patients.id, args.tempPatientId));
    },
    { clinical: true },
  );
}
