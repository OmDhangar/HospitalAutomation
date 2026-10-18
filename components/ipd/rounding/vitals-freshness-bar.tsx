'use client';

import Link from 'next/link';
import { cn } from '@/components/ui';
import type { RoundingCockpitData } from '@/lib/services/ipd-rounding-cockpit';

export interface VitalsFreshnessBarProps {
  admissionId: string;
  vitals: RoundingCockpitData['vitalsFreshness'];
  className?: string;
}

function formatAge(minutes: number | null): string {
  if (minutes === null) return 'No recorded vitals';
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes} min${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  const remainingMins = minutes % 60;
  if (remainingMins === 0) return `${hours} hr${hours === 1 ? '' : 's'} ago`;
  return `${hours}h ${remainingMins}m ago`;
}

interface VitalMetric {
  id: string;
  label: string;
  value: string;
  unit: string;
  isAbnormal: boolean;
  statusText?: string;
}

export function VitalsFreshnessBar({
  admissionId,
  vitals,
  className,
}: VitalsFreshnessBarProps) {
  const { reading, ageMinutes, isStale } = vitals;

  if (!reading) {
    return (
      <div
        className={cn(
          'flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50/70 p-3.5 text-sm text-amber-900',
          className,
        )}
      >
        <div className="flex items-center gap-2">
          <span className="flex size-6 items-center justify-center rounded-full bg-amber-100 text-amber-700 font-bold text-xs">
            !
          </span>
          <div>
            <p className="font-medium text-amber-950">No TPR vitals recorded yet</p>
            <p className="text-xs text-amber-700">Baseline bedside vitals have not been logged for this admission.</p>
          </div>
        </div>
        <Link
          href={`/ipd/admissions/${admissionId}/tpr`}
          className="inline-flex items-center gap-1.5 rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-xs font-semibold text-amber-900 shadow-xs transition hover:bg-amber-50"
        >
          <span>Record Vitals (TPR) &rarr;</span>
        </Link>
      </div>
    );
  }

  const pulse = reading.pulseBpm;
  const sys = reading.bpSystolic;
  const dia = reading.bpDiastolic;
  const spo2 = reading.spo2Percent;
  const temp = reading.temperatureF;
  const rr = reading.respiratoryRate;
  const bsl = reading.bloodSugarMgDl;

  const metrics: VitalMetric[] = [
    {
      id: 'pulse',
      label: 'Pulse',
      value: pulse !== null ? `${pulse}` : '—',
      unit: 'bpm',
      isAbnormal: pulse !== null && (pulse < 60 || pulse > 100),
      statusText: pulse !== null && pulse > 100 ? 'Tachycardia' : pulse !== null && pulse < 60 ? 'Bradycardia' : undefined,
    },
    {
      id: 'bp',
      label: 'BP',
      value: sys !== null && dia !== null ? `${sys}/${dia}` : sys !== null ? `${sys}/—` : '—',
      unit: 'mmHg',
      isAbnormal: (sys !== null && (sys > 140 || sys < 90)) || (dia !== null && dia > 90),
      statusText: sys !== null && sys > 140 ? 'High' : sys !== null && sys < 90 ? 'Low' : undefined,
    },
    {
      id: 'spo2',
      label: 'SpO2',
      value: spo2 !== null ? `${spo2}%` : '—',
      unit: '',
      isAbnormal: spo2 !== null && spo2 < 95,
      statusText: spo2 !== null && spo2 < 95 ? 'Hypoxic' : undefined,
    },
    {
      id: 'temp',
      label: 'Temp',
      value: temp !== null ? `${temp.toFixed(1)}°` : '—',
      unit: 'F',
      isAbnormal: temp !== null && (temp > 99.5 || temp < 96.0),
      statusText: temp !== null && temp > 99.5 ? 'Febrile' : undefined,
    },
    {
      id: 'rr',
      label: 'Resp',
      value: rr !== null ? `${rr}` : '—',
      unit: '/min',
      isAbnormal: rr !== null && (rr > 22 || rr < 12),
      statusText: rr !== null && rr > 22 ? 'Tachypnea' : undefined,
    },
    {
      id: 'bsl',
      label: 'Sugar',
      value: bsl !== null ? `${bsl}` : '—',
      unit: 'mg/dL',
      isAbnormal: bsl !== null && (bsl > 180 || bsl < 70),
      statusText: bsl !== null && bsl > 180 ? 'Hyperglycemia' : bsl !== null && bsl < 70 ? 'Hypoglycemia' : undefined,
    },
  ];

  return (
    <div
      className={cn(
        'rounded-xl border border-ink-200 bg-white p-3.5 shadow-xs transition',
        isStale && 'border-amber-300 bg-amber-50/30',
        className,
      )}
    >
      <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2 border-b border-ink-100 pb-2">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold uppercase tracking-wider text-ink-500">
            Latest Bedside Vitals
          </span>
          <span
            className={cn(
              'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium',
              isStale
                ? 'bg-amber-100 text-amber-900 ring-1 ring-inset ring-amber-300'
                : 'bg-emerald-50 text-emerald-800 ring-1 ring-inset ring-emerald-200',
            )}
          >
            <span
              className={cn(
                'size-1.5 rounded-full',
                isStale ? 'bg-amber-500 animate-pulse' : 'bg-emerald-500',
              )}
            />
            {formatAge(ageMinutes)}
          </span>
          {isStale && (
            <span className="hidden text-xs text-amber-700 sm:inline">
              (Over 6 hours old — reassessment advised)
            </span>
          )}
        </div>

        <Link
          href={`/ipd/admissions/${admissionId}/tpr`}
          className="inline-flex items-center gap-1 text-xs font-medium text-brand-700 hover:text-brand-800 hover:underline"
        >
          <span>View TPR Trend Chart &rarr;</span>
        </Link>
      </div>

      <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
        {metrics.map((m) => (
          <div
            key={m.id}
            className={cn(
              'flex flex-col justify-between rounded-lg border p-2 transition',
              m.isAbnormal
                ? 'border-rose-200 bg-rose-50/60 text-rose-950'
                : 'border-ink-100 bg-ink-50/40 text-ink-900',
            )}
          >
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-medium text-ink-500">{m.label}</span>
              {m.isAbnormal && (
                <span className="size-1.5 rounded-full bg-rose-500" title="Abnormal reading" />
              )}
            </div>
            <div className="mt-1 flex items-baseline gap-1">
              <span
                className={cn(
                  'font-mono text-base font-semibold leading-none',
                  m.isAbnormal ? 'text-rose-700' : 'text-ink-900',
                )}
              >
                {m.value}
              </span>
              {m.unit && <span className="text-[10px] text-ink-400">{m.unit}</span>}
            </div>
            {m.statusText ? (
              <span className="mt-1 truncate text-[10px] font-medium text-rose-600">
                {m.statusText}
              </span>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}
