import { NextResponse } from 'next/server';
import { CareEntryError, undoCareEntry } from '@/lib/services/care-entries';
import { ipdCaller } from '../../session';

/** The record screen's Undo: the nurse's own entry, within two minutes. */
export async function POST(request: Request) {
  const caller = await ipdCaller('ipd.record', { write: true });
  if ('response' in caller) return caller.response;
  let entryId = '';
  try {
    entryId = String(((await request.json()) as { entryId?: unknown }).entryId ?? '');
  } catch {
    return NextResponse.json({ error: 'Not JSON' }, { status: 400 });
  }
  if (!/^[0-9a-f-]{36}$/i.test(entryId)) return NextResponse.json({ error: 'Bad id' }, { status: 400 });
  try {
    await undoCareEntry({ hospitalId: caller.session.hospitalId, entryId, actorUserId: caller.session.userId });
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof CareEntryError) return NextResponse.json({ error: err.message }, { status: 409 });
    throw err;
  }
}
