'use client';

import { useState } from 'react';
import { Button, Field, Input } from '@/components/ui';
import { BackLink, StandingPill, shortDate } from '../../../ui';
import { ConfirmModal } from '@/components/confirm-destructive';
import { startImpersonationAction } from '../actions';
import type { AccountRow } from '@/lib/services/platform-accounts';

export function AccountHeader({
  account,
  branches = [],
  canImpersonate = true,
}: {
  account: AccountRow;
  branches?: Array<{ id: string; name: string }>;
  canImpersonate?: boolean;
}) {
  const [supportModalOpen, setSupportModalOpen] = useState(false);

  const branchText =
    branches.length === 1
      ? branches[0].name
      : branches.length > 1
        ? `${branches.length} branches`
        : 'No branches';

  return (
    <div className="space-y-4">
      <BackLink href="/admin/hospitals">All accounts</BackLink>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2.5">
            <h1 className="text-xl font-bold text-ink-900">{account.name}</h1>
            <StandingPill standing={account.standing} />
            {!account.active && (
              <span className="rounded-full bg-ink-800 px-2 py-0.5 text-xs font-semibold text-white">
                Switched off
              </span>
            )}
          </div>
          <p className="mt-0.5 text-xs text-ink-500">
            {account.slug} · {branchText} · Onboarded {shortDate(account.createdAt)}
          </p>
        </div>

        {canImpersonate && (
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="secondary"
              onClick={() => setSupportModalOpen(true)}
            >
              Support access
            </Button>
          </div>
        )}
      </div>

      <ConfirmModal
        isOpen={supportModalOpen}
        onClose={() => setSupportModalOpen(false)}
        title="Support access (read-only, 30 min)"
      >
        <form action={startImpersonationAction} className="space-y-4">
          <input type="hidden" name="hospitalId" value={account.hospitalId} />
          <p className="text-xs text-ink-600">
            This starts a 30-minute read-only session as this hospital. The reason is recorded in their audit log.
          </p>
          <Field label="Reason" hint="Ticket number or operational reason">
            <Input
              name="reason"
              required
              autoFocus
              placeholder="e.g. Ticket #1234 or checking billing issue"
              className="py-2 text-sm"
            />
          </Field>
          <div className="flex items-center justify-end gap-2 pt-2 border-t border-ink-100">
            <Button
              type="button"
              variant="ghost"
              onClick={() => setSupportModalOpen(false)}
            >
              Cancel
            </Button>
            <Button type="submit" variant="primary">
              View as hospital
            </Button>
          </div>
        </form>
      </ConfirmModal>
    </div>
  );
}
