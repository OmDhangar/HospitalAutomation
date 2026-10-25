import { Card, CardHeader } from '@/components/ui';
import { UsageMeter, shortDate } from '../../../ui';
import type { UsageAxis } from '@/lib/domain/subscription';

export function UsageThisPeriodCard({
  period,
  appointments,
  messages,
}: {
  period: { start: Date; end: Date } | null;
  appointments: UsageAxis;
  messages: UsageAxis;
}) {
  const periodHint = period
    ? `Usage this period · ${shortDate(period.start)} – ${shortDate(period.end)}`
    : 'Usage this period';

  return (
    <Card>
      <CardHeader
        title={periodHint}
        hint={period ? undefined : 'No term to measure'}
      />

      <div className="space-y-4 p-5">
        <UsageMeter label="Appointments completed" axis={appointments} />
        <UsageMeter label="Messages sent" axis={messages} />

        <p className="text-xs text-ink-500">
          {appointments.used > 0
            ? `${(messages.used / appointments.used).toFixed(2)} messages per appointment`
            : 'No completed appointments yet this period.'}
        </p>
      </div>
    </Card>
  );
}
