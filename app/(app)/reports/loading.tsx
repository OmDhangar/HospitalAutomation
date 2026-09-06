export default function ReportsLoading() {
  return (
    <div className="space-y-5 animate-pulse">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="h-6 w-24 rounded bg-ink-200" />
          <div className="mt-1 h-3 w-48 rounded bg-ink-200" />
        </div>
        <div className="h-9 w-28 rounded-lg bg-ink-200" />
      </div>

      {/* Stats row skeleton */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="rounded-2xl border border-ink-200 bg-white p-5 shadow-sm">
            <div className="h-3 w-20 rounded bg-ink-200 mb-2" />
            <div className="h-7 w-16 rounded bg-ink-200" />
          </div>
        ))}
      </div>

      {/* Table skeleton */}
      <div className="rounded-2xl border border-ink-200 bg-white p-5 shadow-sm">
        <div className="h-4 w-28 rounded bg-ink-200 mb-4" />
        <div className="space-y-3">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="flex items-center justify-between py-2 border-b border-ink-100">
              <div className="flex items-center gap-3">
                <div className="h-4 w-28 rounded bg-ink-200" />
                <div className="h-4 w-16 rounded bg-ink-200" />
              </div>
              <div className="h-4 w-12 rounded bg-ink-200" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
