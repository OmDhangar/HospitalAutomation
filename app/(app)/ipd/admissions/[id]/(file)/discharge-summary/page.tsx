import { notFound } from 'next/navigation';
import { EmptyState, Card } from '@/components/ui';
import { requireModule } from '@/lib/auth/modules';
import { requireSession } from '@/lib/auth/session';
import { can } from '@/lib/domain/permissions';
import { moduleAllows } from '@/lib/modules/registry';
import { getSummaryView } from '@/lib/services/discharge-summary';
import { listOrderingDoctors } from '@/lib/services/mar';
import { loadAdmission } from '../data';
import { SummaryEditor } from './summary-editor';

export const metadata = { title: 'Discharge summary · IPD' };

/**
 * The discharge summary tab (IPD sheets plan B5): the working draft, built
 * from the record and edited here, and the finalised versions with who
 * signed them. Unsigned versions print as DRAFT.
 */
export default async function DischargeSummaryPage({ params }: PageProps<'/ipd/admissions/[id]/discharge-summary'>) {
  const session = await requireSession();
  const states = await requireModule(session, 'discharge_summary');
  const { id } = await params;
  const admission = await loadAdmission(session.hospitalId, id);
  if (!admission) notFound();
  if (admission.status === 'awaiting_bed' || admission.status === 'cancelled') {
    return (
      <Card>
        <EmptyState title="No stay to summarise yet" hint="The summary opens once the patient has a bed." />
      </Card>
    );
  }
  const mayWrite = can(session.role, 'ipd.summary');
  const mayTranscribe = can(session.role, 'ipd.summaryTranscribe');
  const canEdit = (mayWrite || mayTranscribe) && !session.readOnly && moduleAllows(states, 'discharge_summary', 'write');
  const [view, doctors] = await Promise.all([
    getSummaryView({ hospitalId: session.hospitalId, admissionId: id, timezone: session.timezone }),
    canEdit ? listOrderingDoctors(session.hospitalId) : Promise.resolve([]),
  ]);
  return (
    <SummaryEditor
      admissionId={id}
      timezone={session.timezone}
      draft={view.draft}
      draftSaved={view.draftSaved ? { at: view.draftSaved.at.toISOString(), by: view.draftSaved.by } : null}
      versions={view.versions.map((v) => ({
        id: v.id,
        version: v.version,
        doctorName: v.doctorName,
        doctorUserId: v.doctorUserId,
        finalisedAt: v.finalisedAt.toISOString(),
        finalisedBy: v.finalisedBy,
        transcribed: v.transcribed,
        signedAt: v.signedAt?.toISOString() ?? null,
        signedBy: v.signedBy,
        changeReason: v.changeReason,
      }))}
      doctorId={view.doctorId}
      doctors={doctors}
      canEdit={canEdit}
      canSign={can(session.role, 'ipd.summary') && !session.readOnly}
      myUserId={session.userId}
    />
  );
}
