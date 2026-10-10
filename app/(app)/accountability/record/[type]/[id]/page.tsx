import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Card, EmptyState, cn } from '@/components/ui';
import { CheckIcon } from '@/components/icons';
import { requireSession } from '@/lib/auth/session';
import { eventDetail, eventLabel } from '@/lib/domain/evidence';
import { formatIpdNumber } from '@/lib/domain/ipd-number';
import { can } from '@/lib/domain/permissions';
import { getRecordHistory, recordHistoryView } from '@/lib/services/evidence';
import { getAdmissionSummary } from '@/lib/services/ipd-census';

export const metadata = { title: 'History · Accountability' };

const TYPE_LABELS: Record<string, string> = {
  chart_entry: 'T.P.R. reading',
  care_entry: 'Bedside item',
  bill_item: 'Bill line',
  admission: 'Admission',
  bed_assignment: 'Bed move',
  record_access: 'Record opened',
  stock_movement: 'Stock movement',
  stock_receipt: 'Stock receipt',
  stock_transfer: 'Stock delivery',
  stock_count: 'Stock count',
  stock_adjustment: 'Stock adjustment',
};

const ROLE_LABELS: Record<string, string> = { owner: 'owner', doctor: 'doctor', nurse: 'nurse', receptionist: 'reception' };
const CHANNEL_LABELS: Record<string, string> = { ward_device: 'ward tablet', personal: 'own device' };
const LATE_MS = 2 * 3_600_000;

/**
 * One record's history (IPD sheets plan Rev 5.1): who made it, who changed or
 * struck it through, who opened it — each with how (ward tablet or own device,
 * which device and session) and when, and whether the hourly seal already
 * holds it. Owner only. Opening it is itself recorded, on the same record.
 */
export default async function RecordHistoryPage({ params }: PageProps<'/accountability/record/[type]/[id]'>) {
  const session = await requireSession();
  if (!can(session.role, 'acct.view') || session.readOnly) notFound();
  const { type, id } = await params;
  if (!/^[a-z][a-z0-9_]{0,59}$/.test(type) || id.length > 200) notFound();

  const history = await getRecordHistory({ hospitalId: session.hospitalId, objectType: type, objectId: id });
  await recordHistoryView({ hospitalId: session.hospitalId, actorUserId: session.userId, objectType: type, objectId: id });
  const admission = history.admissionId ? await getAdmissionSummary(session.hospitalId, history.admissionId) : null;

  const when = (date: Date) =>
    new Intl.DateTimeFormat('en-IN', {
      timeZone: session.timezone,
      day: '2-digit',
      month: 'short',
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
    }).format(date);

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Link href="/accountability" className="inline-flex min-h-11 items-center text-sm text-ink-500 hover:text-ink-800">
          ← Accountability
        </Link>
        {admission ? (
          <Link
            href={`/ipd/admissions/${admission.admissionId}${type === 'chart_entry' ? '/tpr' : ''}`}
            className="inline-flex min-h-11 items-center text-sm font-semibold text-brand-700 hover:text-brand-900"
          >
            Open the patient file →
          </Link>
        ) : null}
      </div>

      <Card>
        <div className="p-4 sm:p-5">
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-500">
            History · {TYPE_LABELS[type] ?? type.replace(/_/g, ' ')}
          </p>
          <h1 className="mt-0.5 text-xl font-bold text-ink-900">
            {history.record?.description ?? admission?.patientName ?? TYPE_LABELS[type] ?? type}
          </h1>
          {admission ? (
            <p className="text-sm text-ink-600">
              {history.record?.description ? `${admission.patientName} · ` : ''}IPD No. {formatIpdNumber(admission.ipdNumber)}
            </p>
          ) : null}
          {history.record?.voided ? (
            <p className="mt-2 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-900 ring-1 ring-rose-200">
              Struck through{history.record.voidReason ? ` — “${history.record.voidReason}”` : ''}
            </p>
          ) : null}
        </div>
      </Card>

      <Card>
        {history.events.length === 0 ? (
          <EmptyState
            title="No history recorded for this record"
            hint="Records made before the evidence log was switched on have none; their sign-ins and settings changes are under Activity."
          />
        ) : (
          <ol className="divide-y divide-ink-100">
            {history.events.map((event) => {
              const detail = eventDetail(event.action, event.payload);
              const late = event.recordedAt.getTime() - event.occurredAt.getTime() > LATE_MS;
              const related = event.objectId !== id && event.objectType !== type;
              return (
                <li key={event.seq} className="flex gap-3 px-4 py-3 sm:px-5">
                  <span
                    aria-hidden="true"
                    className={cn(
                      'mt-1.5 size-2.5 shrink-0 rounded-full',
                      event.action.endsWith('.voided') ? 'bg-rose-500' : event.action.startsWith('evidence.') ? 'bg-ink-300' : 'bg-brand-600',
                    )}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-ink-900">
                      <span className="font-semibold">{eventLabel(event.action)}</span>
                      {related ? <span className="ml-1.5 rounded bg-ink-100 px-1.5 py-0.5 text-xs text-ink-600">{TYPE_LABELS[event.objectType] ?? event.objectType}</span> : null}
                      {detail ? <span className="text-ink-700"> · {detail}</span> : null}
                    </p>
                    <p className="text-sm text-ink-600">
                      by <strong className="font-semibold text-ink-800">{event.actorName ?? 'the system'}</strong>
                      {event.actorRole ? ` (${ROLE_LABELS[event.actorRole] ?? event.actorRole})` : ''}
                      {event.channel ? ` · ${CHANNEL_LABELS[event.channel] ?? event.channel}` : ''}
                      {event.deviceId ? <span className="numeric text-ink-400"> · device {event.deviceId.slice(0, 8)}</span> : null}
                      {event.sessionId ? <span className="numeric text-ink-400"> · session {event.sessionId.slice(0, 8)}</span> : null}
                    </p>
                    <p className="numeric text-xs text-ink-500">
                      {when(event.occurredAt)}
                      {late ? <span className="font-semibold text-amber-800"> · written {when(event.recordedAt)} (late)</span> : null}
                    </p>
                  </div>
                  <span
                    className={cn(
                      'h-fit shrink-0 rounded px-1.5 py-0.5 text-xs font-semibold',
                      event.sealedIn ? 'bg-emerald-50 text-emerald-800 ring-1 ring-emerald-200' : 'bg-ink-100 text-ink-600',
                    )}
                    title={event.sealedIn ? 'Held by an hourly seal: any change would be found by the check' : 'Sealed at the next hourly run'}
                  >
                    {event.sealedIn ? (
                      <span className="inline-flex items-center gap-1">
                        <CheckIcon className="size-3" />
                        Seal #{event.sealedIn}
                      </span>
                    ) : (
                      'Not sealed yet'
                    )}
                  </span>
                </li>
              );
            })}
          </ol>
        )}
      </Card>
      <p className="text-xs text-ink-500">
        Times are when it happened; “late” shows when it was written, if more than 2 hours after. Entries in this history cannot be
        changed or deleted. This is a record to look into, not a judgement of anyone.
      </p>
    </div>
  );
}
