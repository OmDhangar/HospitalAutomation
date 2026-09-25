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
    <div className="space-y-5 sm:space-y-6">
      <div>
        <h1 className="text-xl font-bold text-ink-900">Activity & Audit Log</h1>
        <p className="mt-0.5 text-xs sm:text-sm text-ink-500">
          Queue history cannot be edited or rewritten, only appended to.
        </p>
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Card>
            <CardHeader title="Queue history" hint="Real-time timeline of patient queue events" />
            {events.length === 0 ? (
              <EmptyState title="Nothing has happened yet today" />
            ) : (
              <ul className="divide-y divide-ink-200">
                {events.map((event) => (
                  <li key={event.id} className="p-3.5 sm:px-5 sm:py-3 hover:bg-ink-50/50 transition-colors">
                    <div className="flex flex-col sm:flex-row sm:items-baseline justify-between gap-1 sm:gap-3">
                      <div className="flex items-start gap-2.5 min-w-0">
                        <span className="numeric shrink-0 mt-0.5 inline-flex items-center justify-center rounded-md bg-brand-50 px-2 py-0.5 text-xs font-bold text-brand-800 border border-brand-200">
                          {event.tokenNumber ? `#${event.tokenNumber}` : '—'}
                        </span>
                        
                        <div className="min-w-0 flex-1 text-xs sm:text-sm text-ink-800">
                          <span className="font-bold text-ink-900">{event.patientName ?? 'Unknown Patient'}</span>{' '}
                          <span className="text-ink-600 font-medium">
                            {ACTION_LABELS[event.action] ?? event.action}
                          </span>
                          {event.actorName ? (
                            <span className="text-ink-500"> by <strong className="text-ink-700 font-medium">{event.actorName}</strong></span>
                          ) : (
                            <span className="text-ink-400"> (automatically)</span>
                          )}
                        </div>
                      </div>

                      <time className="shrink-0 text-[11px] sm:text-xs text-ink-400 self-end sm:self-auto pl-8 sm:pl-0 font-medium">
                        {when(event.createdAt)}
                      </time>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        <Card>
          <CardHeader title="Access and settings" hint="Sign-ins and configuration history" />
          {logs.length === 0 ? (
            <EmptyState title="No records yet" />
          ) : (
            <ul className="divide-y divide-ink-200">
              {logs.map((log) => (
                <li key={log.id} className="p-3.5 sm:px-5 sm:py-3 hover:bg-ink-50/50 transition-colors">
                  <div className="flex flex-col sm:flex-row sm:items-baseline justify-between gap-1">
                    <div className="min-w-0 flex-1 text-xs sm:text-sm text-ink-800">
                      <span className="font-bold text-ink-900">{log.actorName ?? 'System'}</span>{' '}
                      <span className="text-ink-600 capitalize">{log.action.replace('.', ' ')}</span>
                    </div>
                    <time className="text-[11px] sm:text-xs text-ink-400 shrink-0 font-medium">
                      {when(log.createdAt)}
                    </time>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
