export type AuditCategory =
  | 'auth'
  | 'session'
  | 'billing'
  | 'subscription'
  | 'support'
  | 'config'
  | 'other';

export function categorizeAuditAction(action: string): AuditCategory {
  if (action.startsWith('auth.')) return 'auth';
  if (action.startsWith('opd.session.') || action.startsWith('session.')) return 'session';
  if (action.startsWith('billing.') || action.startsWith('payment.')) return 'billing';
  if (action.startsWith('subscription.')) return 'subscription';
  if (action.startsWith('support.') || action.startsWith('platform.')) return 'support';
  if (action.startsWith('config.') || action.startsWith('settings.')) return 'config';
  return 'other';
}

export function isDestructiveAction(action: string): boolean {
  return /\.(voided|suspended|revoked|deleted|failed)$/.test(action);
}

export type AuditEventGroup = {
  key: string;
  category: AuditCategory;
  action: string;
  actorName: string | null;
  count: number;
  firstAt: Date;
  lastAt: Date;
  isDestructive: boolean;
};

export function groupConsecutiveEvents(
  events: Array<{ id: string; action: string; actorName: string | null; createdAt: Date }>,
  { windowMs = 60_000 }: { windowMs?: number } = {},
): AuditEventGroup[] {
  if (events.length === 0) return [];

  const groups: AuditEventGroup[] = [];
  let currentGroup: AuditEventGroup | null = null;
  let lastEventTime = 0;

  for (const event of events) {
    const eventTime = event.createdAt.getTime();

    if (
      currentGroup &&
      currentGroup.action === event.action &&
      currentGroup.actorName === event.actorName &&
      Math.abs(lastEventTime - eventTime) <= windowMs
    ) {
      currentGroup.count += 1;
      // Since events are in descending order, event is chronologically earlier
      if (eventTime < currentGroup.firstAt.getTime()) {
        currentGroup.firstAt = event.createdAt;
      }
      if (eventTime > currentGroup.lastAt.getTime()) {
        currentGroup.lastAt = event.createdAt;
      }
      lastEventTime = eventTime;
    } else {
      if (currentGroup) {
        groups.push(currentGroup);
      }
      currentGroup = {
        key: event.id,
        category: categorizeAuditAction(event.action),
        action: event.action,
        actorName: event.actorName,
        count: 1,
        firstAt: event.createdAt,
        lastAt: event.createdAt,
        isDestructive: isDestructiveAction(event.action),
      };
      lastEventTime = eventTime;
    }
  }

  if (currentGroup) {
    groups.push(currentGroup);
  }

  return groups;
}
