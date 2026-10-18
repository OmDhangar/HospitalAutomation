'use client';

import React, { useState, useEffect } from 'react';
import { recordVitalReadingAction, recordIntakeOutputAction } from '@/app/(app)/ipd/actions';
import { calculateNews2 } from '@/lib/domain/vitals-news2';

export interface RecordVitalsModalProps {
  admissionId: string;
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: () => void;
  initialDate?: string; // YYYY-MM-DD
  initialTime?: string; // HH:mm e.g. "08:00"
  initialSlotLabel?: string; // e.g. "08:00 AM"
}

export function RecordVitalsModal({
  admissionId,
  isOpen,
  onClose,
  onSuccess,
  initialDate,
  initialTime,
  initialSlotLabel,
}: RecordVitalsModalProps) {
  // Format current local date YYYY-MM-DD and time HH:mm
  const getTodayStr = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const getNowTimeStr = () => {
    const d = new Date();
    return `${String(d.getHours()).padStart(2, '0')}:00`;
  };

  const [obsDate, setObsDate] = useState(initialDate || getTodayStr());
  const [obsTime, setObsTime] = useState(initialTime || getNowTimeStr());

  // Vitals Parameters
  const [pulseBpm, setPulseBpm] = useState('');
  const [bpSystolic, setBpSystolic] = useState('');
  const [bpDiastolic, setBpDiastolic] = useState('');
  const [spo2Percent, setSpo2Percent] = useState('');
  const [temperatureF, setTemperatureF] = useState('');
  const [bsl, setBsl] = useState('');
  const [respiratoryRate, setRespiratoryRate] = useState('');
  const [abdGirthCm, setAbdGirthCm] = useState('');
  const [painScore, setPainScore] = useState('0');

  // Fluid Balance fields for this slot
  const [showFluidSection, setShowFluidSection] = useState(false);
  const [oralMl, setOralMl] = useState('');
  const [ivMl, setIvMl] = useState('');
  const [urineMl, setUrineMl] = useState('');
  const [drainMl, setDrainMl] = useState('');
  const [rtAspirateMl, setRtAspirateMl] = useState('');

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Sync initial props when opened
  useEffect(() => {
    if (isOpen) {
      if (initialDate) setObsDate(initialDate);
      if (initialTime) setObsTime(initialTime);
    }
  }, [isOpen, initialDate, initialTime]);

  if (!isOpen) return null;

  const newsResult = calculateNews2({
    temperatureF: temperatureF ? parseFloat(temperatureF) : null,
    pulseBpm: pulseBpm ? parseInt(pulseBpm, 10) : null,
    bpSystolic: bpSystolic ? parseInt(bpSystolic, 10) : null,
    respiratoryRate: respiratoryRate ? parseInt(respiratoryRate, 10) : null,
    spo2Percent: spo2Percent ? parseInt(spo2Percent, 10) : null,
  });

  const calculatedNews = newsResult.totalScore;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setError(null);

    try {
      // Build ISO timestamp from selected date & time
      const [year, month, day] = obsDate.split('-').map(Number);
      const [hour, min] = obsTime.split(':').map(Number);
      const recordedTimestamp = new Date(year, month - 1, day, hour || 0, min || 0, 0);

      // 1. Record vital reading
      await recordVitalReadingAction({
        admissionId,
        recordedAt: recordedTimestamp,
        pulseBpm: pulseBpm ? parseInt(pulseBpm, 10) : null,
        bpSystolic: bpSystolic ? parseInt(bpSystolic, 10) : null,
        bpDiastolic: bpDiastolic ? parseInt(bpDiastolic, 10) : null,
        spo2Percent: spo2Percent ? parseInt(spo2Percent, 10) : null,
        temperatureF: temperatureF ? parseFloat(temperatureF) : null,
        bsl: bsl ? parseInt(bsl, 10) : null,
        respiratoryRate: respiratoryRate ? parseInt(respiratoryRate, 10) : null,
        abdGirthCm: abdGirthCm ? parseFloat(abdGirthCm) : null,
        painScore: painScore ? parseInt(painScore, 10) : null,
        news2Score: calculatedNews,
        scheduledSlot: initialSlotLabel || obsTime,
        avpu: 'A',
      });

      // 2. If fluid quantities entered, record corresponding intake/output
      const promises: Promise<any>[] = [];
      if (oralMl && parseInt(oralMl, 10) > 0) {
        promises.push(
          recordIntakeOutputAction({
            admissionId,
            recordedAt: recordedTimestamp,
            kind: 'ORAL',
            ml: parseInt(oralMl, 10),
            notes: `Recorded at ${obsTime} slot`,
          }),
        );
      }
      if (ivMl && parseInt(ivMl, 10) > 0) {
        promises.push(
          recordIntakeOutputAction({
            admissionId,
            recordedAt: recordedTimestamp,
            kind: 'IV',
            ml: parseInt(ivMl, 10),
            notes: `Recorded at ${obsTime} slot`,
          }),
        );
      }
      if (urineMl && parseInt(urineMl, 10) > 0) {
        promises.push(
          recordIntakeOutputAction({
            admissionId,
            recordedAt: recordedTimestamp,
            kind: 'URINE',
            ml: parseInt(urineMl, 10),
            notes: `Recorded at ${obsTime} slot`,
          }),
        );
      }
      if (drainMl && parseInt(drainMl, 10) > 0) {
        promises.push(
          recordIntakeOutputAction({
            admissionId,
            recordedAt: recordedTimestamp,
            kind: 'DRAIN',
            ml: parseInt(drainMl, 10),
            notes: `Recorded at ${obsTime} slot`,
          }),
        );
      }
      if (rtAspirateMl && parseInt(rtAspirateMl, 10) > 0) {
        promises.push(
          recordIntakeOutputAction({
            admissionId,
            recordedAt: recordedTimestamp,
            kind: 'RT_ASPIRATE',
            ml: parseInt(rtAspirateMl, 10),
            notes: `Recorded at ${obsTime} slot`,
          }),
        );
      }

      if (promises.length > 0) {
        await Promise.all(promises);
      }

      if (onSuccess) onSuccess();
      onClose();
    } catch (err: any) {
      setError(err?.message || 'Failed to record vitals.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4">
      <div className="w-full max-w-xl max-h-[90vh] overflow-y-auto rounded-2xl border border-slate-300 bg-white p-5 shadow-2xl">
        <div className="flex items-center justify-between border-b border-ink-100 pb-3">
          <div>
            <h3 className="text-sm font-bold text-ink-950">Record Nursing T.P.R. &amp; Vitals</h3>
            <p className="text-xs text-ink-500">
              {initialSlotLabel ? `Documenting for ${initialSlotLabel} slot` : 'Enter clinical observations and fluid balance'}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1 text-ink-400 hover:bg-ink-100 hover:text-ink-700"
          >
            ✕
          </button>
        </div>

        {error && (
          <div className="mt-3 rounded-lg bg-rose-50 border border-rose-200 p-2 text-xs font-semibold text-rose-800">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="mt-4 space-y-4 text-xs">
          {/* Observation Date & Time Chooser */}
          <div className="p-3 rounded-xl bg-brand-50/60 border border-brand-200">
            <span className="block font-bold text-ink-900 mb-2">Observation Date &amp; Time Slot:</span>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[11px] font-semibold text-ink-700 mb-1">
                  Date
                </label>
                <input
                  type="date"
                  value={obsDate}
                  onChange={(e) => setObsDate(e.target.value)}
                  className="w-full rounded-lg border border-ink-300 bg-white px-3 py-1.5 text-xs font-medium focus:border-brand-500 focus:outline-hidden"
                  required
                />
              </div>
              <div>
                <label className="block text-[11px] font-semibold text-ink-700 mb-1">
                  Time Slot (Hour:Min)
                </label>
                <input
                  type="time"
                  value={obsTime}
                  onChange={(e) => setObsTime(e.target.value)}
                  className="w-full rounded-lg border border-ink-300 bg-white px-3 py-1.5 text-xs font-medium focus:border-brand-500 focus:outline-hidden"
                  required
                />
              </div>
            </div>
          </div>

          {/* Primary TPR Grid */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
            {/* Pulse */}
            <div>
              <label className="block font-semibold text-ink-700 mb-1">
                PULSE (bpm)
              </label>
              <input
                type="number"
                placeholder="80"
                value={pulseBpm}
                onChange={(e) => setPulseBpm(e.target.value)}
                className="w-full rounded-lg border border-ink-300 px-2.5 py-1.5 text-xs focus:border-brand-500 focus:outline-hidden"
              />
            </div>

            {/* BP Systolic */}
            <div>
              <label className="block font-semibold text-ink-700 mb-1">
                BP Systolic
              </label>
              <input
                type="number"
                placeholder="110"
                value={bpSystolic}
                onChange={(e) => setBpSystolic(e.target.value)}
                className="w-full rounded-lg border border-ink-300 px-2.5 py-1.5 text-xs focus:border-brand-500 focus:outline-hidden"
              />
            </div>

            {/* BP Diastolic */}
            <div>
              <label className="block font-semibold text-ink-700 mb-1">
                BP Diastolic
              </label>
              <input
                type="number"
                placeholder="70"
                value={bpDiastolic}
                onChange={(e) => setBpDiastolic(e.target.value)}
                className="w-full rounded-lg border border-ink-300 px-2.5 py-1.5 text-xs focus:border-brand-500 focus:outline-hidden"
              />
            </div>

            {/* SpO2 */}
            <div>
              <label className="block font-semibold text-ink-700 mb-1">
                SPO2 (%)
              </label>
              <input
                type="number"
                placeholder="98"
                value={spo2Percent}
                onChange={(e) => setSpo2Percent(e.target.value)}
                className="w-full rounded-lg border border-ink-300 px-2.5 py-1.5 text-xs focus:border-brand-500 focus:outline-hidden"
              />
            </div>

            {/* Temperature */}
            <div>
              <label className="block font-semibold text-ink-700 mb-1">
                TEMP (°F)
              </label>
              <input
                type="number"
                step="0.1"
                placeholder="98.6"
                value={temperatureF}
                onChange={(e) => setTemperatureF(e.target.value)}
                className="w-full rounded-lg border border-ink-300 px-2.5 py-1.5 text-xs focus:border-brand-500 focus:outline-hidden"
              />
            </div>

            {/* BSL */}
            <div>
              <label className="block font-semibold text-ink-700 mb-1">
                BSL (mg/dL)
              </label>
              <input
                type="number"
                placeholder="110"
                value={bsl}
                onChange={(e) => setBsl(e.target.value)}
                className="w-full rounded-lg border border-ink-300 px-2.5 py-1.5 text-xs focus:border-brand-500 focus:outline-hidden"
              />
            </div>

            {/* Respiratory Rate */}
            <div>
              <label className="block font-semibold text-ink-700 mb-1">
                R.R. (/min)
              </label>
              <input
                type="number"
                placeholder="20"
                value={respiratoryRate}
                onChange={(e) => setRespiratoryRate(e.target.value)}
                className="w-full rounded-lg border border-ink-300 px-2.5 py-1.5 text-xs focus:border-brand-500 focus:outline-hidden"
              />
            </div>

            {/* Abdominal Girth */}
            <div>
              <label className="block font-semibold text-ink-700 mb-1">
                ABD GIRTH (cm)
              </label>
              <input
                type="number"
                step="0.1"
                placeholder="75"
                value={abdGirthCm}
                onChange={(e) => setAbdGirthCm(e.target.value)}
                className="w-full rounded-lg border border-ink-300 px-2.5 py-1.5 text-xs focus:border-brand-500 focus:outline-hidden"
              />
            </div>
          </div>

          {/* Fluid Intake / Output Collapsible Section */}
          <div className="border border-ink-200 rounded-xl overflow-hidden">
            <button
              type="button"
              onClick={() => setShowFluidSection(!showFluidSection)}
              className="w-full flex items-center justify-between p-2.5 bg-ink-50 text-left font-bold text-ink-800 text-xs hover:bg-ink-100 transition-colors"
            >
              <span>+ Record Fluids (Intake &amp; Output for this hour)</span>
              <span className="text-[11px] text-ink-500 font-normal">
                {showFluidSection ? '▲ Hide' : '▼ Expand'}
              </span>
            </button>

            {showFluidSection && (
              <div className="p-3 bg-white space-y-3">
                <div>
                  <span className="font-bold text-[11px] uppercase text-emerald-800 tracking-wider block mb-1.5">
                    INTAKE (INTEX)
                  </span>
                  <div className="grid grid-cols-2 gap-2.5">
                    <div>
                      <label className="block text-[11px] text-ink-600 mb-0.5">ORAL (ml)</label>
                      <input
                        type="number"
                        placeholder="200"
                        value={oralMl}
                        onChange={(e) => setOralMl(e.target.value)}
                        className="w-full rounded border border-ink-300 px-2 py-1 text-xs"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] text-ink-600 mb-0.5">I/V FLUID (ml)</label>
                      <input
                        type="number"
                        placeholder="250"
                        value={ivMl}
                        onChange={(e) => setIvMl(e.target.value)}
                        className="w-full rounded border border-ink-300 px-2 py-1 text-xs"
                      />
                    </div>
                  </div>
                </div>

                <div>
                  <span className="font-bold text-[11px] uppercase text-amber-800 tracking-wider block mb-1.5">
                    OUTPUT (OUT PUT)
                  </span>
                  <div className="grid grid-cols-3 gap-2.5">
                    <div>
                      <label className="block text-[11px] text-ink-600 mb-0.5">URINE (ml)</label>
                      <input
                        type="number"
                        placeholder="400"
                        value={urineMl}
                        onChange={(e) => setUrineMl(e.target.value)}
                        className="w-full rounded border border-ink-300 px-2 py-1 text-xs"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] text-ink-600 mb-0.5">DRAIN (ml)</label>
                      <input
                        type="number"
                        placeholder="50"
                        value={drainMl}
                        onChange={(e) => setDrainMl(e.target.value)}
                        className="w-full rounded border border-ink-300 px-2 py-1 text-xs"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] text-ink-600 mb-0.5">RT. ASPIRATE (ml)</label>
                      <input
                        type="number"
                        placeholder="100"
                        value={rtAspirateMl}
                        onChange={(e) => setRtAspirateMl(e.target.value)}
                        className="w-full rounded border border-ink-300 px-2 py-1 text-xs"
                      />
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* NEWS2 Indicator */}
          <div className="flex items-center justify-between rounded-xl bg-ink-50 p-2.5 border border-ink-200">
            <span className="text-xs font-semibold text-ink-700">Calculated NEWS2 Risk:</span>
            <span
              className={`rounded-md px-2 py-0.5 font-mono text-xs font-bold ${
                calculatedNews >= 5
                  ? 'bg-rose-100 text-rose-800'
                  : calculatedNews >= 3
                    ? 'bg-amber-100 text-amber-800'
                    : 'bg-emerald-100 text-emerald-800'
              }`}
            >
              Score: {calculatedNews} ({calculatedNews >= 5 ? 'High Risk' : calculatedNews >= 3 ? 'Medium Risk' : 'Low Risk'})
            </span>
          </div>

          {/* Action buttons */}
          <div className="flex justify-end gap-2 pt-2 border-t border-ink-100">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-ink-300 px-3.5 py-1.5 text-xs font-semibold text-ink-700 hover:bg-ink-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="rounded-lg bg-brand-700 px-4 py-1.5 text-xs font-bold text-white shadow-xs hover:bg-brand-800 disabled:opacity-50"
            >
              {isSubmitting ? 'Saving…' : 'Save Slot Reading'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
