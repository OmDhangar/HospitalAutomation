import { notFound } from 'next/navigation';
import { requireModule, getModuleStatesForRequest } from '@/lib/auth/modules';
import { requireSession } from '@/lib/auth/session';
import { can } from '@/lib/domain/permissions';
import { dayOfStay } from '@/lib/domain/admission';
import { withTenant } from '@/lib/db';
import { ipdAllergyAssessments } from '@/lib/db/schema';
import { and, eq } from 'drizzle-orm';
import { getBedsideEmar } from '@/lib/services/ipd-emar';
import { getQuickPicks } from '@/lib/services/care-entries';
import { moduleAllows } from '@/lib/modules/registry';
import {
  BedsideTreatmentWorkspace,
  type Pick,
} from '@/components/ipd/bedside/bedside-treatment-workspace';
import type { AllergenItem } from '@/lib/services/ipd-rounding-cockpit';
import { loadAdmission } from '../data';

export const metadata = { title: 'Bedside Medication Chart · IPD' };

export default async function BedsideTreatmentPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await requireSession();
  await requireModule(session, 'patient_file');
  const { id } = await params;

  const admission = await loadAdmission(session.hospitalId, id);
  if (!admission) notFound();

  // Load bedside eMAR data, allergy assessments, supply quick-picks, and module states in parallel
  const [emarData, [currentAllergy], picks, states] = await Promise.all([
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
    getModuleStatesForRequest(session.hospitalId),
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

  const chartHref = moduleAllows(states, 'charts', 'read')
    ? `/ipd/admissions/${id}/tpr`
    : `/ipd/patients/${id}/vitals`;

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
        chartHref={chartHref}
        recentSupplies={picks.recent as Pick[]}
        commonSupplies={picks.common as Pick[]}
        canAdminister={canAdminister}
        userRole={session.role}
      />
    </div>
  );
}
