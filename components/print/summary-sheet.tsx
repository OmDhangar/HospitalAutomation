import { DISCHARGE_TYPES, SECTIONS, type SummaryContent } from '@/lib/domain/discharge-summary';

/**
 * The discharge summary on paper (IPD sheets plan B5). Prints the latest
 * finalised version; until a doctor has signed it (or when only a draft
 * exists) every page carries DRAFT and it must not be handed over as final.
 */
export function SummarySheet({
  content,
  signed,
  footer,
}: {
  content: SummaryContent;
  signed: boolean;
  /** "Version 2 · signed by Dr …, 11 Oct 2026" or "Draft — not finalised". */
  footer: string;
}) {
  return (
    <div className="relative pt-3">
      {!signed ? (
        <p aria-hidden className="pointer-events-none absolute inset-x-0 top-24 -rotate-12 text-center text-[96px] font-black tracking-widest text-ink-200/70 select-none">
          DRAFT
        </p>
      ) : null}
      <div className="relative space-y-2">
        <p>
          <span className="font-bold">Discharge: </span>
          {DISCHARGE_TYPES[content.dischargeType]}
        </p>
        {SECTIONS.filter((s) => content[s.key]).map((s) => (
          <section key={s.key} className="break-inside-avoid">
            <h3 className="text-[12px] font-bold uppercase tracking-wide">{s.label}</h3>
            <p className="whitespace-pre-line">{content[s.key]}</p>
          </section>
        ))}
        {content.medicines.length > 0 ? (
          <section className="break-inside-avoid">
            <h3 className="text-[12px] font-bold uppercase tracking-wide">Medicines to continue at home</h3>
            <table className="w-full border-collapse">
              <thead>
                <tr className="border-y border-ink-400 text-left text-[10px] uppercase tracking-wide">
                  <th className="py-1 pr-2">Medicine</th>
                  <th className="py-1 pr-2">Dose</th>
                  <th className="py-1 pr-2">How often</th>
                  <th className="py-1">How long</th>
                </tr>
              </thead>
              <tbody>
                {content.medicines.map((m, i) => (
                  <tr key={i} className="border-b border-ink-200">
                    <td className="py-1 pr-2 font-semibold">{m.name}{m.note ? <span className="font-normal"> ({m.note})</span> : null}</td>
                    <td className="py-1 pr-2">{m.dose}</td>
                    <td className="py-1 pr-2">{m.frequency}</td>
                    <td className="py-1">{m.duration}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ) : null}
        <p className="pt-4 text-[11px] text-ink-700">{footer}</p>
        {!signed ? <p className="text-[11px] font-bold">NOT SIGNED — not to be given to the patient as final.</p> : null}
      </div>
    </div>
  );
}
