import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { Alert, Button, Card, EmptyState } from '@/components/ui';
import { BedPicker } from '@/components/ipd/bed-picker';
import { PatientHeader } from '@/components/ipd/patient-header';
import { requireSession } from '@/lib/auth/session';
import { can } from '@/lib/domain/permissions';
import { getAdmissionSummary, listFreeBeds, type IpdStatus } from '@/lib/services/ipd-census';
import { transferBedAction } from '../../../actions';

export const metadata = { title: 'Move bed · IPD' };

/**
 * Transfer: pick the new bed, confirm. The old bed is freed and the new one
 * taken in one transaction; everything recorded stays on the same stay, and
 * the bed-day charge follows the ward the patient was in each day.
 */
export default async function TransferBedPage({ params, searchParams }: PageProps<'/ipd/admissions/[id]/transfer'>) {
  const session = await requireSession();
  const { id } = await params;
  const query = await searchParams;

  if (!can(session.role, 'ipd.admit')) {
    return (
      <Card>
        <EmptyState title="The desk moves patients" hint="Ask reception to move this patient." />
      </Card>
    );
  }
  const admission = await getAdmissionSummary(session.hospitalId, id);
  if (!admission) notFound();
  if (admission.status !== 'admitted' && admission.status !== 'discharge_ready') redirect(`/ipd/admissions/${id}`);

  const freeWards = await listFreeBeds({ hospitalId: session.hospitalId, branchId: admission.branchId });

  return (
    <form action={transferBedAction} className="mx-auto max-w-3xl space-y-4 pb-28 sm:pb-6">
      <input type="hidden" name="admissionId" value={admission.admissionId} />
      <Link href={`/ipd/admissions/${id}`} className="inline-flex min-h-11 items-center text-sm text-ink-500 hover:text-ink-800">
        ← Back to {admission.patientName}
      </Link>
      <PatientHeader
        name={admission.patientName}
        age={admission.age}
        gender={admission.gender}
        bed={admission.bed}
        admittedAt={admission.admittedAt}
        doctorName={admission.doctorName}
        status={admission.status as IpdStatus}
        timezone={session.timezone}
        now={new Date()}
        sticky={false}
      />
      {typeof query.error === 'string' ? <Alert tone="error">{query.error}</Alert> : null}
      <Card>
        <div className="border-b border-ink-200 px-4 py-3 sm:px-5">
          <h2 className="text-base font-bold text-ink-900">Move to which bed?</h2>
        </div>
        <div className="p-4 sm:p-5">
          <BedPicker wards={freeWards} />
        </div>
      </Card>
      <div className="fixed inset-x-0 bottom-0 z-40 border-t border-ink-200 bg-white/95 px-3.5 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur sm:static sm:border-0 sm:bg-transparent sm:p-0">
        <Button type="submit" variant="primary" size="xl" className="w-full" disabled={freeWards.length === 0}>
          Move patient
        </Button>
      </div>
    </form>
  );
}
