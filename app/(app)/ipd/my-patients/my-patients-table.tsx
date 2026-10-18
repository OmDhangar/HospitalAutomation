import React from 'react';
import Link from 'next/link';
import { dayOfStay, sinceLabel } from '@/lib/domain/admission';
import { toTitleCase } from '@/lib/domain/doctor';
import type { MyPatient, TestChip } from '@/lib/services/doctor-ipd';
import { orderTestsAction, setDischargeReadyAction } from '../actions';

export interface MyPatientsTableProps {
  patients: MyPatient[];
  chips: TestChip[];
  writable?: boolean;
  timezone: string;
}

export function MyPatientsTable({
  patients,
  chips,
  writable = true,
  timezone,
}: MyPatientsTableProps) {
  const now = new Date();

  if (patients.length === 0) {
    return (
      <div className="rounded-xl border border-ink-200 bg-white p-8 text-center shadow-2xs">
        <p className="text-sm font-bold text-ink-900">No admitted patients under your care.</p>
        <p className="mt-1 text-xs text-ink-500">
          Patients admitted to wards will appear here once allocated to your consultation roster.
        </p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-ink-200/80 bg-white shadow-2xs">
      <table className="w-full border-collapse text-left text-xs">
        <thead>
          <tr className="border-b border-ink-200 bg-ink-50/80 text-[11px] font-bold uppercase tracking-wider text-ink-600">
            <th className="px-3.5 py-2.5">Bed / Ward</th>
            <th className="px-3.5 py-2.5">Patient</th>
            <th className="px-3.5 py-2.5">Age / Sex</th>
            <th className="px-3.5 py-2.5">Day</th>
            <th className="px-3.5 py-2.5">Last Given</th>
            <th className="px-3.5 py-2.5">Status</th>
            <th className="px-3.5 py-2.5 text-right">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-ink-100">
          {patients.map((patient) => {
            const isReady = patient.status === 'discharge_ready';
            const formattedName = toTitleCase(patient.patientName);
            const daysCount = patient.admittedAt ? dayOfStay(patient.admittedAt, now, timezone) : 1;

            return (
              <tr
                key={patient.admissionId}
                className="transition-colors hover:bg-brand-50/20 even:bg-ink-50/20"
              >
                {/* Bed / Ward */}
                <td className="px-3.5 py-2.5 whitespace-nowrap">
                  {patient.bed ? (
                    <div className="flex items-center gap-1.5">
                      <span className="rounded bg-brand-700 px-1.5 py-0.5 font-mono text-[11px] font-bold text-white shadow-2xs">
                        {`Bed ${patient.bed.label}`}
                      </span>
                      <span className="text-ink-600 text-[11px] truncate max-w-[120px]">
                        {patient.bed.wardName}
                      </span>
                    </div>
                  ) : (
                    <span className="text-ink-400 italic text-[11px]">No bed</span>
                  )}
                </td>

                {/* Patient Name */}
                <td className="px-3.5 py-2.5">
                  <Link
                    href={`/ipd/patients/${patient.admissionId}/summary`}
                    className="font-bold text-ink-950 hover:text-brand-700 hover:underline inline-flex items-center gap-1"
                  >
                    <span>{formattedName}</span>
                  </Link>
                </td>

                {/* Age / Sex */}
                <td className="px-3.5 py-2.5 text-ink-600 whitespace-nowrap">
                  {patient.age ? `${patient.age}y` : '—'}
                  {patient.gender ? ` · ${patient.gender}` : ''}
                </td>

                {/* Day of Stay */}
                <td className="px-3.5 py-2.5 whitespace-nowrap">
                  <span className="inline-flex rounded-md border border-sky-200 bg-sky-50 px-2 py-0.5 font-mono text-[11px] font-bold text-sky-800">
                    Day {daysCount}
                  </span>
                </td>

                {/* Last Administered */}
                <td className="px-3.5 py-2.5 text-ink-600 whitespace-nowrap font-mono text-[11px]">
                  {patient.lastEntryAt ? (
                    `Last given ${sinceLabel(patient.lastEntryAt, now)}`
                  ) : (
                    <span className="text-ink-400 italic font-sans">Nothing given yet</span>
                  )}
                </td>

                {/* Status Badge */}
                <td className="px-3.5 py-2.5 whitespace-nowrap">
                  {isReady ? (
                    <span className="inline-flex items-center gap-1 rounded-md border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-[11px] font-bold text-emerald-800">
                      ✓ Ready for discharge
                    </span>
                  ) : (
                    <span className="inline-flex items-center rounded-md border border-ink-200 bg-ink-100 px-2 py-0.5 text-[11px] font-semibold text-ink-700">
                      Admitted
                    </span>
                  )}
                </td>

                {/* Actions */}
                <td className="px-3.5 py-2.5 text-right whitespace-nowrap">
                  <div className="inline-flex items-center gap-1.5">
                    <Link
                      href={`/ipd/patients/${patient.admissionId}/summary`}
                      className="inline-flex items-center rounded-md border border-brand-300 bg-brand-50 px-2.5 py-1 text-xs font-bold text-brand-900 shadow-2xs hover:bg-brand-100"
                    >
                      Chart &rarr;
                    </Link>

                    {writable && (
                      <form action={setDischargeReadyAction} className="inline">
                        <input type="hidden" name="admissionId" value={patient.admissionId} />
                        <input type="hidden" name="ready" value={isReady ? 'false' : 'true'} />
                        <input type="hidden" name="back" value="/ipd/my-patients" />
                        <button
                          type="submit"
                          className={`inline-flex items-center rounded-md border px-2 py-1 text-xs font-semibold shadow-2xs cursor-pointer ${
                            isReady
                              ? 'border-amber-300 bg-amber-50 text-amber-900 hover:bg-amber-100'
                              : 'border-emerald-300 bg-emerald-50 text-emerald-900 hover:bg-emerald-100'
                          }`}
                        >
                          {isReady ? 'Not ready' : 'Discharge ready'}
                        </button>
                      </form>
                    )}

                    {writable && chips.length > 0 && (
                      <details className="group relative inline-block text-left">
                        <summary className="inline-flex cursor-pointer list-none items-center rounded-md border border-ink-300 bg-white px-2 py-1 text-xs font-semibold text-ink-700 shadow-2xs hover:bg-ink-50">
                          Tests
                        </summary>
                        <div className="absolute right-0 z-30 mt-1 w-64 rounded-xl border border-ink-200 bg-white p-3 shadow-lg">
                          <p className="text-[11px] font-bold uppercase tracking-wider text-ink-500 mb-2">
                            Quick Order Tests
                          </p>
                          <form action={orderTestsAction} className="space-y-2">
                            <input type="hidden" name="admissionId" value={patient.admissionId} />
                            <input type="hidden" name="back" value="/ipd/my-patients" />
                            <div className="grid grid-cols-2 gap-1.5 max-h-48 overflow-y-auto">
                              {chips.map((chip) => (
                                <label
                                  key={chip.id}
                                  className="flex items-center gap-1.5 rounded p-1 text-[11px] hover:bg-ink-50 cursor-pointer"
                                >
                                  <input
                                    type="checkbox"
                                    name="tests"
                                    value={chip.id}
                                    className="rounded border-ink-300 text-brand-600 focus:ring-brand-500"
                                  />
                                  <span className="truncate">{chip.name}</span>
                                </label>
                              ))}
                            </div>
                            <button
                              type="submit"
                              className="w-full mt-2 rounded-md bg-brand-700 py-1 text-xs font-bold text-white hover:bg-brand-800"
                            >
                              Submit Orders
                            </button>
                          </form>
                        </div>
                      </details>
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
