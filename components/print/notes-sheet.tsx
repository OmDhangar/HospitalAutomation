import { SYSTEMS, generalExamText, vitalsText, type SystemKey } from '@/lib/domain/notes';
import type { NoteView } from '@/lib/services/notes';

/**
 * The case sheet and progress notes on paper (IPD sheets plan C3), in the
 * paper's sections, each note with who saw the patient and who signed.
 * Struck-out notes are left off; the screen and the evidence log keep them.
 */
export function NotesSheet({ notes, timezone }: { notes: NoteView[]; timezone: string }) {
  const live = notes.filter((n) => !n.voidedAt);
  const dateTime = (at: Date) => at.toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: timezone });
  if (live.length === 0) return <p className="pt-3 text-ink-600">No notes written.</p>;
  return (
    <div className="space-y-4 pt-3">
      {live.map((n) => {
        const systems = (Object.keys(SYSTEMS) as SystemKey[]).filter((k) => n.systemicExam[k]);
        const oe = [generalExamText(n.generalExam), vitalsText(n.vitals)].filter(Boolean).join(' · ');
        const line = (label: string, value: React.ReactNode) => (
          <div className="grid grid-cols-[5rem_1fr] gap-x-2">
            <dt className="font-bold">{label}</dt>
            <dd className="whitespace-pre-line">{value}</dd>
          </div>
        );
        return (
          <section key={n.id} className="break-inside-avoid border-b border-ink-300 pb-3">
            <h3 className="mb-1 text-[13px] font-bold">
              {n.kind === 'admission' ? 'Case sheet' : 'Progress note'} · {dateTime(n.seenAt)}
            </h3>
            <dl className="space-y-0.5">
              {n.caseOf ? line('Case of', n.caseOf) : null}
              {n.complaints.length > 0 ? line('C/O', n.complaints.map((c) => `${c.text}${c.duration ? ` × ${c.duration}` : ''}`).join('\n')) : null}
              {n.history ? line('H/O', n.history) : null}
              {n.pastHistory ? line('P/H', n.pastHistory) : null}
              {n.progress ? line('Progress', n.progress) : null}
              {oe ? line('O/E', oe) : null}
              {systems.length > 0 ? line('S/E', systems.map((k) => `${SYSTEMS[k]}: ${n.systemicExam[k]}`).join('\n')) : null}
              {n.advice ? line('Adv', n.advice) : null}
            </dl>
            <p className="mt-1 text-[11px] text-ink-700">
              Seen by {n.doctorName}
              {n.transcribed
                ? ` · written by ${n.writtenBy ?? 'staff'} · ${n.countersignedAt ? `countersigned ${dateTime(n.countersignedAt)}` : 'NOT YET COUNTERSIGNED'}`
                : ' · signed'}
            </p>
          </section>
        );
      })}
    </div>
  );
}
