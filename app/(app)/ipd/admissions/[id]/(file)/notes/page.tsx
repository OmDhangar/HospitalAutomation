import { notFound } from 'next/navigation';
import { requireModule } from '@/lib/auth/modules';
import { requireSession } from '@/lib/auth/session';
import { can } from '@/lib/domain/permissions';
import { moduleAllows } from '@/lib/modules/registry';
import { listOrderingDoctors } from '@/lib/services/mar';
import { getNoteContext, listNotes } from '@/lib/services/notes';
import { loadAdmission } from '../data';
import { NotesBoard } from './notes-board';

export const metadata = { title: 'Doctor’s notes · IPD' };

/**
 * The doctor's notes tab (IPD sheets plan C3): the case sheet and progress
 * notes. Writing is open while the patient is in the hospital.
 */
export default async function NotesPage({ params }: PageProps<'/ipd/admissions/[id]/notes'>) {
  const session = await requireSession();
  const states = await requireModule(session, 'doctor_notes');
  const { id } = await params;
  const admission = await loadAdmission(session.hospitalId, id);
  if (!admission) notFound();
  const open = admission.status !== 'discharged' && admission.status !== 'cancelled';
  const mayWrite = can(session.role, 'ipd.notes');
  const mayTranscribe = can(session.role, 'ipd.notesTranscribe');
  const canWrite = open && (mayWrite || mayTranscribe) && !session.readOnly && moduleAllows(states, 'doctor_notes', 'write');
  const [notes, context, doctors] = await Promise.all([
    listNotes(session.hospitalId, id),
    getNoteContext(session.hospitalId, id),
    canWrite ? listOrderingDoctors(session.hospitalId) : Promise.resolve([]),
  ]);
  const myDoctor = doctors.find((d) => d.userId === session.userId);

  return (
    <NotesBoard
      admissionId={id}
      timezone={session.timezone}
      notes={notes.map((n) => ({
        ...n,
        seenAt: n.seenAt.toISOString(),
        generalExam: n.generalExam as Record<string, string>,
        systemicExam: n.systemicExam as Record<string, string>,
        countersignedAt: n.countersignedAt?.toISOString() ?? null,
        voided: Boolean(n.voidedAt),
        voidedAt: undefined,
      }))}
      recent={context.recent ? { observedAt: context.recent.observedAt.toISOString(), vitals: context.recent.vitals } : null}
      hasAdmissionNote={context.hasAdmissionNote}
      doctors={doctors}
      defaultDoctorId={myDoctor?.id ?? admission.doctorId}
      canWrite={canWrite}
      transcribing={!mayWrite || (!myDoctor && session.role !== 'owner')}
      canCountersign={can(session.role, 'ipd.countersign') && !session.readOnly}
      myUserId={session.userId}
      isOwner={session.role === 'owner'}
    />
  );
}
