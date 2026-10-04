import { SavedNotice } from '@/components/saved-notice';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Alert, Button, Card, CardHeader, EmptyState, Field, Input, cn } from '@/components/ui';
import { AlertTriangleIcon, BedIcon, SyringeIcon } from '@/components/icons';
import { PatientHeader } from '@/components/ipd/patient-header';
import { requireSession } from '@/lib/auth/session';
import { formatRupees } from '@/lib/domain/billing';
import { isLateRecording } from '@/lib/domain/care-entry';
import { can } from '@/lib/domain/permissions';
import { formatTimeIn, serviceDateIn } from '@/lib/domain/time';
import { PAYER_KIND_LABELS } from '@/lib/domain/payer';
import { listEntriesForAdmission, type TimelineEntry } from '@/lib/services/care-entries';
import { getAdmissionSummary } from '@/lib/services/ipd-census';
import { getEncounterSettlement } from '@/lib/services/patient-billing';
import { cancelAdmissionAction, setDischargeReadyAction, voidCareEntryAction, undoIpdAction } from '../../actions';

export const metadata = { title: 'Patient · IPD' };

/**
 * One patient's stay (IPD plan §5.5): who and where, what each role can do
 * next, and everything recorded, day by day, newest first.
 *
 * Amounts and the running total are shown only to roles that take money;
 * a nurse or doctor sees the same timeline without a rupee on it. Opening
 * this page is logged as a read of the patient's record.
 */
export default async function AdmissionPage({ params, searchParams }: PageProps<'/ipd/admissions/[id]'>) {
  const session = await requireSession();
  const { id } = await params;
  const query = await searchParams;
  const now = new Date();

  const admission = await getAdmissionSummary(session.hospitalId, id);
  if (!admission) notFound();

  const showMoney = can(session.role, 'billing.collect');
  const writable = !session.readOnly;
  const [entries, settlement] = await Promise.all([
    listEntriesForAdmission({
      hospitalId: session.hospitalId,
      admissionId: id,
      actorUserId: session.userId,
      logView: true,
    }),
    showMoney ? getEncounterSettlement(session.hospitalId, admission.encounterId) : Promise.resolve(null),
  ]);

  const live = entries.filter((entry) => !entry.voidedAt);
  const unpricedCount = live.filter((entry) => entry.unpriced).length;
  const days = groupByDay(entries, session.timezone);
  const inBed = admission.status === 'admitted' || admission.status === 'discharge_ready';
  const canCorrect = can(session.role, 'ipd.correct') && writable && admission.status !== 'discharged';

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <Link href="/ipd" className="inline-flex min-h-11 items-center text-sm text-ink-500 hover:text-ink-800">
        ← IPD
      </Link>

      <PatientHeader
        name={admission.patientName}
        age={admission.age}
        gender={admission.gender}
        phoneE164={admission.phoneE164}
        bed={admission.bed && inBed ? admission.bed : null}
        admittedAt={admission.admittedAt}
        doctorName={admission.doctorName}
        status={admission.status}
        timezone={session.timezone}
        now={now}
      />

      {typeof query.error === 'string' ? <Alert tone="error">{query.error}</Alert> : null}
      {typeof query.saved === 'string' ? (
        <SavedNotice
          message={query.saved}
          undo={typeof query.undo === 'string' ? query.undo : null}
          action={undoIpdAction} hidden={{ _back: `/ipd/admissions/${id}` }}
        />
      ) : null}

      {writable ? (
        <div className="flex flex-wrap gap-2">
          {admission.status === 'awaiting_bed' && can(session.role, 'ipd.admit') ? (
            <Link href={`/ipd/admissions/${id}/assign`}>
              <Button variant="primary" size="lg" className="gap-2">
                <BedIcon className="size-5" />
                Assign bed
              </Button>
            </Link>
          ) : null}
          {inBed && admission.bed && can(session.role, 'ipd.record') ? (
            <Link href={`/ipd/ward/${admission.bed.wardId}/bed/${admission.bed.id}`}>
              <Button variant="primary" size="lg" className="gap-2">
                <SyringeIcon className="size-5" />
                Record item
              </Button>
            </Link>
          ) : null}
          {inBed && can(session.role, 'ipd.admit') ? (
            <Link href={`/ipd/admissions/${id}/transfer`}>
              <Button size="lg">Transfer bed</Button>
            </Link>
          ) : null}
          {inBed && can(session.role, 'ipd.dischargeReady') ? (
            <form action={setDischargeReadyAction}>
              <input type="hidden" name="admissionId" value={id} />
              <input type="hidden" name="ready" value={admission.status === 'admitted' ? 'true' : 'false'} />
              <Button type="submit" size="lg" variant={admission.status === 'admitted' ? 'secondary' : 'ghost'}>
                {admission.status === 'admitted' ? 'Discharge ready' : 'Not ready after all'}
              </Button>
            </form>
          ) : null}
          {inBed && can(session.role, 'ipd.discharge') ? (
            <Link href={`/ipd/admissions/${id}/bill`}>
              <Button size="lg" variant={admission.status === 'discharge_ready' ? 'primary' : 'secondary'}>
                Discharge bill
              </Button>
            </Link>
          ) : null}
          {admission.status === 'discharged' && can(session.role, 'ipd.discharge') ? (
            <Link href={`/ipd/admissions/${id}/bill`}>
              <Button size="lg">Final bill</Button>
            </Link>
          ) : null}
        </div>
      ) : null}

      {showMoney && unpricedCount > 0 ? (
        <Alert tone="warn">
          <span className="inline-flex items-center gap-1.5 font-semibold">
            <AlertTriangleIcon className="size-4" />
            {unpricedCount} item{unpricedCount === 1 ? ' has' : 's have'} no price yet
          </span>{' '}
          and {unpricedCount === 1 ? 'is' : 'are'} not on the bill.{' '}
          {can(session.role, 'billing.price') ? (
            <Link href="/settings/ipd/items?mode=prices" className="font-semibold underline">
              Set prices
            </Link>
          ) : (
            'Ask the owner to set prices.'
          )}
        </Alert>
      ) : null}

      <div className={cn('grid gap-4', showMoney && 'lg:grid-cols-[1fr_18rem] lg:items-start')}>
        <Card>
          <CardHeader
            title="What was given"
            hint={live.length === 0 ? undefined : `${live.length} item${live.length === 1 ? '' : 's'}`}
          />
          {days.length === 0 ? (
            <EmptyState
              title="Nothing recorded yet."
              hint={inBed ? 'Nurses record items from the ward, by tapping this patient’s bed.' : undefined}
            />
          ) : (
            <div className="divide-y divide-ink-200">
              {days.map((day) => (
                <section key={day.date} aria-label={day.label}>
                  <h3 className="sticky top-[8.5rem] z-10 bg-ink-50 px-4 py-2 text-xs font-bold uppercase tracking-wide text-ink-600 sm:px-5">
                    {day.label}
                  </h3>
                  <ul className="divide-y divide-ink-100">
                    {day.live.map((entry) => (
                      <EntryRow
                        key={entry.id}
                        entry={entry}
                        timezone={session.timezone}
                        showMoney={showMoney}
                        correct={canCorrect ? { admissionId: id } : null}
                      />
                    ))}
                  </ul>
                  {day.voided.length > 0 ? (
                    <details className="px-4 py-2 text-sm sm:px-5">
                      <summary className="cursor-pointer text-xs text-ink-500">
                        {day.voided.length} removed entr{day.voided.length === 1 ? 'y' : 'ies'}
                      </summary>
                      <ul className="mt-2 space-y-1">
                        {day.voided.map((entry) => (
                          <li key={entry.id} className="text-ink-500">
                            <span className="line-through">
                              {formatTimeIn(session.timezone, entry.occurredAt)} · {entry.description} ×{entry.quantity}
                            </span>{' '}
                            — {entry.voidReason}
                          </li>
                        ))}
                      </ul>
                    </details>
                  ) : null}
                  {showMoney && day.subtotalPaise > 0 ? (
                    <p className="numeric px-4 pb-3 text-right text-sm font-semibold text-ink-800 sm:px-5">
                      Day total {formatRupees(day.subtotalPaise)}
                    </p>
                  ) : null}
                </section>
              ))}
            </div>
          )}
        </Card>

        {showMoney && settlement ? (
          <div className="space-y-4">
            <Card>
              <CardHeader title="Running total" hint="Bedside items, room days, and anything billed in OPD" />
              <dl className="divide-y divide-ink-100 text-sm">
                <MoneyRow label="Charges so far" value={formatRupees(settlement.totalPaise)} />
                <MoneyRow label="Received" value={formatRupees(settlement.paidPaise)} />
                <MoneyRow
                  label={settlement.paidPaise > settlement.totalPaise ? 'In credit' : 'Balance'}
                  value={formatRupees(Math.abs(settlement.totalPaise - settlement.paidPaise))}
                  strong
                />
              </dl>
            </Card>
            <Card>
              <CardHeader title="Payer" />
              <p className="px-5 py-3 text-sm text-ink-700">
                {admission.payer
                  ? `${PAYER_KIND_LABELS[admission.payer.kind]}${admission.payer.payerName ? ` · ${admission.payer.payerName}` : ''}${
                      admission.payer.preauthAmountPaise ? ` · pre-auth ${formatRupees(admission.payer.preauthAmountPaise)}` : ''
                    }`
                  : 'Self (not recorded)'}
              </p>
            </Card>
          </div>
        ) : null}
      </div>

      {admission.status === 'awaiting_bed' && can(session.role, 'ipd.admit') && writable ? (
        <details className="rounded-xl border border-ink-200 bg-white p-4 text-sm">
          <summary className="cursor-pointer font-medium text-ink-600">Cancel this admission</summary>
          <form action={cancelAdmissionAction} className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-end">
            <input type="hidden" name="admissionId" value={id} />
            <div className="flex-1">
              <Field label="Why">
                <Input name="reason" required placeholder="Family took the patient to another hospital" />
              </Field>
            </div>
            <Button type="submit" variant="danger" size="lg">
              Cancel admission
            </Button>
          </form>
        </details>
      ) : null}
    </div>
  );
}

function MoneyRow({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-center justify-between px-5 py-2.5">
      <dt className="text-ink-600">{label}</dt>
      <dd className={cn('numeric', strong ? 'text-base font-bold text-ink-900' : 'text-ink-800')}>{value}</dd>
    </div>
  );
}

function EntryRow({
  entry,
  timezone,
  showMoney,
  correct,
}: {
  entry: TimelineEntry;
  timezone: string;
  showMoney: boolean;
  correct: { admissionId: string } | null;
}) {
  const late = isLateRecording(entry.occurredAt, entry.recordedAt);
  return (
    <li className="px-4 py-2.5 sm:px-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm text-ink-900">
            <span className="numeric mr-2 text-ink-500">{formatTimeIn(timezone, entry.occurredAt)}</span>
            <span className="font-semibold">{entry.description}</span>
            <span className="numeric text-ink-600"> ×{entry.quantity}</span>
          </p>
          <p className="text-xs text-ink-500">
            {entry.recordedByName ?? 'Staff'}
            {late ? ` · recorded ${formatTimeIn(timezone, entry.recordedAt)}` : ''}
          </p>
        </div>
        {showMoney ? (
          <span className={cn('numeric shrink-0 text-sm', entry.unpriced ? 'text-amber-700' : 'text-ink-800')}>
            {entry.amountPaise !== null ? formatRupees(entry.amountPaise) : entry.unpriced ? 'No price' : '—'}
          </span>
        ) : null}
      </div>
      {correct ? (
        <details className="mt-1 text-xs">
          <summary className="cursor-pointer text-ink-400 hover:text-ink-700">Correct</summary>
          <form action={voidCareEntryAction} className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center">
            <input type="hidden" name="admissionId" value={correct.admissionId} />
            <input type="hidden" name="entryId" value={entry.id} />
            <Input name="reason" required placeholder="Why it is wrong" className="py-2 text-sm" />
            <Button type="submit" size="sm" variant="danger">
              Remove entry
            </Button>
          </form>
        </details>
      ) : null}
    </li>
  );
}

type Day = { date: string; label: string; live: TimelineEntry[]; voided: TimelineEntry[]; subtotalPaise: number };

/** Entries by calendar day in the hospital's timezone, newest day first (entries are already newest first). */
function groupByDay(entries: readonly TimelineEntry[], timezone: string): Day[] {
  const days = new Map<string, Day>();
  const today = serviceDateIn(timezone);
  for (const entry of entries) {
    const date = serviceDateIn(timezone, entry.occurredAt);
    let day = days.get(date);
    if (!day) {
      const label =
        date === today
          ? 'Today'
          : new Intl.DateTimeFormat('en-IN', { timeZone: timezone, weekday: 'short', day: 'numeric', month: 'short' }).format(
              entry.occurredAt,
            );
      day = { date, label, live: [], voided: [], subtotalPaise: 0 };
      days.set(date, day);
    }
    if (entry.voidedAt) day.voided.push(entry);
    else {
      day.live.push(entry);
      day.subtotalPaise += entry.amountPaise ?? 0;
    }
  }
  return [...days.values()];
}
