'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { VitalsReadingRow, IntakeOutputRow } from '@/lib/db/schema';
import { RecordVitalsModal } from './record-vitals-modal';
import { RecordFluidBalanceModal } from './record-fluid-balance-modal';

export interface VitalsAndIoTabProps {
  admissionId: string;
  vitals: VitalsReadingRow[];
  fluids: IntakeOutputRow[];
  canRecord?: boolean;
}

export function VitalsAndIoTab({
  admissionId,
  vitals,
  fluids,
  canRecord = true,
}: VitalsAndIoTabProps) {
  const router = useRouter();
  const [isVitalsModalOpen, setIsVitalsModalOpen] = useState(false);
  const [isFluidModalOpen, setIsFluidModalOpen] = useState(false);

  // Calculate 24-hour fluid balance (past 24h)
  const past24hTime = Date.now() - 24 * 60 * 60 * 1000;
  const recentFluids = fluids.filter(
    (f) => new Date(f.recordedAt).getTime() >= past24hTime,
  );

  let oralMl = 0;
  let ivMl = 0;
  let urineMl = 0;
  let drainMl = 0;

  for (const item of recentFluids) {
    if (item.kind === 'ORAL') oralMl += item.ml;
    else if (item.kind === 'IV') ivMl += item.ml;
    else if (item.kind === 'URINE') urineMl += item.ml;
    else if (item.kind === 'DRAIN' || item.kind === 'RT_ASPIRATE') drainMl += item.ml;
  }

  const totalIn = oralMl + ivMl;
  const totalOut = urineMl + drainMl;
  const netBalance = totalIn - totalOut;

  const handleRefresh = () => {
    router.refresh();
  };

  return (
    <div className="space-y-4">
      {/* Action Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 border-b border-ink-200 pb-3">
        <div>
          <h2 className="text-sm font-bold text-ink-950">Vitals &amp; Fluid Balance (TPR &amp; I/O)</h2>
          <p className="text-xs text-ink-500">
            Temperature, Pulse, BP, Respiration, SpO2 flowsheet and 24-hour fluid intake vs output
          </p>
        </div>

        {canRecord && (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setIsFluidModalOpen(true)}
              className="inline-flex items-center rounded-lg border border-ink-300 bg-white px-3 py-1.5 text-xs font-semibold text-ink-800 shadow-2xs hover:bg-ink-50 cursor-pointer"
            >
              + Record Fluid Balance
            </button>
            <button
              type="button"
              onClick={() => setIsVitalsModalOpen(true)}
              className="inline-flex items-center rounded-lg bg-brand-700 px-3.5 py-1.5 text-xs font-bold text-white shadow-2xs hover:bg-brand-800 cursor-pointer"
            >
              + Record Vitals
            </button>
          </div>
        )}
      </div>

      {/* SECTION 1: TPR & NEWS2 FLOWSHEET */}
      <div className="rounded-xl border border-ink-200/80 bg-white shadow-2xs overflow-hidden">
        <div className="flex items-center justify-between border-b border-ink-200 bg-ink-50/60 px-4 py-2.5">
          <div className="flex items-center gap-2">
            <span className="size-2 rounded-full bg-brand-600" />
            <h3 className="text-xs font-bold uppercase tracking-wider text-ink-800">
              Temperature, Pulse &amp; Respiration (TPR Flowsheet)
            </h3>
          </div>
          <span className="text-[11px] font-mono text-ink-500">
            {vitals.length} {vitals.length === 1 ? 'Reading' : 'Readings'} Recorded
          </span>
        </div>

        {vitals.length === 0 ? (
          <div className="p-8 text-center text-xs text-ink-500">
            <p className="font-semibold text-ink-700">No vitals readings recorded yet for this stay.</p>
            <p className="mt-1">Click &ldquo;+ Record Vitals&rdquo; above to record temperature, pulse, and blood pressure.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-xs">
              <thead>
                <tr className="border-b border-ink-200 bg-ink-50/40 text-[10px] font-bold uppercase tracking-wider text-ink-600">
                  <th className="px-3 py-2">Recorded At</th>
                  <th className="px-3 py-2">Slot</th>
                  <th className="px-3 py-2 text-right">Temp (°F)</th>
                  <th className="px-3 py-2 text-right">Pulse (bpm)</th>
                  <th className="px-3 py-2 text-center">BP (mmHg)</th>
                  <th className="px-3 py-2 text-right">Resp (/min)</th>
                  <th className="px-3 py-2 text-right">SpO2 (%)</th>
                  <th className="px-3 py-2 text-center">Pain</th>
                  <th className="px-3 py-2 text-center">AVPU</th>
                  <th className="px-3 py-2 text-center">NEWS2</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100 font-mono text-[11px]">
                {vitals.map((v) => {
                  const d = new Date(v.recordedAt);
                  const timeStr = d.toLocaleDateString('en-IN', {
                    day: 'numeric',
                    month: 'short',
                    hour: '2-digit',
                    minute: '2-digit',
                  });

                  const tempNum = v.temperatureF ? parseFloat(v.temperatureF) : null;
                  const isFever = tempNum != null && tempNum >= 100.4;
                  const isHighPulse = v.pulseBpm != null && (v.pulseBpm > 100 || v.pulseBpm < 50);
                  const isLowO2 = v.spo2Percent != null && v.spo2Percent < 95;
                  const news = v.news2Score ?? 0;

                  return (
                    <tr key={v.id} className="hover:bg-brand-50/20 even:bg-ink-50/20">
                      <td className="px-3 py-2 text-ink-900 font-medium whitespace-nowrap">
                        {timeStr}
                      </td>
                      <td className="px-3 py-2 text-ink-500 whitespace-nowrap">
                        {v.scheduledSlot || 'Routine'}
                      </td>
                      <td
                        className={`px-3 py-2 text-right font-bold whitespace-nowrap ${
                          isFever ? 'text-rose-600' : 'text-ink-900'
                        }`}
                      >
                        {v.temperatureF ? `${v.temperatureF}°` : '—'}
                      </td>
                      <td
                        className={`px-3 py-2 text-right font-bold whitespace-nowrap ${
                          isHighPulse ? 'text-rose-600' : 'text-ink-900'
                        }`}
                      >
                        {v.pulseBpm != null ? v.pulseBpm : '—'}
                      </td>
                      <td className="px-3 py-2 text-center font-bold text-ink-900 whitespace-nowrap">
                        {v.bpSystolic != null && v.bpDiastolic != null
                          ? `${v.bpSystolic}/${v.bpDiastolic}`
                          : '—'}
                      </td>
                      <td className="px-3 py-2 text-right text-ink-800 whitespace-nowrap">
                        {v.respiratoryRate != null ? v.respiratoryRate : '—'}
                      </td>
                      <td
                        className={`px-3 py-2 text-right font-bold whitespace-nowrap ${
                          isLowO2 ? 'text-rose-600' : 'text-ink-900'
                        }`}
                      >
                        {v.spo2Percent != null ? `${v.spo2Percent}%` : '—'}
                      </td>
                      <td className="px-3 py-2 text-center text-ink-700 whitespace-nowrap">
                        {v.painScore != null ? v.painScore : '—'}
                      </td>
                      <td className="px-3 py-2 text-center text-ink-700 whitespace-nowrap">
                        {v.avpu || 'A'}
                      </td>
                      <td className="px-3 py-2 text-center whitespace-nowrap">
                        <span
                          className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${
                            news >= 5
                              ? 'bg-rose-100 text-rose-800'
                              : news >= 3
                                ? 'bg-amber-100 text-amber-800'
                                : 'bg-emerald-100 text-emerald-800'
                          }`}
                        >
                          {news}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* SECTION 2: 24-HOUR FLUID BALANCE (INTAKE VS OUTPUT) */}
      <div className="rounded-xl border border-ink-200/80 bg-white shadow-2xs overflow-hidden">
        <div className="flex items-center justify-between border-b border-ink-200 bg-ink-50/60 px-4 py-2.5">
          <div className="flex items-center gap-2">
            <span className="size-2 rounded-full bg-sky-600" />
            <h3 className="text-xs font-bold uppercase tracking-wider text-ink-800">
              24-Hour Fluid Balance (Intake vs Output)
            </h3>
          </div>
          <span
            className={`rounded-md px-2 py-0.5 font-mono text-xs font-bold ${
              netBalance >= 0
                ? 'bg-emerald-100 text-emerald-800'
                : 'bg-rose-100 text-rose-800'
            }`}
          >
            Net: {netBalance >= 0 ? `+${netBalance}` : netBalance} ml
          </span>
        </div>

        {/* 3 Summary metric cards */}
        <div className="grid grid-cols-1 sm:grid-cols-3 divide-y sm:divide-y-0 sm:divide-x divide-ink-200 border-b border-ink-200 bg-white p-3.5">
          {/* Total Intake */}
          <div className="px-3 py-1">
            <span className="text-[10px] font-bold uppercase tracking-wider text-emerald-800">
              Total Intake
            </span>
            <p className="mt-0.5 font-mono text-lg font-black text-ink-950">{`${totalIn} ml`}</p>
            <p className="text-[11px] text-ink-500 font-mono">
              Oral: {oralMl} ml · IV Infusions: {ivMl} ml
            </p>
          </div>

          {/* Total Output */}
          <div className="px-3 py-1">
            <span className="text-[10px] font-bold uppercase tracking-wider text-rose-800">
              Total Output
            </span>
            <p className="mt-0.5 font-mono text-lg font-black text-ink-950">{`${totalOut} ml`}</p>
            <p className="text-[11px] text-ink-500 font-mono">
              Urine: {urineMl} ml · Drains / Aspirate: {drainMl} ml
            </p>
          </div>

          {/* Net Fluid Balance */}
          <div className="px-3 py-1">
            <span className="text-[10px] font-bold uppercase tracking-wider text-ink-600">
              24-Hour Net Balance
            </span>
            <p
              className={`mt-0.5 font-mono text-lg font-black ${
                netBalance >= 0 ? 'text-emerald-700' : 'text-rose-700'
              }`}
            >
              {`${netBalance >= 0 ? '+' : ''}${netBalance} ml`}
            </p>
            <p className="text-[11px] text-ink-500">
              {netBalance > 500
                ? 'Positive balance (Watch fluid retention)'
                : netBalance < -500
                  ? 'Negative balance (Watch dehydration)'
                  : 'Normal physiological range'}
            </p>
          </div>
        </div>

        {/* Fluid entries log */}
        {fluids.length === 0 ? (
          <div className="p-6 text-center text-xs text-ink-500">
            No fluid intake or output recorded in the last 24 hours.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-xs">
              <thead>
                <tr className="border-b border-ink-200 bg-ink-50/40 text-[10px] font-bold uppercase tracking-wider text-ink-600">
                  <th className="px-3.5 py-2">Recorded At</th>
                  <th className="px-3.5 py-2">Direction</th>
                  <th className="px-3.5 py-2">Category</th>
                  <th className="px-3.5 py-2 text-right">Volume (ml)</th>
                  <th className="px-3.5 py-2">Notes</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100 font-mono text-[11px]">
                {fluids.map((item) => {
                  const d = new Date(item.recordedAt);
                  const isInput = item.kind === 'ORAL' || item.kind === 'IV';
                  return (
                    <tr key={item.id} className="hover:bg-brand-50/20 even:bg-ink-50/20">
                      <td className="px-3.5 py-2 text-ink-900 font-medium whitespace-nowrap">
                        {d.toLocaleDateString('en-IN', {
                          day: 'numeric',
                          month: 'short',
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </td>
                      <td className="px-3.5 py-2 whitespace-nowrap">
                        <span
                          className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${
                            isInput
                              ? 'bg-emerald-100 text-emerald-800'
                              : 'bg-rose-100 text-rose-800'
                          }`}
                        >
                          {isInput ? '+ Intake' : '- Output'}
                        </span>
                      </td>
                      <td className="px-3.5 py-2 text-ink-800 whitespace-nowrap">
                        {item.kind === 'ORAL'
                          ? 'Oral Fluids'
                          : item.kind === 'IV'
                            ? 'IV Infusion'
                            : item.kind === 'URINE'
                              ? 'Urine Output'
                              : item.kind === 'DRAIN'
                                ? 'Surgical Drain'
                                : 'RT Aspirate'}
                      </td>
                      <td
                        className={`px-3.5 py-2 text-right font-bold whitespace-nowrap ${
                          isInput ? 'text-emerald-700' : 'text-rose-700'
                        }`}
                      >
                        {item.ml} ml
                      </td>
                      <td className="px-3.5 py-2 text-ink-500 font-sans truncate max-w-xs">
                        {item.notes || '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Entry Modals */}
      <RecordVitalsModal
        admissionId={admissionId}
        isOpen={isVitalsModalOpen}
        onClose={() => setIsVitalsModalOpen(false)}
        onSuccess={handleRefresh}
      />

      <RecordFluidBalanceModal
        admissionId={admissionId}
        isOpen={isFluidModalOpen}
        onClose={() => setIsFluidModalOpen(false)}
        onSuccess={handleRefresh}
      />
    </div>
  );
}
