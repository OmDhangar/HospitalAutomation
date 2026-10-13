import React from 'react';
import { notFound } from 'next/navigation';
import { and, eq } from 'drizzle-orm';
import { requireSession } from '@/lib/auth/session';
import { requireModule } from '@/lib/auth/modules';
import { can } from '@/lib/domain/permissions';
import { dayOfStay } from '@/lib/domain/admission';
import { withTenant } from '@/lib/db';
import { ipdAllergyAssessments } from '@/lib/db/schema';
import { getAdmissionSummary } from '@/lib/services/ipd-census';
import { getBedsideEmar } from '@/lib/services/ipd-emar';
import { getQuickPicks } from '@/lib/services/care-entries';
import {
  BedsideTreatmentWorkspace,
  type Pick,
} from '@/components/ipd/bedside/bedside-treatment-workspace';
import type { AllergenItem } from '@/lib/services/ipd-rounding-cockpit';

export const metadata = { title: 'eMAR & Bedside Treatment · IPD' };

export default async function PatientEmarPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await requireSession();
  await requireModule(session, 'patient_file');
  const { id } = await params;

  const admission = await getAdmissionSummary(session.hospitalId, id);
  if (!admission) notFound();

  // Load bedside eMAR data, allergy assessments, supply quick-picks in parallel
  const [emarData, [currentAllergy], picks] = await Promise.all([
    getBedsideEmar({
      hospitalId: session.hospitalId,
      admissionId: id,
    }),
    withTenant(session.hospitalId, async (tx) =>
      tx
        .select({
          status: ipdAllergyAssessments.status,
          allergens: ipdAllergyAssessments.allergens,
        })
        .from(ipdAllergyAssessments)
        .where(
          and(
            eq(ipdAllergyAssessments.hospitalId, session.hospitalId),
            eq(ipdAllergyAssessments.admissionId, id),
            eq(ipdAllergyAssessments.isCurrent, true),
          ),
        ),
    ),
    getQuickPicks({ hospitalId: session.hospitalId, admissionId: id }),
  ]);

  const allergies: AllergenItem[] = (
    (currentAllergy?.allergens as any[]) ?? []
  ).map((item) =>
    typeof item === 'string'
      ? { substance: item }
      : {
          substance: item.substance ?? String(item),
          reaction: item.reaction,
          severity:
            item.severity === 'mild' || item.severity === 'moderate' || item.severity === 'severe'
              ? item.severity
              : undefined,
        },
  );

  const ageSex = [
    admission.age !== null && admission.age !== undefined
      ? `${admission.age} yrs`
      : null,
    admission.gender ? admission.gender[0].toUpperCase() : null,
  ]
    .filter(Boolean)
    .join(' · ');

  const canAdminister = can(session.role, 'ipd.administer') && !session.readOnly;

  return (
    <div className="space-y-4">
      <BedsideTreatmentWorkspace
        admissionId={id}
        patient={{
          name: admission.patientName,
          ageSex: ageSex || '—',
          bedLabel: admission.bed?.label ?? '—',
          wardName: admission.bed?.wardName ?? 'Ward',
          wardId: admission.bed?.wardId ?? '',
          day: admission.admittedAt ? dayOfStay(admission.admittedAt, new Date(), session.timezone) : null,
          ipdNumber: admission.ipdNumber != null ? String(admission.ipdNumber) : null,
          doctorName: admission.doctorName ?? null,
          diagnosis: admission.reason ?? null,
        }}
        emarData={emarData}
        allergyStatus={currentAllergy?.status ?? 'unreviewed'}
        allergies={allergies}
        chartHref={`/ipd/patients/${id}/vitals`}
        recentSupplies={picks.recent as Pick[]}
        commonSupplies={picks.common as Pick[]}
        canAdminister={canAdminister}
      />
    </div>
  );
}
