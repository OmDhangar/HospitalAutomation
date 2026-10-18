'use server';

import { revalidatePath } from 'next/cache';
import { ModuleUnavailableError, assertModule } from '@/lib/auth/modules';
import { requireWritableSession } from '@/lib/auth/session';
import { SummaryError, parseSummary, type SummaryContent } from '@/lib/domain/discharge-summary';
import { can } from '@/lib/domain/permissions';
import { countersignSummary, finaliseSummary, refreshDraft, saveDraft } from '@/lib/services/discharge-summary';

/** Discharge summary (IPD sheets plan B5): save the draft, fill from the record, finalise, sign. */

export type SummaryResult = { ok: true; message: string; content?: SummaryContent } | { ok: false; error: string };

const isId = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value);

async function begin(admissionId: string) {
  const session = await requireWritableSession();
  if (!can(session.role, 'ipd.summary') && !can(session.role, 'ipd.summaryTranscribe')) throw new SummaryError('Your login cannot write the summary');
  await assertModule(session, 'discharge_summary', 'write');
  if (!isId(admissionId)) throw new SummaryError('Patient not found');
  return session;
}

async function run(admissionId: string, fn: () => Promise<SummaryResult>): Promise<SummaryResult> {
  try {
    const result = await fn();
    revalidatePath(`/ipd/admissions/${admissionId}/discharge-summary`);
    return result;
  } catch (err) {
    if (err instanceof SummaryError || err instanceof ModuleUnavailableError) return { ok: false, error: err.message };
    console.error('[summary] action failed', err);
    return { ok: false, error: 'Could not save. Try again.' };
  }
}

export async function saveSummaryDraftDynamic(args: { admissionId: string; content: Record<string, unknown> }): Promise<SummaryResult> {
  return run(args.admissionId, async () => {
    const session = await begin(args.admissionId);
    await saveDraft({ hospitalId: session.hospitalId, admissionId: args.admissionId, content: parseSummary(args.content), actorUserId: session.userId });
    return { ok: true, message: 'Draft saved' };
  });
}

export async function refreshSummaryDynamic(args: { admissionId: string; content: Record<string, unknown> }): Promise<SummaryResult> {
  return run(args.admissionId, async () => {
    const session = await begin(args.admissionId);
    const content = await refreshDraft({ hospitalId: session.hospitalId, admissionId: args.admissionId, current: parseSummary(args.content), timezone: session.timezone, actorUserId: session.userId });
    return { ok: true, message: 'Tests, treatment and medicines filled again from the record', content };
  });
}

export async function finaliseSummaryDynamic(args: {
  admissionId: string;
  content: Record<string, unknown>;
  doctorId: string;
  changeReason: string;
  clientId: string;
}): Promise<SummaryResult> {
  return run(args.admissionId, async () => {
    const session = await begin(args.admissionId);
    if (!isId(args.doctorId) || !isId(args.clientId)) throw new SummaryError('Choose the doctor responsible');
    const result = await finaliseSummary({
      hospitalId: session.hospitalId,
      admissionId: args.admissionId,
      content: parseSummary(args.content, { final: true }),
      doctorId: args.doctorId,
      changeReason: args.changeReason || null,
      actorUserId: session.userId,
      mayTranscribe: can(session.role, 'ipd.summaryTranscribe'),
      clientId: args.clientId,
    });
    return { ok: true, message: result.signed ? `Version ${result.version} finalised and signed` : `Version ${result.version} finalised. It waits for the doctor’s signature.` };
  });
}

export async function countersignSummaryDynamic(args: { admissionId: string; summaryId: string }): Promise<SummaryResult> {
  return run(args.admissionId, async () => {
    const session = await requireWritableSession();
    if (!can(session.role, 'ipd.summary')) throw new SummaryError('Your login cannot sign the summary');
    await assertModule(session, 'discharge_summary', 'write');
    await countersignSummary({ hospitalId: session.hospitalId, summaryId: args.summaryId, actorUserId: session.userId });
    return { ok: true, message: 'Summary signed' };
  });
}
