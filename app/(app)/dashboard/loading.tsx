import { Card, CardHeader } from '@/components/ui';

export default function DashboardLoading() {
  return (
    <div className="animate-pulse space-y-5">
      {/* Doctor selector tabs skeleton */}
      <div className="mb-5 flex items-center gap-2 overflow-x-auto pb-1 scrollbar-none">
        <div className="h-10 w-36 rounded-lg bg-brand-200/70" />
        <div className="h-10 w-32 rounded-lg bg-ink-200/80" />
        <div className="h-10 w-40 rounded-lg bg-ink-200/80" />
      </div>

      <div className="grid items-start gap-5 lg:grid-cols-3">
        {/* Left Column: Now Serving & Waiting List */}
        <div className="space-y-5 lg:col-span-2">
          {/* Now Serving Skeleton */}
          <Card>
            <CardHeader
              title="Now serving"
              hint="Loading doctor queue..."
            />
            <div className="p-6">
              <div className="flex flex-wrap items-center gap-6">
                <div className="flex size-28 shrink-0 items-center justify-center rounded-2xl bg-brand-100/70">
                  <div className="h-12 w-12 rounded-lg bg-brand-300/60 animate-pulse" />
                </div>
                <div className="min-w-0 flex-1 space-y-3">
                  <div className="h-7 w-48 rounded-md bg-ink-200" />
                  <div className="flex items-center gap-2">
                    <div className="h-5 w-20 rounded-full bg-ink-200" />
                    <div className="h-4 w-32 rounded bg-ink-100" />
                  </div>
                </div>
              </div>
            </div>
            <div className="flex items-center gap-3 border-t border-ink-200 bg-ink-50 px-6 py-4">
              <div className="h-9 w-28 rounded-lg bg-ink-200" />
              <div className="h-9 w-20 rounded-lg bg-ink-200" />
              <div className="h-9 w-20 rounded-lg bg-ink-200" />
            </div>
          </Card>

          {/* Waiting in Queue Skeleton */}
          <Card>
            <CardHeader title="Waiting" hint="Loading patients in line..." />
            <ul className="divide-y divide-ink-200">
              {[1, 2, 3, 4, 5].map((i) => (
                <li key={i} className="flex items-center justify-between p-4">
                  <div className="flex items-center gap-4">
                    <div className="flex size-9 items-center justify-center rounded-lg bg-ink-100">
                      <div className="h-4 w-4 rounded bg-ink-300/60" />
                    </div>
                    <div className="space-y-1.5">
                      <div className="h-4.5 w-40 rounded bg-ink-200" />
                      <div className="h-3.5 w-24 rounded bg-ink-100" />
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="h-6 w-16 rounded-full bg-ink-100" />
                    <div className="h-8 w-16 rounded-lg bg-ink-100" />
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        </div>

        {/* Right Column: Add Walk-in & Stats */}
        <div className="space-y-5">
          <Card>
            <CardHeader title="Add walk-in" hint="Issues a token and sends the queue link" />
            <div className="space-y-4 p-6">
              <div className="space-y-1.5">
                <div className="h-3.5 w-24 rounded bg-ink-200" />
                <div className="h-10 w-full rounded-lg bg-ink-100" />
              </div>
              <div className="space-y-1.5">
                <div className="h-3.5 w-28 rounded bg-ink-200" />
                <div className="h-10 w-full rounded-lg bg-ink-100" />
              </div>
              <div className="h-10 w-full rounded-lg bg-brand-200/60" />
            </div>
          </Card>

          <Card>
            <CardHeader title="Today" hint="Loading stats..." />
            <div className="grid grid-cols-2 divide-x divide-y divide-ink-200 p-2">
              {[1, 2, 3, 4].map((i) => (
                <div key={i} className="p-4 space-y-2">
                  <div className="h-3 w-16 rounded bg-ink-200" />
                  <div className="h-6 w-10 rounded bg-ink-200" />
                </div>
              ))}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
