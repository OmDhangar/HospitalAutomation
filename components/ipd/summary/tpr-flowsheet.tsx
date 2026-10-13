import React from 'react';
import Link from 'next/link';

export interface TprReading {
  time: string;
  tempF?: string | number | null;
  pulse?: number | null;
  bp?: string | null;
  resp?: number | null;
  spo2?: number | null;
  news2?: number | null;
  pain?: number | null;
}

export interface TprFlowsheetProps {
  readings: TprReading[];
  admissionId?: string;
  className?: string;
}

function getTempColor(temp?: string | number | null): string {
  if (temp == null) return 'text-ink-700';
  const val = typeof temp === 'string' ? parseFloat(temp) : temp;
  if (val >= 100.4) return 'text-amber-800 font-bold bg-amber-50 px-1 rounded';
  if (val >= 102.0) return 'text-rose-800 font-bold bg-rose-50 px-1 rounded';
  return 'text-ink-800';
}

function getPulseColor(pulse?: number | null): string {
  if (pulse == null) return 'text-ink-700';
  if (pulse > 100 || pulse < 55) return 'text-amber-800 font-bold bg-amber-50 px-1 rounded';
  return 'text-ink-800';
}

function getSpo2Color(spo2?: number | null): string {
  if (spo2 == null) return 'text-ink-700';
  if (spo2 < 94) return 'text-rose-800 font-bold bg-rose-50 px-1 rounded';
  return 'text-ink-800';
}

function getNews2Badge(news2?: number | null): React.ReactNode {
  if (news2 == null) return <span className="text-ink-400">—</span>;
  if (news2 >= 5) {
    return (
      <span className="inline-flex items-center px-1.5 py-0.2 rounded font-bold text-[10px] bg-rose-100 text-rose-900 ring-1 ring-inset ring-rose-300">
        {news2} ⚠ High
      </span>
    );
  }
  if (news2 >= 3) {
    return (
      <span className="inline-flex items-center px-1.5 py-0.2 rounded font-bold text-[10px] bg-amber-100 text-amber-900 ring-1 ring-inset ring-amber-300">
        {news2} Med
      </span>
    );
  }
  return (
    <span className="inline-flex items-center px-1.5 py-0.2 rounded font-semibold text-[10px] bg-emerald-50 text-emerald-800 ring-1 ring-inset ring-emerald-200">
      {news2} Low
    </span>
  );
}

export function TprFlowsheet({
  readings,
  admissionId,
  className = '',
}: TprFlowsheetProps) {
  if (readings.length === 0) {
    return (
      <div className={`p-4 bg-surface rounded-lg border border-ink-200 text-center ${className}`}>
        <p className="text-xs text-ink-500 italic">
          No vital readings recorded yet for this stay.
        </p>
      </div>
    );
  }

  return (
    <div className={`bg-surface rounded-lg border border-ink-200 shadow-2xs overflow-hidden ${className}`}>
      {/* Header */}
      <div className="px-3 py-2 bg-ink-50/70 border-b border-ink-200 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-xs font-bold text-ink-900 tracking-tight">
            TPR &amp; Vitals Flowsheet (Temperature, Pulse, BP)
          </span>
          <span className="inline-flex items-center px-1.5 py-0.2 rounded-full text-[10px] font-semibold bg-sky-50 text-sky-800 ring-1 ring-inset ring-sky-200">
            Recent {readings.length} checks
          </span>
        </div>
        {admissionId && (
          <Link
            href={`/ipd/patients/${admissionId}/vitals`}
            className="text-[11px] font-semibold text-primary hover:underline"
          >
            Full Flowsheet &rarr;
          </Link>
        )}
      </div>

      {/* Spreadsheet Grid */}
      <div className="overflow-x-auto">
        <table className="w-full text-left border-collapse text-xs font-mono tabular-nums">
          <thead>
            <tr className="border-b border-ink-200 bg-ink-50/40 text-[11px] font-sans font-semibold text-ink-600">
              <th className="py-1.5 px-3">Date / Time</th>
              <th className="py-1.5 px-2.5">Temp (°F)</th>
              <th className="py-1.5 px-2.5">Pulse (bpm)</th>
              <th className="py-1.5 px-2.5">BP (mmHg)</th>
              <th className="py-1.5 px-2.5">Resp (/min)</th>
              <th className="py-1.5 px-2.5">SpO2 (%)</th>
              <th className="py-1.5 px-3">NEWS2</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {readings.map((r, idx) => (
              <tr key={idx} className="hover:bg-slate-50/70 transition-colors">
                <td className="py-1.5 px-3 font-sans font-medium text-ink-700 text-xs">
                  {r.time}
                </td>
                <td className="py-1.5 px-2.5">
                  <span className={getTempColor(r.tempF)}>
                    {r.tempF != null ? `${r.tempF}°` : '—'}
                  </span>
                </td>
                <td className="py-1.5 px-2.5">
                  <span className={getPulseColor(r.pulse)}>
                    {r.pulse != null ? r.pulse : '—'}
                  </span>
                </td>
                <td className="py-1.5 px-2.5 font-semibold text-ink-800">
                  {r.bp ?? '—'}
                </td>
                <td className="py-1.5 px-2.5 text-ink-700">
                  {r.resp != null ? r.resp : '—'}
                </td>
                <td className="py-1.5 px-2.5">
                  <span className={getSpo2Color(r.spo2)}>
                    {r.spo2 != null ? `${r.spo2}%` : '—'}
                  </span>
                </td>
                <td className="py-1.5 px-3 font-sans">
                  {getNews2Badge(r.news2)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
