import { doctorDisplayName } from '@/lib/domain/letterhead';
import { formatIpdNumber } from '@/lib/domain/ipd-number';

/**
 * The patient strip under the letterhead on every printed sheet: the fields
 * the paper forms make staff write again on each page, printed once from the
 * record so name, age and IPD No. are the same everywhere (IPD sheets plan §1).
 */
export type SheetPatient = {
  name: string;
  age: number | null;
  gender: string | null;
  ipdNumber: number | null;
  mrn: string | null;
  wardBed: string | null;
  admittedAt: Date | null;
  doctorName: string;
};

export function PrintSheetHeader({
  patient,
  timezone,
  sheetDate,
}: {
  patient: SheetPatient;
  timezone: string;
  /** The day the sheet covers (TPR, treatment card); omitted on sheets that cover the whole stay. */
  sheetDate?: Date;
}) {
  const dateTime = (at: Date) =>
    at.toLocaleString('en-IN', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZone: timezone,
    });
  const ageSex = [patient.age !== null ? `${patient.age} y` : null, patient.gender].filter(Boolean).join(' / ');

  const cells: [string, string][] = [
    ['Name', patient.name],
    ['Age / Sex', ageSex || '—'],
    ['IPD No.', formatIpdNumber(patient.ipdNumber)],
    ['Patient ID', patient.mrn ?? '—'],
    ['Ward / Bed', patient.wardBed ?? '—'],
    ['Admitted', patient.admittedAt ? dateTime(patient.admittedAt) : '—'],
    ['Consultant', doctorDisplayName(patient.doctorName)],
  ];
  if (sheetDate) {
    cells.push(['Date', sheetDate.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: timezone })]);
  }

  return (
    <dl className="grid grid-cols-4 gap-x-4 gap-y-1 border-b border-ink-400 py-2">
      {cells.map(([label, value]) => (
        <div key={label} className={label === 'Name' ? 'col-span-2' : undefined}>
          <dt className="text-[10px] uppercase tracking-wide text-ink-500">{label}</dt>
          <dd className="numeric font-semibold">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
