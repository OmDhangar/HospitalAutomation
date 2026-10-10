import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AutoRefresh } from '@/components/auto-refresh';
import { SinceClock } from '@/components/since-clock';
import { Alert, Button, Card, CardHeader, EmptyState, cn } from '@/components/ui';
import { requireModule } from '@/lib/auth/modules';
import { requireSession } from '@/lib/auth/session';
import { can } from '@/lib/domain/permissions';
import { formatIndianPhone } from '@/lib/domain/phone';
import { CALL_OUTCOMES, ESCALATE_AFTER_MS, ORDER_STATUSES, directionsLine, type FollowUpState, type Lang, type ServicePointText } from '@/lib/domain/test-orders';
import { formatTimeIn } from '@/lib/domain/time';
import { TestOrderError, getWorklist, type WorklistPatient } from '@/lib/services/test-orders';
import { advanceTestsAction, recordCallAction } from '../actions';

export const metadata = { title: 'Test list' };

const LANG_NAME: Record<Lang, string> = { en: 'English', mr: 'मराठी', hi: 'हिंदी' };

const STATE: Record<FollowUpState, { label: string; tone: string } | null> = {
  escalated: { label: 'Not arrived · raised to admin', tone: 'bg-red-600 text-white' },
  task: { label: 'Not arrived · call now', tone: 'bg-amber-500 text-white' },
  followed_up: { label: 'Called', tone: 'bg-sky-100 text-sky-900' },
  waiting: { label: 'On the way', tone: 'bg-ink-100 text-ink-700' },
  awaiting_payment: { label: 'Not paid yet', tone: 'bg-ink-100 text-ink-600' },
  none: null,
};

/**
 * One lab's worklist (IPD sheets plan C4a). Patients not arrived come first,
 * the most urgent on top: raised to the admin, then "call now" (past the set
 * time and nobody has called), then the rest by how long they have been sent.
 * Each card has the patient's number to call, the way to the lab in their
 * language to read out, and what they said last time. Then patients waiting
 * for the test, and tests waiting for the report.
 */
export default async function TestWorklistPage({ params, searchParams }: PageProps<'/tests/[pointId]'>) {
  const session = await requireSession();
  await requireModule(session, 'test_follow_up');
  if (!can(session.role, 'tests.work')) notFound();
  const { pointId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(pointId)) notFound();
  const query = await searchParams;
  const now = new Date();

  let list;
  try {
    list = await getWorklist({ hospitalId: session.hospitalId, servicePointId: pointId, userId: session.userId, isOwner: session.role === 'owner', now });
  } catch (err) {
    if (err instanceof TestOrderError) notFound();
    throw err;
  }
  const { point } = list;
  const writable = !session.readOnly;
  const card = { pointId, now, timezone: session.timezone, writable, point };

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <AutoRefresh seconds={30} />
      <Link href="/tests" className="inline-flex min-h-11 items-center text-sm text-ink-500 hover:text-ink-800">
        ← Tests
      </Link>
      <div>
        <h1 className="text-xl font-bold text-ink-900">{point.name}</h1>
        <p className="text-sm text-ink-600">
          {directionsLine(point, 'en')} · a patient not here {point.clockMinutes} min after the {point.clockFrom === 'order' ? 'order' : 'payment'} is yours to call
        </p>
        {!list.callerAssigned ? (
          <p className="mt-1 text-xs text-ink-500">You are not on this lab’s staff. Your calls are still recorded under your name.</p>
        ) : null}
      </div>
      {typeof query.saved === 'string' ? <Alert tone="success">{query.saved}</Alert> : null}
      {typeof query.error === 'string' ? <Alert tone="error">{query.error}</Alert> : null}

      <Card>
        <CardHeader title="Not arrived" hint={`${list.notArrived.length} patient${list.notArrived.length === 1 ? '' : 's'}`} />
        {list.notArrived.length === 0 ? (
          <EmptyState title="Everyone sent here has arrived" />
        ) : (
          <ul className="divide-y divide-ink-100">
            {list.notArrived.map((p) => (
              <PatientCard key={p.key} patient={p} stage="ordered" {...card} />
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <CardHeader title="Here, waiting for the test" hint={`${list.waitingForTest.length}`} />
        {list.waitingForTest.length === 0 ? (
          <EmptyState title="Nobody waiting" />
        ) : (
          <ul className="divide-y divide-ink-100">
            {list.waitingForTest.map((p) => (
              <PatientCard key={p.key} patient={p} stage="arrived" {...card} />
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <CardHeader title="Test done, report to add" hint={`${list.waitingForReport.length}`} />
        {list.waitingForReport.length === 0 ? (
          <EmptyState title="No report pending" />
        ) : (
          <ul className="divide-y divide-ink-100">
            {list.waitingForReport.map((p) => (
              <PatientCard key={p.key} patient={p} stage="done" {...card} />
            ))}
          </ul>
        )}
      </Card>

      {list.closedToday.length > 0 ? (
        <Card>
          <CardHeader title="Finished today" hint={`${list.closedToday.length}`} />
          <ul className="divide-y divide-ink-100 text-sm">
            {list.closedToday.map((o) => (
              <li key={o.id} className="flex flex-wrap justify-between gap-2 px-4 py-2 sm:px-5">
                <span>
                  <strong>{o.patientName}</strong> · {o.testName}
                </span>
                <span className="text-ink-500">
                  {o.closedReason ? CALL_OUTCOMES[o.closedReason as keyof typeof CALL_OUTCOMES] : ORDER_STATUSES[o.status]} ·{' '}
                  {formatTimeIn(session.timezone, o.at)}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}

function PatientCard({
  patient: p,
  stage,
  pointId,
  now,
  timezone,
  writable,
  point,
}: {
  patient: WorklistPatient;
  stage: 'ordered' | 'arrived' | 'done';
  pointId: string;
  now: Date;
  timezone: string;
  writable: boolean;
  point: ServicePointText;
}) {
  const state = stage === 'ordered' ? STATE[p.state] : null;
  const orderIds = p.orders.map((o) => o.id);
  const hidden = (
    <>
      <input type="hidden" name="servicePointId" value={pointId} />
      <input type="hidden" name="patientName" value={p.patientName} />
      {orderIds.map((id) => (
        <input key={id} type="hidden" name="orderId" value={id} />
      ))}
    </>
  );
  const due = p.orders.map((o) => o.dueAt).filter((d): d is Date => Boolean(d)).sort((a, b) => a.getTime() - b.getTime())[0];

  return (
    <li className={cn('space-y-3 px-4 py-4 sm:px-5', p.state === 'escalated' && stage === 'ordered' && 'bg-red-50')}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-base font-semibold text-ink-900">
            {p.patientName}
            <span className="ml-2 text-xs font-normal text-ink-500">
              {[p.age ? `${p.age} y` : null, p.gender, p.setting === 'ipd' ? (p.where ?? 'IPD') : 'OPD'].filter(Boolean).join(' · ')}
            </span>
          </p>
          <p className="text-sm text-ink-700">{p.orders.map((o) => o.testName).join(', ')}</p>
          <p className="text-xs text-ink-500">
            {p.doctorName ? `Dr ${p.doctorName.replace(/^dr\.?\s*/i, '')}` : ''}
            {p.waitingSince ? (
              <>
                {p.doctorName ? ' · ' : ''}
                {stage === 'ordered' ? 'sent ' : 'since '}
                <SinceClock from={p.waitingSince.toISOString()} serverNow={now.toISOString()} /> ago
              </>
            ) : (
              ' · clock starts when paid'
            )}
          </p>
        </div>
        {state ? <span className={cn('rounded-full px-2.5 py-1 text-xs font-semibold', state.tone)}>{state.label}</span> : null}
      </div>

      {stage === 'ordered' ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <a
              href={`tel:${p.phone}`}
              className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-brand-600 px-4 text-sm font-semibold text-white shadow-xs hover:bg-brand-700"
            >
              Call {formatIndianPhone(p.phone)}
            </a>
            {writable ? (
              <form action={advanceTestsAction}>
                {hidden}
                <input type="hidden" name="to" value="arrived" />
                <Button type="submit" variant="secondary" className="h-11">
                  Arrived
                </Button>
              </form>
            ) : null}
          </div>
          <p className="rounded-lg bg-ink-50 px-3 py-2 text-sm text-ink-800">
            <span className="text-xs font-semibold uppercase tracking-wide text-ink-500">Tell them ({LANG_NAME[p.lang]}): </span>
            {directionsLine(point, p.lang)}
            {p.lang !== 'en' ? <span className="block text-xs text-ink-500">{directionsLine(point, 'en')}</span> : null}
          </p>
          {p.calls.length > 0 ? (
            <ul className="space-y-0.5 text-xs text-ink-600">
              {p.calls.slice(0, 3).map((c, i) => (
                <li key={i}>
                  {formatTimeIn(timezone, c.calledAt)} · {CALL_OUTCOMES[c.outcome]}
                  {c.note ? ` — “${c.note}”` : ''} · {c.calledBy ?? 'staff'}
                </li>
              ))}
            </ul>
          ) : due && p.state === 'task' ? (
            <p className="text-xs font-medium text-amber-800">
              Goes to the admin at {formatTimeIn(timezone, new Date(due.getTime() + ESCALATE_AFTER_MS))} if nobody calls.
            </p>
          ) : null}
          {writable ? (
            <details>
              <summary className="flex min-h-11 cursor-pointer items-center text-sm font-medium text-brand-700">After the call: what did they say?</summary>
              <form action={recordCallAction} className="mt-2 space-y-2">
                {hidden}
                <input type="hidden" name="clientId" value={crypto.randomUUID()} />
                <label className="block text-xs text-ink-600">
                  Note (needed for “other reason”)
                  <input name="note" maxLength={200} className="mt-1 block h-11 w-full rounded-lg border-0 bg-white px-3 text-sm ring-1 ring-inset ring-ink-300" />
                </label>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {Object.entries(CALL_OUTCOMES).map(([value, label]) => (
                    <button
                      key={value}
                      type="submit"
                      name="outcome"
                      value={value}
                      className={cn(
                        'min-h-11 rounded-lg px-2 text-sm font-medium ring-1 ring-inset',
                        value.startsWith('refused') || value === 'went_home'
                          ? 'bg-white text-red-800 ring-red-200 hover:bg-red-50'
                          : 'bg-white text-ink-800 ring-ink-300 hover:bg-ink-50',
                      )}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <p className="text-xs text-ink-500">“Went home” and “Refused” close the test as not coming.</p>
              </form>
            </details>
          ) : null}
        </>
      ) : writable ? (
        <div className="flex flex-wrap gap-2">
          {stage === 'arrived' ? (
            <form action={advanceTestsAction}>
              {hidden}
              <input type="hidden" name="to" value="done" />
              <Button type="submit" variant="primary" className="h-11">
                Test done
              </Button>
            </form>
          ) : null}
          <form action={advanceTestsAction}>
            {hidden}
            <input type="hidden" name="to" value="reported" />
            <Button type="submit" variant={stage === 'done' ? 'primary' : 'secondary'} className="h-11">
              Report added
            </Button>
          </form>
        </div>
      ) : null}
    </li>
  );
}
