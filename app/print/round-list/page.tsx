import { notFound } from 'next/navigation';
import { PrintButton } from '@/components/booking-trace/print-button';
import { requireModule } from '@/lib/auth/modules';
import { requireSession } from '@/lib/auth/session';
import { DEFAULT_SLOTS, TASK_KINDS, boardInstances, slotOf } from '@/lib/domain/due';
import { MarError } from '@/lib/domain/mar';
import { can } from '@/lib/domain/permissions';
import { getWardBoard } from '@/lib/services/due';

export const metadata = { title: 'Round list' };

const hourLabel = (h: number) => (h === 0 ? '12a' : h < 12 ? `${h}a` : h === 12 ? '12p' : `${h - 12}p`);

/**
 * The paper round list (IPD sheets plan B3b, §7.10): the due board's grid for
 * the chart day, A4 landscape — the backup when the tablets are down. Given
 * doses carry ✓ and the time; due doses show their time, with a box to tick.
 */
export default async function RoundListPrint({ searchParams }: PageProps<'/print/round-list'>) {
  const session = await requireSession();
  await requireModule(session, 'mar');
  if (!can(session.role, 'ipd.dueBoard')) notFound();
  const query = await searchParams;
  const wardId = typeof query.ward === 'string' && /^[0-9a-f-]{36}$/i.test(query.ward) ? query.ward : null;
  if (!wardId) notFound();
  let board;
  try {
    board = await getWardBoard({ hospitalId: session.hospitalId, wardId, userId: session.userId, timezone: session.timezone });
  } catch (err) {
    if (err instanceof MarError) notFound();
    throw err;
  }
  const now = new Date(board.serverNow);
  const items = boardInstances(board, now).filter((i) => i.instance.dueAt >= new Date(now.getTime() - 12 * 3_600_000));
  const time = (d: Date) => d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: session.timezone });
  const printed = now.toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: session.timezone });

  return (
    <main className="bg-white p-4 text-[11px] text-ink-900 print:p-0">
      <style>{'@page { size: A4 landscape; margin: 8mm; }'}</style>
      <div className="mb-2 flex items-center justify-between print:hidden">
        <h1 className="text-lg font-bold">Round list</h1>
        <PrintButton />
      </div>
      <p className="mb-2 text-sm font-bold">
        {session.hospitalName} · {board.ward.name} · medication round list · printed {printed}
      </p>
      <table className="w-full border-collapse">
        <thead>
          <tr>
            <th className="w-56 border border-ink-500 px-1 py-1 text-left">Bed · patient · line</th>
            {DEFAULT_SLOTS.map((h) => (
              <th key={h} className="border border-ink-500 px-1 py-1">
                {hourLabel(h)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {board.beds
            .filter((b) => b.admissionId)
            .flatMap((bed) => [
              <tr key={bed.bedId}>
                <td colSpan={DEFAULT_SLOTS.length + 1} className="border border-ink-500 bg-ink-100 px-1 py-1 font-bold">
                  Bed {bed.label} · {bed.patientName} {bed.detail ? `(${bed.detail})` : ''}
                </td>
              </tr>,
              ...board.lines
                .filter((l) => l.admissionId === bed.admissionId)
                .map((line) => (
                  <tr key={line.orderId} className="break-inside-avoid">
                    <td className="border border-ink-400 px-1 py-1">
                      {line.timeCritical ? '⏰ TC · ' : ''}
                      {line.kind === 'task' && line.taskKind ? `${TASK_KINDS[line.taskKind]}: ` : ''}
                      {line.description} {line.dose ?? ''} {line.route ? `· ${line.route.toUpperCase()}` : ''}
                    </td>
                    {DEFAULT_SLOTS.map((h) => {
                      const cell = items.filter((i) => i.line.orderId === line.orderId && slotOf(i.instance.dueAt, session.timezone) === h);
                      return (
                        <td key={h} className="h-7 border border-ink-400 px-1 text-center align-top">
                          {cell.map((i) => (
                            <div key={i.instance.dueAt.getTime()}>
                              {i.instance.record
                                ? i.instance.record.state === 'given'
                                  ? `✓ ${time(i.instance.record.occurredAt)}`
                                  : i.instance.record.state === 'held'
                                    ? 'H'
                                    : i.instance.record.state === 'refused'
                                      ? 'R'
                                      : '✗'
                                : `☐ ${time(i.instance.dueAt)}`}
                            </div>
                          ))}
                        </td>
                      );
                    })}
                  </tr>
                )),
            ])}
        </tbody>
      </table>
      <p className="mt-2 text-[10px] text-ink-600">✓ given (time) · H held · R refused · ✗ not given · ☐ due: tick and sign; enter in the app when it is back.</p>
    </main>
  );
}
