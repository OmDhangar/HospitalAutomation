'use client';

import { useActionState } from 'react';
import { Alert, Button, Input } from '@/components/ui';
import { resetPasswordAction, type ResetPasswordState } from './actions';

const ERRORS: Record<string, string> = {
  REASON_REQUIRED: 'Give a reason — it goes in the hospital’s audit log.',
  MEMBERSHIP_NOT_FOUND: 'That user is not a member of this hospital.',
  USER_NOT_FOUND: 'That user no longer exists.',
  INVALID_INPUT: 'Something was missing. Nothing was changed.',
};

/**
 * A client component for one reason: the new password comes back in the action's
 * return value rather than through a redirect, so it is never written into a
 * URL. `useActionState` is what makes a returned value renderable at all.
 */
export function PasswordResetForm({
  hospitalId,
  userId,
  userName,
}: {
  hospitalId: string;
  userId: string;
  userName: string;
}) {
  const [state, formAction, pending] = useActionState<ResetPasswordState, FormData>(
    resetPasswordAction,
    { status: 'idle' },
  );

  if (state.status === 'done') {
    return (
      <div className="space-y-2">
        <Alert tone="success">
          <p className="font-medium">Password reset for {state.email}</p>
          <p className="mt-1">
            Read this out once, then it is gone — it is not stored anywhere readable
            and they must change it at their next sign-in.
          </p>
          <p className="numeric mt-2 select-all rounded bg-white/70 px-3 py-2 text-base font-semibold tracking-wider text-ink-900">
            {state.temporaryPassword}
          </p>
        </Alert>
      </div>
    );
  }

  return (
    <form action={formAction} className="space-y-2">
      <input type="hidden" name="hospitalId" value={hospitalId} />
      <input type="hidden" name="userId" value={userId} />
      <Input
        name="reason"
        required
        placeholder={`Why ${userName} needs a reset`}
        className="text-sm"
      />
      {state.status === 'error' ? (
        <Alert tone="error">{ERRORS[state.code] ?? 'That did not work.'}</Alert>
      ) : null}
      <Button type="submit" size="sm" variant="secondary" isLoading={pending}>
        Issue temporary password
      </Button>
    </form>
  );
}
