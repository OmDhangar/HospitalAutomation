export default function QueueLoading() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-ink-50 px-4 py-8">
      <div className="w-full max-w-sm animate-pulse space-y-5">
        {/* Token number skeleton */}
        <div className="flex flex-col items-center gap-3">
          <div className="size-20 rounded-2xl bg-ink-200" />
          <div className="h-4 w-32 rounded bg-ink-200" />
          <div className="h-3 w-48 rounded bg-ink-200" />
        </div>

        {/* Status card skeleton */}
        <div className="rounded-2xl border border-ink-200 bg-white p-5 shadow-sm space-y-3">
          <div className="h-4 w-24 rounded bg-ink-200" />
          <div className="h-6 w-full rounded bg-ink-200" />
          <div className="h-3 w-40 rounded bg-ink-200" />
        </div>
      </div>
    </div>
  );
}
