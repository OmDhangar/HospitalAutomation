import { NextResponse } from 'next/server';
import { MarError } from '@/lib/domain/mar';
import { getWardBoard } from '@/lib/services/due';
import { ipdCaller } from '../session';

/**
 * The ward's due board as data (IPD sheets plan B3b, §7.10): the tablet keeps
 * the last copy and recomputes due times itself when the connection drops.
 *
 *   GET ?wardId=…   timed lines, doses, snoozes, escalations, settings
 */
export async function GET(request: Request) {
  const caller = await ipdCaller('ipd.dueBoard', { module: 'mar' });
  if ('response' in caller) return caller.response;
  const wardId = new URL(request.url).searchParams.get('wardId') ?? '';
  if (!/^[0-9a-f-]{36}$/i.test(wardId)) return NextResponse.json({ error: 'Bad id' }, { status: 400 });
  const { session } = caller;
  try {
    const board = await getWardBoard({ hospitalId: session.hospitalId, wardId, userId: session.userId, timezone: session.timezone });
    return NextResponse.json(board, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    if (err instanceof MarError) return NextResponse.json({ error: err.message }, { status: 404 });
    throw err;
  }
}
