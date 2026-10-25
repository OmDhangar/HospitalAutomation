'use client';

import { useActionState, useEffect, useRef } from 'react';
import { Alert, Button, Field, Input } from '@/components/ui';
import { XIcon } from '@/components/icons';
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

export function IssueTempPasswordModal({
  isOpen,
  onClose,
  hospitalId,
  userId,
  userName,
}: {
  isOpen: boolean;
  onClose: () => void;
  hospitalId: string;
  userId: string;
  userName: string;
}) {
  const [state, formAction, pending] = useActionState<ResetPasswordState, FormData>(
    resetPasswordAction,
    { status: 'idle' },
  );

  const dialogRef = useRef<HTMLDivElement>(null);
  const reasonInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      setTimeout(() => {
        reasonInputRef.current?.focus();
      }, 50);
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        return;
      }

      if (e.key === 'Tab') {
        const dialog = dialogRef.current;
        if (!dialog) return;
        const focusable = dialog.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        );
        if (focusable.length === 0) return;

        const first = focusable[0];
        const last = focusable[focusable.length - 1];

        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="issue-temp-password-title"
    >
      <div
        ref={dialogRef}
        className="w-full max-w-md rounded-2xl bg-white p-5 shadow-2xl ring-1 ring-ink-200"
      >
        <header className="flex items-start justify-between gap-3">
          <h3
            id="issue-temp-password-title"
            className="text-base font-semibold text-ink-900"
          >
            Issue temporary password
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-ink-400 hover:bg-ink-100 hover:text-ink-600 focus:outline-none"
            aria-label="Close"
          >
            <XIcon className="size-4" />
          </button>
        </header>

        {state.status === 'done' ? (
          <div className="mt-4 space-y-4">
            <Alert tone="success">
              <p className="font-medium">Password reset for {state.email}</p>
              <p className="mt-1 text-xs">
                Read this out once, then it is gone — it is not stored anywhere readable
                and they must change it at their next sign-in.
              </p>
              <p className="numeric mt-2 select-all rounded bg-white/70 px-3 py-2 text-base font-semibold tracking-wider text-ink-900">
                {state.temporaryPassword}
              </p>
            </Alert>
            <div className="flex justify-end pt-2">
              <Button type="button" variant="primary" onClick={onClose}>
                Done
              </Button>
            </div>
          </div>
        ) : (
          <form action={formAction} className="mt-3 space-y-4">
            <input type="hidden" name="hospitalId" value={hospitalId} />
            <input type="hidden" name="userId" value={userId} />

            <p className="text-xs text-ink-600">
              Generating a temporary password will sign out any active sessions for{' '}
              <span className="font-semibold text-ink-900">{userName}</span>.
            </p>

            <Field label="Reason">
              <Input
                ref={reasonInputRef}
                name="reason"
                required
                placeholder={`Why ${userName} needs a reset`}
                className="py-2 text-sm"
              />
            </Field>

            {state.status === 'error' ? (
              <Alert tone="error">{ERRORS[state.code] ?? 'That did not work.'}</Alert>
            ) : null}

            <footer className="mt-5 flex items-center justify-end gap-2 pt-2 border-t border-ink-100">
              <Button
                type="button"
                variant="ghost"
                onClick={onClose}
                disabled={pending}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                variant="primary"
                disabled={pending}
                isLoading={pending}
              >
                Issue password
              </Button>
            </footer>
          </form>
        )}
      </div>
    </div>
  );
}
