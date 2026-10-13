import React from 'react';
import Link from 'next/link';

export interface DailyMedSlot {
  time: string;
  status: 'DUE' | 'OVERDUE' | 'GIVEN' | 'HELD' | 'REFUSED' | 'NOT_AVAILABLE' | 'MISSED';
  givenAt?: string | null;
  nurseName?: string | null;
  reason?: string | null;
}

export interface DailyMedicationItem {
  orderId: string;
  medicineName: string;
  strength?: string | null;
  form?: string | null;
  route: string;
  frequency?: string | null;
  specialInstructions?: string | null;
  slots: DailyMedSlot[];
}

export interface DailyMedicationMatrixProps {
  medications: DailyMedicationItem[];
  admissionId?: string;
  className?: string;
}

export function DailyMedicationMatrix({
  medications,
  admissionId,
  className = '',
}: DailyMedicationMatrixProps) {
  if (medications.length === 0) {
    return (
      <div className={`p-4 bg-surface rounded-lg border border-ink-200 text-center ${className}`}>
        <p className="text-xs text-ink-500 italic">
          No active medication orders recorded for this patient stay.
        </p>
      </div>
    );
  }

  return (
    <div className={`bg-surface rounded-lg border border-ink-200 shadow-2xs overflow-hidden ${className}`}>
      {/* Table Header */}
      <div className="px-3 py-2 bg-ink-50/70 border-b border-ink-200 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-xs font-bold text-ink-900 tracking-tight">
            Today's Daily Medicines &amp; Doses
          </span>
          <span className="inline-flex items-center px-1.5 py-0.2 rounded-full text-[10px] font-semibold bg-brand-50 text-brand-800 ring-1 ring-inset ring-brand-200">
            {medications.length} active
          </span>
        </div>
        {admissionId && (
          <Link
            href={`/ipd/patients/${admissionId}/orders`}
            className="text-[11px] font-semibold text-primary hover:underline"
          >
            All Orders &rarr;
          </Link>
        )}
      </div>

      {/* Excel-style Dense Flowsheet Table */}
      <div className="overflow-x-auto">
        <table className="w-full text-left border-collapse text-xs">
          <thead>
            <tr className="border-b border-ink-200 bg-ink-50/40 text-[11px] font-semibold text-ink-600">
              <th className="py-1.5 px-3">Medicine &amp; Form</th>
              <th className="py-1.5 px-2.5">Route</th>
              <th className="py-1.5 px-2.5">Freq</th>
              <th className="py-1.5 px-3">Today's Schedule &amp; Fulfillment Checkboxes</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {medications.map((med) => (
              <tr key={med.orderId} className="hover:bg-slate-50/70 transition-colors">
                <td className="py-1.5 px-3">
                  <div className="font-semibold text-ink-900 leading-tight">
                    {med.medicineName}
                  </div>
                  {med.strength && (
                    <div className="text-[11px] text-ink-500">
                      {med.strength} {med.form ? `• ${med.form}` : ''}
                    </div>
                  )}
                </td>
                <td className="py-1.5 px-2.5 font-medium text-ink-700 uppercase text-[11px]">
                  {med.route}
                </td>
                <td className="py-1.5 px-2.5 font-semibold text-ink-700 text-[11px]">
                  {med.frequency ?? 'OD'}
                </td>
                <td className="py-1.5 px-3">
                  <div className="flex flex-wrap items-center gap-2">
                    {med.slots.map((slot, idx) => {
                      if (slot.status === 'GIVEN') {
                        return (
                          <div
                            key={idx}
                            className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded bg-emerald-50 text-emerald-900 ring-1 ring-inset ring-emerald-300 text-[11px] font-medium"
                            title={slot.nurseName ? `Given by ${slot.nurseName}` : 'Dose fulfilled'}
                          >
                            <span className="flex size-3.5 items-center justify-center rounded-xs bg-emerald-600 text-white font-bold text-[9px]">
                              ✓
                            </span>
                            <span className="font-semibold">{slot.time}</span>
                            <span className="text-emerald-700 font-mono text-[10px]">
                              (Given {slot.givenAt ?? slot.time})
                            </span>
                          </div>
                        );
                      }

                      if (slot.status === 'OVERDUE') {
                        return (
                          <div
                            key={idx}
                            className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded bg-rose-50 text-rose-900 ring-1 ring-inset ring-rose-300 text-[11px] font-semibold"
                            title="Overdue dose"
                          >
                            <span className="flex size-3.5 items-center justify-center rounded-xs border border-rose-600 bg-white text-rose-600 font-black text-[9px]">
                              !
                            </span>
                            <span>{slot.time}</span>
                            <span className="text-rose-700 text-[10px] font-normal">(Overdue)</span>
                          </div>
                        );
                      }

                      if (slot.status === 'HELD') {
                        return (
                          <div
                            key={idx}
                            className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded bg-amber-50 text-amber-900 ring-1 ring-inset ring-amber-300 text-[11px] font-medium"
                            title={slot.reason ?? 'Skipped / Held'}
                          >
                            <span className="flex size-3.5 items-center justify-center rounded-xs bg-amber-600 text-white font-bold text-[9px]">
                              ⏸
                            </span>
                            <span>{slot.time}</span>
                            <span className="text-amber-800 text-[10px]">(Skipped)</span>
                          </div>
                        );
                      }

                      // Default DUE
                      return (
                        <div
                          key={idx}
                          className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded bg-slate-50 text-ink-800 ring-1 ring-inset ring-ink-200 text-[11px] font-medium"
                        >
                          <span className="flex size-3.5 items-center justify-center rounded-xs border border-ink-400 bg-white text-transparent">
                            •
                          </span>
                          <span className="font-semibold">{slot.time}</span>
                          <span className="text-ink-500 text-[10px]">(Due)</span>
                        </div>
                      );
                    })}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
