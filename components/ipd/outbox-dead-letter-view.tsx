'use client';

import React, { useState, useTransition } from 'react';
import { Badge, Button, Card, EmptyState } from '@/components/ui';
import { AlertTriangleIcon, CheckIcon, RefreshCwIcon, ClockIcon } from '@/components/icons';
import { retryDeadLetterAction } from '@/app/(app)/ipd/actions';
import type { SelectIpdEmarIntegrationOutbox } from '@/lib/db/schema';

interface OutboxDeadLetterViewProps {
  items: SelectIpdEmarIntegrationOutbox[];
}

export function OutboxDeadLetterView({ items }: OutboxDeadLetterViewProps) {
  const [isPending, startTransition] = useTransition();
  const [retriedIds, setRetriedIds] = useState<Set<string>>(new Set());
  const [feedback, setFeedback] = useState<string | null>(null);

  const handleRetry = (id: string) => {
    startTransition(async () => {
      try {
        await retryDeadLetterAction({ outboxId: id });
        setRetriedIds((prev) => new Set(prev).add(id));
        setFeedback(`Outbox event queued for immediate processing.`);
        setTimeout(() => setFeedback(null), 3000);
      } catch (err: any) {
        setFeedback(`Failed to retry: ${err?.message ?? 'Unknown error'}`);
      }
    });
  };

  const activeItems = items.filter((i) => !retriedIds.has(i.id));

  if (activeItems.length === 0) {
    return (
      <Card className="p-6 text-center">
        <EmptyState
          title="Outbox is healthy"
          hint="There are no dead-lettered or failed eMAR integration events. All administered medications have posted to billing and stock."
        />
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {feedback && (
        <div className="rounded-lg bg-emerald-50 p-3 text-xs font-medium text-emerald-800 border border-emerald-200">
          {feedback}
        </div>
      )}

      <div className="rounded-lg border border-ink-200 bg-white overflow-hidden shadow-sm">
        <div className="bg-ink-50 px-4 py-3 border-b border-ink-200 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <AlertTriangleIcon className="h-4 w-4 text-rose-600" />
            <h3 className="text-sm font-semibold text-ink-900">
              Dead-Letter Queue ({activeItems.length})
            </h3>
          </div>
          <span className="text-xs text-ink-500">
            eMAR Bedside Billing & Stock Sync
          </span>
        </div>

        <div className="divide-y divide-ink-100">
          {activeItems.map((item) => {
            const payload = (item.payload as Record<string, any>) ?? {};
            return (
              <div key={item.id} className="p-4 space-y-2 hover:bg-ink-50/40 transition-colors">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-mono font-bold uppercase tracking-wider text-ink-700 bg-ink-100 px-1.5 py-0.5 rounded">
                        {item.integrationType}:{item.eventType}
                      </span>
                      <span className="text-xs text-ink-500">
                        Attempts: <strong>{item.attempts}</strong>
                      </span>
                    </div>
                    <div className="text-xs text-ink-600 mt-1 font-mono">
                      Admin ID: {item.administrationId}
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <Badge tone={item.status === 'failed' ? 'error' : 'warn'} size="sm">
                      {item.status === 'failed' ? 'Failed (Dead-Letter)' : 'Pending Pricing'}
                    </Badge>
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      disabled={isPending}
                      onClick={() => handleRetry(item.id)}
                      className="gap-1 text-xs min-h-8"
                    >
                      <RefreshCwIcon className={`h-3.5 w-3.5 ${isPending ? 'animate-spin' : ''}`} />
                      Retry
                    </Button>
                  </div>
                </div>

                {item.lastError && (
                  <div className="rounded bg-rose-50 p-2.5 text-xs text-rose-900 border border-rose-200 font-mono">
                    <strong>Error:</strong> {item.lastError}
                  </div>
                )}

                <div className="flex items-center gap-4 text-xs text-ink-400 pt-1">
                  <span className="flex items-center gap-1">
                    <ClockIcon className="h-3.5 w-3.5" />
                    Created {new Date(item.createdAt).toLocaleDateString('en-IN', {
                      day: 'numeric',
                      month: 'short',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </span>
                  {payload.medicineId && (
                    <span>Medicine ID: <code className="text-ink-600">{payload.medicineId}</code></span>
                  )}
                  {payload.quantity && (
                    <span>Qty: <strong>{payload.quantity}</strong></span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
