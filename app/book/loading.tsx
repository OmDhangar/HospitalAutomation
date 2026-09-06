export default function BookingLoading() {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-ink-50 px-4 py-12">
      <div className="w-full max-w-lg animate-pulse space-y-6">
        {/* Doctor info skeleton */}
        <div className="rounded-2xl border border-ink-200 bg-white p-6 shadow-sm">
          <div className="flex items-center gap-4">
            <div className="size-14 rounded-xl bg-ink-200" />
            <div className="space-y-2">
              <div className="h-5 w-40 rounded bg-ink-200" />
              <div className="h-3 w-28 rounded bg-ink-200" />
            </div>
          </div>
        </div>

        {/* Slot grid skeleton */}
        <div className="rounded-2xl border border-ink-200 bg-white p-6 shadow-sm space-y-4">
          <div className="h-4 w-32 rounded bg-ink-200" />
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="h-10 rounded-lg bg-ink-200" />
            ))}
          </div>
        </div>

        {/* Form fields skeleton */}
        <div className="rounded-2xl border border-ink-200 bg-white p-6 shadow-sm space-y-4">
          <div className="h-4 w-24 rounded bg-ink-200" />
          <div className="h-10 w-full rounded-xl bg-ink-200" />
          <div className="h-10 w-full rounded-xl bg-ink-200" />
          <div className="h-11 w-full rounded-xl bg-ink-200" />
        </div>
      </div>
    </div>
  );
}
