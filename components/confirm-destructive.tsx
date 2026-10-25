'use client';

import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Button, Field, Input } from '@/components/ui';
import { XIcon } from '@/components/icons';

export interface ConfirmDestructiveModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  description: string[];
  confirmWord: string;
  reasonLabel?: string;
  reasonRequired?: boolean;
  submitLabel: string;
  onConfirm: (reason: string) => Promise<{ ok: boolean; error?: string }>;
}

export function ConfirmDestructiveModal({
  isOpen,
  onClose,
  title,
  description,
  confirmWord,
  reasonLabel = 'Reason',
  reasonRequired = true,
  submitLabel,
  onConfirm,
}: ConfirmDestructiveModalProps) {
  const [reason, setReason] = useState('');
  const [typed, setTyped] = useState('');
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dialogRef = useRef<HTMLDivElement>(null);
  const reasonInputRef = useRef<HTMLInputElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (isOpen) {
      previousFocusRef.current = document.activeElement as HTMLElement | null;
      setReason('');
      setTyped('');
      setError(null);
      setIsPending(false);
      // Focus the reason input on open
      setTimeout(() => {
        reasonInputRef.current?.focus();
      }, 50);
    } else if (previousFocusRef.current) {
      previousFocusRef.current.focus();
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

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (typed !== confirmWord || isPending) return;
    if (reasonRequired && !reason.trim()) {
      setError('A reason is required.');
      return;
    }

    setIsPending(true);
    setError(null);
    try {
      const res = await onConfirm(reason.trim());
      if (!res.ok) {
        setError(res.error ?? 'Action failed.');
      } else {
        onClose();
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes('NEXT_REDIRECT')) {
        throw err;
      }
      setError(err instanceof Error ? err.message : 'An error occurred.');
    } finally {
      setIsPending(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-destructive-title"
    >
      <div
        ref={dialogRef}
        className="w-full max-w-md rounded-2xl bg-white p-5 shadow-2xl ring-1 ring-ink-200"
      >
        <header className="flex items-start justify-between gap-3">
          <h3
            id="confirm-destructive-title"
            className="text-base font-semibold text-ink-900"
          >
            {title}
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

        <form onSubmit={handleSubmit} className="mt-3 space-y-4">
          {description.length > 0 && (
            <ul className="list-disc pl-5 text-sm text-ink-700 space-y-1">
              {description.map((bullet, i) => (
                <li key={i}>{bullet}</li>
              ))}
            </ul>
          )}

          <Field label={reasonLabel}>
            <Input
              ref={reasonInputRef}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              required={reasonRequired}
              placeholder="Reason for audit log"
              className="py-2 text-sm"
            />
          </Field>

          <div>
            <Field label={`Type ${confirmWord} to confirm`}>
              <Input
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                placeholder={confirmWord}
                autoComplete="off"
                aria-describedby="destructive-confirm-help destructive-confirm-error"
                className="py-2 text-sm font-mono"
              />
            </Field>
            <span id="destructive-confirm-help" className="sr-only">
              Required, type {confirmWord} to confirm
            </span>
            {error ? (
              <p
                id="destructive-confirm-error"
                role="alert"
                aria-live="polite"
                className="mt-1.5 text-xs text-rose-700 font-medium"
              >
                {error}
              </p>
            ) : null}
          </div>

          <footer className="mt-5 flex items-center justify-end gap-2 pt-2 border-t border-ink-100">
            <Button
              type="button"
              variant="ghost"
              onClick={onClose}
              disabled={isPending}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="danger"
              disabled={typed !== confirmWord || isPending}
              isLoading={isPending}
            >
              {submitLabel}
            </Button>
          </footer>
        </form>
      </div>
    </div>
  );
}

export interface ConfirmModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  reasonLabel?: string;
  reasonRequired?: boolean;
  reasonPlaceholder?: string;
  submitLabel?: string;
  submitVariant?: 'primary' | 'secondary' | 'danger';
  onConfirm?: (reason: string) => Promise<{ ok: boolean; error?: string }> | void | Promise<void>;
  children?: ReactNode;
}

export function ConfirmModal({
  isOpen,
  onClose,
  title,
  description,
  reasonLabel = 'Reason',
  reasonRequired = false,
  reasonPlaceholder,
  submitLabel = 'Confirm',
  submitVariant = 'primary',
  onConfirm,
  children,
}: ConfirmModalProps) {
  const [reason, setReason] = useState('');
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (isOpen) {
      previousFocusRef.current = document.activeElement as HTMLElement | null;
      setReason('');
      setError(null);
      setIsPending(false);
      setTimeout(() => {
        if (inputRef.current) {
          inputRef.current.focus();
        } else if (dialogRef.current) {
          const focusable = dialogRef.current.querySelector<HTMLElement>(
            'button, [href], input, select, textarea',
          );
          focusable?.focus();
        }
      }, 50);
    } else if (previousFocusRef.current) {
      previousFocusRef.current.focus();
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

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isPending) return;
    if (reasonRequired && !reason.trim()) {
      setError('A reason is required.');
      return;
    }

    if (!onConfirm) {
      onClose();
      return;
    }

    setIsPending(true);
    setError(null);
    try {
      const res = await onConfirm(reason.trim());
      if (res && typeof res === 'object' && 'ok' in res && !res.ok) {
        setError(res.error ?? 'Action failed.');
      } else {
        onClose();
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes('NEXT_REDIRECT')) {
        throw err;
      }
      setError(err instanceof Error ? err.message : 'An error occurred.');
    } finally {
      setIsPending(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-modal-title"
    >
      <div
        ref={dialogRef}
        className="w-full max-w-md rounded-2xl bg-white p-5 shadow-2xl ring-1 ring-ink-200"
      >
        <header className="flex items-start justify-between gap-3">
          <h3 id="confirm-modal-title" className="text-base font-semibold text-ink-900">
            {title}
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

        {children ? (
          <div className="mt-3">{children}</div>
        ) : (
          <form onSubmit={handleSubmit} className="mt-3 space-y-4">
            {description ? (
              <div className="text-sm text-ink-700">
                {Array.isArray(description) ? (
                  <ul className="list-disc pl-5 space-y-1">
                    {description.map((b, i) => (
                      <li key={i}>{b}</li>
                    ))}
                  </ul>
                ) : (
                  description
                )}
              </div>
            ) : null}

            {onConfirm && (
              <Field label={reasonLabel}>
                <Input
                  ref={inputRef}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  required={reasonRequired}
                  placeholder={reasonPlaceholder ?? 'Reason for audit log'}
                  className="py-2 text-sm"
                />
              </Field>
            )}

            {error ? (
              <p role="alert" aria-live="polite" className="text-xs text-rose-700 font-medium">
                {error}
              </p>
            ) : null}

            <footer className="mt-5 flex items-center justify-end gap-2 pt-2 border-t border-ink-100">
              <Button
                type="button"
                variant="ghost"
                onClick={onClose}
                disabled={isPending}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                variant={submitVariant}
                disabled={isPending}
                isLoading={isPending}
              >
                {submitLabel}
              </Button>
            </footer>
          </form>
        )}
      </div>
    </div>
  );
}
