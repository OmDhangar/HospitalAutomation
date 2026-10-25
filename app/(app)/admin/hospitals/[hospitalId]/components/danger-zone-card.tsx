'use client';

import { useState } from 'react';
import { Button } from '@/components/ui';
import { AlertTriangleIcon } from '@/components/icons';
import { ConfirmDestructiveModal } from '@/components/confirm-destructive';
import {
  revokePlanAction,
  restorePlanAction,
  setHospitalActiveAction,
} from '../actions';

export function DangerZoneCard({
  hospitalId,
  hasCurrentPlan,
  revokeReason,
  accountActive,
}: {
  hospitalId: string;
  hasCurrentPlan: boolean;
  revokeReason: string | null;
  accountActive: boolean;
}) {
  const [revokeModalOpen, setRevokeModalOpen] = useState(false);
  const [suspendModalOpen, setSuspendModalOpen] = useState(false);

  const handleRevokeConfirm = async (reason: string) => {
    const formData = new FormData();
    formData.set('hospitalId', hospitalId);
    formData.set('reason', reason);
    formData.set('confirm', 'REVOKE');
    try {
      await revokePlanAction(formData);
      return { ok: true };
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes('NEXT_REDIRECT')) {
        throw err;
      }
      return {
        ok: false,
        error: err instanceof Error ? err.message : 'Failed to revoke plan',
      };
    }
  };

  const handleSuspendConfirm = async (reason: string) => {
    const formData = new FormData();
    formData.set('hospitalId', hospitalId);
    formData.set('active', 'false');
    formData.set('reason', reason);
    formData.set('confirm', 'SUSPEND');
    try {
      await setHospitalActiveAction(formData);
      return { ok: true };
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes('NEXT_REDIRECT')) {
        throw err;
      }
      return {
        ok: false,
        error: err instanceof Error ? err.message : 'Failed to suspend account',
      };
    }
  };

  return (
    <div className="rounded-xl border border-rose-200 bg-white overflow-hidden shadow-xs">
      <div className="flex items-center gap-2.5 border-b border-rose-200 bg-rose-50 px-5 py-3.5">
        <AlertTriangleIcon className="size-5 shrink-0 text-rose-600" />
        <div>
          <h3 className="text-sm font-semibold text-rose-900">Danger zone</h3>
          <p className="text-xs text-rose-700">
            These actions change this account&apos;s status or lock staff out.
          </p>
        </div>
      </div>

      <div className="divide-y divide-ink-100 p-2">
        {/* Revoke / Restore Row */}
        <div className="flex flex-wrap items-center justify-between gap-4 p-3.5">
          <div className="min-w-0 flex-1">
            <h4 className="text-sm font-semibold text-ink-900">
              {revokeReason !== null ? 'Plan revoked' : 'Revoke plan'}
            </h4>
            <p className="mt-0.5 text-xs text-ink-600">
              {revokeReason !== null ? (
                <span className="font-medium text-rose-800">
                  Plan revoked · Reason: {revokeReason || 'unspecified'}. Staff are locked out.
                </span>
              ) : (
                'Locks staff out and stops online booking. Restorable at any time.'
              )}
            </p>
          </div>

          <div className="shrink-0">
            {revokeReason !== null ? (
              <form action={restorePlanAction}>
                <input type="hidden" name="hospitalId" value={hospitalId} />
                <Button type="submit" variant="primary">
                  Restore plan
                </Button>
              </form>
            ) : (
              <Button
                type="button"
                variant="danger"
                disabled={!hasCurrentPlan}
                onClick={() => setRevokeModalOpen(true)}
              >
                Revoke plan…
              </Button>
            )}
          </div>
        </div>

        {/* Suspend / Reactivate Row */}
        <div className="flex flex-wrap items-center justify-between gap-4 p-3.5">
          <div className="min-w-0 flex-1">
            <h4 className="text-sm font-semibold text-ink-900">
              {!accountActive ? 'Account suspended' : 'Suspend account'}
            </h4>
            <p className="mt-0.5 text-xs text-ink-600">
              {!accountActive
                ? 'This hospital is hidden from portfolio and lists. Reactivate to restore visibility.'
                : 'Hides this hospital from the portfolio and onboarding lists. Staff cannot sign in.'}
            </p>
          </div>

          <div className="shrink-0">
            {!accountActive ? (
              <form action={setHospitalActiveAction}>
                <input type="hidden" name="hospitalId" value={hospitalId} />
                <input type="hidden" name="active" value="true" />
                <input type="hidden" name="reason" value="Reactivated by operator" />
                <Button type="submit" variant="primary">
                  Reactivate account
                </Button>
              </form>
            ) : (
              <Button
                type="button"
                variant="danger"
                onClick={() => setSuspendModalOpen(true)}
              >
                Suspend account…
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* Revoke Plan Destructive Modal */}
      <ConfirmDestructiveModal
        isOpen={revokeModalOpen}
        onClose={() => setRevokeModalOpen(false)}
        title="Revoke plan?"
        description={[
          'Sign out every staff member immediately',
          'Stop all online bookings for this hospital',
          'Hide the hospital from onboarding lists',
          'Nothing is deleted — you can restore at any time',
        ]}
        confirmWord="REVOKE"
        submitLabel="Revoke plan"
        onConfirm={handleRevokeConfirm}
      />

      {/* Suspend Account Destructive Modal */}
      <ConfirmDestructiveModal
        isOpen={suspendModalOpen}
        onClose={() => setSuspendModalOpen(false)}
        title="Suspend account?"
        description={[
          'Hides this hospital from the portfolio and onboarding lists',
          'Staff can no longer sign in to this account',
          'Clinical and patient data remains intact',
          'You can reactivate this account at any time',
        ]}
        confirmWord="SUSPEND"
        submitLabel="Suspend account"
        onConfirm={handleSuspendConfirm}
      />
    </div>
  );
}
