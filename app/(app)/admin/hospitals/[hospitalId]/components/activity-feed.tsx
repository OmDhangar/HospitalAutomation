import { EmptyState } from '@/components/ui';
import type { AuditEventGroup } from '@/lib/domain/audit';
import { ActivityEventRow } from './activity-event-row';

function getDayKey(date: Date, timezone: string): string {
  try {
    return date.toLocaleDateString('en-CA', { timeZone: timezone });
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

function getDayLabel(date: Date, timezone: string): string {
  const now = new Date();
  const key = getDayKey(date, timezone);
  const todayKey = getDayKey(now, timezone);
  const yesterday = new Date(now.getTime() - 86_400_000);
  const yesterdayKey = getDayKey(yesterday, timezone);

  if (key === todayKey) return 'Today';
  if (key === yesterdayKey) return 'Yesterday';

  try {
    return date.toLocaleDateString('en-IN', {
      day: 'numeric',
      month: 'short',
      year: date.getFullYear() !== now.getFullYear() ? 'numeric' : undefined,
      timeZone: timezone,
    });
  } catch {
    return date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
  }
}

export function ActivityFeed({
  groups,
  timezone = 'Asia/Kolkata',
}: {
  groups: AuditEventGroup[];
  timezone?: string;
}) {
  if (groups.length === 0) {
    return (
      <EmptyState
        title="No activity recorded"
        hint="Activity matching the current filter will appear here."
      />
    );
  }

  // Group events by day key
  const daysMap = new Map<string, { label: string; items: AuditEventGroup[] }>();

  for (const group of groups) {
    const key = getDayKey(group.firstAt, timezone);
    if (!daysMap.has(key)) {
      daysMap.set(key, {
        label: getDayLabel(group.firstAt, timezone),
        items: [],
      });
    }
    daysMap.get(key)!.items.push(group);
  }

  return (
    <div className="space-y-6">
      {Array.from(daysMap.entries()).map(([dayKey, day]) => (
        <section key={dayKey} className="space-y-2">
          <h4 className="border-b border-ink-100 pb-1 text-xs font-semibold uppercase tracking-wide text-ink-500">
            {day.label}
          </h4>

          <div className="rounded-xl border border-ink-200 bg-white shadow-xs divide-y divide-ink-100 overflow-hidden">
            {day.items.map((group) => (
              <ActivityEventRow
                key={group.key}
                group={group}
                timezone={timezone}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
