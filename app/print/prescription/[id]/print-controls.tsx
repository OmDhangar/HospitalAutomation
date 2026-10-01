'use client';

import { useEffect } from 'react';

/**
 * Opens the browser's print dialog once the prescription has rendered, and
 * offers the buttons again for a second copy. Hidden on paper.
 */
export function PrintControls({ autoPrint }: { autoPrint: boolean }) {
  useEffect(() => {
    if (!autoPrint) return;
    // One frame's grace so fonts and layout settle before the dialog opens.
    const timer = setTimeout(() => window.print(), 300);
    return () => clearTimeout(timer);
  }, [autoPrint]);

  return (
    <div className="mb-6 flex justify-end gap-2 print:hidden">
      <button
        type="button"
        onClick={() => window.close()}
        className="rounded-lg px-4 py-2 text-sm font-medium text-ink-700 ring-1 ring-ink-300 hover:bg-ink-100"
      >
        Close
      </button>
      <button
        type="button"
        onClick={() => window.print()}
        className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700"
      >
        Print
      </button>
    </div>
  );
}
