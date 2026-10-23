import React from 'react';

export type ClaimsKpis = {
  activeCount: number;
  pendingPreauthCount: number;
  urgentQueriesCount: number;
  dischargeReadyCount: number;
};

export function ClaimsKpiStrip({ kpis }: { kpis: ClaimsKpis }) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
      <div className="bg-white rounded-xl border border-ink-100 p-4 shadow-xs">
        <div className="text-xs font-semibold uppercase tracking-wider text-ink-500">
          Active Insured Stays
        </div>
        <div className="mt-2 text-2xl font-bold text-ink-900">{kpis.activeCount}</div>
        <div className="mt-1 text-xs text-ink-500">Commercial & schemes</div>
      </div>

      <div className="bg-white rounded-xl border border-ink-100 p-4 shadow-xs">
        <div className="text-xs font-semibold uppercase tracking-wider text-amber-600">
          Pending Pre-Auth
        </div>
        <div className="mt-2 text-2xl font-bold text-ink-900">{kpis.pendingPreauthCount}</div>
        <div className="mt-1 text-xs text-amber-700">6h initial turnaround</div>
      </div>

      <div className="bg-white rounded-xl border border-ink-100 p-4 shadow-xs">
        <div className="text-xs font-semibold uppercase tracking-wider text-rose-600 flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-rose-500 animate-pulse" />
          Urgent Queries (&lt;60m)
        </div>
        <div className="mt-2 text-2xl font-bold text-rose-700">{kpis.urgentQueriesCount}</div>
        <div className="mt-1 text-xs text-rose-600">High rejection risk</div>
      </div>

      <div className="bg-white rounded-xl border border-ink-100 p-4 shadow-xs">
        <div className="text-xs font-semibold uppercase tracking-wider text-emerald-600">
          Discharge Ready
        </div>
        <div className="mt-2 text-2xl font-bold text-ink-900">{kpis.dischargeReadyCount}</div>
        <div className="mt-1 text-xs text-emerald-700">Awaiting final packet / settlement</div>
      </div>
    </div>
  );
}
