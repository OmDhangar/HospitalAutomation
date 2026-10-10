import { CONTROL_FLAGS, DOSE_MARK, DOSE_STATES, REASONS, ROUTES } from '@/lib/domain/mar';
import { chartDayOf } from '@/lib/domain/tpr';
import type { CardDose, CardOrder } from '@/lib/services/mar';

/**
 * The treatment card and MAR on paper (IPD sheets plan B3-min): the doctor's
 * lines with who ordered, wrote and countersigned them; then each chart day's
 * doses in time order with the paper marks (✓ given, H held, R refused, ✗ not
 * given), who gave them, the witness, and anything a rule found missing.
 */
export function TreatmentSheet({ card, timezone }: { card: { orders: CardOrder[]; doses: CardDose[] }; timezone: string }) {
  const at = (d: Date) => d.toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: timezone });
  const time = (d: Date) => d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: timezone });
  const orderName = new Map(card.orders.map((o) => [o.id, o.description]));
  const days = new Map<string, CardDose[]>();
  for (const d of card.doses) {
    const day = chartDayOf(d.occurredAt, timezone);
    days.set(day, [...(days.get(day) ?? []), d]);
  }
  const th = 'border border-ink-400 px-1.5 py-1 text-left font-semibold';
  const td = 'border border-ink-300 px-1.5 py-1 align-top';

  return (
    <div className="mt-3 space-y-4">
      <table className="w-full border-collapse text-[11px]">
        <thead>
          <tr>
            <th className={th}>Treatment</th>
            <th className={th}>Dose · route · frequency</th>
            <th className={th}>Ordered</th>
            <th className={th}>Status</th>
          </tr>
        </thead>
        <tbody>
          {card.orders.length === 0 ? (
            <tr>
              <td className={td} colSpan={4}>
                No treatment written.
              </td>
            </tr>
          ) : (
            card.orders.map((o) => (
              <tr key={o.id} className={o.status === 'struck_out' ? 'line-through' : undefined}>
                <td className={td}>
                  {o.description}
                  {o.risk ? ` [${o.risk.className}]` : ''}
                </td>
                <td className={td}>
                  {o.kind === 'medicine' ? `${o.dose} · ${o.route ? ROUTES[o.route] : ''} · ${o.frequency}` : '—'}
                  {o.instructions ? ` · ${o.instructions}` : ''}
                </td>
                <td className={td}>
                  {o.doctorName}, {at(o.orderedAt)}
                  {o.transcribed ? ` (written by ${o.enteredBy ?? 'staff'}; ${o.countersignedAt ? 'countersigned' : 'NOT countersigned'})` : ''}
                </td>
                <td className={td}>
                  {o.status === 'stopped' ? `Stopped ${o.stoppedAt ? at(o.stoppedAt) : ''}: ${o.stopReason}` : o.status === 'struck_out' ? 'Struck out' : o.status === 'awaiting_countersign' ? 'Awaiting countersign' : 'Active'}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>

      {[...days.entries()].map(([day, doses]) => (
        <section key={day} className="break-inside-avoid">
          <h3 className="mb-1 text-[12px] font-bold">
            MAR · {new Date(`${day}T00:00:00Z`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })} (8 am to 8 am)
          </h3>
          <table className="w-full border-collapse text-[11px]">
            <thead>
              <tr>
                <th className={th}>Time</th>
                <th className={th}>Medicine</th>
                <th className={th}>Mark</th>
                <th className={th}>Dose / reason</th>
                <th className={th}>By</th>
                <th className={th}>Witness</th>
              </tr>
            </thead>
            <tbody>
              {doses.map((d) => (
                <tr key={d.id} className={d.voidedAt ? 'line-through' : undefined}>
                  <td className={td}>{time(d.occurredAt)}</td>
                  <td className={td}>{orderName.get(d.orderId)}</td>
                  <td className={td}>
                    {DOSE_MARK[d.state]} {DOSE_STATES[d.state]}
                  </td>
                  <td className={td}>
                    {d.state === 'given' ? (d.dose ?? '') : d.reasonCode ? REASONS[d.reasonCode] : ''}
                    {d.reasonText ? ` — ${d.reasonText}` : ''}
                    {d.flags.length ? ` ⚑ ${d.flags.map((f) => CONTROL_FLAGS[f]).join('; ')}` : ''}
                    {d.voidedAt ? ` (struck out: ${d.voidReason})` : ''}
                  </td>
                  <td className={td}>{d.recordedBy}</td>
                  <td className={td}>{d.witnessStatus === 'witnessed' ? d.witnessedBy : d.witnessStatus === 'not_needed' ? '' : 'none'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </div>
  );
}
