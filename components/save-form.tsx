'use client';

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useFormStatus } from 'react-dom';
import { Button, cn } from '@/components/ui';
import { CheckIcon } from '@/components/icons';

/**
 * A settings form that shows, where the user is looking, that it saved.
 *
 * The forms it wraps are plain server-action posts that redirect back with a
 * notice at the top of the page. On a long page that notice is off-screen, the
 * input still holds the value just typed, and nothing visibly changes — so the
 * owner cannot tell whether Save did anything. This adds the missing feedback
 * at the button itself: "Saving…" while it posts, then a green "Saved" with a
 * brief highlight, scrolled into view; and "Unsaved changes" as soon as
 * anything is edited again. The server action and its redirect are unchanged.
 */

type SaveFormState = { changed: number; justSaved: boolean };

const SaveFormContext = createContext<SaveFormState>({ changed: 0, justSaved: false });

/** How many fields differ from what the page loaded with. */
function countChanged(form: HTMLFormElement): number {
  let changed = 0;
  for (const element of Array.from(form.elements)) {
    if (element instanceof HTMLInputElement) {
      if (element.type === 'hidden' || element.type === 'submit') continue;
      if (element.type === 'checkbox' || element.type === 'radio') {
        if (element.checked !== element.defaultChecked) changed += 1;
      } else if (element.value !== element.defaultValue) {
        changed += 1;
      }
    } else if (element instanceof HTMLSelectElement) {
      if (Array.from(element.options).some((option) => option.selected !== option.defaultSelected)) changed += 1;
    } else if (element instanceof HTMLTextAreaElement) {
      if (element.value !== element.defaultValue) changed += 1;
    }
  }
  return changed;
}

export function SaveForm({
  action,
  justSaved = false,
  className,
  children,
}: {
  action: (formData: FormData) => void | Promise<void>;
  /** True when the page was reloaded by this form's own save. */
  justSaved?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLFormElement>(null);
  const [changed, setChanged] = useState(0);
  const [highlight, setHighlight] = useState(justSaved);

  useEffect(() => {
    if (!justSaved) return;
    ref.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    const timer = window.setTimeout(() => setHighlight(false), 2500);
    return () => window.clearTimeout(timer);
  }, [justSaved]);

  const recount = () => {
    if (ref.current) setChanged(countChanged(ref.current));
  };

  return (
    <SaveFormContext.Provider value={{ changed, justSaved: justSaved && changed === 0 }}>
      <form
        ref={ref}
        action={action}
        onInput={recount}
        onChange={recount}
        className={cn(
          'rounded-lg transition-shadow duration-700',
          highlight && 'ring-2 ring-emerald-400 ring-offset-2',
          className,
        )}
      >
        {children}
      </form>
    </SaveFormContext.Provider>
  );
}

/**
 * The submit button for a `SaveForm`. `countNoun` turns a bulk form's button
 * into "Save 3 prices" as boxes are filled. (A string, not a function, so
 * server-rendered pages can pass it.)
 */
export function SaveButton({
  label,
  countNoun,
  size = 'sm',
  variant = 'secondary',
  className,
}: {
  label: string;
  countNoun?: string;
  size?: 'sm' | 'md' | 'lg';
  variant?: 'primary' | 'secondary';
  className?: string;
}) {
  const { pending } = useFormStatus();
  const { changed, justSaved } = useContext(SaveFormContext);

  if (justSaved && !pending) {
    return (
      <span className={cn('inline-flex items-center gap-2', className)}>
        <span
          role="status"
          className="inline-flex min-h-9 items-center gap-1.5 rounded-lg bg-emerald-50 px-3 py-1.5 text-sm font-semibold text-emerald-800 ring-1 ring-inset ring-emerald-300"
        >
          <CheckIcon className="size-4" />
          Saved
        </span>
      </span>
    );
  }

  return (
    <span className={cn('inline-flex items-center gap-2', className)}>
      <Button type="submit" size={size} variant={changed > 0 ? 'primary' : variant} isLoading={pending}>
        {pending
          ? 'Saving…'
          : changed > 0 && countNoun
            ? `Save ${changed} ${countNoun}${changed === 1 ? '' : 's'}`
            : label}
      </Button>
      {changed > 0 && !pending ? (
        <span className="text-xs font-medium text-amber-700">Unsaved changes</span>
      ) : null}
    </span>
  );
}

/** What a bulk save just did, shown next to its button rather than only at the top of the page. */
export function SavedSummary({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <p role="status" className="flex items-start gap-1.5 text-sm font-medium text-emerald-800">
      <CheckIcon className="mt-0.5 size-4 shrink-0" />
      <span>{text}</span>
    </p>
  );
}
