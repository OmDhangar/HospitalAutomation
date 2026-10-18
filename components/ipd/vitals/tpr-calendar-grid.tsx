'use client';

import React, { useMemo, useState } from 'react';
import type { VitalsReadingRow, IntakeOutputRow } from '@/lib/db/schema';
import type { Letterhead } from '@/lib/domain/letterhead';
import { RecordVitalsModal } from './record-vitals-modal';

export interface TreatmentLogItem {
  id: string;
  actualTime: Date | string;
  medicineName: string;
  doseGiven?: string | null;
  routeGiven?: string | null;
}

export interface PatientDemographics {
  name: string;
  age?: number | string | null;
  gender?: string | null;
  ipdNumber?: string | number | null;
  wardName?: string | null;
  bedLabel?: string | null;
  admittedAt?: Date | string | null;
  doctorName?: string | null;
}

export interface TprCalendarGridProps {
  admissionId: string;
  patient?: PatientDemographics;
  hospitalName?: string;
  letterhead?: Letterhead;
  vitals: VitalsReadingRow[];
  fluids: IntakeOutputRow[];
  treatments?: TreatmentLogItem[];
  canRecord?: boolean;
  canPrint?: boolean;
  userRole?: string;
}

interface HourlySlotData {
  slotHour: number; // 0 to 23
  slotDateStr: string; // YYYY-MM-DD
  timeLabel: string; // e.g. "8 am"
  slotTimeStr: string; // "08:00"
  startTimeMs: number;
  endTimeMs: number;
  vitals: VitalsReadingRow[];
  primaryVital?: VitalsReadingRow;
  output: {
    drainMl: number;
    urineMl: number;
    rtAspiMl: number;
  };
  intake: {
    oralMl: number;
    ivFluidMl: number;
  };
  treatments: string[];
}

export function TprCalendarGrid({
  admissionId,
  patient,
  hospitalName,
  letterhead,
  vitals,
  fluids,
  treatments = [],
  canRecord = true,
  canPrint = true,
  userRole,
}: TprCalendarGridProps) {
  const displayHospitalName = hospitalName || letterhead?.hospitalName || 'HOSPITAL';
  // Helper to format Date into YYYY-MM-DD
  const formatDateToIso = (d: Date) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };

  // Determine available admission dates from vitals, fluids, and treatments
  const availableDates = useMemo(() => {
    const dateSet = new Set<string>();

    if (patient?.admittedAt) {
      dateSet.add(formatDateToIso(new Date(patient.admittedAt)));
    }
    dateSet.add(formatDateToIso(new Date()));

    for (const v of vitals) {
      dateSet.add(formatDateToIso(new Date(v.recordedAt)));
    }
    for (const f of fluids) {
      dateSet.add(formatDateToIso(new Date(f.recordedAt)));
    }
    for (const t of treatments) {
      dateSet.add(formatDateToIso(new Date(t.actualTime)));
    }

    return Array.from(dateSet).sort().reverse();
  }, [vitals, fluids, treatments, patient?.admittedAt]);

  // Default to the date of the most recent vital/fluid reading, or today
  const defaultInitialDate = useMemo(() => {
    if (vitals.length > 0) {
      return formatDateToIso(new Date(vitals[0].recordedAt));
    }
    if (fluids.length > 0) {
      return formatDateToIso(new Date(fluids[0].recordedAt));
    }
    return formatDateToIso(new Date());
  }, [vitals, fluids]);

  // Selected date defaults to most recent record date or today
  const [selectedDate, setSelectedDate] = useState<string>(defaultInitialDate);

  // Modal State for slot clicking
  const [isVitalsModalOpen, setIsVitalsModalOpen] = useState(false);
  const [activeSlotTarget, setActiveSlotTarget] = useState<{
    date: string;
    time: string;
    slotLabel: string;
  } | null>(null);

  // Generate 24 Hourly Slots starting at 8:00 AM of selectedDate through 7:00 AM next day
  const { hourlyRows, totals } = useMemo(() => {
    const [year, month, day] = selectedDate.split('-').map(Number);
    // Base 8:00 AM of selected date
    const baseDate = new Date(year, month - 1, day, 8, 0, 0, 0);

    const rows: HourlySlotData[] = [];
    const totalsAcc = {
      drainMl: 0,
      urineMl: 0,
      rtAspiMl: 0,
      totalOutputMl: 0,
      oralMl: 0,
      ivFluidMl: 0,
      totalIntakeMl: 0,
      netBalanceMl: 0,
    };

    // 24 slots: 8 am, 9 am, 10 am ... 12 pm ... 7 am next day
    for (let i = 0; i < 24; i++) {
      const slotStart = new Date(baseDate.getTime() + i * 60 * 60 * 1000);
      const slotEnd = new Date(slotStart.getTime() + 60 * 60 * 1000);

      const hours = slotStart.getHours();
      const ampm = hours >= 12 ? 'pm' : 'am';
      const displayHours = hours % 12 === 0 ? 12 : hours % 12;
      const timeLabel = `${displayHours} ${ampm}`;
      const slotTimeStr = `${String(hours).padStart(2, '0')}:00`;
      const slotDateStr = formatDateToIso(slotStart);

      // Find matching vitals in this hour window
      const matchedVitals = vitals.filter((v) => {
        const vt = new Date(v.recordedAt).getTime();
        return vt >= slotStart.getTime() && vt < slotEnd.getTime();
      });

      // Find matching fluids in this hour window
      let drainMl = 0;
      let urineMl = 0;
      let rtAspiMl = 0;
      let oralMl = 0;
      let ivFluidMl = 0;

      for (const f of fluids) {
        const ft = new Date(f.recordedAt).getTime();
        if (ft >= slotStart.getTime() && ft < slotEnd.getTime()) {
          if (f.kind === 'DRAIN') drainMl += f.ml;
          else if (f.kind === 'URINE') urineMl += f.ml;
          else if (f.kind === 'RT_ASPIRATE') rtAspiMl += f.ml;
          else if (f.kind === 'ORAL') oralMl += f.ml;
          else if (f.kind === 'IV') ivFluidMl += f.ml;
        }
      }

      // Find matching treatments in this hour window
      const matchedTreatments = treatments
        .filter((t) => {
          const tt = new Date(t.actualTime).getTime();
          return tt >= slotStart.getTime() && tt < slotEnd.getTime();
        })
        .map((t) => `${t.medicineName}${t.doseGiven ? ` (${t.doseGiven})` : ''}`);

      totalsAcc.drainMl += drainMl;
      totalsAcc.urineMl += urineMl;
      totalsAcc.rtAspiMl += rtAspiMl;
      totalsAcc.oralMl += oralMl;
      totalsAcc.ivFluidMl += ivFluidMl;

      rows.push({
        slotHour: hours,
        slotDateStr,
        timeLabel,
        slotTimeStr,
        startTimeMs: slotStart.getTime(),
        endTimeMs: slotEnd.getTime(),
        vitals: matchedVitals,
        primaryVital: matchedVitals.length > 0 ? matchedVitals[matchedVitals.length - 1] : undefined,
        output: { drainMl, urineMl, rtAspiMl },
        intake: { oralMl, ivFluidMl },
        treatments: matchedTreatments,
      });
    }

    totalsAcc.totalOutputMl = totalsAcc.drainMl + totalsAcc.urineMl + totalsAcc.rtAspiMl;
    totalsAcc.totalIntakeMl = totalsAcc.oralMl + totalsAcc.ivFluidMl;
    totalsAcc.netBalanceMl = totalsAcc.totalIntakeMl - totalsAcc.totalOutputMl;

    return { hourlyRows: rows, totals: totalsAcc };
  }, [selectedDate, vitals, fluids, treatments]);

  // Navigate to previous / next day
  const handleDayShift = (days: number) => {
    const [y, m, d] = selectedDate.split('-').map(Number);
    const curr = new Date(y, m - 1, d);
    curr.setDate(curr.getDate() + days);
    setSelectedDate(formatDateToIso(curr));
  };

  // Open modal pre-filling clicked slot
  const handleSlotClick = (slot: HourlySlotData) => {
    if (!canRecord) return;
    setActiveSlotTarget({
      date: slot.slotDateStr,
      time: slot.slotTimeStr,
      slotLabel: slot.timeLabel,
    });
    setIsVitalsModalOpen(true);
  };

  return (
    <div className="space-y-3 font-sans">
      {/* 1. Date Navigation & Filter Controls */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2.5 bg-surface rounded-xl border border-ink-200 p-3 shadow-2xs">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center rounded-lg border border-ink-300 bg-white p-0.5 shadow-2xs">
            <button
              type="button"
              onClick={() => handleDayShift(-1)}
              className="px-2.5 py-1 text-xs font-bold text-ink-700 hover:bg-ink-100 rounded cursor-pointer"
              title="Previous Day"
            >
              &larr; Prev
            </button>
            <input
              type="date"
              value={selectedDate}
              onChange={(e) => setSelectedDate(e.target.value)}
              className="px-2 py-1 text-xs font-semibold text-ink-900 border-x border-ink-200 focus:outline-hidden cursor-pointer"
            />
            <button
              type="button"
              onClick={() => handleDayShift(1)}
              className="px-2.5 py-1 text-xs font-bold text-ink-700 hover:bg-ink-100 rounded cursor-pointer"
              title="Next Day"
            >
              Next &rarr;
            </button>
          </div>

          <button
            type="button"
            onClick={() => setSelectedDate(formatDateToIso(new Date()))}
            className="px-2.5 py-1 text-xs font-bold rounded-lg border border-ink-300 bg-white hover:bg-ink-50 shadow-2xs text-ink-800 cursor-pointer"
          >
            Today
          </button>

          {/* Quick Date Chips */}
          <div className="hidden md:flex items-center gap-1.5 ml-2 overflow-x-auto scrollbar-none">
            {availableDates.slice(0, 5).map((dateStr) => {
              const d = new Date(dateStr + 'T00:00:00');
              const isSelected = dateStr === selectedDate;
              return (
                <button
                  key={dateStr}
                  type="button"
                  onClick={() => setSelectedDate(dateStr)}
                  className={`px-2 py-0.5 text-[11px] font-semibold rounded-md transition-colors cursor-pointer ${
                    isSelected
                      ? 'bg-brand-700 text-white shadow-2xs'
                      : 'bg-ink-100/70 text-ink-700 hover:bg-ink-200'
                  }`}
                >
                  {d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}
                </button>
              );
            })}
          </div>
        </div>

        {/* Action Buttons (Hidden for nurses) */}
        {userRole !== 'nurse' && canPrint && (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                if (typeof window !== 'undefined') {
                  window.print();
                }
              }}
              className="inline-flex items-center gap-1 rounded-lg border border-ink-300 bg-white px-3 py-1.5 text-xs font-semibold text-ink-700 shadow-2xs hover:bg-ink-50 cursor-pointer"
              title="Print Nursing TPR Chart"
            >
              <span>🖨️ Print Chart</span>
            </button>
          </div>
        )}
      </div>

      {/* 2. Authentic Paper-Style Nursing T.P.R. Chart */}
      <div className="rounded-xl border-2 border-slate-300 bg-white shadow-sm overflow-hidden text-ink-900 print:border-none print:shadow-none">
        {/* Authentic Header Matching Real Hospital Paper Sheet */}
        <div className="border-b-2 border-slate-300 bg-sky-50/50 p-4 text-center space-y-1">
          <h2 className="text-base sm:text-lg font-black tracking-wider uppercase text-sky-950 font-serif">
            {displayHospitalName}
          </h2>
          {(letterhead?.address || letterhead?.branchName || letterhead?.phones || letterhead?.registrationNo) && (
            <p className="text-[11px] font-medium text-ink-600 tracking-wide">
              {[
                letterhead.branchName,
                letterhead.address,
                letterhead.phones ? `Tel: ${letterhead.phones}` : null,
                letterhead.registrationNo ? `Reg. No: ${letterhead.registrationNo}` : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
          )}
          <h3 className="text-xs sm:text-sm font-extrabold tracking-widest uppercase text-sky-800 underline decoration-sky-600 underline-offset-4 pt-0.5">
            NURSING T.P.R. CHART
          </h3>

          {/* Patient Details Line */}
          <div className="mt-3 grid grid-cols-2 sm:grid-cols-5 gap-2 border-t border-slate-300 pt-2.5 text-left text-xs font-medium text-ink-800">
            <div>
              <span className="text-ink-500 font-semibold">Patients Name: </span>
              <strong className="text-ink-950 font-bold">{patient?.name || '—'}</strong>
            </div>
            <div>
              <span className="text-ink-500 font-semibold">Age / Sex: </span>
              <strong className="text-ink-950">{patient?.age ? `${patient.age} Y` : '—'} / {patient?.gender || '—'}</strong>
            </div>
            <div>
              <span className="text-ink-500 font-semibold">IPD No.: </span>
              <strong className="font-mono text-ink-950 font-bold">{patient?.ipdNumber || '—'}</strong>
            </div>
            <div>
              <span className="text-ink-500 font-semibold">Ward &amp; Bed: </span>
              <strong className="text-ink-950 font-bold">
                {patient?.wardName ? `${patient.wardName} · Bed ${patient.bedLabel || ''}` : 'General Ward'}
              </strong>
            </div>
            <div>
              <span className="text-ink-500 font-semibold">Date: </span>
              <strong className="font-mono text-ink-950 font-bold">
                {new Date(selectedDate + 'T00:00:00').toLocaleDateString('en-IN', {
                  day: '2-digit',
                  month: '2-digit',
                  year: 'numeric',
                })}
              </strong>
            </div>
          </div>
        </div>

        {/* 24-Hour Grid Table */}
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-xs font-mono tabular-nums text-left">
            <thead>
              {/* Row 1 of Table Headers: Single Columns + Merged Super-Headers for OUT PUT and INTEX */}
              <tr className="bg-sky-100/80 border-b border-slate-300 text-sky-950 text-[11px] font-sans font-bold uppercase tracking-wider text-center">
                <th rowSpan={2} className="py-2 px-3 border-r border-slate-300 w-16 text-left">
                  TIME
                </th>
                <th rowSpan={2} className="py-2 px-2 border-r border-slate-300 w-16">
                  PULSE
                </th>
                <th rowSpan={2} className="py-2 px-2 border-r border-slate-300 w-20">
                  B.P.
                </th>
                <th rowSpan={2} className="py-2 px-2 border-r border-slate-300 w-14">
                  SPO2
                </th>
                <th rowSpan={2} className="py-2 px-2 border-r border-slate-300 w-16">
                  TEMP
                </th>
                <th rowSpan={2} className="py-2 px-2 border-r border-slate-300 w-16">
                  BSL
                </th>
                <th rowSpan={2} className="py-2 px-2 border-r border-slate-300 w-14">
                  R.R.
                </th>
                <th rowSpan={2} className="py-2 px-2 border-r border-slate-300 w-16">
                  ABD GIRTH
                </th>
                <th colSpan={3} className="py-1 px-2 border-r border-slate-300 bg-amber-100/70 text-amber-950">
                  OUT PUT (ml)
                </th>
                <th colSpan={2} className="py-1 px-2 border-r border-slate-300 bg-emerald-100/70 text-emerald-950">
                  INTEX (INTAKE ml)
                </th>
                <th rowSpan={2} className="py-2 px-3 text-left min-w-[200px]">
                  TREATMENT / MEDICINES GIVEN
                </th>
              </tr>

              {/* Row 2 of Table Headers: Sub-columns for OUT PUT and INTEX */}
              <tr className="bg-sky-50/60 border-b-2 border-slate-300 text-[10px] font-sans font-semibold text-ink-700 text-center">
                {/* Under OUT PUT */}
                <th className="py-1 px-2 border-r border-slate-300 w-14 bg-amber-50/50">DRAIN</th>
                <th className="py-1 px-2 border-r border-slate-300 w-14 bg-amber-50/50">URIN</th>
                <th className="py-1 px-2 border-r border-slate-300 w-14 border-r-slate-300 bg-amber-50/50">RT.ASPI</th>

                {/* Under INTEX */}
                <th className="py-1 px-2 border-r border-slate-300 w-16 bg-emerald-50/50">ORAL</th>
                <th className="py-1 px-2 border-r border-slate-300 w-20 bg-emerald-50/50">I/V FLUID</th>
              </tr>
            </thead>

            <tbody className="divide-y divide-slate-200">
              {hourlyRows.map((row) => {
                const v = row.primaryVital;
                const hasVitals = Boolean(v);
                const hasData = hasVitals || row.output.drainMl > 0 || row.output.urineMl > 0 ||
                  row.output.rtAspiMl > 0 || row.intake.oralMl > 0 || row.intake.ivFluidMl > 0 ||
                  row.treatments.length > 0;

                const isFever = v?.temperatureF ? parseFloat(v.temperatureF) >= 100.4 : false;
                const isHypoxemia = v?.spo2Percent ? v.spo2Percent < 94 : false;
                const isTachy = v?.pulseBpm ? v.pulseBpm > 100 : false;
                const isBrady = v?.pulseBpm ? v.pulseBpm < 55 : false;

                return (
                  <tr
                    key={row.timeLabel}
                    onClick={() => handleSlotClick(row)}
                    className={`transition-colors cursor-pointer group ${
                      hasData ? 'bg-white hover:bg-sky-50/50' : 'bg-slate-50/30 hover:bg-sky-50/30'
                    }`}
                    title={canRecord ? `Click to record or modify vitals for ${row.timeLabel}` : undefined}
                  >
                    {/* 1. TIME */}
                    <td className="py-1.5 px-3 border-r border-slate-300 font-sans font-bold text-ink-900 text-xs bg-slate-50/80 group-hover:bg-sky-100/60 whitespace-nowrap">
                      <div className="flex items-center justify-between">
                        <span>{row.timeLabel}</span>
                        {canRecord && (
                          <span className="opacity-0 group-hover:opacity-100 text-[10px] text-brand-700 font-bold ml-1">
                            +
                          </span>
                        )}
                      </div>
                    </td>

                    {/* 2. PULSE */}
                    <td className={`py-1.5 px-2 border-r border-slate-300 text-center font-bold ${
                      isTachy || isBrady ? 'text-amber-800 bg-amber-50/60' : 'text-ink-900'
                    }`}>
                      {v?.pulseBpm ?? '—'}
                    </td>

                    {/* 3. B.P. */}
                    <td className="py-1.5 px-2 border-r border-slate-300 text-center font-bold text-ink-900 whitespace-nowrap">
                      {v?.bpSystolic && v?.bpDiastolic ? `${v.bpSystolic}/${v.bpDiastolic}` : '—'}
                    </td>

                    {/* 4. SPO2 */}
                    <td className={`py-1.5 px-2 border-r border-slate-300 text-center font-bold ${
                      isHypoxemia ? 'text-rose-800 bg-rose-50/70 font-black' : 'text-ink-900'
                    }`}>
                      {v?.spo2Percent ?? '—'}
                    </td>

                    {/* 5. TEMP */}
                    <td className={`py-1.5 px-2 border-r border-slate-300 text-center font-bold ${
                      isFever ? 'text-rose-800 bg-rose-50/80 font-black' : 'text-ink-900'
                    }`}>
                      {v?.temperatureF ? `${v.temperatureF}°F` : '—'}
                    </td>

                    {/* 6. BSL */}
                    <td className="py-1.5 px-2 border-r border-slate-300 text-center text-ink-800">
                      {v?.bsl ?? '—'}
                    </td>

                    {/* 7. R.R. */}
                    <td className="py-1.5 px-2 border-r border-slate-300 text-center text-ink-800">
                      {v?.respiratoryRate ?? '—'}
                    </td>

                    {/* 8. ABD GIRTH */}
                    <td className="py-1.5 px-2 border-r border-slate-300 text-center text-ink-800">
                      {v?.abdGirthCm ? `${v.abdGirthCm}` : '—'}
                    </td>

                    {/* 9. OUTPUT: DRAIN */}
                    <td className="py-1.5 px-2 border-r border-slate-300 text-center text-amber-900">
                      {row.output.drainMl > 0 ? row.output.drainMl : '—'}
                    </td>

                    {/* 10. OUTPUT: URIN */}
                    <td className="py-1.5 px-2 border-r border-slate-300 text-center font-bold text-amber-950">
                      {row.output.urineMl > 0 ? row.output.urineMl : '—'}
                    </td>

                    {/* 11. OUTPUT: RT.ASPI */}
                    <td className="py-1.5 px-2 border-r border-slate-300 text-center text-amber-900">
                      {row.output.rtAspiMl > 0 ? row.output.rtAspiMl : '—'}
                    </td>

                    {/* 12. INTEX: ORAL */}
                    <td className="py-1.5 px-2 border-r border-slate-300 text-center font-bold text-emerald-950">
                      {row.intake.oralMl > 0 ? row.intake.oralMl : '—'}
                    </td>

                    {/* 13. INTEX: I/V FLUID */}
                    <td className="py-1.5 px-2 border-r border-slate-300 text-center font-bold text-emerald-950 whitespace-nowrap">
                      {row.intake.ivFluidMl > 0 ? `${row.intake.ivFluidMl} ml` : '—'}
                    </td>

                    {/* 14. TREATMENT */}
                    <td className="py-1.5 px-3 font-sans text-xs text-ink-800">
                      {row.treatments.length > 0 ? (
                        <div className="flex flex-wrap gap-1">
                          {row.treatments.map((t, idx) => (
                            <span
                              key={idx}
                              className="inline-block rounded bg-sky-50 px-1.5 py-0.5 text-[11px] font-semibold text-sky-900 border border-sky-200"
                            >
                              {t}
                            </span>
                          ))}
                        </div>
                      ) : (
                        <span className="text-ink-300 italic text-[11px]">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>

            {/* 3. Totals Row Matching Paper Chart Footer */}
            <tfoot>
              <tr className="border-t-2 border-slate-400 bg-sky-100 font-sans font-bold text-xs text-sky-950">
                <td className="py-2.5 px-3 border-r border-slate-300 text-left font-extrabold uppercase">
                  &Sigma; TOTALS
                </td>
                <td colSpan={7} className="py-2.5 px-3 border-r border-slate-300 text-right text-[11px] text-ink-600 font-normal">
                  24-Hour Cumulative Fluid Intake &amp; Output Summary:
                </td>

                {/* Total Drain */}
                <td className="py-2.5 px-2 border-r border-slate-300 text-center font-mono font-bold text-amber-950">
                  {totals.drainMl > 0 ? `${totals.drainMl}` : '—'}
                </td>

                {/* Total Urine */}
                <td className="py-2.5 px-2 border-r border-slate-300 text-center font-mono font-black text-amber-950">
                  {totals.urineMl > 0 ? `${totals.urineMl}` : '0'}
                </td>

                {/* Total RT.ASPI */}
                <td className="py-2.5 px-2 border-r border-slate-300 text-center font-mono font-bold text-amber-950">
                  {totals.rtAspiMl > 0 ? `${totals.rtAspiMl}` : '—'}
                </td>

                {/* Total Oral */}
                <td className="py-2.5 px-2 border-r border-slate-300 text-center font-mono font-bold text-emerald-950">
                  {totals.oralMl > 0 ? `${totals.oralMl}` : '—'}
                </td>

                {/* Total IV Fluid */}
                <td className="py-2.5 px-2 border-r border-slate-300 text-center font-mono font-black text-emerald-950">
                  {totals.ivFluidMl > 0 ? `${totals.ivFluidMl}` : '—'}
                </td>

                {/* Grand Balance Box */}
                <td className="py-2.5 px-3 font-mono font-bold text-xs">
                  <div className="flex flex-wrap items-center gap-3">
                    <span className="text-emerald-900">
                      &Sigma; In: <strong>{totals.totalIntakeMl} ml</strong>
                    </span>
                    <span className="text-amber-900">
                      &Sigma; Out: <strong>{totals.totalOutputMl} ml</strong>
                    </span>
                    <span
                      className={`px-2 py-0.5 rounded text-[11px] font-black ${
                        totals.netBalanceMl >= 0
                          ? 'bg-emerald-200 text-emerald-900'
                          : 'bg-rose-200 text-rose-900'
                      }`}
                    >
                      Net: {totals.netBalanceMl > 0 ? `+${totals.netBalanceMl}` : totals.netBalanceMl} ml
                    </span>
                  </div>
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      {/* 4. Slot Clicking Record Modal */}
      {isVitalsModalOpen && (
        <RecordVitalsModal
          admissionId={admissionId}
          isOpen={isVitalsModalOpen}
          initialDate={activeSlotTarget?.date || selectedDate}
          initialTime={activeSlotTarget?.time || '08:00'}
          initialSlotLabel={activeSlotTarget?.slotLabel}
          onClose={() => {
            setIsVitalsModalOpen(false);
            setActiveSlotTarget(null);
          }}
          onSuccess={() => {
            setIsVitalsModalOpen(false);
            setActiveSlotTarget(null);
            if (typeof window !== 'undefined') {
              window.location.reload();
            }
          }}
        />
      )}
    </div>
  );
}
