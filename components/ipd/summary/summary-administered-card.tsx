import React from 'react';
import Link from 'next/link';
import { formatRoutePlain } from '@/lib/domain/medicine';

export interface AdministeredDoseEntry {
  id: string;
  doseGiven?: string | null;
  routeGiven?: string | null;
  actualTime?: string | Date | null;
  recordedAt?: string | Date | null;
  clinicalNote?: string | null;
  outcome?: string;
  voidedAt?: string | Date | null;
  medicineName?: string | null;
}

export interface SummaryAdministeredCardProps {
  admissionId: string;
  doses: AdministeredDoseEntry[];
  className?: string;
}

export function SummaryAdministeredCard({
  admissionId,
  doses,
  className = '',
}: SummaryAdministeredCardProps) {
  const activeDoses = doses.filter((d) => !d.voidedAt);

  return (
    <div className={`bg-surface rounded-lg border border-ink-200 shadow-2xs p-3.5 space-y-2.5 ${className}`}>
      <div className="flex items-center justify-between border-b border-ink-100 pb-2">
        <div className="flex items-center gap-2">
          <span className="font-bold text-ink-900 text-xs tracking-tight">
            Given Medicines Today
          </span>
          <span className="inline-flex items-center px-1.5 py-0.2 rounded-full text-[10px] font-bold bg-emerald-50 text-emerald-800 ring-1 ring-inset ring-emerald-200">
            {`${activeDoses.length} given`}
          </span>
        </div>
        <Link
          href={`/ipd/patients/${admissionId}/emar`}
          className="text-[11px] font-semibold text-brand-700 hover:underline"
        >
          Medication Chart &rarr;
        </Link>
      </div>

      {activeDoses.length === 0 ? (
        <div className="py-4 text-center text-xs text-ink-400 italic">
          No medication doses recorded yet today.
        </div>
      ) : (
        <div className="max-h-64 overflow-y-auto space-y-2 pr-1">
          {activeDoses.map((dose) => (
            <div
              key={dose.id}
              className="p-2 rounded-md border border-ink-100 bg-slate-50/70 text-xs flex items-center justify-between"
            >
              <div>
                <div className="font-bold text-ink-900">
                  {dose.doseGiven || 'Medication'}
                  {dose.routeGiven && (
                    <span className="ml-1 text-[11px] font-normal text-ink-600">
                      ({formatRoutePlain(dose.routeGiven)})
                    </span>
                  )}
                </div>
                <div className="text-[11px] text-ink-500">
                  {dose.actualTime
                    ? new Date(dose.actualTime).toLocaleTimeString(undefined, {
                        hour: '2-digit',
                        minute: '2-digit',
                      })
                    : 'Administered'}
                  {dose.clinicalNote && (
                    <span className="ml-1 italic text-ink-600">· {dose.clinicalNote}</span>
                  )}
                </div>
              </div>
              <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold bg-emerald-100 text-emerald-800">
                ✓ Given
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
