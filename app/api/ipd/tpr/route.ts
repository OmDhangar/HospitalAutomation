import { NextResponse } from 'next/server';
import { moduleAllows } from '@/lib/modules/registry';
import { chartDayOf, isChartDay, parseTprBatch } from '@/lib/domain/tpr';
import { getTprDay, recordTprEntries, undoableUntil } from '@/lib/services/tpr';
import { ipdCaller } from '../session';

/**
 * The T.P.R. chart from the nurse's phone (IPD sheets plan B1).
 *
 * A route handler, like bedside entries (ADR-015), so an outbox flush never
 * queues behind the next tap.
 *
 *   POST { entries: [...] }            record a batch; one result per reading
 *   GET  ?admissionId=…&day=YYYY-MM-DD one chart day (8 am–8 am); today's by default
 */
export async function POST(request: Request) {
  const caller = await ipdCaller('ipd.chart', { write: true, module: 'charts' });
  if ('response' in caller) return caller.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Not JSON' }, { status: 400 });
  }
  const parsed = parseTprBatch(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const { session, states } = caller;
  const results = await recordTprEntries({
    hospitalId: session.hospitalId,
    entries: parsed.entries,
    actorUserId: session.userId,
    // The module may be on for some wards only: each reading is checked against the patient's ward.
    wardAllowed: (wardId) => (states ? moduleAllows(states, 'charts', 'write', wardId) : true),
  });
  return NextResponse.json({ results });
}

export async function GET(request: Request) {
  const caller = await ipdCaller('ipd.view', { module: 'charts' });
  if ('response' in caller) return caller.response;
  const url = new URL(request.url);
  const admissionId = url.searchParams.get('admissionId') ?? '';
  if (!/^[0-9a-f-]{36}$/i.test(admissionId)) return NextResponse.json({ error: 'Bad id' }, { status: 400 });

  const { session } = caller;
  const now = new Date();
  const dayParam = url.searchParams.get('day');
  if (dayParam !== null && !isChartDay(dayParam)) return NextResponse.json({ error: 'Bad day' }, { status: 400 });
  const day = dayParam ?? chartDayOf(now, session.timezone);

  const chart = await getTprDay({ hospitalId: session.hospitalId, admissionId, day, timezone: session.timezone });
  return NextResponse.json({
    day: chart.day,
    readings: chart.readings.map(({ recordedByUserId, ...reading }) => ({
      ...reading,
      observedAt: reading.observedAt.toISOString(),
      recordedAt: reading.recordedAt.toISOString(),
      voidedAt: null,
      undoUntil: undoableUntil({ recordedByUserId, recordedAt: reading.recordedAt, voidedAt: null }, session.userId, now)?.toISOString() ?? null,
    })),
    voided: chart.voided.map((reading) => ({
      id: reading.id,
      observedAt: reading.observedAt.toISOString(),
      voidReason: reading.voidReason,
    })),
    treatment: chart.treatment.map((given) => ({ ...given, occurredAt: given.occurredAt.toISOString() })),
    totals: chart.totals,
  });
}
