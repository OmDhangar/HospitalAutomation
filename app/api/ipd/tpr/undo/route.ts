import { NextResponse } from 'next/server';
import { TprError, undoTprEntry } from '@/lib/services/tpr';
import { ipdCaller } from '../../session';

/** Undo on the T.P.R. chart: the nurse's own reading, within two minutes. */
export async function POST(request: Request) {
  const caller = await ipdCaller('ipd.chart', { write: true, module: 'charts' });
  if ('response' in caller) return caller.response;
  let entryId = '';
  try {
    entryId = String(((await request.json()) as { entryId?: unknown }).entryId ?? '');
  } catch {
    return NextResponse.json({ error: 'Not JSON' }, { status: 400 });
  }
  if (!/^[0-9a-f-]{36}$/i.test(entryId)) return NextResponse.json({ error: 'Bad id' }, { status: 400 });
  try {
    await undoTprEntry({ hospitalId: caller.session.hospitalId, entryId, actorUserId: caller.session.userId });
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof TprError) return NextResponse.json({ error: err.message }, { status: 409 });
    throw err;
  }
}
