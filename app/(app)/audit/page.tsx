import { Card, CardHeader, EmptyState } from '@/components/ui';
import { requireSession } from '@/lib/auth/session';
import { canConfigureHospital } from '@/lib/services/auth';
import { listAuditLogs, listQueueEvents } from '@/lib/services/audit';

export const metadata = { title: 'Activity · OPD Queue' };

const ACTION_LABELS: Record<string, string> = {
  enqueue: 'added to queue',
  call: 'called',
  start_consultation: 'started consultation',
  complete: 'completed',
  skip: 'skipped',
  recall: 'recalled',
  hold: 'put on hold',
  resume: 'resumed',
  cancel: 'cancelled',
  mark_no_show: 'marked no show',
  expire: 'expired',
  confirm: 'confirmed',
  arrive: 'marked arrived',
};

export default async function AuditPage() {
  const session = await requireSession();

  if (!canConfigureHospital(session.role)) {
    return (
      <Card>
        <EmptyState
          title="Only the hospital owner can view activity"
          hint="This page shows who changed what, including staff sign-ins."
        />
      </Card>
    );
  }

  const [events, logs] = await Promise.all([
    listQueueEvents({ hospitalId: session.hospitalId, limit: 60 }),
    listAuditLogs({ hospitalId: session.hospitalId, limit: 40 }),
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

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-lg font-semibold text-ink-900">Activity</h1>
        <p className="mt-0.5 text-sm text-ink-500">
          Queue history cannot be edited or rewritten, only added to.
        </p>
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Card>
            <CardHeader title="Queue history" hint="Most recent first" />
            {events.length === 0 ? (
              <EmptyState title="Nothing has happened yet today" />
            ) : (
              <ul className="divide-y divide-ink-200">
                {events.map((event) => (
                  <li key={event.id} className="flex items-baseline gap-3 px-5 py-2.5">
                    <span className="numeric w-9 shrink-0 text-sm font-semibold text-ink-500">
                      {event.tokenNumber ?? '—'}
                    </span>
                    <p className="min-w-0 flex-1 truncate text-sm text-ink-800">
                      <span className="font-medium">{event.patientName ?? 'Unknown'}</span>{' '}
                      <span className="text-ink-500">
                        {ACTION_LABELS[event.action] ?? event.action}
                      </span>
                      {event.actorName ? (
                        <span className="text-ink-400"> by {event.actorName}</span>
                      ) : (
                        <span className="text-ink-400"> automatically</span>
                      )}
                    </p>
                    <time className="shrink-0 text-xs text-ink-400">
                      {when(event.createdAt)}
                    </time>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        <Card>
          <CardHeader title="Access and settings" hint="Sign-ins and configuration" />
          {logs.length === 0 ? (
            <EmptyState title="No records yet" />
          ) : (
            <ul className="divide-y divide-ink-200">
              {logs.map((log) => (
                <li key={log.id} className="px-5 py-2.5">
                  <p className="truncate text-sm text-ink-800">
                    <span className="font-medium">{log.actorName ?? 'System'}</span>{' '}
                    <span className="text-ink-500">{log.action.replace('.', ' ')}</span>
                  </p>
                  <time className="text-xs text-ink-400">{when(log.createdAt)}</time>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
