import { NextResponse } from 'next/server';
import { canUndoEntry, parseCareEntryBatch } from '@/lib/domain/care-entry';
import { serviceDateIn } from '@/lib/domain/time';
import { listEntriesForAdmission, recordCareEntries } from '@/lib/services/care-entries';
import { ipdCaller } from '../session';

/**
 * Bedside entries from the nurse's phone (IPD plan §5.6, task T1.7).
 *
 * A route handler, not a server action (ADR-015): server actions run one at a
 * time per page, and an outbox flush of ten offline entries must not queue
 * behind — or block — the next tap.
 *
 *   POST { entries: [...] }       record a batch; one result per entry
 *   GET  ?admissionId=…           today's entries for the record screen
 *
 * The request schema is strict and has no price field. The response has no
 * prices either: nurses never see them.
 */
export async function POST(request: Request) {
  const caller = await ipdCaller('ipd.record', { write: true });
  if ('response' in caller) return caller.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Not JSON' }, { status: 400 });
  }
  const parsed = parseCareEntryBatch(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const results = await recordCareEntries({
    hospitalId: caller.session.hospitalId,
    entries: parsed.entries,
    actorUserId: caller.session.userId,
  });
  // `billed` is dropped: whether an item is priced is the owner's business.
  return NextResponse.json({
    results: results.map((result) =>
      result.ok
        ? { clientId: result.clientId, ok: true, entryId: result.entryId, description: result.description }
        : result,
    ),
  });
}

export async function GET(request: Request) {
  const caller = await ipdCaller('ipd.record');
  if ('response' in caller) return caller.response;
  const admissionId = new URL(request.url).searchParams.get('admissionId') ?? '';
  if (!/^[0-9a-f-]{36}$/i.test(admissionId)) return NextResponse.json({ error: 'Bad id' }, { status: 400 });

  const { session } = caller;
  const now = new Date();
  const today = serviceDateIn(session.timezone, now);
  const entries = await listEntriesForAdmission({
    hospitalId: session.hospitalId,
    admissionId,
    actorUserId: session.userId,
  });
  return NextResponse.json({
    entries: entries
      .filter((entry) => !entry.voidedAt && serviceDateIn(session.timezone, entry.occurredAt) === today)
      .map((entry) => ({
        id: entry.id,
        description: entry.description,
        quantity: entry.quantity,
        occurredAt: entry.occurredAt.toISOString(),
        recordedByName: entry.recordedByName,
        canUndo: canUndoEntry({
          recordedByUserId: entry.recordedByUserId,
          actorUserId: session.userId,
          recordedAt: entry.recordedAt,
          voided: false,
          now,
        }),
        undoUntil:
          entry.recordedByUserId === session.userId
            ? new Date(entry.recordedAt.getTime() + 2 * 60_000).toISOString()
            : null,
      })),
  });
}
