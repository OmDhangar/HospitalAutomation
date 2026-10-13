'use client';

import React, { useState } from 'react';
import { recordVitalReadingAction } from '@/app/(app)/ipd/actions';

export interface RecordVitalsModalProps {
  admissionId: string;
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: () => void;
}

export function RecordVitalsModal({
  admissionId,
  isOpen,
  onClose,
  onSuccess,
}: RecordVitalsModalProps) {
  const [temperatureF, setTemperatureF] = useState('');
  const [pulseBpm, setPulseBpm] = useState('');
  const [bpSystolic, setBpSystolic] = useState('');
  const [bpDiastolic, setBpDiastolic] = useState('');
  const [respiratoryRate, setRespiratoryRate] = useState('');
  const [spo2Percent, setSpo2Percent] = useState('');
  const [painScore, setPainScore] = useState('0');
  const [bsl, setBsl] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  // Simple NEWS2 calculation
  const calculateNews2 = (): number => {
    let score = 0;
    const temp = parseFloat(temperatureF);
    if (!isNaN(temp)) {
      if (temp <= 95.0) score += 3;
      else if (temp <= 96.8) score += 1;
      else if (temp >= 102.4) score += 2;
      else if (temp >= 100.6) score += 1;
    }
    const pulse = parseInt(pulseBpm, 10);
    if (!isNaN(pulse)) {
      if (pulse <= 40 || pulse >= 131) score += 3;
      else if (pulse >= 111) score += 2;
      else if (pulse <= 50 || pulse >= 91) score += 1;
    }
    const sys = parseInt(bpSystolic, 10);
    if (!isNaN(sys)) {
      if (sys <= 90 || sys >= 220) score += 3;
      else if (sys <= 100) score += 2;
      else if (sys <= 110) score += 1;
    }
    const rr = parseInt(respiratoryRate, 10);
    if (!isNaN(rr)) {
      if (rr <= 8 || rr >= 25) score += 3;
      else if (rr >= 21) score += 2;
      else if (rr <= 11) score += 1;
    }
    const o2 = parseInt(spo2Percent, 10);
    if (!isNaN(o2)) {
      if (o2 <= 91) score += 3;
      else if (o2 <= 93) score += 2;
      else if (o2 <= 95) score += 1;
    }
    return score;
  };

  const calculatedNews = calculateNews2();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setError(null);
    try {
      await recordVitalReadingAction({
        admissionId,
        temperatureF: temperatureF ? parseFloat(temperatureF) : null,
        pulseBpm: pulseBpm ? parseInt(pulseBpm, 10) : null,
        bpSystolic: bpSystolic ? parseInt(bpSystolic, 10) : null,
        bpDiastolic: bpDiastolic ? parseInt(bpDiastolic, 10) : null,
        respiratoryRate: respiratoryRate ? parseInt(respiratoryRate, 10) : null,
        spo2Percent: spo2Percent ? parseInt(spo2Percent, 10) : null,
        painScore: painScore ? parseInt(painScore, 10) : null,
        news2Score: calculatedNews,
        bsl: bsl ? parseInt(bsl, 10) : null,
        avpu: 'A',
      });
      if (onSuccess) onSuccess();
      onClose();
    } catch (err: any) {
      setError(err?.message || 'Failed to record vitals.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/40 p-4 backdrop-blur-2xs">
      <div className="w-full max-w-lg rounded-2xl border border-ink-200 bg-white p-5 shadow-xl">
        <div className="flex items-center justify-between border-b border-ink-100 pb-3">
          <div>
            <h3 className="text-sm font-bold text-ink-950">Record Patient Vitals</h3>
            <p className="text-xs text-ink-500">TPR, Blood Pressure &amp; NEWS2 observations</p>
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
          <div className="grid grid-cols-2 gap-3">
            {/* Temperature */}
            <div>
              <label className="block font-semibold text-ink-700 mb-1">
                Body Temperature (°F)
              </label>
              <input
                type="number"
                step="0.1"
                placeholder="98.6"
                value={temperatureF}
                onChange={(e) => setTemperatureF(e.target.value)}
                className="w-full rounded-lg border border-ink-300 px-3 py-2 text-xs focus:border-brand-500 focus:outline-hidden"
              />
            </div>

            {/* Pulse */}
            <div>
              <label className="block font-semibold text-ink-700 mb-1">
                Pulse (bpm)
              </label>
              <input
                type="number"
                placeholder="72"
                value={pulseBpm}
                onChange={(e) => setPulseBpm(e.target.value)}
                className="w-full rounded-lg border border-ink-300 px-3 py-2 text-xs focus:border-brand-500 focus:outline-hidden"
              />
            </div>

            {/* Blood Pressure Systolic */}
            <div>
              <label className="block font-semibold text-ink-700 mb-1">
                BP Systolic (mmHg)
              </label>
              <input
                type="number"
                placeholder="120"
                value={bpSystolic}
                onChange={(e) => setBpSystolic(e.target.value)}
                className="w-full rounded-lg border border-ink-300 px-3 py-2 text-xs focus:border-brand-500 focus:outline-hidden"
              />
            </div>

            {/* Blood Pressure Diastolic */}
            <div>
              <label className="block font-semibold text-ink-700 mb-1">
                BP Diastolic (mmHg)
              </label>
              <input
                type="number"
                placeholder="80"
                value={bpDiastolic}
                onChange={(e) => setBpDiastolic(e.target.value)}
                className="w-full rounded-lg border border-ink-300 px-3 py-2 text-xs focus:border-brand-500 focus:outline-hidden"
              />
            </div>

            {/* Respiratory Rate */}
            <div>
              <label className="block font-semibold text-ink-700 mb-1">
                Resp. Rate (/min)
              </label>
              <input
                type="number"
                placeholder="16"
                value={respiratoryRate}
                onChange={(e) => setRespiratoryRate(e.target.value)}
                className="w-full rounded-lg border border-ink-300 px-3 py-2 text-xs focus:border-brand-500 focus:outline-hidden"
              />
            </div>

            {/* Oxygen Saturation */}
            <div>
              <label className="block font-semibold text-ink-700 mb-1">
                Oxygen SpO2 (%)
              </label>
              <input
                type="number"
                placeholder="99"
                value={spo2Percent}
                onChange={(e) => setSpo2Percent(e.target.value)}
                className="w-full rounded-lg border border-ink-300 px-3 py-2 text-xs focus:border-brand-500 focus:outline-hidden"
              />
            </div>

            {/* Pain Score */}
            <div>
              <label className="block font-semibold text-ink-700 mb-1">
                Pain Score (0 - 10)
              </label>
              <select
                value={painScore}
                onChange={(e) => setPainScore(e.target.value)}
                className="w-full rounded-lg border border-ink-300 px-3 py-2 text-xs focus:border-brand-500 focus:outline-hidden"
              >
                {[...Array(11)].map((_, i) => (
                  <option key={i} value={i}>
                    {i} {i === 0 ? '(No Pain)' : i <= 3 ? '(Mild)' : i <= 6 ? '(Moderate)' : '(Severe)'}
                  </option>
                ))}
              </select>
            </div>

            {/* Blood Sugar (BSL) */}
            <div>
              <label className="block font-semibold text-ink-700 mb-1">
                Blood Sugar (mg/dL)
              </label>
              <input
                type="number"
                placeholder="110"
                value={bsl}
                onChange={(e) => setBsl(e.target.value)}
                className="w-full rounded-lg border border-ink-300 px-3 py-2 text-xs focus:border-brand-500 focus:outline-hidden"
              />
            </div>
          </div>

          {/* NEWS2 Score Indicator */}
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

          {/* Actions */}
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
              {isSubmitting ? 'Saving…' : 'Save Vitals'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
