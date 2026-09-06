export default function DisplayLoading() {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-ink-950 px-6 py-8">
      <div className="w-full max-w-5xl animate-pulse space-y-8">
        {/* Header skeleton */}
        <div className="flex items-center justify-between">
          <div className="h-8 w-48 rounded bg-ink-800" />
          <div className="h-6 w-24 rounded bg-ink-800" />
        </div>

        {/* Now serving cards skeleton */}
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="rounded-2xl border border-ink-800 bg-ink-900 p-8 space-y-4">
              <div className="h-4 w-24 rounded bg-ink-800" />
              <div className="h-16 w-24 mx-auto rounded bg-ink-800" />
              <div className="h-3 w-32 mx-auto rounded bg-ink-800" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
