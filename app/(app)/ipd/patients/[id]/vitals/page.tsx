import React from 'react';
import { notFound } from 'next/navigation';
import { desc, eq, and, isNull } from 'drizzle-orm';
import { requireSession } from '@/lib/auth/session';
import { withTenant, type Tx } from '@/lib/db';
import { vitalsReadings, intakeOutput, ipdMedicationAdministrations, ipdMedicationOrders } from '@/lib/db/schema';
import { getAdmissionSummary } from '@/lib/services/ipd-census';
import { getLetterhead } from '@/lib/services/letterhead';
import { VitalsAndIoTab } from '@/components/ipd/vitals/vitals-and-io-tab';

export const metadata = { title: 'Vitals & I/O · IPD' };

export default async function PatientVitalsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await requireSession();
  const { id } = await params;

  const admission = await getAdmissionSummary(session.hospitalId, id);
  if (!admission) notFound();

  const letterhead = await getLetterhead(session.hospitalId, admission.branchId);

  const { vitals, fluids, treatments } = await withTenant(
    session.hospitalId,
    async (tx: Tx) => {
      const vList = await tx
        .select()
        .from(vitalsReadings)
        .where(
          and(
            eq(vitalsReadings.hospitalId, session.hospitalId),
            eq(vitalsReadings.admissionId, id),
          ),
        )
        .orderBy(desc(vitalsReadings.recordedAt))
        .limit(300);

      const fList = await tx
        .select()
        .from(intakeOutput)
        .where(
          and(
            eq(intakeOutput.hospitalId, session.hospitalId),
            eq(intakeOutput.admissionId, id),
          ),
        )
        .orderBy(desc(intakeOutput.recordedAt))
        .limit(300);

      let tList: { id: string; actualTime: Date; medicineName: string; doseGiven: string | null; routeGiven: string | null }[] = [];
      try {
        const rawList = await tx
          .select({
            id: ipdMedicationAdministrations.id,
            actualTime: ipdMedicationAdministrations.actualTime,
            recordedAt: ipdMedicationAdministrations.recordedAt,
            doseGiven: ipdMedicationAdministrations.doseGiven,
            routeGiven: ipdMedicationAdministrations.routeGiven,
            medicineName: ipdMedicationOrders.medicineName,
          })
          .from(ipdMedicationAdministrations)
          .innerJoin(
            ipdMedicationOrders,
            eq(ipdMedicationOrders.id, ipdMedicationAdministrations.orderId),
          )
          .where(
            and(
              eq(ipdMedicationAdministrations.hospitalId, session.hospitalId),
              eq(ipdMedicationAdministrations.admissionId, id),
              eq(ipdMedicationAdministrations.outcome, 'administered'),
              isNull(ipdMedicationAdministrations.voidedAt),
            ),
          )
          .orderBy(desc(ipdMedicationAdministrations.actualTime))
          .limit(100);

        tList = rawList.map((r) => ({
          id: r.id,
          actualTime: r.actualTime || r.recordedAt,
          doseGiven: r.doseGiven,
          routeGiven: r.routeGiven,
          medicineName: r.medicineName,
        }));
      } catch {
        // Graceful fallback if table is empty
      }

      return { vitals: vList, fluids: fList, treatments: tList };
    },
    { clinical: true },
  );

  return (
    <VitalsAndIoTab
      admissionId={id}
      patient={{
        name: admission.patientName,
        age: admission.age,
        gender: admission.gender,
        ipdNumber: admission.ipdNumber,
        wardName: admission.bed?.wardName,
        bedLabel: admission.bed?.label,
        admittedAt: admission.admittedAt,
        doctorName: admission.doctorName,
      }}
      hospitalName={letterhead.hospitalName}
      letterhead={letterhead}
      vitals={vitals}
      fluids={fluids}
      treatments={treatments}
      vitalsFrequency={admission.vitalsFrequency ?? 'q4h'}
      canRecord={!session.readOnly}
    />
  );
}
