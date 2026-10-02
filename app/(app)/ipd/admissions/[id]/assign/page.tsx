import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { Alert, Button, Card, EmptyState } from '@/components/ui';
import { AdmissionExtras } from '@/components/ipd/admission-extras';
import { BedPicker } from '@/components/ipd/bed-picker';
import { PatientHeader } from '@/components/ipd/patient-header';
import { requireSession } from '@/lib/auth/session';
import { can } from '@/lib/domain/permissions';
import { getAdmissionSummary, listFreeBeds } from '@/lib/services/ipd-census';
import { assignBedAction } from '../../../actions';

export const metadata = { title: 'Assign bed · IPD' };

/**
 * The admission sheet (IPD plan §5.3): the patient carried over from OPD,
 * the free beds of their branch, and one primary action — Confirm bed —
 * fixed to the bottom on a phone. Reason, payer and deposit are optional and
 * folded away (decision D-AD).
 */
export default async function AssignBedPage({ params, searchParams }: PageProps<'/ipd/admissions/[id]/assign'>) {
  const session = await requireSession();
  const { id } = await params;
  const query = await searchParams;

  if (!can(session.role, 'ipd.admit')) {
    return (
      <Card>
        <EmptyState title="The desk assigns beds" hint="Ask reception to assign this patient a bed." />
      </Card>
    );
  }

  const admission = await getAdmissionSummary(session.hospitalId, id);
  if (!admission) notFound();
  if (admission.status !== 'awaiting_bed') redirect(`/ipd/admissions/${id}`);

  const freeWards = await listFreeBeds({ hospitalId: session.hospitalId, branchId: admission.branchId });
  const preselected = typeof query.bed === 'string' ? query.bed : null;
  const now = new Date();

  return (
    <form action={assignBedAction} className="mx-auto max-w-3xl space-y-4 pb-28 sm:pb-6">
      <input type="hidden" name="admissionId" value={admission.admissionId} />

      <Link href="/ipd?tab=awaiting" className="inline-flex min-h-11 items-center text-sm text-ink-500 hover:text-ink-800">
        ← Awaiting bed
      </Link>

      <PatientHeader
        name={admission.patientName}
        age={admission.age}
        gender={admission.gender}
        phoneE164={admission.phoneE164}
        bed={null}
        admittedAt={null}
        doctorName={admission.doctorName}
        status="awaiting_bed"
        timezone={session.timezone}
        now={now}
        sticky={false}
      />

      {typeof query.error === 'string' ? <Alert tone="error">{query.error}</Alert> : null}

      <Card>
        <div className="space-y-1 border-b border-ink-200 px-4 py-3 sm:px-5">
          <h2 className="text-base font-bold text-ink-900">Tap a free bed</h2>
          <p className="text-sm text-ink-500">Only free beds are shown.</p>
        </div>
        <div className="p-4 sm:p-5">
          <BedPicker wards={freeWards} selectedBedId={preselected} />
        </div>
      </Card>

      <AdmissionExtras
        canCollect={can(session.role, 'billing.collect')}
        defaultReason={admission.reason}
        defaultPayer={admission.payer}
      />

      <div className="fixed inset-x-0 bottom-0 z-40 border-t border-ink-200 bg-white/95 px-3.5 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur sm:static sm:border-0 sm:bg-transparent sm:p-0">
        <Button type="submit" variant="primary" size="xl" className="w-full" disabled={freeWards.length === 0}>
          Confirm bed
        </Button>
      </div>
    </form>
  );
}
