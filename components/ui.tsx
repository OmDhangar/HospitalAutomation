import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react';
import type { AppointmentStatus } from '@/lib/domain/types';

export const cn = (...parts: Array<string | false | null | undefined>): string =>
  parts.filter(Boolean).join(' ');

/* --------------------------------------------------------------- button */

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
type ButtonSize = 'sm' | 'md' | 'lg' | 'xl';

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'bg-brand-600 text-white hover:bg-brand-700 active:bg-brand-800 shadow-sm ' +
    'focus-visible:outline-brand-700',
  secondary:
    'bg-white text-ink-700 ring-1 ring-inset ring-ink-300 hover:bg-ink-50 ' +
    'active:bg-ink-100 focus-visible:outline-ink-500',
  ghost: 'text-ink-600 hover:bg-ink-100 active:bg-ink-200 focus-visible:outline-ink-400',
  danger:
    'bg-white text-rose-700 ring-1 ring-inset ring-rose-200 hover:bg-rose-50 ' +
    'active:bg-rose-100 focus-visible:outline-rose-500',
};

const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-sm gap-1.5',
  md: 'h-10 px-4 text-sm gap-2',
  // Reception taps these hundreds of times a day, often in a hurry.
  lg: 'h-12 px-6 text-base gap-2',
  xl: 'h-16 px-8 text-lg gap-3 font-semibold',
};

export function Button({
  variant = 'secondary',
  size = 'md',
  isLoading = false,
  disabled,
  children,
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  isLoading?: boolean;
}) {
  return (
    <button
      {...props}
      disabled={disabled || isLoading}
      className={cn(
        'inline-flex items-center justify-center rounded-lg font-medium',
        'transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2',
        'disabled:cursor-not-allowed disabled:opacity-40',
        BUTTON_VARIANTS[variant],
        BUTTON_SIZES[size],
        className,
      )}
    >
      {isLoading ? (
        <svg
          className="animate-spin -ml-0.5 mr-2 size-4 text-current shrink-0"
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
        >
          <circle
            className="opacity-25"
            cx="12"
            cy="12"
            r="10"
            stroke="currentColor"
            strokeWidth="4"
          ></circle>
          <path
            className="opacity-75"
            fill="currentColor"
            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
          ></path>
        </svg>
      ) : null}
      {children}
    </button>
  );
}

/* ----------------------------------------------------------------- card */

export function Card({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <section
      className={cn(
        'rounded-xl border border-ink-200 bg-white shadow-[var(--shadow-card)]',
        className,
      )}
    >
      {children}
    </section>
  );
}

export function CardHeader({
  title,
  hint,
  action,
}: {
  title: ReactNode;
  hint?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <header className="flex items-center justify-between gap-4 border-b border-ink-200 px-5 py-3.5">
      <div className="min-w-0">
        <h2 className="truncate text-sm font-semibold text-ink-900">{title}</h2>
        {hint ? <p className="mt-0.5 truncate text-xs text-ink-500">{hint}</p> : null}
      </div>
      {action}
    </header>
  );
}

/* ------------------------------------------------------------ status pill */

/**
 * One vocabulary for queue state across the dashboard and the display, so a
 * receptionist never has to work out whether "Called" and "In consultation"
 * mean the same thing.
 */
const STATUS_STYLES: Record<AppointmentStatus, { label: string; className: string }> = {
  CREATED: { label: 'New', className: 'bg-ink-100 text-ink-600 ring-ink-200' },
  CONFIRMED: { label: 'Booked', className: 'bg-ink-100 text-ink-600 ring-ink-200' },
  ARRIVED: { label: 'Arrived', className: 'bg-sky-50 text-sky-700 ring-sky-200' },
  WAITING: { label: 'Waiting', className: 'bg-ink-100 text-ink-700 ring-ink-200' },
  CALLED: { label: 'Called', className: 'bg-brand-50 text-brand-800 ring-brand-300' },
  IN_CONSULTATION: {
    label: 'With doctor',
    className: 'bg-emerald-50 text-emerald-800 ring-emerald-200',
  },
  COMPLETED: { label: 'Done', className: 'bg-ink-50 text-ink-500 ring-ink-200' },
  SKIPPED: { label: 'Skipped', className: 'bg-amber-50 text-amber-800 ring-amber-200' },
  HELD: { label: 'On hold', className: 'bg-violet-50 text-violet-800 ring-violet-200' },
  CANCELLED: { label: 'Cancelled', className: 'bg-ink-50 text-ink-400 ring-ink-200' },
  NO_SHOW: { label: 'No show', className: 'bg-rose-50 text-rose-700 ring-rose-200' },
  EXPIRED: { label: 'Expired', className: 'bg-ink-50 text-ink-400 ring-ink-200' },
};

export function StatusPill({ status }: { status: AppointmentStatus }) {
  const style = STATUS_STYLES[status];
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded-full px-2 py-0.5',
        'text-xs font-medium ring-1 ring-inset',
        style.className,
      )}
    >
      {style.label}
    </span>
  );
}

export const statusLabel = (status: AppointmentStatus): string =>
  STATUS_STYLES[status].label;

/* ----------------------------------------------------------------- stat */

export function Stat({
  label,
  value,
  tone = 'default',
  hint,
}: {
  label: string;
  value: ReactNode;
  tone?: 'default' | 'brand' | 'warn';
  hint?: string;
}) {
  const toneClass =
    tone === 'brand' ? 'text-brand-700' : tone === 'warn' ? 'text-amber-700' : 'text-ink-900';

  return (
    <div className="px-5 py-4">
      <dt className="text-xs font-medium uppercase tracking-wide text-ink-500">{label}</dt>
      <dd className={cn('numeric mt-1 text-2xl font-semibold', toneClass)}>{value}</dd>
      {hint ? <p className="mt-0.5 text-xs text-ink-500">{hint}</p> : null}
    </div>
  );
}

/* ---------------------------------------------------------------- forms */

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-medium text-ink-700">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-xs text-ink-500">{hint}</span> : null}
    </label>
  );
}

export function Input({
  className,
  ...props
}: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={cn(
        'block w-full rounded-lg border-0 bg-white px-3 py-2.5 text-ink-900',
        'ring-1 ring-inset ring-ink-300 placeholder:text-ink-400',
        'focus:ring-2 focus:ring-inset focus:ring-brand-600 focus:outline-none',
        'disabled:bg-ink-50 disabled:text-ink-400',
        className,
      )}
    />
  );
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="px-6 py-14 text-center">
      <p className="text-sm font-medium text-ink-600">{title}</p>
      {hint ? <p className="mt-1 text-sm text-ink-400">{hint}</p> : null}
    </div>
  );
}

export function Alert({ children, tone = 'warn' }: { children: ReactNode; tone?: 'warn' | 'error' }) {
  return (
    <div
      role="alert"
      className={cn(
        'rounded-lg px-4 py-3 text-sm ring-1 ring-inset',
        tone === 'error'
          ? 'bg-rose-50 text-rose-800 ring-rose-200'
          : 'bg-amber-50 text-amber-900 ring-amber-200',
      )}
    >
      {children}
    </div>
  );
}
