export default function AppLoading() {
  return (
    <div className="space-y-5 animate-pulse">
      {/* Tab bar skeleton */}
      <div className="flex gap-2">
        <div className="h-10 w-32 rounded-lg bg-ink-200" />
        <div className="h-10 w-28 rounded-lg bg-ink-200" />
        <div className="h-10 w-28 rounded-lg bg-ink-200" />
      </div>

      <div className="grid items-start gap-5 lg:grid-cols-3">
        {/* Left column */}
        <div className="space-y-5 lg:col-span-2">
          {/* Main serving card skeleton */}
          <div className="overflow-hidden rounded-2xl border border-ink-200 bg-white p-6 shadow-sm">
            <div className="flex items-center justify-between border-b border-ink-100 pb-4">
              <div className="h-4 w-24 rounded bg-ink-200" />
              <div className="h-8 w-28 rounded-lg bg-ink-200" />
            </div>
            <div className="flex items-center gap-6 py-6">
              <div className="size-28 rounded-2xl bg-ink-200" />
              <div className="space-y-3">
                <div className="h-6 w-48 rounded bg-ink-200" />
                <div className="h-4 w-32 rounded bg-ink-200" />
              </div>
            </div>
            <div className="border-t border-ink-100 pt-4">
              <div className="h-12 w-44 rounded-xl bg-ink-200" />
            </div>
          </div>

          {/* Waiting list skeleton */}
          <div className="overflow-hidden rounded-2xl border border-ink-200 bg-white p-5 shadow-sm">
            <div className="h-4 w-28 rounded bg-ink-200 mb-4" />
            <div className="space-y-3">
              {[1, 2, 3].map((i) => (
                <div key={i} className="flex items-center justify-between py-2 border-b border-ink-100">
                  <div className="flex items-center gap-3">
                    <div className="size-8 rounded bg-ink-200" />
                    <div className="h-4 w-36 rounded bg-ink-200" />
                  </div>
                  <div className="h-7 w-20 rounded bg-ink-200" />
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Right column */}
        <div className="space-y-5">
          {/* Action form card skeleton */}
          <div className="rounded-2xl border border-ink-200 bg-white p-5 shadow-sm space-y-4">
            <div className="h-4 w-32 rounded bg-ink-200" />
            <div className="h-10 w-full rounded-xl bg-ink-200" />
            <div className="h-10 w-full rounded-xl bg-ink-200" />
            <div className="h-10 w-full rounded-xl bg-ink-200" />
          </div>

          {/* Stats card skeleton */}
          <div className="rounded-2xl border border-ink-200 bg-white p-5 shadow-sm">
            <div className="h-4 w-20 rounded bg-ink-200 mb-3" />
            <div className="grid grid-cols-2 gap-4">
              <div className="h-16 rounded-xl bg-ink-200" />
              <div className="h-16 rounded-xl bg-ink-200" />
              <div className="h-16 rounded-xl bg-ink-200" />
              <div className="h-16 rounded-xl bg-ink-200" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
