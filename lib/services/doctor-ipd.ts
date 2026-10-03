import { createHash } from 'node:crypto';
import { and, desc, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import { withTenant } from '@/lib/db';
import {
  admissions,
  bedAssignments,
  beds,
  careEntries,
  chargeItems,
  doctors,
  patients,
  wards,
} from '@/lib/db/schema';
import { STARTER_CHARGE_ITEMS } from '@/lib/domain/starter-charge-items';
import { recordCareEntries, type RecordOutcome } from '@/lib/services/care-entries';

/**
 * The doctor's phone view of IPD (IPD plan §T3.1): my admitted patients,
 * with two buttons each — Discharge ready, and Tests. Nothing to type.
 */

export class DoctorIpdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DoctorIpdError';
  }
}

export type MyPatient = {
  admissionId: string;
  patientName: string;
  age: number | null;
  gender: string | null;
  status: 'admitted' | 'discharge_ready';
  admittedAt: Date | null;
  bed: { label: string; wardName: string } | null;
  lastEntryAt: Date | null;
};

/**
 * Whose patients: the doctor linked to this login (doctors.user_id). An
 * owner who is not a doctor sees every admitted patient, as the person
 * running the hospital.
 */
export async function listMyAdmittedPatients(args: {
  hospitalId: string;
  userId: string;
  seeAll: boolean;
}): Promise<{ linkedDoctor: boolean; patients: MyPatient[] }> {
  return withTenant(
    args.hospitalId,
    async (tx) => {
      const [doctor] = await tx.select({ id: doctors.id }).from(doctors).where(eq(doctors.userId, args.userId));
      if (!doctor && !args.seeAll) return { linkedDoctor: false, patients: [] };

      const rows = await tx
        .select({
          admissionId: admissions.id,
          patientName: patients.name,
          age: patients.age,
          gender: patients.gender,
          status: admissions.status,
          admittedAt: admissions.admittedAt,
          bedLabel: beds.label,
          wardName: wards.name,
          lastEntryAt: sql<Date | null>`(select max(${careEntries.occurredAt}) from ${careEntries}
            where ${careEntries.admissionId} = ${admissions.id} and ${careEntries.voidedAt} is null)`,
        })
        .from(admissions)
        .innerJoin(patients, eq(patients.id, admissions.patientId))
        .leftJoin(bedAssignments, and(eq(bedAssignments.admissionId, admissions.id), isNull(bedAssignments.toAt)))
        .leftJoin(beds, eq(beds.id, bedAssignments.bedId))
        .leftJoin(wards, eq(wards.id, beds.wardId))
        .where(
          and(
            inArray(admissions.status, ['admitted', 'discharge_ready']),
            doctor ? eq(admissions.admittingDoctorId, doctor.id) : undefined,
          ),
        )
        .orderBy(wards.name, beds.label);

      return {
        linkedDoctor: Boolean(doctor),
        patients: rows.map((row) => ({
          admissionId: row.admissionId,
          patientName: row.patientName,
          age: row.age,
          gender: row.gender,
          status: row.status as MyPatient['status'],
          admittedAt: row.admittedAt,
          bed: row.bedLabel && row.wardName ? { label: row.bedLabel, wardName: row.wardName } : null,
          lastEntryAt: row.lastEntryAt ? new Date(row.lastEntryAt) : null,
        })),
      };
    },
    { clinical: true },
  );
}

export type TestChip = { id: string; name: string };

/**
 * The hospital's ten most-ordered tests over 90 days; while there is no
 * history, the starter tests in their listed order.
 */
export async function getTestChips(hospitalId: string, now: Date = new Date()): Promise<TestChip[]> {
  return withTenant(
    hospitalId,
    async (tx) => {
      const tests = await tx
        .select({ id: chargeItems.id, name: chargeItems.name })
        .from(chargeItems)
        .where(and(eq(chargeItems.isTest, true), eq(chargeItems.active, true)));
      if (tests.length === 0) return [];

      const usage = await tx
        .select({ id: careEntries.chargeItemId, uses: sql<number>`count(*)::int` })
        .from(careEntries)
        .where(
          and(
            inArray(careEntries.chargeItemId, tests.map((t) => t.id)),
            isNull(careEntries.voidedAt),
            gte(careEntries.occurredAt, new Date(now.getTime() - 90 * 86_400_000)),
          ),
        )
        .groupBy(careEntries.chargeItemId)
        .orderBy(desc(sql`count(*)`));
      const uses = new Map(usage.map((row) => [row.id, row.uses]));
      const starterOrder = new Map(
        STARTER_CHARGE_ITEMS.filter((item) => item.isTest).map((item, index) => [item.name.toLowerCase(), index]),
      );
      return [...tests]
        .sort(
          (a, b) =>
            (uses.get(b.id) ?? 0) - (uses.get(a.id) ?? 0) ||
            (starterOrder.get(a.name.toLowerCase()) ?? 999) - (starterOrder.get(b.name.toLowerCase()) ?? 999) ||
            a.name.localeCompare(b.name),
        )
        .slice(0, 10);
    },
    { clinical: true },
  );
}

/** A client id derived from the form's one-time key and the test: a resubmitted form records nothing twice. */
export function testClientId(formKey: string, chargeItemId: string): string {
  const hex = createHash('sha256').update(`${formKey}:${chargeItemId}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Orders tests: each becomes a care entry recorded by the doctor, billed
 * like any other item. Only items flagged as tests are accepted, and a
 * doctor may order only for their own patients.
 */
export async function orderTests(args: {
  hospitalId: string;
  admissionId: string;
  chargeItemIds: readonly string[];
  formKey: string;
  actorUserId: string;
  seeAll: boolean;
}): Promise<RecordOutcome[]> {
  const ids = [...new Set(args.chargeItemIds)].slice(0, 20);
  if (ids.length === 0) throw new DoctorIpdError('Tap at least one test');

  await withTenant(
    args.hospitalId,
    async (tx) => {
      const tests = await tx
        .select({ id: chargeItems.id })
        .from(chargeItems)
        .where(and(inArray(chargeItems.id, ids), eq(chargeItems.isTest, true), eq(chargeItems.active, true)));
      if (tests.length !== ids.length) throw new DoctorIpdError('Only tests can be ordered here');

      const [admission] = await tx
        .select({ doctorUserId: doctors.userId })
        .from(admissions)
        .innerJoin(doctors, eq(doctors.id, admissions.admittingDoctorId))
        .where(eq(admissions.id, args.admissionId));
      if (!admission) throw new DoctorIpdError('Patient not found');
      if (!args.seeAll && admission.doctorUserId !== args.actorUserId) {
        throw new DoctorIpdError('You can order tests only for your own patients');
      }
    },
    { clinical: true },
  );

  const now = new Date().toISOString();
  return recordCareEntries({
    hospitalId: args.hospitalId,
    entries: ids.map((id) => ({
      clientId: testClientId(args.formKey, id),
      admissionId: args.admissionId,
      item: { type: 'charge' as const, id },
      quantity: 1,
      occurredAt: now,
    })),
    actorUserId: args.actorUserId,
  });
}
