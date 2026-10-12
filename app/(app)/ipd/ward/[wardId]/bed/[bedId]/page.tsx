import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Button, Card, EmptyState } from '@/components/ui';
import { OutboxStatus } from '@/components/ipd/outbox-status';
import { BedsideTreatmentChart } from '@/components/ipd/bedside/bedside-treatment-chart';
import { getModuleStatesForRequest } from '@/lib/auth/modules';
import { requireSession } from '@/lib/auth/session';
import { dayOfStay } from '@/lib/domain/admission';
import { can } from '@/lib/domain/permissions';
import { withTenant } from '@/lib/db';
import { ipdAllergyAssessments } from '@/lib/db/schema';
import { and, eq } from 'drizzle-orm';
import { getQuickPicks } from '@/lib/services/care-entries';
import { getIpdCensus, getAdmissionSummary } from '@/lib/services/ipd-census';
import { getBedsideEmar } from '@/lib/services/ipd-emar';
import { moduleAllows } from '@/lib/modules/registry';
import type { AllergenItem } from '@/lib/services/ipd-rounding-cockpit';

export const metadata = { title: 'Bedside Treatment Chart · IPD' };

/**
 * The bedside nursing treatment screen for whoever is in this bed now.
 * Displays patient diagnosis, doctor's routine daily medicines,
 * and SOS medicines with 1-click administration.
 */
export default async function RecordPage({ params }: PageProps<'/ipd/ward/[wardId]/bed/[bedId]'>) {
  const session = await requireSession();
  const { wardId, bedId } = await params;
  if (!can(session.role, 'ipd.record')) notFound();

  const census = await getIpdCensus({ hospitalId: session.hospitalId, branchId: session.branchId });
  const ward = census.wards.find((w) => w.id === wardId);
  const bed = ward?.beds.find((b) => b.id === bedId);
  if (!ward || !bed) notFound();

  if (!bed.occupant) {
    return (
      <div className="mx-auto max-w-xl space-y-4">
        <Card>
          <EmptyState title={`Bed ${bed.label} is empty now.`} hint="The patient may have moved or gone home." />
          <div className="pb-6 text-center">
            <Link href={`/ipd/ward/${ward.id}`}>
              <Button variant="primary" size="lg">
                Back to {ward.name}
              </Button>
            </Link>
          </div>
        </Card>
      </div>
    );
  }

  const occupant = bed.occupant;

  const [admission, emarData, [currentAllergy], picks, states] = await Promise.all([
    getAdmissionSummary(session.hospitalId, occupant.admissionId),
    getBedsideEmar({ hospitalId: session.hospitalId, admissionId: occupant.admissionId }),
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
            eq(ipdAllergyAssessments.admissionId, occupant.admissionId),
            eq(ipdAllergyAssessments.isCurrent, true),
          ),
        ),
    ),
    getQuickPicks({ hospitalId: session.hospitalId, admissionId: occupant.admissionId }),
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

  const chartHref =
    can(session.role, 'ipd.chart') && moduleAllows(states, 'charts', 'read')
      ? `/ipd/admissions/${occupant.admissionId}/tpr`
      : null;

  const ageSex = [occupant.age !== null ? String(occupant.age) : null, occupant.gender?.[0]?.toUpperCase() ?? null]
    .filter(Boolean)
    .join(' ');

  const canAdminister = can(session.role, 'ipd.administer') && !session.readOnly;

  return (
    <>
      <div className="mx-auto mb-4 max-w-xl">
        <OutboxStatus />
      </div>
      <BedsideTreatmentChart
        admissionId={occupant.admissionId}
        patient={{
          name: occupant.patientName,
          ageSex,
          bedLabel: bed.label,
          wardName: ward.name,
          wardId: ward.id,
          day: occupant.admittedAt ? dayOfStay(occupant.admittedAt, new Date(), session.timezone) : null,
          ipdNumber: admission?.ipdNumber != null ? String(admission.ipdNumber) : null,
          doctorName: admission?.doctorName,
          diagnosis: admission?.reason,
        }}
        emarData={emarData}
        allergyStatus={currentAllergy?.status ?? 'unreviewed'}
        allergies={allergies}
        chartHref={chartHref}
        recentSupplies={picks.recent}
        commonSupplies={picks.common}
        canAdminister={canAdminister}
      />
    </>
  );
}
