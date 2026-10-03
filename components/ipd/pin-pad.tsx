'use client';

import { useRef, useState } from 'react';
import { cn } from '@/components/ui';

/**
 * A 4-digit PIN pad with big keys (IPD plan §5.6). Submits itself on the
 * fourth digit, so unlocking is four taps. The digits are never shown.
 */
export function PinPad({ action, userId }: { action: (form: FormData) => Promise<void>; userId: string }) {
  const [pin, setPin] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);

  const press = (digit: string) => {
    if (submitting || pin.length >= 4) return;
    const next = pin + digit;
    setPin(next);
    if (next.length === 4) {
      setSubmitting(true);
      // Let the fourth dot render before the page navigates.
      requestAnimationFrame(() => formRef.current?.requestSubmit());
    }
  };

  return (
    <form ref={formRef} action={action} className="space-y-5">
      <input type="hidden" name="userId" value={userId} />
      <input type="hidden" name="pin" value={pin} />
      <div className="flex justify-center gap-4" aria-label={`${pin.length} of 4 digits entered`} role="status">
        {[0, 1, 2, 3].map((i) => (
          <span
            key={i}
            className={cn('size-5 rounded-full ring-2 ring-brand-600', i < pin.length ? 'bg-brand-600' : 'bg-white')}
          />
        ))}
      </div>
      <div className="mx-auto grid max-w-xs grid-cols-3 gap-3">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((digit) => (
          <Key key={digit} onClick={() => press(digit)} disabled={submitting}>
            {digit}
          </Key>
        ))}
        <Key onClick={() => setPin('')} disabled={submitting || pin.length === 0} label="Clear">
          <span className="text-base font-semibold">Clear</span>
        </Key>
        <Key onClick={() => press('0')} disabled={submitting}>
          0
        </Key>
        <Key onClick={() => setPin((p) => p.slice(0, -1))} disabled={submitting || pin.length === 0} label="Delete last digit">
          <span className="text-2xl">⌫</span>
        </Key>
      </div>
    </form>
  );
}

function Key({
  children,
  onClick,
  disabled,
  label,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className="numeric flex h-16 items-center justify-center rounded-2xl bg-white text-3xl font-bold text-ink-900 shadow-xs ring-1 ring-ink-200 active:bg-ink-100 disabled:opacity-40"
    >
      {children}
    </button>
  );
}
