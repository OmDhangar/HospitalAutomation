import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Button, Card, EmptyState } from '@/components/ui';
import { OutboxStatus } from '@/components/ipd/outbox-status';
import { RecordScreen } from '@/components/ipd/record-screen';
import { requireSession } from '@/lib/auth/session';
import { dayOfStay } from '@/lib/domain/admission';
import { can } from '@/lib/domain/permissions';
import { getQuickPicks } from '@/lib/services/care-entries';
import { getIpdCensus } from '@/lib/services/ipd-census';

export const metadata = { title: 'Record · IPD' };

/**
 * The record screen (IPD plan §5.6) for whoever is in this bed now. If the
 * bed has emptied since the grid was loaded — a discharge, a transfer — the
 * nurse is told so instead of recording against the wrong patient.
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
  const picks = await getQuickPicks({ hospitalId: session.hospitalId, admissionId: occupant.admissionId });
  const ageSex = [occupant.age !== null ? String(occupant.age) : null, occupant.gender?.[0]?.toUpperCase() ?? null]
    .filter(Boolean)
    .join(' ');

  return (
    <>
      <div className="mx-auto mb-4 max-w-xl">
        <OutboxStatus />
      </div>
      <RecordScreen
        admissionId={occupant.admissionId}
        patient={{
          name: occupant.patientName,
          ageSex,
          bedLabel: bed.label,
          wardName: ward.name,
          day: occupant.admittedAt ? dayOfStay(occupant.admittedAt, new Date(), session.timezone) : null,
        }}
        backHref={`/ipd/ward/${ward.id}`}
        backLabel={ward.name}
        recent={picks.recent}
        common={picks.common}
      />
    </>
  );
}
