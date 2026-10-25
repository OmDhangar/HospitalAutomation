'use client';

import { useRef, useState } from 'react';
import { Button, Card, CardHeader, EmptyState, Field, Input, cn } from '@/components/ui';
import { RowMenu, type RowMenuItem } from '@/components/row-menu';
import { ConfirmModal } from '@/components/confirm-destructive';
import { dateTime } from '../../../ui';
import { IssueTempPasswordModal } from '../password-reset';
import {
  addStaffAction,
  setMembershipActiveAction,
  setUserActiveAction,
} from '../actions';
import type { AccountUser } from '@/lib/services/platform-accounts';

const SELECT_CLASS =
  'block w-full rounded-lg border-0 bg-white px-3 py-2 text-sm text-ink-900 ' +
  'ring-1 ring-inset ring-ink-300 focus:ring-2 focus:ring-inset focus:ring-brand-600 focus:outline-none';

export function LoginsTable({
  hospitalId,
  users,
}: {
  hospitalId: string;
  users: AccountUser[];
}) {
  const [showAddForm, setShowAddForm] = useState(false);
  const [resetUser, setResetUser] = useState<{ userId: string; userName: string } | null>(null);
  const [revokeUser, setRevokeUser] = useState<AccountUser | null>(null);
  const [disableUser, setDisableUser] = useState<AccountUser | null>(null);

  const actionFormRef = useRef<HTMLFormElement>(null);
  const [actionFormData, setActionFormData] = useState<{
    action: (formData: FormData) => Promise<void>;
    fields: Record<string, string>;
  } | null>(null);

  const triggerDirectAction = (
    action: (formData: FormData) => Promise<void>,
    fields: Record<string, string>,
  ) => {
    setActionFormData({ action, fields });
    setTimeout(() => {
      actionFormRef.current?.requestSubmit();
    }, 10);
  };

  const owners = users.filter((u) => u.role === 'owner' && u.membershipActive && u.userActive);
  const hint = `${users.length} staff · ${owners.length} active ${owners.length === 1 ? 'owner' : 'owners'}`;

  return (
    <Card>
      <CardHeader
        title="Logins"
        hint={hint}
        action={
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => setShowAddForm((v) => !v)}
          >
            {showAddForm ? 'Cancel' : '+ Add login'}
          </Button>
        }
      />

      {users.length === 0 ? (
        <EmptyState title="Nobody can sign in" hint="This hospital has no staff accounts." />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-ink-200 text-left text-xs uppercase tracking-wide text-ink-500">
                <th className="px-5 py-2.5 font-medium">Person</th>
                <th className="px-5 py-2.5 font-medium">Role</th>
                <th className="px-5 py-2.5 font-medium">Last sign-in</th>
                <th className="px-5 py-2.5 font-medium">State</th>
                <th className="px-5 py-2.5 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-200 align-top">
              {users.map((user) => {
                const locked = !user.userActive || !user.membershipActive;

                const menuItems: RowMenuItem[] = [
                  {
                    label: 'Issue temporary password',
                    onClick: () =>
                      setResetUser({ userId: user.userId, userName: user.name }),
                  },
                ];

                if (user.membershipActive && user.membershipId) {
                  menuItems.push({
                    label: 'Revoke access to this hospital',
                    tone: 'danger',
                    onClick: () => setRevokeUser(user),
                  });
                } else if (user.membershipId) {
                  menuItems.push({
                    label: 'Restore access to this hospital',
                    onClick: () =>
                      triggerDirectAction(setMembershipActiveAction, {
                        hospitalId,
                        membershipId: user.membershipId!,
                        active: 'true',
                      }),
                  });
                }

                if (user.userActive) {
                  menuItems.push({
                    label: 'Disable login',
                    tone: 'danger',
                    onClick: () => setDisableUser(user),
                  });
                } else {
                  menuItems.push({
                    label: 'Enable login',
                    onClick: () =>
                      triggerDirectAction(setUserActiveAction, {
                        hospitalId,
                        userId: user.userId,
                        active: 'true',
                      }),
                  });
                }

                return (
                  <tr key={user.membershipId ?? user.userId}>
                    <td className="px-5 py-3">
                      <p className="font-medium text-ink-900">{user.name}</p>
                      <p className="text-xs text-ink-500">{user.email}</p>
                      {user.branchName ? (
                        <p className="text-xs text-ink-400">{user.branchName}</p>
                      ) : null}
                      {user.mustChangePassword ? (
                        <span className="mt-1 inline-block rounded bg-amber-50 px-1.5 py-0.5 text-[11px] font-medium text-amber-800 ring-1 ring-inset ring-amber-200">
                          Must change password
                        </span>
                      ) : null}
                    </td>
                    <td className="px-5 py-3 capitalize text-ink-700">
                      {user.role ?? '—'}
                      {user.isPlatformAdmin ? (
                        <span className="ml-1.5 rounded bg-violet-50 px-1.5 py-0.5 text-xs font-medium text-violet-800">
                          operator
                        </span>
                      ) : null}
                    </td>
                    <td className="px-5 py-3 text-xs text-ink-500">
                      {dateTime(user.lastLoginAt)}
                    </td>
                    <td className="px-5 py-3">
                      <span
                        className={cn(
                          'inline-flex rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset',
                          locked
                            ? 'bg-rose-50 text-rose-800 ring-rose-200'
                            : 'bg-emerald-50 text-emerald-800 ring-emerald-200',
                        )}
                      >
                        {!user.userActive
                          ? 'Login disabled'
                          : !user.membershipActive
                            ? 'No access here'
                            : 'Active'}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-right">
                      <RowMenu
                        items={menuItems}
                        ariaLabel={`Actions for ${user.name}`}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Inline Add Login Form */}
      {showAddForm && (
        <form
          action={addStaffAction}
          className="grid gap-3 border-t border-ink-200 bg-ink-50/50 p-4 sm:grid-cols-4"
        >
          <input type="hidden" name="hospitalId" value={hospitalId} />
          <Field label="Name">
            <Input name="name" required placeholder="Dr. Anjali Patil" className="py-2 text-sm" />
          </Field>
          <Field label="Email">
            <Input name="email" type="email" required placeholder="anjali@hospital.in" className="py-2 text-sm" />
          </Field>
          <Field label="Role">
            <select name="role" defaultValue="receptionist" className={SELECT_CLASS}>
              <option value="owner">Owner</option>
              <option value="receptionist">Receptionist</option>
              <option value="doctor">Doctor</option>
              <option value="nurse">Nurse</option>
            </select>
          </Field>
          <div className="flex items-end">
            <Button type="submit" variant="primary" className="w-full">
              Add login
            </Button>
          </div>
          <p className="text-xs text-ink-500 sm:col-span-4">
            Starts on the default password until reset. Counts against the plan’s staff
            limit, which is checked here exactly as it is for the hospital itself.
          </p>
        </form>
      )}

      {/* Hidden helper form for direct server action calls */}
      {actionFormData && (
        <form ref={actionFormRef} action={actionFormData.action} className="hidden">
          {Object.entries(actionFormData.fields).map(([k, v]) => (
            <input key={k} type="hidden" name={k} value={v} />
          ))}
        </form>
      )}

      {/* Password Reset Modal */}
      {resetUser && (
        <IssueTempPasswordModal
          isOpen={true}
          onClose={() => setResetUser(null)}
          hospitalId={hospitalId}
          userId={resetUser.userId}
          userName={resetUser.userName}
        />
      )}

      {/* Revoke Membership Confirmation Modal */}
      {revokeUser && (
        <ConfirmModal
          isOpen={true}
          onClose={() => setRevokeUser(null)}
          title={`Revoke access for ${revokeUser.name}?`}
          submitLabel="Revoke access"
          submitVariant="danger"
        >
          <form action={setMembershipActiveAction} className="space-y-4">
            <input type="hidden" name="hospitalId" value={hospitalId} />
            <input type="hidden" name="membershipId" value={revokeUser.membershipId ?? ''} />
            <input type="hidden" name="active" value="false" />
            <p className="text-sm text-ink-700">
              This locks <span className="font-semibold">{revokeUser.name}</span> out of this
              hospital and signs out all their active sessions for it.
            </p>
            <div className="flex justify-end gap-2 pt-2 border-t border-ink-100">
              <Button type="button" variant="ghost" onClick={() => setRevokeUser(null)}>
                Cancel
              </Button>
              <Button type="submit" variant="danger">
                Revoke access
              </Button>
            </div>
          </form>
        </ConfirmModal>
      )}

      {/* Disable Login Confirmation Modal */}
      {disableUser && (
        <ConfirmModal
          isOpen={true}
          onClose={() => setDisableUser(null)}
          title={`Disable login for ${disableUser.name}?`}
          submitLabel="Disable login"
          submitVariant="danger"
        >
          <form action={setUserActiveAction} className="space-y-4">
            <input type="hidden" name="hospitalId" value={hospitalId} />
            <input type="hidden" name="userId" value={disableUser.userId} />
            <input type="hidden" name="active" value="false" />
            <p className="text-sm text-ink-700">
              This prevents <span className="font-semibold">{disableUser.name}</span> from
              signing in anywhere on QuriioHQ and terminates all active sessions.
            </p>
            <div className="flex justify-end gap-2 pt-2 border-t border-ink-100">
              <Button type="button" variant="ghost" onClick={() => setDisableUser(null)}>
                Cancel
              </Button>
              <Button type="submit" variant="danger">
                Disable login
              </Button>
            </div>
          </form>
        </ConfirmModal>
      )}
    </Card>
  );
}
