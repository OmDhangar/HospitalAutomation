import { notFound } from 'next/navigation';
import { requireModule } from '@/lib/auth/modules';
import { requireSession } from '@/lib/auth/session';
import { can } from '@/lib/domain/permissions';
import { withTenant } from '@/lib/db';
import { ipdAllergyAssessments } from '@/lib/db/schema';
import { and, eq } from 'drizzle-orm';
import { getBedsideEmar } from '@/lib/services/ipd-emar';
import { BedsideEmar, type AllergenItem } from '@/components/ipd/emar/bedside-emar';
import { loadAdmission } from '../data';

export const metadata = { title: 'Bedside Nursing eMAR · IPD' };

export default async function BedsideEmarPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await requireSession();
  await requireModule(session, 'patient_file');
  const { id } = await params;

  const admission = await loadAdmission(session.hospitalId, id);
  if (!admission) notFound();

  // Load bedside eMAR data
  const emarData = await getBedsideEmar({
    hospitalId: session.hospitalId,
    admissionId: id,
  });

  // Load patient allergy assessment
  const [currentAllergy] = await withTenant(session.hospitalId, async (tx) =>
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
  );

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

  const canAdminister = can(session.role, 'ipd.administer') && !session.readOnly;

  return (
    <div className="space-y-4">
      <BedsideEmar
        admissionId={id}
        patientName={admission.patientName}
        ipdNumber={admission.ipdNumber != null ? String(admission.ipdNumber) : null}
        bedLabel={admission.bed?.label}
        wardName={admission.bed?.wardName}
        data={emarData}
        allergyStatus={currentAllergy?.status ?? 'unreviewed'}
        allergies={allergies}
        canAdminister={canAdminister}
      />
    </div>
  );
}
