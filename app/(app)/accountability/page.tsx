import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Alert, Button, Card, CardHeader, EmptyState, cn } from '@/components/ui';
import { ShieldIcon } from '@/components/icons';
import { requireSession } from '@/lib/auth/session';
import { EVENT_FAMILIES, PROBLEM_TEXT, eventLabel, isEventFamily } from '@/lib/domain/evidence';
import { can } from '@/lib/domain/permissions';
import { listStaffMembers } from '@/lib/services/auth';
import { getEvidenceStatus, listEvidenceEvents, recordEvidenceView } from '@/lib/services/evidence';
import { checkEvidenceAction } from './actions';

export const metadata = { title: 'Accountability' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CHANNEL_LABELS: Record<string, string> = { ward_device: 'Ward tablet', personal: 'Own device' };

/**
 * The evidence log (IPD sheets plan §7.6, phase A6-min): what was done, by
 * whom, when and from which device — charting, bedside items, bills,
 * admissions, records opened, sign-ins — and whether the hourly seals still
 * hold. Owner only. Opening it is itself logged.
 *
 * A record for review, not a verdict: the words on the page say so (plan §7.1).
 */
export default async function AccountabilityPage({ searchParams }: PageProps<'/accountability'>) {
  const session = await requireSession();
  if (!can(session.role, 'acct.view')) notFound();
  const query = await searchParams;

  if (session.readOnly) {
    return (
      <Card>
        <EmptyState title="Not available in a support session" hint="The evidence log holds clinical data, which support sessions never see." />
      </Card>
    );
  }

  const family = typeof query.family === 'string' && isEventFamily(query.family) ? query.family : null;
  const person = typeof query.person === 'string' && UUID.test(query.person) ? query.person : null;
  const before = typeof query.before === 'string' && /^\d{1,18}$/.test(query.before) ? Number(query.before) : null;

  await recordEvidenceView({
    hospitalId: session.hospitalId,
    actorUserId: session.userId,
    filters: Object.fromEntries(
      Object.entries({ family, person, before: before === null ? null : String(before) }).filter(([, v]) => v !== null),
    ) as Record<string, string>,
  });

  const [status, page, staff] = await Promise.all([
    getEvidenceStatus(session.hospitalId),
    listEvidenceEvents({ hospitalId: session.hospitalId, beforeSeq: before, family, actorUserId: person }),
    listStaffMembers(session.hospitalId),
  ]);

  const when = (date: Date) =>
    new Intl.DateTimeFormat('en-IN', {
      timeZone: session.timezone,
      day: '2-digit',
      month: 'short',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    }).format(date);

  const filterQuery = (extra: Record<string, string | number | null>) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries({ family, person, ...extra })) {
      if (value !== null && value !== undefined) params.set(key, String(value));
    }
    const text = params.toString();
    return text ? `/accountability?${text}` : '/accountability';
  };

  const check = status.lastCheck;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="flex items-center gap-2 text-xl font-bold text-ink-900">
          <ShieldIcon className="size-5 text-brand-700" />
          Accountability
        </h1>
        <p className="mt-0.5 max-w-3xl text-sm text-ink-600">
          Every charting, bedside, billing and sign-in action: who did it, when, and from which device. Sealed every hour —
          nothing here can be changed or deleted without the check below noticing.
        </p>
        <p className="mt-1 max-w-3xl text-sm text-ink-500">This is a record to look into, not a judgement of anyone.</p>
      </div>

      {query.checked === 'ok' ? <Alert tone="success">The check found nothing wrong.</Alert> : null}
      {check && !check.ok ? (
        <Alert tone="error">
          <p className="font-semibold">The last check found a problem ({when(check.ranAt)}). QuriioHQ has been alerted.</p>
          <ul className="mt-1 list-disc pl-5">
            {check.problems.map((problem, i) => (
              <li key={i}>
                {PROBLEM_TEXT[problem.code] ?? problem.code}
                {problem.digestNo ? ` (seal #${problem.digestNo})` : ''}
              </li>
            ))}
          </ul>
        </Alert>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-3">
        <Card>
          <div className="p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-ink-500">Last seal</p>
            {status.lastDigest ? (
              <>
                <p className="mt-1 text-lg font-bold text-ink-900">
                  #{status.lastDigest.digestNo} · {when(status.lastDigest.sealedAt)}
                </p>
                <p className="text-sm text-ink-600">{count(status.sealedEvents, 'event')} sealed in all</p>
                <p className="mt-1 flex flex-wrap gap-1.5 text-xs font-semibold">
                  <Badge good={status.lastDigest.signed}>{status.lastDigest.signed ? 'Signed' : 'Not signed'}</Badge>
                  <Badge good={status.lastDigest.anchored}>{status.lastDigest.anchored ? 'Copy kept outside' : 'No outside copy'}</Badge>
                </p>
              </>
            ) : (
              <p className="mt-1 text-sm text-ink-600">Nothing sealed yet. The first seal is made within the hour.</p>
            )}
          </div>
        </Card>
        <Card>
          <div className="p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-ink-500">Since the last seal</p>
            <p className="mt-1 text-lg font-bold text-ink-900">{count(status.unsealedEvents, 'event')}</p>
            <p className="text-sm text-ink-600">Sealed at the next hourly run.</p>
          </div>
        </Card>
        <Card>
          <div className="p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-ink-500">Last check</p>
            {check ? (
              <p className={cn('mt-1 text-lg font-bold', check.ok ? 'text-emerald-700' : 'text-rose-700')}>
                {check.ok ? 'All in order' : 'PROBLEM FOUND'} · {when(check.ranAt)}
              </p>
            ) : (
              <p className="mt-1 text-sm text-ink-600">Not checked yet.</p>
            )}
            {check ? (
              <p className="text-sm text-ink-600">
                {count(check.eventsChecked, 'event')}, {count(check.digestsChecked, 'seal')} ·{' '}
                {check.source === 'manual' ? 'checked by hand' : 'automatic'}
              </p>
            ) : null}
            <form action={checkEvidenceAction} className="mt-2">
              <Button type="submit" variant="secondary" size="sm">
                Check now
              </Button>
            </form>
          </div>
        </Card>
      </div>

      <Card>
        <CardHeader title="Activity" hint="Newest first. Tap an action to see that record's whole history." />
        <form method="get" className="flex flex-wrap items-end gap-2 border-b border-ink-100 px-4 pb-3 sm:px-5">
          <label className="block">
            <span className="text-xs font-medium text-ink-600">What</span>
            <select
              name="family"
              defaultValue={family ?? ''}
              className="mt-0.5 block h-11 rounded-lg border-0 bg-white px-3 text-sm ring-1 ring-inset ring-ink-300 focus:ring-2 focus:ring-brand-600"
            >
              <option value="">Everything</option>
              {Object.entries(EVENT_FAMILIES).map(([key, value]) => (
                <option key={key} value={key}>
                  {value.label}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-xs font-medium text-ink-600">Who</span>
            <select
              name="person"
              defaultValue={person ?? ''}
              className="mt-0.5 block h-11 max-w-[14rem] rounded-lg border-0 bg-white px-3 text-sm ring-1 ring-inset ring-ink-300 focus:ring-2 focus:ring-brand-600"
            >
              <option value="">Everyone</option>
              {staff.map((member) => (
                <option key={member.userId} value={member.userId}>
                  {member.name}
                </option>
              ))}
            </select>
          </label>
          <Button type="submit" variant="secondary" size="sm" className="h-11">
            Show
          </Button>
          {family || person || before ? (
            <Link href="/accountability" className="inline-flex h-11 items-center px-2 text-sm font-semibold text-ink-600 hover:text-ink-900">
              Clear
            </Link>
          ) : null}
        </form>

        {page.events.length === 0 ? (
          <EmptyState title="Nothing recorded yet" hint={family || person ? 'Try “Everything” and “Everyone”.' : undefined} />
        ) : (
          <ul className="divide-y divide-ink-100">
            {page.events.map((event) => {
              const late = event.recordedAt.getTime() - event.occurredAt.getTime() > 2 * 3_600_000;
              return (
                <li key={event.seq} className="flex flex-col gap-0.5 px-4 py-2.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4 sm:px-5">
                  <div className="min-w-0 text-sm text-ink-800">
                    {event.objectId && !event.objectType.startsWith('evidence') ? (
                      <Link
                        href={`/accountability/record/${event.objectType}/${encodeURIComponent(event.objectId)}`}
                        className="font-semibold text-ink-900 underline decoration-ink-300 underline-offset-2 hover:text-brand-800 hover:decoration-brand-400"
                      >
                        {eventLabel(event.action)}
                      </Link>
                    ) : (
                      <span className={cn('font-semibold', event.action.endsWith('failed') ? 'text-rose-700' : 'text-ink-900')}>
                        {eventLabel(event.action)}
                      </span>
                    )}{' '}
                    <span className="text-ink-600">by {event.actorName ?? 'the system'}</span>
                    {event.channel ? (
                      <span className="text-ink-500">
                        {' '}
                        · {CHANNEL_LABELS[event.channel] ?? event.channel}
                        {event.deviceId ? <span className="numeric text-ink-400"> {event.deviceId.slice(0, 8)}</span> : null}
                      </span>
                    ) : null}
                  </div>
                  <div className="numeric shrink-0 text-xs text-ink-500">
                    {when(event.occurredAt)}
                    {late ? <span className="ml-1 font-semibold text-amber-800">· written {when(event.recordedAt)}</span> : null}
                    <span className="ml-2 text-ink-300">#{event.seq}</span>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {page.nextBefore ? (
          <div className="border-t border-ink-100 px-4 py-3 text-right sm:px-5">
            <Link href={filterQuery({ before: page.nextBefore })} className="inline-flex min-h-11 items-center text-sm font-semibold text-brand-700 hover:text-brand-900">
              Older →
            </Link>
          </div>
        ) : null}
      </Card>
    </div>
  );
}

const count = (n: number, noun: string) => `${n.toLocaleString('en-IN')} ${noun}${n === 1 ? '' : 's'}`;

function Badge({ good, children }: { good: boolean; children: React.ReactNode }) {
  return (
    <span className={cn('rounded px-1.5 py-0.5', good ? 'bg-emerald-50 text-emerald-800 ring-1 ring-emerald-200' : 'bg-amber-50 text-amber-900 ring-1 ring-amber-200')}>
      {children}
    </span>
  );
}
