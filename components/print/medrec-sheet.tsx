import { ADMISSION_DECISIONS, DISCHARGE_DECISIONS, MED_REC_SOURCES } from '@/lib/domain/medrec';
import type { MedRecView } from '@/lib/services/medrec';

/**
 * Medication reconciliation on paper (IPD sheets plan B2): the home medicines
 * with the doctor's decision, and the list going home, each with who signed.
 */
export function MedRecSheet({ view, timezone }: { view: MedRecView; timezone: string }) {
  const date = (at: Date) => at.toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: timezone });
  const parts = [
    { title: 'At admission: medicines taken at home', part: view.admission, decisions: ADMISSION_DECISIONS as Record<string, string> },
    { title: 'At discharge: medicines to take at home', part: view.discharge, decisions: DISCHARGE_DECISIONS as Record<string, string> },
  ];
  return (
    <div className="space-y-4 pt-3">
      {parts.map(({ title, part, decisions }) => (
        <section key={title}>
          <h3 className="mb-1 text-[13px] font-bold">{title}</h3>
          {part.items.length === 0 ? (
            <p className="text-ink-600">{part.signoff?.noneAtHome ? 'Takes nothing at home.' : 'Nothing listed.'}</p>
          ) : (
            <table className="w-full border-collapse">
              <thead>
                <tr className="border-y border-ink-400 text-left text-[10px] uppercase tracking-wide">
                  <th className="py-1 pr-2">Medicine</th>
                  <th className="py-1 pr-2">Dose · how often</th>
                  <th className="py-1 pr-2">From</th>
                  <th className="py-1 pr-2">Decision</th>
                  <th className="py-1">Note</th>
                </tr>
              </thead>
              <tbody>
                {part.items.map((i) => (
                  <tr key={i.id} className="border-b border-ink-200 align-top">
                    <td className="py-1 pr-2 font-semibold">{i.name}</td>
                    <td className="py-1 pr-2">{[i.dose, i.frequency, i.route, i.duration].filter(Boolean).join(' · ') || '—'}</td>
                    <td className="py-1 pr-2">{i.source ? MED_REC_SOURCES[i.source] : '—'}</td>
                    <td className="py-1 pr-2">{i.decision ? decisions[i.decision] : '—'}</td>
                    <td className="py-1">{i.decisionNote ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="mt-1 text-[11px] text-ink-700">
            {part.signoff ? `Completed by ${part.signoff.doctorName}, ${date(part.signoff.signedAt)}` : 'Not completed. Doctor’s signature: ____________________'}
          </p>
        </section>
      ))}
    </div>
  );
}
