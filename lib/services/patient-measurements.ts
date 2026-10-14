import { and, desc, eq } from 'drizzle-orm';
import { patientMeasurements } from '@/lib/db/schema';
import { withTenant } from '@/lib/db';

export function calculateBmi(weightKg?: number | null, heightCm?: number | null): number | null {
  if (weightKg == null || heightCm == null) return null;
  if (weightKg <= 0 || heightCm <= 0) return null;
  const heightM = heightCm / 100;
  const rawBmi = weightKg / (heightM * heightM);
  if (!isFinite(rawBmi) || isNaN(rawBmi)) return null;
  return Math.round(rawBmi * 10) / 10;
}

export interface RecordPatientMeasurementInput {
  hospitalId: string;
  patientId: string;
  admissionId: string;
  weightKg?: number;
  heightCm?: number;
  measuredByUserId?: string;
  notes?: string;
  recordedAt?: Date;
}

export async function recordPatientMeasurement(
  input: RecordPatientMeasurementInput,
  executorDb?: any,
): Promise<{ id: string; bmi: number | null }> {
  const hasWeight = input.weightKg != null && input.weightKg > 0;
  const hasHeight = input.heightCm != null && input.heightCm > 0;

  if (!hasWeight && !hasHeight) {
    throw new Error('At least weight or height must be provided with positive values.');
  }

  const computedBmi = calculateBmi(input.weightKg, input.heightCm);

  const valuesToInsert = {
    hospitalId: input.hospitalId,
    patientId: input.patientId,
    admissionId: input.admissionId,
    recordedAt: input.recordedAt ?? new Date(),
    weightKg: input.weightKg != null ? input.weightKg.toFixed(2) : null,
    heightCm: input.heightCm != null ? input.heightCm.toFixed(2) : null,
    bmi: computedBmi != null ? computedBmi.toFixed(1) : null,
    measuredByUserId: input.measuredByUserId ?? null,
    notes: input.notes?.trim() || null,
  };

  if (executorDb) {
    const [row] = await executorDb.insert(patientMeasurements).values(valuesToInsert).returning();
    return { id: row.id, bmi: computedBmi };
  }

  return withTenant(input.hospitalId, async (tx) => {
    const [row] = await tx.insert(patientMeasurements).values(valuesToInsert).returning();
    return { id: row.id, bmi: computedBmi };
  });
}

export interface FormattedMeasurement {
  id: string;
  hospitalId: string;
  patientId: string;
  admissionId: string;
  recordedAt: Date;
  weightKg: number | null;
  heightCm: number | null;
  bmi: number | null;
  notes: string | null;
}

export async function getLatestMeasurementForAdmission(
  hospitalId: string,
  admissionId: string,
  executorDb?: any,
): Promise<FormattedMeasurement | null> {
  if (executorDb?.query?.patientMeasurements) {
    const row = await executorDb.query.patientMeasurements.findFirst({
      where: and(
        eq(patientMeasurements.hospitalId, hospitalId),
        eq(patientMeasurements.admissionId, admissionId),
      ),
      orderBy: [desc(patientMeasurements.recordedAt)],
    });

    if (!row) return null;

    return {
      id: row.id,
      hospitalId: row.hospitalId,
      patientId: row.patientId,
      admissionId: row.admissionId,
      recordedAt: row.recordedAt,
      weightKg: row.weightKg ? Number(row.weightKg) : null,
      heightCm: row.heightCm ? Number(row.heightCm) : null,
      bmi: row.bmi ? Number(row.bmi) : null,
      notes: row.notes,
    };
  }

  return withTenant(
    hospitalId,
    async (tx) => {
      const [row] = await tx
        .select()
        .from(patientMeasurements)
        .where(
          and(
            eq(patientMeasurements.hospitalId, hospitalId),
            eq(patientMeasurements.admissionId, admissionId),
          ),
        )
        .orderBy(desc(patientMeasurements.recordedAt))
        .limit(1);

      if (!row) return null;

      return {
        id: row.id,
        hospitalId: row.hospitalId,
        patientId: row.patientId,
        admissionId: row.admissionId,
        recordedAt: row.recordedAt,
        weightKg: row.weightKg ? Number(row.weightKg) : null,
        heightCm: row.heightCm ? Number(row.heightCm) : null,
        bmi: row.bmi ? Number(row.bmi) : null,
        notes: row.notes,
      };
    },
    { clinical: true },
  );
}
