/** The IPD screens' skeleton: tabs, then a grid of bed tiles. */
export default function IpdLoading() {
  return (
    <div className="animate-pulse space-y-4" aria-busy="true" aria-label="Loading">
      <div className="grid grid-cols-3 gap-1 rounded-xl bg-ink-200/60 p-1 sm:w-96">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-11 rounded-lg bg-white/70" />
        ))}
      </div>
      {[1, 2].map((ward) => (
        <div key={ward} className="space-y-3 rounded-xl border border-ink-200 bg-white p-4">
          <div className="h-4 w-28 rounded bg-ink-200" />
          <div className="grid grid-cols-[repeat(auto-fill,minmax(4.5rem,1fr))] gap-2">
            {Array.from({ length: 8 }, (_, i) => (
              <div key={i} className="aspect-square rounded-xl bg-ink-100" />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
