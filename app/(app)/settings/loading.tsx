export default function SettingsLoading() {
  return (
    <div className="space-y-5 animate-pulse">
      <div className="h-6 w-24 rounded bg-ink-200" />

      {/* Branches card skeleton */}
      <div className="rounded-2xl border border-ink-200 bg-white p-5 shadow-sm space-y-4">
        <div className="h-4 w-20 rounded bg-ink-200" />
        <div className="space-y-2">
          {[1, 2].map((i) => (
            <div key={i} className="flex items-center justify-between py-2 border-b border-ink-100">
              <div className="h-4 w-36 rounded bg-ink-200" />
              <div className="h-7 w-16 rounded bg-ink-200" />
            </div>
          ))}
        </div>
        <div className="h-10 w-full rounded-xl bg-ink-200" />
      </div>

      {/* Doctors card skeleton */}
      <div className="rounded-2xl border border-ink-200 bg-white p-5 shadow-sm space-y-4">
        <div className="h-4 w-20 rounded bg-ink-200" />
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <div key={i} className="flex items-center justify-between py-2 border-b border-ink-100">
              <div className="flex items-center gap-3">
                <div className="h-4 w-32 rounded bg-ink-200" />
                <div className="h-3 w-20 rounded bg-ink-200" />
              </div>
              <div className="h-7 w-20 rounded bg-ink-200" />
            </div>
          ))}
        </div>
        <div className="h-10 w-full rounded-xl bg-ink-200" />
        <div className="h-10 w-full rounded-xl bg-ink-200" />
        <div className="h-10 w-28 rounded-xl bg-ink-200" />
      </div>
    </div>
  );
}
