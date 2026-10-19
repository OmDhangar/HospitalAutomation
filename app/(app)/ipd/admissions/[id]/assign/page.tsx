import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { Card, EmptyState } from '@/components/ui';
import { UnifiedIntakeForm } from '@/components/ipd/intake/unified-intake-form';
import { requireSession } from '@/lib/auth/session';
import { can } from '@/lib/domain/permissions';
import { listDoctors } from '@/lib/services/hospital';
import { getAdmissionSummary, listFreeBeds } from '@/lib/services/ipd-census';

export const metadata = { title: 'Assign Bed & Intake · IPD' };

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

  const [freeWards, doctorRows] = await Promise.all([
    listFreeBeds({ hospitalId: session.hospitalId, branchId: admission.branchId }),
    listDoctors({ hospitalId: session.hospitalId, branchId: admission.branchId }),
  ]);

  const preselectedBedId = typeof query.bed === 'string' ? query.bed : null;

  return (
    <UnifiedIntakeForm
      mode="opd_prefilled"
      branchId={admission.branchId}
      freeWards={freeWards}
      doctors={doctorRows}
      preselectedBedId={preselectedBedId}
      initialAdmission={{
        admissionId: admission.admissionId,
        patientId: admission.patientId,
        patientName: admission.patientName,
        phoneE164: admission.phoneE164,
        age: admission.age,
        gender: admission.gender,
        address: admission.address,
        mrn: admission.mrn,
        qid: admission.qid,
        doctorId: admission.doctorId,
        doctorName: admission.doctorName,
        urgency: admission.urgency,
        advisedWardKind: admission.advisedWardKind,
        reason: admission.reason,
        receptionNotes: admission.receptionNotes,
      }}
    />
  );
}
