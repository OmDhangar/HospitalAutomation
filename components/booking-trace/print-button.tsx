'use client';

/** Prints the trace, so a hospital can be handed the evidence instead of database output. */
export function PrintButton() {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className="inline-flex h-10 items-center rounded-lg bg-white px-3.5 text-sm font-semibold text-ink-800 ring-1 ring-inset ring-ink-300 hover:bg-ink-50 print:hidden cursor-pointer"
    >
      Print / save as PDF
    </button>
  );
}
