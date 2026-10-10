import { doctorLetterheadLines, type Letterhead } from '@/lib/domain/letterhead';

/**
 * The top of every printed IPD sheet, like the hospital's paper forms: name
 * and address on the left, the doctors on the letterhead with their degrees
 * and registration numbers on the right, phones and the hospital's
 * registration number underneath. Text only until there is file storage for
 * a logo (phase A7).
 */
export function PrintLetterhead({ letterhead, title }: { letterhead: Letterhead; title?: string }) {
  const contact = [
    letterhead.phones ? `☎ ${letterhead.phones}` : null,
    letterhead.registrationNo ? `Reg. No. ${letterhead.registrationNo}` : null,
  ].filter(Boolean);

  return (
    <header className="border-b-2 border-ink-900 pb-2">
      <div className="flex items-start justify-between gap-6">
        <div className="min-w-0">
          <h1 className="text-lg font-bold uppercase tracking-wide">{letterhead.hospitalName}</h1>
          {letterhead.branchName || letterhead.address ? (
            <p className="text-ink-700">{[letterhead.branchName, letterhead.address].filter(Boolean).join(' · ')}</p>
          ) : null}
          {contact.length > 0 ? <p className="numeric text-ink-700">{contact.join('   ·   ')}</p> : null}
        </div>
        {letterhead.doctors.length > 0 ? (
          <div className="shrink-0 space-y-1 text-right">
            {letterhead.doctors.map((doctor) => {
              const [name, detail] = doctorLetterheadLines(doctor);
              return (
                <div key={name}>
                  <p className="font-bold">{name}</p>
                  {detail ? <p className="text-[11px] text-ink-700">{detail}</p> : null}
                </div>
              );
            })}
          </div>
        ) : null}
      </div>
      {title ? <p className="mt-2 text-center text-sm font-bold uppercase tracking-[0.2em]">{title}</p> : null}
    </header>
  );
}
