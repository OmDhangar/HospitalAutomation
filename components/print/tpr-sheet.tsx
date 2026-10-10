import { Fragment } from 'react';
import { PrintLetterhead } from '@/components/print/letterhead';
import { PrintSheetHeader, type SheetPatient } from '@/components/print/sheet-header';
import { formatIpdNumber } from '@/lib/domain/ipd-number';
import type { Letterhead } from '@/lib/domain/letterhead';
import {
  BACK_HOURS,
  FRONT_HOURS,
  INTAKE_COLUMNS,
  OUTPUT_COLUMNS,
  SHIFTS,
  VITAL_COLUMNS,
  chartDayWindow,
  hourLabel,
  readingSummary,
  vitalCell,
  type IoTotal,
} from '@/lib/domain/tpr';
import type { TprDay, TprReading } from '@/lib/services/tpr';

/**
 * The nursing T.P.R. chart as the paper is laid out (IPD sheets plan B1): one
 * chart day on two A4 landscape pages — the front 8 am–10 pm, the back
 * 11 pm–7 am — with the paper's columns, the Treatment column filled from the
 * bedside entries, and intake/output totalled after each shift and for the 24
 * hours. Empty hours keep a row, so the sheet can be finished by hand.
 *
 * `day` null prints a blank sheet (the paper fallback, plan §12).
 */
export function TprSheetPages({
  day,
  date,
  letterhead,
  patient,
  timezone,
}: {
  day: TprDay | null;
  date: string;
  letterhead: Letterhead;
  patient: SheetPatient;
  timezone: string;
}) {
  const sheetDate = chartDayWindow(date, timezone).from;
  const time = new Intl.DateTimeFormat('en-IN', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: timezone,
  });
  return (
    <>
      {(['front', 'back'] as const).map((side) => (
        <article
          key={side}
          className="sheet tpr-page mb-6 bg-white p-8 text-[11px] leading-tight text-ink-900 shadow-sm print:mb-0 print:p-0 print:shadow-none"
        >
          {side === 'front' ? (
            <>
              <PrintLetterhead letterhead={letterhead} title="Nursing T.P.R. chart" />
              <PrintSheetHeader patient={patient} timezone={timezone} sheetDate={sheetDate} />
            </>
          ) : (
            <p className="flex justify-between border-b border-ink-400 pb-1 font-semibold">
              <span>
                {patient.name} · IPD No. {formatIpdNumber(patient.ipdNumber)}
              </span>
              <span>
                T.P.R. chart ·{' '}
                {sheetDate.toLocaleDateString('en-IN', {
                  day: '2-digit',
                  month: 'short',
                  year: 'numeric',
                  timeZone: timezone,
                })}{' '}
                · back (11 pm – 7 am)
              </span>
            </p>
          )}
          <Grid hours={side === 'front' ? FRONT_HOURS : BACK_HOURS} day={day} time={time} />
          {side === 'back' ? <BackFooter day={day} time={time} /> : null}
        </article>
      ))}
    </>
  );
}

const FLUID_COLUMNS = [...OUTPUT_COLUMNS, ...INTAKE_COLUMNS];

function Grid({ hours, day, time }: { hours: readonly number[]; day: TprDay | null; time: Intl.DateTimeFormat }) {
  return (
    <table className="mt-2 w-full border-collapse border border-ink-700">
      <thead>
        <tr className="text-[10px] uppercase">
          <th rowSpan={2} className="w-[16mm] border border-ink-700 px-1 py-1">
            Time
          </th>
          {VITAL_COLUMNS.map((column) => (
            <th key={column.key} rowSpan={2} className="border border-ink-700 px-1 py-1">
              {column.label}
              <span className="block font-normal normal-case text-ink-600">{column.unit}</span>
            </th>
          ))}
          <th colSpan={3} className="border border-ink-700 px-1 py-0.5">
            Output (ml)
          </th>
          <th colSpan={2} className="border border-ink-700 px-1 py-0.5">
            Intake (ml)
          </th>
          <th rowSpan={2} className="w-[62mm] border border-ink-700 px-1 py-1">
            Treatment
          </th>
          <th rowSpan={2} className="w-[18mm] border border-ink-700 px-1 py-1">
            By
          </th>
        </tr>
        <tr className="text-[9px] uppercase">
          {FLUID_COLUMNS.map((column) => (
            <th key={column.key} className="border border-ink-700 px-1 py-0.5 font-semibold">
              {column.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {hours.map((hour) => {
          const readings = day?.readings.filter((r) => r.hour === hour) ?? [];
          const given = day?.treatment.filter((g) => g.hour === hour) ?? [];
          const rows: (TprReading | null)[] = readings.length > 0 ? readings : [null];
          const shiftEnd = SHIFTS.find((s) => (s.toHour + 23) % 24 === hour);
          return (
            <Fragment key={hour}>
              {rows.map((r, i) => (
                <tr key={r?.id ?? `${hour}-blank`} className="h-[6.5mm] align-top">
                  <td className="numeric border border-ink-700 px-1 py-0.5">
                    {i === 0 ? <span className="font-semibold">{hourLabel(hour)}</span> : null}
                    {r ? (
                      <span className="block text-[9px] text-ink-700">
                        {time.format(r.observedAt)}
                        {r.late ? ' late entry' : ''}
                      </span>
                    ) : null}
                  </td>
                  {VITAL_COLUMNS.map((column) => {
                    const cell = r ? vitalCell(r, column.key) : null;
                    return (
                      <td key={column.key} className="numeric border border-ink-700 px-1 py-0.5 text-center">
                        {cell ? (
                          <span className={cell.flag ? 'font-bold' : undefined}>
                            {cell.text}
                            {cell.flag ? <sup className="ml-0.5">{cell.flag === 'high' ? 'H' : 'L'}</sup> : null}
                          </span>
                        ) : null}
                      </td>
                    );
                  })}
                  {FLUID_COLUMNS.map((column) => (
                    <td key={column.key} className="numeric border border-ink-700 px-1 py-0.5 text-center">
                      {r?.[column.key] ?? ''}
                    </td>
                  ))}
                  <td className="border border-ink-700 px-1 py-0.5">
                    {i === 0 ? given.map((g) => `${g.description} × ${g.quantity}`).join(', ') : null}
                    {r?.note ? <span className="block italic">{r.note}</span> : null}
                    {r && (r.onOxygen || r.consciousness) ? (
                      <span className="block text-[9px]">
                        {[r.onOxygen ? 'On O₂' : null, r.consciousness ? `AVPU: ${r.consciousness}` : null]
                          .filter(Boolean)
                          .join(' · ')}
                      </span>
                    ) : null}
                  </td>
                  <td className="border border-ink-700 px-1 py-0.5 text-[9px]">{r?.recordedByName ?? ''}</td>
                </tr>
              ))}
              {shiftEnd ? (
                <tr className="bg-ink-100 print:bg-transparent">
                  <td colSpan={8} className="border border-ink-700 px-1 py-0.5 text-right font-semibold">
                    Shift {shiftEnd.label}: intake / output
                  </td>
                  <td colSpan={7} className="numeric border border-ink-700 px-1 py-0.5 font-semibold">
                    {day ? <IoText total={day.totals.byShift[shiftEnd.key]} /> : null}
                  </td>
                </tr>
              ) : null}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}

function IoText({ total }: { total: IoTotal }) {
  return (
    <>
      In {total.intakeMl} ml · Out {total.outputMl} ml · Balance {total.balanceMl > 0 ? '+' : ''}
      {total.balanceMl} ml
    </>
  );
}

function BackFooter({ day, time }: { day: TprDay | null; time: Intl.DateTimeFormat }) {
  return (
    <div className="mt-2 space-y-2">
      <p className="border border-ink-700 px-2 py-1 font-bold">
        24 hours (8 am – 8 am): {day ? <IoText total={day.totals.day} /> : 'In ______ ml · Out ______ ml · Balance ______ ml'}
      </p>
      {day && day.voided.length > 0 ? (
        <div>
          <p className="font-semibold">Corrected entries</p>
          <ul className="list-disc pl-4">
            {day.voided.map((v) => (
              <li key={v.id}>
                <span className="line-through">
                  {time.format(v.observedAt)} · {readingSummary(v)}
                </span>{' '}
                — {v.voidReason}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <p className="text-[9px] text-ink-700">
        H / L: outside the usual adult range (a prompt to look, not a diagnosis). “late entry”: written more than 2 hours after it
        was taken. Printed from QuriioHQ; entries are signed by the staff member named under “By”.
      </p>
      <div className="flex justify-between pt-4 text-[10px]">
        <span>Sister in-charge: ______________________</span>
        <span>Doctor: ______________________</span>
      </div>
    </div>
  );
}
