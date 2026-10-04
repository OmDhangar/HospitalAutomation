import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Alert, Button, Card, CardHeader, EmptyState, Field, Input, cn } from '@/components/ui';
import { AlertTriangleIcon, CheckIcon, FileTextIcon } from '@/components/icons';
import { PatientHeader } from '@/components/ipd/patient-header';
import { requireSession } from '@/lib/auth/session';
import { formatRupees } from '@/lib/domain/billing';
import type { AdmissionStatus } from '@/lib/domain/admission';
import { PAYER_KIND_LABELS } from '@/lib/domain/payer';
import { can } from '@/lib/domain/permissions';
import { isMockPhone } from '@/lib/domain/phone';
import { formatTimeIn, serviceDateIn } from '@/lib/domain/time';
import { getDischargeBillView, type BillLine } from '@/lib/services/discharge-billing';
import {
  discountLineAction,
  finalizeAction,
  recordPaymentAction,
  revokeBillLinkAction,
  setApprovedAmountAction,
  shareBillLinkAction,
  undoBillAction,
  voidLineAction,
} from './actions';
import { SavedNotice } from '@/components/saved-notice';
import { UNDO_WINDOWS_MS, formatUndoToken, withinWindow } from '@/lib/domain/undo';

export const metadata = { title: 'Discharge bill · IPD' };

const SELECT_CLASS =
  'block w-full rounded-lg border-0 bg-white px-3 py-2.5 text-ink-900 ring-1 ring-inset ring-ink-300 focus:ring-2 focus:ring-inset focus:ring-brand-600 focus:outline-none';

/**
 * Discharge billing (IPD plan §T2.2). The bill already exists — built at the
 * bedside — so this screen is a review: flags first, then the day-wise
 * lines with a reasoned void or discount on each, the payer and the money
 * received, and one Finalise. Then Print and Send.
 */
export default async function DischargeBillPage({ params, searchParams }: PageProps<'/ipd/admissions/[id]/bill'>) {
  const session = await requireSession();
  const { id } = await params;
  const query = await searchParams;

  if (!can(session.role, 'ipd.discharge')) {
    return (
      <Card>
        <EmptyState title="The desk prepares the bill" hint="Ask reception to open the discharge bill." />
      </Card>
    );
  }
  const view = await getDischargeBillView({ hospitalId: session.hospitalId, admissionId: id });
  if (!view) notFound();

  const final = view.bill?.status === 'final';
  const writable = !session.readOnly;
  const canCorrect = can(session.role, 'ipd.correct') && writable && !final;
  const canCollect = can(session.role, 'billing.collect') && writable;
  const live = view.lines.filter((line) => !line.voidedAt);
  const days = groupDays(view.lines, session.timezone);
  const blocking = view.flags.unpriced.length;
  const sharedToken = typeof query.link === 'string' ? query.link : null;
  const shareUrl = sharedToken ? `${(process.env.PUBLIC_BASE_URL ?? '').replace(/\/$/, '')}/b/${sharedToken}` : null;
  const whatsappText = shareUrl
    ? `Hospital bill for ${view.admission.patientName}, updated as items are given: ${shareUrl}`
    : '';

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <Link href={`/ipd/admissions/${id}`} className="inline-flex min-h-11 items-center text-sm text-ink-500 hover:text-ink-800">
        ← Back to {view.admission.patientName}
      </Link>

      <PatientHeader
        name={view.admission.patientName}
        age={view.admission.age}
        gender={view.admission.gender}
        phoneE164={view.admission.phoneE164}
        bed={view.admission.bed}
        admittedAt={view.admission.admittedAt}
        doctorName={view.admission.doctorName}
        status={view.admission.status as AdmissionStatus}
        timezone={session.timezone}
        now={new Date()}
        sticky={false}
      />

      {typeof query.error === 'string' ? <Alert tone="error">{query.error}</Alert> : null}
      {typeof query.saved === 'string' ? (
        <SavedNotice
          message={query.saved}
          undo={typeof query.undo === 'string' ? query.undo : null}
          action={undoBillAction}
          hidden={{ admissionId: id }}
          // A final bill is reopened, with a reason, rather than silently undone.
          reasonPrompt={typeof query.undo === 'string' && query.undo.startsWith('finalize~') ? 'Why reopen?' : undefined}
        />
      ) : null}

      {shareUrl ? (
        <Card>
          <CardHeader title="Running bill link" hint="Send it now: it is shown only once." />
          <div className="space-y-3 p-4 sm:p-5">
            <p className="break-all rounded-lg bg-ink-50 px-3 py-2 font-mono text-sm text-ink-800">{shareUrl}</p>
            {isMockPhone(view.admission.phoneE164) ? (
              <p className="text-sm text-ink-600">No phone on file: copy the link or print the bill.</p>
            ) : (
              <a
                href={`https://wa.me/${view.admission.phoneE164.replace(/^\+/, '')}?text=${encodeURIComponent(whatsappText)}`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex min-h-12 items-center rounded-lg bg-emerald-600 px-5 font-semibold text-white hover:bg-emerald-700"
              >
                Send on WhatsApp
              </a>
            )}
          </div>
        </Card>
      ) : null}

      {final && view.bill ? (
        <Card>
          <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5">
            <p className="flex items-center gap-2 text-base font-semibold text-emerald-800">
              <CheckIcon className="size-5" />
              Bill {view.bill.billNumber} is final.
            </p>
            <div className="flex flex-wrap gap-2">
              <a href={`/print/ipd-bill/${view.bill.id}`} target="_blank" rel="noreferrer">
                <Button variant="primary" size="lg" className="gap-2">
                  <FileTextIcon className="size-5" />
                  Print bill
                </Button>
              </a>
              {writable ? (
                <form action={shareBillLinkAction}>
                  <input type="hidden" name="admissionId" value={id} />
                  <Button type="submit" size="lg">
                    Send on WhatsApp
                  </Button>
                </form>
              ) : null}
            </div>
          </div>
          {writable &&
          view.admission.dischargedAt &&
          withinWindow(view.admission.dischargedAt, UNDO_WINDOWS_MS.reopenBill) ? (
            <details className="border-t border-ink-100 px-4 py-3 text-sm sm:px-5">
              <summary className="cursor-pointer text-ink-500 hover:text-ink-800">Found a mistake? Reopen this bill</summary>
              <form action={undoBillAction} className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
                <input type="hidden" name="admissionId" value={id} />
                <input type="hidden" name="undo" value={formatUndoToken('finalize', id)} />
                <Input name="reason" required placeholder="Why reopen?" className="py-2 text-sm" />
                <Button type="submit" size="sm">
                  Reopen bill
                </Button>
              </form>
              <p className="mt-2 text-xs text-ink-500">
                Bill {view.bill.billNumber} is kept as cancelled; its lines move to a new draft. Possible on the day of discharge.
              </p>
            </details>
          ) : null}
        </Card>
      ) : null}

      {!final && (view.flags.unpriced.length > 0 || view.flags.possibleDuplicates.length > 0 || view.flags.lateRecordings.length > 0) ? (
        <Card>
          <CardHeader title="Check these first" />
          <ul className="divide-y divide-ink-100 text-sm">
            {view.flags.unpriced.map((flag) => (
              <FlagRow key={`u-${flag.id}`} tone="error" timezone={session.timezone} flag={flag}>
                No price — not on the bill. Finalise is blocked until it is priced or removed.
              </FlagRow>
            ))}
            {view.flags.possibleDuplicates.map((flag) => (
              <FlagRow key={`d-${flag.id}`} tone="warn" timezone={session.timezone} flag={flag}>
                Same item within 15 minutes of another — recorded twice?
              </FlagRow>
            ))}
            {view.flags.lateRecordings.map((flag) => (
              <FlagRow key={`l-${flag.id}`} tone="warn" timezone={session.timezone} flag={flag}>
                Recorded more than 6 hours after it was given.
              </FlagRow>
            ))}
          </ul>
          {view.flags.unpriced.length > 0 && can(session.role, 'billing.price') ? (
            <p className="border-t border-ink-100 px-5 py-3 text-sm">
              <Link href="/settings/ipd/items?mode=prices" className="font-semibold text-brand-700 underline">
                Set prices for IPD items
              </Link>{' '}
              ·{' '}
              <Link href="/settings/medicines?mode=prices" className="font-semibold text-brand-700 underline">
                medicines
              </Link>
            </p>
          ) : null}
        </Card>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[1fr_20rem] lg:items-start">
        <Card>
          <CardHeader title="Bill, day by day" hint={`${live.length} line${live.length === 1 ? '' : 's'}`} />
          {days.length === 0 ? (
            <EmptyState title="Nothing charged yet." />
          ) : (
            days.map((day) => (
              <section key={day.date} className="border-b border-ink-100 last:border-0">
                <h3 className="flex items-center justify-between bg-ink-50 px-4 py-2 text-xs font-bold uppercase tracking-wide text-ink-600 sm:px-5">
                  <span>{day.label}</span>
                  <span className="numeric">{formatRupees(day.totalPaise)}</span>
                </h3>
                <ul className="divide-y divide-ink-100">
                  {day.lines.map((line) => (
                    <LineRow key={line.id} line={line} timezone={session.timezone} admissionId={id} canCorrect={canCorrect} />
                  ))}
                </ul>
              </section>
            ))
          )}
        </Card>

        <div className="space-y-4 lg:sticky lg:top-20">
          <Card>
            <CardHeader title="Total" />
            <dl className="divide-y divide-ink-100 text-sm">
              <Row label="Charges" value={formatRupees(view.totals.subtotalPaise)} />
              {view.totals.discountPaise > 0 ? <Row label="Discounts" value={`− ${formatRupees(view.totals.discountPaise)}`} /> : null}
              {view.totals.taxPaise > 0 ? <Row label="Tax" value={formatRupees(view.totals.taxPaise)} /> : null}
              <Row label="Bill total" value={formatRupees(view.totals.totalPaise)} strong />
              {view.split.payerSharePaise > 0 ? (
                <Row label={`${view.payer?.payerName ?? 'Payer'} pays`} value={`− ${formatRupees(view.split.payerSharePaise)}`} />
              ) : null}
              <Row label="Received from patient" value={`− ${formatRupees(view.split.paidPaise)}`} />
              <Row
                label={view.split.balancePaise < 0 ? 'Refund due' : 'Patient to pay'}
                value={formatRupees(Math.abs(view.split.balancePaise))}
                strong
              />
            </dl>
          </Card>

          <Card>
            <CardHeader title="Payer" />
            <div className="space-y-3 p-4 text-sm">
              <p className="text-ink-800">
                {view.payer
                  ? `${PAYER_KIND_LABELS[view.payer.kind]}${view.payer.payerName ? ` · ${view.payer.payerName}` : ''}${
                      view.payer.policyNumber ? ` · ${view.payer.policyNumber}` : ''
                    }`
                  : 'Self'}
              </p>
              {view.payer?.preauthAmountPaise ? (
                <p className="text-ink-600">Pre-authorised {formatRupees(view.payer.preauthAmountPaise)}</p>
              ) : null}
              {view.payer && view.payer.kind !== 'self' && !final && writable ? (
                <form action={setApprovedAmountAction} className="flex items-end gap-2">
                  <input type="hidden" name="admissionId" value={id} />
                  <div className="flex-1">
                    <Field label="Approved (₹)">
                      <Input
                        name="approved"
                        inputMode="decimal"
                        defaultValue={view.payer.approvedAmountPaise ? (view.payer.approvedAmountPaise / 100).toFixed(2) : ''}
                      />
                    </Field>
                  </div>
                  <Button type="submit">Save</Button>
                </form>
              ) : null}
            </div>
          </Card>

          <Card>
            <CardHeader title="Money received" />
            {view.payments.filter((p) => !p.voidedAt).length === 0 ? (
              <p className="px-5 py-3 text-sm text-ink-500">Nothing received yet.</p>
            ) : (
              <ul className="divide-y divide-ink-100 text-sm">
                {view.payments
                  .filter((p) => !p.voidedAt)
                  .map((payment) => (
                    <li key={payment.id} className="flex justify-between px-5 py-2">
                      <span className="text-ink-600">
                        {payment.receivedAt.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })} ·{' '}
                        {payment.kind === 'refund' ? 'Refund' : payment.method.toUpperCase()}
                      </span>
                      <span className={cn('numeric', payment.kind === 'refund' && 'text-rose-700')}>
                        {payment.kind === 'refund' ? '− ' : ''}
                        {formatRupees(payment.amountPaise)}
                      </span>
                    </li>
                  ))}
              </ul>
            )}
            {canCollect ? (
              <form action={recordPaymentAction} className="grid grid-cols-2 gap-2 border-t border-ink-100 p-4">
                <input type="hidden" name="admissionId" value={id} />
                <Field label="Amount (₹)">
                  <Input
                    name="amount"
                    inputMode="decimal"
                    required
                    defaultValue={view.split.balancePaise > 0 ? (view.split.balancePaise / 100).toFixed(2) : ''}
                  />
                </Field>
                <Field label="By">
                  <select name="method" className={SELECT_CLASS} defaultValue="cash">
                    <option value="cash">Cash</option>
                    <option value="upi">UPI</option>
                    <option value="card">Card</option>
                    <option value="bank">Bank</option>
                  </select>
                </Field>
                <select name="kind" className={cn(SELECT_CLASS, 'col-span-2')} defaultValue={view.split.balancePaise < 0 ? 'refund' : 'payment'}>
                  <option value="payment">Payment received</option>
                  <option value="refund">Refund given</option>
                </select>
                <Button type="submit" className="col-span-2" size="lg">
                  Record
                </Button>
              </form>
            ) : null}
          </Card>

          {!final && writable ? (
            <Card>
              <div className="space-y-3 p-4">
                {blocking > 0 ? (
                  <p className="flex items-start gap-2 text-sm text-rose-800">
                    <AlertTriangleIcon className="mt-0.5 size-4 shrink-0" />
                    {blocking} item{blocking === 1 ? ' has' : 's have'} no price. Price or remove {blocking === 1 ? 'it' : 'them'} to finalise.
                  </p>
                ) : (
                  <p className="text-sm text-ink-600">
                    Finalising numbers the bill, discharges the patient and frees the bed. It cannot be undone.
                  </p>
                )}
                <details className="group">
                  <summary
                    className={cn(
                      'flex min-h-12 cursor-pointer list-none items-center justify-center rounded-lg bg-brand-600 px-4 text-base font-semibold text-white hover:bg-brand-700',
                      blocking > 0 && 'pointer-events-none opacity-40',
                    )}
                  >
                    Finalise and discharge
                  </summary>
                  <form action={finalizeAction} className="mt-3">
                    <input type="hidden" name="admissionId" value={id} />
                    <Button type="submit" variant="danger" size="lg" className="w-full" disabled={blocking > 0}>
                      Yes, finalise {formatRupees(view.totals.totalPaise)}
                    </Button>
                  </form>
                </details>
              </div>
            </Card>
          ) : null}

          {view.admission.billLinkActive && writable ? (
            <form action={revokeBillLinkAction} className="text-center">
              <input type="hidden" name="admissionId" value={id} />
              <button type="submit" className="min-h-11 text-sm text-ink-500 underline">
                Stop the family’s link from working
              </button>
            </form>
          ) : !final && writable ? (
            <form action={shareBillLinkAction} className="text-center">
              <input type="hidden" name="admissionId" value={id} />
              <button type="submit" className="min-h-11 text-sm font-semibold text-brand-700 underline">
                Share the running bill with the family
              </button>
            </form>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function Row({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 px-5 py-2.5">
      <dt className="text-ink-600">{label}</dt>
      <dd className={cn('numeric', strong ? 'text-base font-bold text-ink-900' : 'text-ink-800')}>{value}</dd>
    </div>
  );
}

function FlagRow({
  flag,
  tone,
  timezone,
  children,
}: {
  flag: { description: string; occurredAt: Date };
  tone: 'error' | 'warn';
  timezone: string;
  children: React.ReactNode;
}) {
  return (
    <li className="flex items-start gap-2 px-5 py-2.5">
      <AlertTriangleIcon className={cn('mt-0.5 size-4 shrink-0', tone === 'error' ? 'text-rose-600' : 'text-amber-600')} />
      <span>
        <span className="font-semibold text-ink-900">{flag.description}</span>{' '}
        <span className="numeric text-ink-500">
          {flag.occurredAt.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: timezone })}{' '}
          {formatTimeIn(timezone, flag.occurredAt)}
        </span>
        <span className="block text-ink-600">{children}</span>
      </span>
    </li>
  );
}

function LineRow({
  line,
  timezone,
  admissionId,
  canCorrect,
}: {
  line: BillLine;
  timezone: string;
  admissionId: string;
  canCorrect: boolean;
}) {
  if (line.voidedAt) {
    return (
      <li className="px-4 py-2 text-xs text-ink-400 sm:px-5">
        <span className="line-through">
          {line.description} ×{line.quantity} {formatRupees(line.totalPaise)}
        </span>{' '}
        — {line.voidReason}
      </li>
    );
  }
  return (
    <li className="px-4 py-2.5 sm:px-5">
      <div className="flex items-start justify-between gap-3 text-sm">
        <p className="min-w-0 text-ink-900">
          {line.at ? <span className="numeric mr-2 text-ink-500">{formatTimeIn(timezone, line.at)}</span> : null}
          {line.description}
          <span className="numeric text-ink-500">
            {' '}
            × {line.quantity} @ {formatRupees(line.unitPricePaise)}
          </span>
          {line.discountPaise > 0 ? (
            <span className="block text-xs text-emerald-700">
              Discount {formatRupees(line.discountPaise)}: {line.discountReason}
            </span>
          ) : null}
        </p>
        <span className="numeric shrink-0 font-medium text-ink-900">{formatRupees(line.totalPaise)}</span>
      </div>
      {canCorrect ? (
        <details className="mt-1 text-xs">
          <summary className="cursor-pointer text-ink-400 hover:text-ink-700">Correct</summary>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            <form action={voidLineAction} className="flex gap-2">
              <input type="hidden" name="admissionId" value={admissionId} />
              <input type="hidden" name="lineId" value={line.id} />
              <Input name="reason" required placeholder="Why remove" className="py-2 text-sm" />
              <Button type="submit" size="sm" variant="danger">
                Remove
              </Button>
            </form>
            <form action={discountLineAction} className="flex gap-2">
              <input type="hidden" name="admissionId" value={admissionId} />
              <input type="hidden" name="lineId" value={line.id} />
              <Input name="discount" required inputMode="decimal" placeholder="₹" className="w-20 py-2 text-sm" />
              <Input name="reason" required placeholder="Why" className="py-2 text-sm" />
              <Button type="submit" size="sm">
                Discount
              </Button>
            </form>
          </div>
        </details>
      ) : null}
    </li>
  );
}

type Day = { date: string; label: string; lines: BillLine[]; totalPaise: number };

/** Lines by day, oldest first, as a bill reads. */
function groupDays(lines: readonly BillLine[], timezone: string): Day[] {
  const today = serviceDateIn(timezone);
  const days = new Map<string, Day>();
  for (const line of lines) {
    let day = days.get(line.day);
    if (!day) {
      const label =
        line.day === today
          ? 'Today'
          : new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(
              new Date(`${line.day}T00:00:00Z`),
            );
      day = { date: line.day, label, lines: [], totalPaise: 0 };
      days.set(line.day, day);
    }
    day.lines.push(line);
    if (!line.voidedAt) day.totalPaise += line.totalPaise;
  }
  return [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
}
