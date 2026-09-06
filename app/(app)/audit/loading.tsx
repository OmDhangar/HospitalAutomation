export default function AuditLoading() {
  return (
    <div className="space-y-5 animate-pulse">
      <div className="h-6 w-20 rounded bg-ink-200" />

      {/* Activity log skeleton */}
      <div className="rounded-2xl border border-ink-200 bg-white p-5 shadow-sm">
        <div className="h-4 w-28 rounded bg-ink-200 mb-4" />
        <div className="space-y-3">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="flex items-center gap-4 py-2 border-b border-ink-100">
              <div className="h-3 w-16 rounded bg-ink-200" />
              <div className="h-3 w-40 rounded bg-ink-200 flex-1" />
              <div className="h-3 w-12 rounded bg-ink-200" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
