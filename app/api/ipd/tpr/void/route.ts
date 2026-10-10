import { NextResponse } from 'next/server';
import { TprError, voidTprEntry } from '@/lib/services/tpr';
import { ipdCaller } from '../../session';

/** Correct a wrong reading: it is struck through with a reason, never edited. */
export async function POST(request: Request) {
  const caller = await ipdCaller('ipd.chart', { write: true, module: 'charts' });
  if ('response' in caller) return caller.response;
  let entryId = '';
  let reason = '';
  try {
    const body = (await request.json()) as { entryId?: unknown; reason?: unknown };
    entryId = String(body.entryId ?? '');
    reason = String(body.reason ?? '');
  } catch {
    return NextResponse.json({ error: 'Not JSON' }, { status: 400 });
  }
  if (!/^[0-9a-f-]{36}$/i.test(entryId)) return NextResponse.json({ error: 'Bad id' }, { status: 400 });
  try {
    await voidTprEntry({ hospitalId: caller.session.hospitalId, entryId, actorUserId: caller.session.userId, reason });
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof TprError) return NextResponse.json({ error: err.message }, { status: 409 });
    throw err;
  }
}
