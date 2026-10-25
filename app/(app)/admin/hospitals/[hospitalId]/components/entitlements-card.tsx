import { Card, CardHeader, cn } from '@/components/ui';
import { CheckIcon, XIcon } from '@/components/icons';
import { EntitlementMeter } from '../../../ui';
import { supportLabel } from '@/lib/domain/entitlements';
import type { EntitlementAxis } from '@/lib/domain/platform-account';

const FEATURES = [
  { key: 'hasDisplayBoard', label: 'Display board' },
  { key: 'hasOwnerReport', label: 'Owner report' },
  { key: 'hasAdvancedReports', label: 'Advanced reports' },
  { key: 'hasDataExport', label: 'Data export' },
  { key: 'hasAuditLog', label: 'Audit log' },
] as const;

export function EntitlementsCard({
  entitlements,
  features,
}: {
  entitlements: EntitlementAxis[];
  features?: {
    supportTier: string;
    hasDisplayBoard: boolean;
    hasOwnerReport: boolean;
    hasAdvancedReports: boolean;
    hasDataExport: boolean;
    hasAuditLog: boolean;
  } | null;
}) {
  return (
    <Card>
      <CardHeader
        title="What the plan allows"
        hint="Counted live against the agreement"
      />

      <div className="space-y-4 p-5">
        {entitlements.map((axis) => (
          <div key={axis.kind} className="space-y-1">
            <EntitlementMeter axis={axis} />
            {(axis.level === 'exhausted' || axis.level === 'critical') && (
              <p className="text-xs font-medium text-amber-800">
                ⚠ At the plan limit
              </p>
            )}
          </div>
        ))}
      </div>

      {features ? (
        <div className="border-t border-ink-200 px-5 py-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-500">
            Features
          </p>
          <ul className="mt-2.5 grid grid-cols-1 gap-2 sm:grid-cols-2">
            {FEATURES.map(({ key, label }) => {
              const enabled = Boolean(features[key]);
              return (
                <li key={key} className="flex items-center gap-2 text-xs">
                  {enabled ? (
                    <CheckIcon className="size-4 shrink-0 text-emerald-600" />
                  ) : (
                    <XIcon className="size-4 shrink-0 text-ink-300" />
                  )}
                  <span
                    className={
                      enabled
                        ? 'font-medium text-ink-800'
                        : 'text-ink-400 line-through'
                    }
                  >
                    {label}
                  </span>
                </li>
              );
            })}
          </ul>
          <p className="mt-3 text-xs text-ink-600">
            Support tier: <span className="font-medium text-ink-800">{supportLabel(features.supportTier)}</span>
          </p>
        </div>
      ) : null}
    </Card>
  );
}
