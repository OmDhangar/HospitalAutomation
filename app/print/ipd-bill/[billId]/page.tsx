import { notFound, redirect } from 'next/navigation';
import { requireSession } from '@/lib/auth/session';
import { formatRupees } from '@/lib/domain/billing';
import { PAYER_KIND_LABELS, type PayerKind } from '@/lib/domain/payer';
import { can } from '@/lib/domain/permissions';
import { formatIndianPhone } from '@/lib/domain/phone';
import { formatTimeIn } from '@/lib/domain/time';
import { getBillForPrint, type BillLine } from '@/lib/services/discharge-billing';
import { PrintControls } from '../../prescription/[id]/print-controls';

export const metadata = { title: 'IPD bill' };

/**
 * The itemised IPD bill (IPD plan §T2.3), A4. Outside the app shell, like the
 * prescription, so there is nothing to hide with print CSS.
 *
 * Day by day: date, then time · item · quantity · rate · amount, and the
 * day's total. Then the totals, the payer's share, what was paid, and the
 * balance. Voided lines never print. A draft prints, marked provisional; a
 * final bill prints its frozen totals. Every print is logged.
 */
export default async function IpdBillPrintPage({ params, searchParams }: PageProps<'/print/ipd-bill/[billId]'>) {
  const session = await requireSession();
  if (session.mustChangePassword) redirect('/change-password');
  if (!can(session.role, 'ipd.discharge') && !can(session.role, 'billing.collect')) notFound();
  const { billId } = await params;
  const query = await searchParams;

  const bill = await getBillForPrint({ hospitalId: session.hospitalId, billId, actorUserId: session.userId });
  if (!bill) notFound();

  const tz = bill.timezone;
  const date = (at: Date | null) =>
    at ? at.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: tz }) : '—';
  const days = groupDays(bill.lines);
  const final = bill.bill.status === 'final';

  return (
    <main className="min-h-dvh bg-ink-100 py-8 print:bg-white print:py-0">
      <style>{'@page { size: A4; margin: 14mm 12mm 16mm; } @media print { .page-number::after { content: counter(page); } }'}</style>
      <div className="mx-auto max-w-[210mm] print:max-w-none">
        <PrintControls autoPrint={query.print !== '0'} />

        <article className="bg-white p-10 text-[12px] leading-snug text-ink-900 shadow-sm print:p-0 print:shadow-none">
          {!final ? (
            <p className="mb-4 rounded border-2 border-amber-600 px-3 py-2 text-center text-sm font-bold uppercase tracking-wide text-amber-800">
              Provisional — not the final bill
            </p>
          ) : null}

          <header className="flex items-start justify-between gap-6 border-b-2 border-ink-900 pb-3">
            <div>
              <h1 className="text-lg font-bold">{bill.hospital.name}</h1>
              <p className="text-ink-600">
                {bill.hospital.branchName}
                {bill.hospital.branchAddress ? ` · ${bill.hospital.branchAddress}` : ''}
              </p>
            </div>
            <div className="text-right">
              <p className="text-base font-bold">IPD bill</p>
              <p className="numeric">{bill.bill.billNumber ?? 'Draft'}</p>
              <p className="text-ink-600">{final ? date(bill.bill.finalizedAt) : date(new Date())}</p>
            </div>
          </header>

          <section className="grid grid-cols-2 gap-x-8 gap-y-1 border-b border-ink-300 py-3">
            <p>
              <span className="font-semibold">{bill.patient.name}</span>
              {bill.patient.age !== null ? `, ${bill.patient.age} yrs` : ''}
              {bill.patient.gender ? `, ${bill.patient.gender}` : ''}
            </p>
            <p className="text-right">
              Admitted {date(bill.admission.admittedAt)} · Discharged {date(bill.admission.dischargedAt)}
            </p>
            <p>
              {formatIndianPhone(bill.patient.phone)}
              {bill.patient.address ? ` · ${bill.patient.address}` : ''}
            </p>
            <p className="text-right">
              {bill.admission.doctorName}
              {bill.admission.bed ? ` · ${bill.admission.bed.wardName}, bed ${bill.admission.bed.label}` : ''}
            </p>
            {bill.payer && bill.payer.kind !== 'self' ? (
              <p className="col-span-2">
                Payer: {PAYER_KIND_LABELS[bill.payer.kind as PayerKind]} · {bill.payer.payerName}
                {bill.payer.policyNumber ? ` · Policy ${bill.payer.policyNumber}` : ''}
              </p>
            ) : null}
          </section>

          <table className="mt-3 w-full border-collapse">
            <thead>
              <tr className="border-b border-ink-900 text-left text-[11px] uppercase tracking-wide">
                <th className="py-1.5 pr-2 font-semibold">Time</th>
                <th className="py-1.5 pr-2 font-semibold">Item</th>
                <th className="py-1.5 pr-2 text-right font-semibold">Qty</th>
                <th className="py-1.5 pr-2 text-right font-semibold">Rate</th>
                <th className="py-1.5 text-right font-semibold">Amount</th>
              </tr>
            </thead>
            {days.map((day) => (
              <tbody key={day.date} className="break-inside-avoid">
                <tr>
                  <td colSpan={5} className="pt-3 pb-1 font-bold">
                    {new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(
                      new Date(`${day.date}T00:00:00Z`),
                    )}
                  </td>
                </tr>
                {day.lines.map((line) => (
                  <tr key={line.id} className="border-b border-ink-100 align-top">
                    <td className="numeric py-1 pr-2 text-ink-600">{line.at ? formatTimeIn(tz, line.at) : ''}</td>
                    <td className="py-1 pr-2">
                      {line.description}
                      {line.discountPaise > 0 ? (
                        <span className="block text-[11px] text-ink-600">
                          Less {formatRupees(line.discountPaise)}: {line.discountReason}
                        </span>
                      ) : null}
                    </td>
                    <td className="numeric py-1 pr-2 text-right">{line.quantity}</td>
                    <td className="numeric py-1 pr-2 text-right">{formatRupees(line.unitPricePaise)}</td>
                    <td className="numeric py-1 text-right">{formatRupees(line.totalPaise)}</td>
                  </tr>
                ))}
                <tr>
                  <td colSpan={4} className="py-1 pr-2 text-right text-ink-600">
                    Day total
                  </td>
                  <td className="numeric py-1 text-right font-semibold">{formatRupees(day.totalPaise)}</td>
                </tr>
              </tbody>
            ))}
          </table>

          <section className="ml-auto mt-4 w-72 break-inside-avoid border-t-2 border-ink-900 pt-2">
            <Total label="Charges" value={formatRupees(bill.totals.subtotalPaise)} />
            {bill.totals.discountPaise > 0 ? <Total label="Discounts" value={`− ${formatRupees(bill.totals.discountPaise)}`} /> : null}
            {bill.totals.taxPaise > 0 ? <Total label="Tax" value={formatRupees(bill.totals.taxPaise)} /> : null}
            <Total label="Bill total" value={formatRupees(bill.totals.totalPaise)} strong />
            {bill.split.payerSharePaise > 0 ? (
              <Total label={`${bill.payer?.payerName ?? 'Payer'} share`} value={`− ${formatRupees(bill.split.payerSharePaise)}`} />
            ) : null}
            {bill.payments.map((payment) => (
              <Total
                key={payment.id}
                label={`${payment.kind === 'refund' ? 'Refunded' : 'Paid'} ${date(payment.receivedAt)} (${payment.method.toUpperCase()})`}
                value={`${payment.kind === 'refund' ? '+' : '−'} ${formatRupees(payment.amountPaise)}`}
              />
            ))}
            <Total
              label={bill.split.balancePaise < 0 ? 'Refund due' : 'Balance to pay'}
              value={formatRupees(Math.abs(bill.split.balancePaise))}
              strong
            />
          </section>

          <footer className="mt-12 flex items-end justify-between text-[11px] text-ink-600">
            <p>
              Page <span className="page-number" />
            </p>
            <div className="w-48 border-t border-ink-900 pt-1 text-center">Authorised signatory</div>
          </footer>
        </article>
      </div>
    </main>
  );
}

function Total({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <p className={strong ? 'flex justify-between py-1 text-[13px] font-bold' : 'flex justify-between py-0.5'}>
      <span>{label}</span>
      <span className="numeric">{value}</span>
    </p>
  );
}

function groupDays(lines: readonly BillLine[]) {
  const days = new Map<string, { date: string; lines: BillLine[]; totalPaise: number }>();
  for (const line of lines) {
    const day = days.get(line.day) ?? { date: line.day, lines: [], totalPaise: 0 };
    day.lines.push(line);
    day.totalPaise += line.totalPaise;
    days.set(line.day, day);
  }
  return [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
}
