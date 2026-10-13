import React from 'react';
import { notFound } from 'next/navigation';
import { desc, eq, and } from 'drizzle-orm';
import { requireSession } from '@/lib/auth/session';
import { withTenant, type Tx } from '@/lib/db';
import { vitalsReadings, intakeOutput } from '@/lib/db/schema';
import { getAdmissionSummary } from '@/lib/services/ipd-census';
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

  const { vitals, fluids } = await withTenant(
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
        .limit(30);

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
        .limit(50);

      return { vitals: vList, fluids: fList };
    },
    { clinical: true },
  );

  return (
    <VitalsAndIoTab
      admissionId={id}
      vitals={vitals}
      fluids={fluids}
      canRecord={!session.readOnly}
    />
  );
}
