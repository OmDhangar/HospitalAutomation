export default function LoginLoading() {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-ink-100 px-4 py-12">
      <div className="w-full max-w-sm animate-pulse">
        <div className="mb-8 flex flex-col items-center gap-3">
          <div className="size-12 rounded-xl bg-ink-200" />
          <div className="h-5 w-24 rounded bg-ink-200" />
          <div className="h-3 w-48 rounded bg-ink-200" />
        </div>

        <div className="space-y-4 rounded-2xl border border-ink-200 bg-white p-6 shadow-sm">
          <div className="space-y-2">
            <div className="h-3 w-12 rounded bg-ink-200" />
            <div className="h-10 w-full rounded-xl bg-ink-200" />
          </div>
          <div className="space-y-2">
            <div className="h-3 w-16 rounded bg-ink-200" />
            <div className="h-10 w-full rounded-xl bg-ink-200" />
          </div>
          <div className="h-10 w-full rounded-xl bg-ink-200" />
        </div>
      </div>
    </main>
  );
}
