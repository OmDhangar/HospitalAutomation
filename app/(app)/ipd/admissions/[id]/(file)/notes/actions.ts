'use server';

import { revalidatePath } from 'next/cache';
import { ModuleUnavailableError, assertModule, getModuleStatesForRequest } from '@/lib/auth/modules';
import { requireWritableSession } from '@/lib/auth/session';
import { NoteError, parseNote } from '@/lib/domain/notes';
import { can } from '@/lib/domain/permissions';
import { moduleAllows } from '@/lib/modules/registry';
import { getAdmissionSummary } from '@/lib/services/ipd-census';
import { countersignNote, strikeOutNote, writeNote } from '@/lib/services/notes';

/**
 * Doctor's notes (IPD sheets plan C3). Each returns a result for a toast.
 * Writing needs `ipd.notes` (signed) or `ipd.notesTranscribe` (for the
 * doctor, countersigned later); the module must be on.
 */

export type NoteResult = { ok: true; message: string } | { ok: false; error: string };

const isId = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value);

async function run(admissionId: string, fn: () => Promise<string>): Promise<NoteResult> {
  try {
    const message = await fn();
    revalidatePath(`/ipd/admissions/${admissionId}/notes`);
    return { ok: true, message };
  } catch (err) {
    if (err instanceof NoteError || err instanceof ModuleUnavailableError) return { ok: false, error: err.message };
    console.error('[notes] action failed', err);
    return { ok: false, error: 'Could not save. Try again.' };
  }
}

export async function writeNoteDynamic(args: {
  admissionId: string;
  clientId: string;
  seenByDoctorId: string;
  note: Parameters<typeof parseNote>[0];
}): Promise<NoteResult> {
  return run(args.admissionId, async () => {
    const session = await requireWritableSession();
    const mayWrite = can(session.role, 'ipd.notes');
    const mayTranscribe = can(session.role, 'ipd.notesTranscribe');
    if (!mayWrite && !mayTranscribe) throw new NoteError('Your login cannot write notes');
    await assertModule(session, 'doctor_notes', 'write');
    if (!isId(args.clientId) || !isId(args.seenByDoctorId) || !isId(args.admissionId)) throw new NoteError('Choose the doctor who saw the patient');
    const admission = await getAdmissionSummary(session.hospitalId, args.admissionId);
    if (!admission) throw new NoteError('Patient not found');
    const states = await getModuleStatesForRequest(session.hospitalId);
    const result = await writeNote({
      hospitalId: session.hospitalId,
      admissionId: args.admissionId,
      input: parseNote(args.note),
      seenByDoctorId: args.seenByDoctorId,
      actorUserId: session.userId,
      mayTranscribe,
      chart: moduleAllows(states, 'charts', 'write', admission.bed?.wardId ?? null),
      clientId: args.clientId,
    });
    const chart = result.chart === 'written' ? ' The vitals are on the T.P.R. chart.' : '';
    return result.transcribed ? `Note saved. It waits for the doctor’s countersign.${chart}` : `Note saved.${chart}`;
  });
}

export async function countersignNoteDynamic(args: { admissionId: string; noteId: string }): Promise<NoteResult> {
  return run(args.admissionId, async () => {
    const session = await requireWritableSession();
    if (!can(session.role, 'ipd.countersign')) throw new NoteError('Your login cannot countersign');
    await assertModule(session, 'doctor_notes', 'write');
    await countersignNote({ hospitalId: session.hospitalId, noteId: args.noteId, actorUserId: session.userId });
    return 'Countersigned';
  });
}

export async function strikeOutNoteDynamic(args: { admissionId: string; noteId: string; reason: string }): Promise<NoteResult> {
  return run(args.admissionId, async () => {
    const session = await requireWritableSession();
    if (!can(session.role, 'ipd.notes') && !can(session.role, 'ipd.notesTranscribe')) throw new NoteError('Your login cannot do this');
    await assertModule(session, 'doctor_notes', 'write');
    await strikeOutNote({ hospitalId: session.hospitalId, noteId: args.noteId, reason: args.reason, actorUserId: session.userId, isOwner: session.role === 'owner' });
    return 'Note struck out';
  });
}
