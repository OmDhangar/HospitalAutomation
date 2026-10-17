import React from 'react';
import type { PrintableMedicalReport } from '@/lib/services/medical-report';

export interface PatientMedicalReportProps {
  patient: {
    name: string;
    age: number | null;
    gender: string | null;
    ipdNumber: string | null;
    doctorName: string | null;
  };
  report: PrintableMedicalReport;
  hospitalName?: string;
}

export function PatientMedicalReport({
  patient,
  report,
  hospitalName = 'GURUVED HOSPITAL & CRITICARE CENTRE',
}: PatientMedicalReportProps) {
  const patientDemographics = [
    patient.name,
    patient.age || patient.gender
      ? `(${[patient.age ? `${patient.age}y` : null, patient.gender].filter(Boolean).join(', ')})`
      : null,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <section className="mt-8 break-before-page border-t-2 border-dashed border-ink-300 pt-6 print:mt-0 print:border-none print:pt-0">
      {/* Header */}
      <header className="relative border-b-2 border-ink-950 pb-2">
        <div className="absolute top-0 right-0 text-[9px] font-bold uppercase tracking-widest text-ink-400 print:text-ink-600">
          Powered by QuriioHQ
        </div>

        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-black uppercase tracking-tight text-ink-950">
              {hospitalName}
            </h1>
            <p className="text-xs font-bold uppercase tracking-wider text-ink-700">
              Inpatient Clinical Dossier &amp; Diagnostic Findings
            </p>
          </div>
          <div className="text-right text-[11px] font-mono">
            <span className="font-bold text-ink-700">IPD: </span>
            <span className="font-black text-ink-950">{`IPD-${patient.ipdNumber || '—'}`}</span>
          </div>
        </div>

        {/* Patient Strip */}
        <div className="mt-2 flex flex-wrap items-center justify-between gap-3 bg-ink-50 px-3 py-1.5 text-xs text-ink-900 border border-ink-200">
          <div>
            <span className="font-bold text-ink-700">Patient: </span>
            <span className="font-black text-ink-950">{patientDemographics}</span>
          </div>
          <div>
            <span className="font-bold text-ink-700">Consultant: </span>
            <span className="font-bold text-ink-950">{patient.doctorName || 'Attending Physician'}</span>
          </div>
        </div>
      </header>

      {/* 1. Diagnostic Investigations */}
      <div className="mt-4 break-inside-avoid">
        <h2 className="border-b border-ink-950 pb-1 text-xs font-black uppercase tracking-wider text-ink-950 flex items-center gap-2">
          <span>Diagnostic Investigations &amp; Laboratory Findings</span>
          <span className="text-[10px] font-normal text-ink-500 font-mono">
            ({report.investigations.length} {report.investigations.length === 1 ? 'test' : 'tests'})
          </span>
        </h2>

        {report.investigations.length === 0 ? (
          <p className="py-3 text-xs italic text-ink-500">
            No diagnostic investigations recorded for this stay.
          </p>
        ) : (
          <table className="mt-2 w-full border-collapse text-left text-[11px] leading-tight text-ink-900">
            <thead>
              <tr className="border-b border-ink-300 bg-ink-50/70 text-[10px] font-bold uppercase text-ink-700">
                <th className="py-1.5 px-2">Investigation Test</th>
                <th className="py-1.5 px-2">Date &amp; Time</th>
                <th className="py-1.5 px-2">Status</th>
                <th className="py-1.5 px-2">Report Results / Findings</th>
                <th className="py-1.5 px-2">Reference Limits</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {report.investigations.map((test) => (
                <tr key={test.id} className="align-top">
                  <td className="py-1.5 px-2 font-bold text-ink-950">
                    {test.name}
                    {test.isCritical && (
                      <span className="ml-2 rounded bg-rose-600 px-1 py-0.2 text-[8px] font-black uppercase text-white">
                        CRITICAL
                      </span>
                    )}
                  </td>
                  <td className="py-1.5 px-2 font-mono text-ink-600 whitespace-nowrap">
                    {new Date(test.orderedAt).toLocaleDateString('en-IN', {
                      day: '2-digit',
                      month: 'short',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </td>
                  <td className="py-1.5 px-2 font-semibold text-emerald-800 whitespace-nowrap">
                    {test.status}
                  </td>
                  <td className="py-1.5 px-2 font-mono text-ink-900">
                    {test.result || 'Results archived in laboratory record'}
                  </td>
                  <td className="py-1.5 px-2 font-mono text-ink-500 whitespace-nowrap">
                    {test.normalRange || 'Standard limits'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* 2. Doctor Progress & Rounding Notes */}
      <div className="mt-6 break-inside-avoid">
        <h2 className="border-b border-ink-950 pb-1 text-xs font-black uppercase tracking-wider text-ink-950 flex items-center gap-2">
          <span>Doctor Progress &amp; Rounding Notes</span>
          <span className="text-[10px] font-normal text-ink-500 font-mono">
            ({report.progressNotes.length} {report.progressNotes.length === 1 ? 'entry' : 'entries'})
          </span>
        </h2>

        {report.progressNotes.length === 0 ? (
          <p className="py-3 text-xs italic text-ink-500">
            No clinical progress notes recorded for this stay.
          </p>
        ) : (
          <div className="mt-2.5 space-y-2.5">
            {report.progressNotes.map((note) => (
              <div key={note.id} className="border border-ink-200 bg-white p-2.5 text-xs text-ink-900 break-inside-avoid">
                <div className="flex items-center justify-between border-b border-ink-100 pb-1 text-[10px]">
                  <span className="font-bold text-ink-950">
                    {note.authorName} · {note.noteType === 'SOAP' ? 'Doctor Rounds' : 'Nursing Note'}
                  </span>
                  <span className="font-mono text-ink-600">
                    {new Date(note.createdAt).toLocaleDateString('en-IN', {
                      day: '2-digit',
                      month: 'short',
                      year: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </span>
                </div>

                <div className="mt-2 space-y-1 text-[11px] leading-snug">
                  {note.soapS && (
                    <div className="flex gap-2">
                      <span className="font-bold text-ink-600 w-4 shrink-0">S:</span>
                      <span className="text-ink-900">{note.soapS}</span>
                    </div>
                  )}
                  {note.soapO && (
                    <div className="flex gap-2">
                      <span className="font-bold text-ink-600 w-4 shrink-0">O:</span>
                      <span className="text-ink-900">{note.soapO}</span>
                    </div>
                  )}
                  {note.soapA && (
                    <div className="flex gap-2">
                      <span className="font-bold text-ink-600 w-4 shrink-0">A:</span>
                      <span className="font-bold text-ink-950">{note.soapA}</span>
                    </div>
                  )}
                  {note.soapP && (
                    <div className="flex gap-2">
                      <span className="font-bold text-ink-600 w-4 shrink-0">P:</span>
                      <span className="text-ink-900">{note.soapP}</span>
                    </div>
                  )}
                  {!note.soapS && !note.soapO && !note.soapA && !note.soapP && note.body && (
                    <p className="text-ink-900 whitespace-pre-wrap">{note.body}</p>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 3. Discharge Clinical Summary (if present) */}
      {report.dischargeSummary && (
        <div className="mt-6 break-inside-avoid">
          <h2 className="border-b border-ink-950 pb-1 text-xs font-black uppercase tracking-wider text-ink-950">
            Discharge Summary &amp; Take-Home Instructions
          </h2>

          <div className="mt-2.5 border border-ink-200 bg-ink-50/30 p-3 text-xs space-y-2">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <span className="font-bold text-ink-700">Primary Diagnosis: </span>
                <span className="font-black text-ink-950">
                  {report.dischargeSummary.primaryDiagnosis || 'Clinical Diagnosis on File'}
                </span>
              </div>
              <div>
                <span className="font-bold text-ink-700">Condition at Discharge: </span>
                <span className="font-semibold text-ink-900">
                  {report.dischargeSummary.conditionAtDischarge || 'Clinically Stable'}
                </span>
              </div>
            </div>

            {report.dischargeSummary.dischargeAdvice && (
              <div>
                <span className="font-bold text-ink-700">Advice: </span>
                <span className="text-ink-900">{report.dischargeSummary.dischargeAdvice}</span>
              </div>
            )}

            {/* Take-Home Medications Table */}
            {report.dischargeSummary.takeHomePrescriptions?.length > 0 && (
              <div className="pt-2 border-t border-ink-200">
                <span className="font-bold text-ink-950 uppercase text-[10px] tracking-wider block mb-1">
                  Take-Home Medications Prescribed:
                </span>
                <table className="w-full border-collapse text-left text-[10px] bg-white border border-ink-200">
                  <thead>
                    <tr className="border-b border-ink-200 bg-ink-50 font-bold uppercase text-ink-700">
                      <th className="py-1 px-2">Medicine</th>
                      <th className="py-1 px-2">Dosage</th>
                      <th className="py-1 px-2">Frequency</th>
                      <th className="py-1 px-2">Duration</th>
                      <th className="py-1 px-2">Instructions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-ink-100">
                    {report.dischargeSummary.takeHomePrescriptions.map((p, idx) => (
                      <tr key={idx}>
                        <td className="py-1 px-2 font-bold text-ink-950">{p.medicineName}</td>
                        <td className="py-1 px-2">{p.dosage}</td>
                        <td className="py-1 px-2 font-semibold text-brand-800">{p.frequency}</td>
                        <td className="py-1 px-2">{p.duration || '—'}</td>
                        <td className="py-1 px-2 text-ink-600">{p.instructions || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Footer */}
      <footer className="mt-8 flex items-end justify-between border-t border-ink-300 pt-3 text-[10px] text-ink-600 break-inside-avoid">
        <div>
          <span>Powered by QuriioHQ</span>
        </div>
        <div className="w-56 text-right">
          <div className="border-t border-ink-950 pt-1 text-center font-bold text-ink-900 uppercase">
            Consultant Doctor Signature
          </div>
        </div>
      </footer>
    </section>
  );
}
