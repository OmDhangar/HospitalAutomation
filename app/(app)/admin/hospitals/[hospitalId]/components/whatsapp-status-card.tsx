'use client';

import { useState } from 'react';
import { Button, Card, CardHeader, EmptyState, cn } from '@/components/ui';
import { Drawer } from '@/components/ipd/drawer';
import type { BindingView } from '@/lib/services/whatsapp-byo';
import { WhatsAppCard } from '../whatsapp-card';

export function WhatsAppStatusCard({
  hospitalId,
  binding,
  number,
}: {
  hospitalId: string;
  binding: BindingView | null;
  number: {
    phoneNumberId: string;
    displayPhoneNumber: string | null;
    verifiedName: string | null;
    status: string;
    qualityRating: string | null;
  } | null;
}) {
  const [drawerOpen, setDrawerOpen] = useState(false);

  const phone = number?.displayPhoneNumber ?? binding?.phoneNumberId ?? null;
  const verifiedName = number?.verifiedName ?? binding?.verifiedName ?? null;
  const status = number?.status ?? binding?.status ?? null;
  const wabaId = binding?.wabaId ?? null;
  const quality = number?.qualityRating ?? null;

  const isConfigured = Boolean(number || binding);

  const isLive =
    status &&
    (status.toLowerCase() === 'live' ||
      status.toLowerCase() === 'connected' ||
      status.toLowerCase() === 'registered' ||
      status.toLowerCase() === 'verified');

  return (
    <>
      <Card>
        <CardHeader title="WhatsApp" />

        {!isConfigured ? (
          <div className="p-5 text-center">
            <p className="text-sm font-medium text-ink-600">No WhatsApp configured</p>
            <p className="mt-1 text-xs text-ink-400">
              Bind the hospital’s own WABA or assign a number.
            </p>
            <div className="mt-4">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => setDrawerOpen(true)}
              >
                Configure WhatsApp…
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-4 p-5">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate font-medium text-ink-900">
                  {phone ?? 'Not assigned'}
                  {verifiedName ? ` · ${verifiedName}` : ''}
                </p>
                <p className="mt-0.5 text-xs text-ink-500">
                  WABA: {wabaId ? `…${wabaId.slice(-8)}` : '—'} · Quality:{' '}
                  {quality ?? '—'}
                </p>
              </div>

              {status ? (
                <span
                  className={cn(
                    'inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ring-inset',
                    isLive
                      ? 'bg-emerald-50 text-emerald-800 ring-emerald-200'
                      : 'bg-amber-50 text-amber-800 ring-amber-200',
                  )}
                >
                  ● {status.charAt(0).toUpperCase() + status.slice(1).toLowerCase()}
                </span>
              ) : null}
            </div>

            <div className="pt-2">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => setDrawerOpen(true)}
              >
                Open details →
              </Button>
            </div>
          </div>
        )}
      </Card>

      <Drawer
        isOpen={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        title="WhatsApp Configuration"
        size="lg"
      >
        <div className="py-2">
          <WhatsAppCard
            hospitalId={hospitalId}
            binding={binding}
            number={number}
          />
        </div>
      </Drawer>
    </>
  );
}
