export default function SubscriptionLoading() {
  return (
    <div className="space-y-5 animate-pulse">
      <div className="h-6 w-36 rounded bg-ink-200" />

      {/* Current plan card */}
      <div className="rounded-2xl border border-ink-200 bg-white p-6 shadow-sm space-y-4">
        <div className="flex items-center justify-between">
          <div className="h-5 w-28 rounded bg-ink-200" />
          <div className="h-6 w-16 rounded-full bg-ink-200" />
        </div>
        <div className="h-3 w-full rounded bg-ink-200" />
        <div className="grid grid-cols-2 gap-4">
          <div className="h-16 rounded-xl bg-ink-200" />
          <div className="h-16 rounded-xl bg-ink-200" />
        </div>
      </div>

      {/* Usage card */}
      <div className="rounded-2xl border border-ink-200 bg-white p-6 shadow-sm space-y-3">
        <div className="h-4 w-20 rounded bg-ink-200" />
        <div className="h-4 w-full rounded-full bg-ink-200" />
        <div className="h-3 w-32 rounded bg-ink-200" />
      </div>

      {/* Plans grid */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {[1, 2, 3].map((i) => (
          <div key={i} className="rounded-2xl border border-ink-200 bg-white p-5 shadow-sm space-y-3">
            <div className="h-5 w-20 rounded bg-ink-200" />
            <div className="h-8 w-24 rounded bg-ink-200" />
            <div className="space-y-2">
              <div className="h-3 w-full rounded bg-ink-200" />
              <div className="h-3 w-3/4 rounded bg-ink-200" />
              <div className="h-3 w-5/6 rounded bg-ink-200" />
            </div>
            <div className="h-10 w-full rounded-xl bg-ink-200" />
          </div>
        ))}
      </div>
    </div>
  );
}
