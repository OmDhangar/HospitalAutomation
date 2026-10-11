import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { withTenant, type Tx } from '@/lib/db';
import { auditLogs, patientAllergies, patientAllergyReviews, users } from '@/lib/db/schema';
import {
  AllergyError,
  allergyStatus,
  type AllergyCategory,
  type AllergyInput,
  type AllergySeverity,
  type AllergySource,
  type AllergyStatus,
  type DrugClass,
  type PatientAllergy,
} from '@/lib/domain/allergy';

/**
 * Allergies (IPD sheets plan B2). Per patient, so they follow the patient
 * into every stay and visit. Clinical: each call reads and writes with the
 * clinical key. The database keeps them struck-out-only.
 */

export { AllergyError };

const clinical = { clinical: true } as const;

export type AllergyRow = PatientAllergy & {
  reaction: string | null;
  source: AllergySource;
  recordedAt: Date;
  recordedBy: string | null;
};

export type AllergyView = {
  allergies: AllergyRow[];
  lastReview: { outcome: 'nkda' | 'recorded' | 'unable'; at: Date; by: string | null; note: string | null } | null;
  status: AllergyStatus;
};

/** The patient's allergies, as the database holds them now (struck-out ones left out). */
export async function activeAllergiesInTx(tx: Tx, patientId: string): Promise<PatientAllergy[]> {
  return tx
    .select({
      id: patientAllergies.id,
      substance: patientAllergies.substance,
      category: patientAllergies.category,
      drugClass: patientAllergies.drugClass,
      medicineId: patientAllergies.medicineId,
      severity: patientAllergies.severity,
    })
    .from(patientAllergies)
    .where(and(eq(patientAllergies.patientId, patientId), isNull(patientAllergies.voidedAt)));
}

export async function getAllergies(hospitalId: string, patientId: string): Promise<AllergyView> {
  return withTenant(
    hospitalId,
    async (tx) => {
      const rows = await tx
        .select({
          id: patientAllergies.id,
          substance: patientAllergies.substance,
          category: patientAllergies.category,
          drugClass: patientAllergies.drugClass,
          medicineId: patientAllergies.medicineId,
          severity: patientAllergies.severity,
          reaction: patientAllergies.reaction,
          source: patientAllergies.source,
          recordedAt: patientAllergies.recordedAt,
          recordedBy: users.name,
        })
        .from(patientAllergies)
        .leftJoin(users, eq(users.id, patientAllergies.recordedByUserId))
        .where(and(eq(patientAllergies.patientId, patientId), isNull(patientAllergies.voidedAt)))
        .orderBy(sql`case ${patientAllergies.severity} when 'severe' then 0 when 'moderate' then 1 when 'mild' then 2 else 3 end`, patientAllergies.substance);
      const [review] = await tx
        .select({ outcome: patientAllergyReviews.outcome, at: patientAllergyReviews.reviewedAt, by: users.name, note: patientAllergyReviews.note })
        .from(patientAllergyReviews)
        .leftJoin(users, eq(users.id, patientAllergyReviews.reviewedByUserId))
        .where(eq(patientAllergyReviews.patientId, patientId))
        .orderBy(desc(patientAllergyReviews.reviewedAt))
        .limit(1);
      const lastReview = review ?? null;
      return { allergies: rows, lastReview, status: allergyStatus(rows, lastReview) };
    },
    clinical,
  );
}

/** Banners for many patients at once (ward and patient lists): patient id → status. */
export async function allergyStatuses(hospitalId: string, patientIds: readonly string[]): Promise<Map<string, AllergyStatus>> {
  if (patientIds.length === 0) return new Map();
  return withTenant(
    hospitalId,
    async (tx) => {
      const ids = sql.join(patientIds.map((id) => sql`${id}::uuid`), sql`, `);
      const allergyRows = await tx.execute<{ patient_id: string; severity: AllergySeverity }>(
        sql`select patient_id, severity from patient_allergies where voided_at is null and patient_id in (${ids})`,
      );
      const reviewRows = await tx.execute<{ patient_id: string; outcome: 'nkda' | 'recorded' | 'unable'; reviewed_at: string }>(
        sql`select distinct on (patient_id) patient_id, outcome, reviewed_at from patient_allergy_reviews
            where patient_id in (${ids}) order by patient_id, reviewed_at desc`,
      );
      const result = new Map<string, AllergyStatus>();
      for (const id of patientIds) {
        const review = [...reviewRows].find((r) => r.patient_id === id);
        result.set(
          id,
          allergyStatus(
            [...allergyRows].filter((a) => a.patient_id === id),
            review ? { outcome: review.outcome, at: new Date(review.reviewed_at) } : null,
          ),
        );
      }
      return result;
    },
    clinical,
  );
}

/** Records an allergy (and that allergies were asked about). Once per client id. */
export async function recordAllergy(args: {
  hospitalId: string;
  patientId: string;
  admissionId: string | null;
  input: AllergyInput;
  medicineId?: string | null;
  clientId: string;
  actorUserId: string;
}): Promise<{ id: string; repeat: boolean }> {
  return withTenant(
    args.hospitalId,
    async (tx) => {
      const [existing] = await tx.select({ id: patientAllergies.id }).from(patientAllergies).where(eq(patientAllergies.clientId, args.clientId));
      if (existing) return { id: existing.id, repeat: true };
      const same = (await activeAllergiesInTx(tx, args.patientId)).find((a) => a.substance.toLowerCase() === args.input.substance.toLowerCase());
      if (same) throw new AllergyError(`${same.substance} is already recorded`);
      const [row] = await tx
        .insert(patientAllergies)
        .values({
          hospitalId: args.hospitalId,
          patientId: args.patientId,
          admissionId: args.admissionId,
          substance: args.input.substance,
          category: args.input.category as AllergyCategory,
          medicineId: args.medicineId ?? null,
          drugClass: args.input.drugClass as DrugClass | null,
          reaction: args.input.reaction,
          severity: args.input.severity,
          source: args.input.source,
          recordedByUserId: args.actorUserId,
          clientId: args.clientId,
        })
        .returning({ id: patientAllergies.id });
      await tx.insert(patientAllergyReviews).values({
        hospitalId: args.hospitalId,
        patientId: args.patientId,
        admissionId: args.admissionId,
        outcome: 'recorded',
        reviewedByUserId: args.actorUserId,
      });
      return { id: row.id, repeat: false };
    },
    clinical,
  );
}

/** Strikes out an allergy recorded in error (or found not to be one), with the reason. */
export async function strikeOutAllergy(args: { hospitalId: string; allergyId: string; reason: string; actorUserId: string }): Promise<void> {
  const reason = args.reason.replace(/\s+/g, ' ').trim().slice(0, 200);
  if (reason.length < 3) throw new AllergyError('Write why it is struck out');
  await withTenant(
    args.hospitalId,
    async (tx) => {
      const [row] = await tx
        .update(patientAllergies)
        .set({ voidedAt: new Date(), voidedByUserId: args.actorUserId, voidReason: reason })
        .where(and(eq(patientAllergies.id, args.allergyId), isNull(patientAllergies.voidedAt)))
        .returning({ id: patientAllergies.id });
      if (!row) throw new AllergyError('Allergy not found');
      await tx.insert(auditLogs).values({
        hospitalId: args.hospitalId,
        actorUserId: args.actorUserId,
        action: 'allergy.struck_out',
        objectType: 'patient_allergy',
        objectId: row.id,
        metadata: {},
      });
    },
    clinical,
  );
}

/**
 * Says allergies were asked about: none known (NKDA), or could not ask
 * (unconscious, no family). "None known" is refused while a medicine allergy
 * is on record — strike that out first.
 */
export async function reviewAllergies(args: {
  hospitalId: string;
  patientId: string;
  admissionId: string | null;
  outcome: 'nkda' | 'unable';
  note: string | null;
  actorUserId: string;
}): Promise<void> {
  const note = args.note?.replace(/\s+/g, ' ').trim().slice(0, 200) || null;
  if (args.outcome === 'unable' && !note) throw new AllergyError('Say why it could not be asked');
  await withTenant(
    args.hospitalId,
    async (tx) => {
      if (args.outcome === 'nkda' && (await activeAllergiesInTx(tx, args.patientId)).some((a) => a.category === 'drug')) {
        throw new AllergyError('A medicine allergy is recorded. Strike it out first if it is wrong.');
      }
      await tx.insert(patientAllergyReviews).values({
        hospitalId: args.hospitalId,
        patientId: args.patientId,
        admissionId: args.admissionId,
        outcome: args.outcome,
        note,
        reviewedByUserId: args.actorUserId,
      });
    },
    clinical,
  );
}
