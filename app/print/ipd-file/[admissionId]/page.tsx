import { notFound, redirect } from 'next/navigation';
import { PrintLetterhead } from '@/components/print/letterhead';
import { PrintSheetHeader, type SheetPatient } from '@/components/print/sheet-header';
import { TprSheetPages } from '@/components/print/tpr-sheet';
import { requireModule } from '@/lib/auth/modules';
import { requireSession } from '@/lib/auth/session';
import { formatRupees } from '@/lib/domain/billing';
import { PAYER_KIND_LABELS } from '@/lib/domain/payer';
import { can } from '@/lib/domain/permissions';
import { formatIndianPhone } from '@/lib/domain/phone';
import { chartDayOf, isChartDay } from '@/lib/domain/tpr';
import { printSheetsFor } from '@/lib/modules/registry';
import { getAdmissionSummary, type AdmissionSummary } from '@/lib/services/ipd-census';
import { getLetterhead } from '@/lib/services/letterhead';
import { logRecordAccess } from '@/lib/services/record-access';
import { getTprDays, type TprDay } from '@/lib/services/tpr';
import { PrintControls } from '../../prescription/[id]/print-controls';

export const metadata = { title: 'Patient file' };

/**
 * The whole patient file, printed (IPD sheets plan §4.1, phase A4-min): the
 * sheets asked for in `?sheets=` — only those this role may print and whose
 * module is on — each on its own A4 page with the letterhead and the same
 * patient strip. Each sheet module adds its own pages.
 *
 * Day sheets (the T.P.R. chart) print `?day=` only, or — with no day — every
 * day of the stay that has something on it. `?blank=1` with a day prints an
 * empty sheet for the paper fallback.
 *
 * Every print is logged, without the de-duplication a screen view gets.
 */
export default async function PatientFilePrintPage({ params, searchParams }: PageProps<'/print/ipd-file/[admissionId]'>) {
  const session = await requireSession();
  if (session.mustChangePassword) redirect('/change-password');
  if (!can(session.role, 'ipd.view')) notFound();
  const states = await requireModule(session, 'patient_file');
  const { admissionId } = await params;
  const query = await searchParams;

  const admission = await getAdmissionSummary(session.hospitalId, admissionId);
  if (!admission) notFound();

  const allowed = printSheetsFor(states, session.role);
  const asked = typeof query.sheets === 'string' ? query.sheets.split(',') : [];
  const sheets = allowed.filter((sheet) => asked.length === 0 || asked.includes(sheet.id));
  if (sheets.length === 0) notFound();

  const letterhead = await getLetterhead(session.hospitalId, admission.branchId);
  await logRecordAccess({
    hospitalId: session.hospitalId,
    actorUserId: session.userId,
    patientId: admission.patientId,
    encounterId: admission.encounterId,
    action: 'print_ipd_file',
  });

  // T.P.R. chart pages: one day, or each day of the stay with something charted or given.
  let tprDays: { date: string; day: TprDay | null }[] = [];
  if (sheets.some((sheet) => sheet.id === 'tpr')) {
    const today = chartDayOf(new Date(), session.timezone);
    const asked = typeof query.day === 'string' && isChartDay(query.day) ? query.day : null;
    if (asked && query.blank === '1') {
      tprDays = [{ date: asked, day: null }];
    } else {
      const first = admission.admittedAt ? chartDayOf(admission.admittedAt, session.timezone) : today;
      const last = admission.dischargedAt ? chartDayOf(admission.dischargedAt, session.timezone) : today;
      const days = await getTprDays({
        hospitalId: session.hospitalId,
        admissionId,
        fromDay: asked ?? first,
        toDay: asked ?? (last < today ? last : today),
        timezone: session.timezone,
      });
      const withData = asked ? days : days.filter((d) => d.readings.length + d.voided.length + d.treatment.length > 0);
      tprDays = withData.length > 0 ? withData.map((d) => ({ date: d.day, day: d })) : [{ date: asked ?? today, day: null }];
    }
  }

  const patient: SheetPatient = {
    name: admission.patientName,
    age: admission.age,
    gender: admission.gender,
    ipdNumber: admission.ipdNumber,
    mrn: admission.mrn,
    wardBed: admission.bed ? `${admission.bed.wardName} · Bed ${admission.bed.label}` : null,
    admittedAt: admission.admittedAt,
    doctorName: admission.doctorName,
  };

  return (
    <main className="min-h-dvh bg-ink-100 py-8 print:bg-white print:py-0">
      <style>
        {
          '@page { size: A4; margin: 12mm 12mm 14mm; } @page tpr { size: A4 landscape; margin: 8mm 10mm; } .tpr-page { page: tpr; } .sheet + .sheet { break-before: page; }'
        }
      </style>
      <div className={tprDays.length > 0 ? 'mx-auto max-w-[297mm] print:max-w-none' : 'mx-auto max-w-[210mm] print:max-w-none'}>
        <PrintControls autoPrint={query.print !== '0'} />
        {sheets.map((sheet) =>
          sheet.id === 'tpr' ? (
            tprDays.map(({ date, day }) => (
              <TprSheetPages
                key={`tpr-${date}`}
                day={day}
                date={date}
                letterhead={letterhead}
                patient={patient}
                timezone={session.timezone}
              />
            ))
          ) : (
            <article
              key={sheet.id}
              className="sheet mb-6 bg-white p-10 text-[12px] leading-snug text-ink-900 shadow-sm print:mb-0 print:p-0 print:shadow-none"
            >
              <PrintLetterhead letterhead={letterhead} title={sheet.label} />
              <PrintSheetHeader patient={patient} timezone={session.timezone} />
              {sheet.id === 'cover' ? <CoverSheet admission={admission} timezone={session.timezone} /> : null}
            </article>
          ),
        )}
      </div>
    </main>
  );
}

const STATUS_LABELS: Record<AdmissionSummary['status'], string> = {
  awaiting_bed: 'Awaiting bed',
  admitted: 'Admitted',
  discharge_ready: 'Ready for discharge',
  discharged: 'Discharged',
  cancelled: 'Cancelled',
};

/** The admission form's facts that the record already holds. */
function CoverSheet({ admission, timezone }: { admission: AdmissionSummary; timezone: string }) {
  const dateTime = (at: Date | null) =>
    at
      ? at.toLocaleString('en-IN', {
          day: '2-digit',
          month: 'short',
          year: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
          timeZone: timezone,
        })
      : '—';
  const payer = admission.payer
    ? [
        PAYER_KIND_LABELS[admission.payer.kind],
        admission.payer.payerName,
        admission.payer.policyNumber ? `Policy ${admission.payer.policyNumber}` : null,
        admission.payer.preauthAmountPaise ? `Pre-auth ${formatRupees(admission.payer.preauthAmountPaise)}` : null,
      ]
        .filter(Boolean)
        .join(' · ')
    : 'Self';

  const rows: [string, string][] = [
    ['Phone', formatIndianPhone(admission.phoneE164)],
    ['Address', admission.address ?? '—'],
    ['Reason for admission', admission.reason ?? '—'],
    ['Admission requested', dateTime(admission.requestedAt)],
    ['Admitted', dateTime(admission.admittedAt)],
    ['Discharged', dateTime(admission.dischargedAt)],
    ['Status', STATUS_LABELS[admission.status]],
    ['Payer', payer],
  ];

  return (
    <table className="mt-3 w-full border-collapse">
      <tbody>
        {rows.map(([label, value]) => (
          <tr key={label} className="border-b border-ink-200">
            <th scope="row" className="w-1/3 py-2 pr-4 text-left font-semibold text-ink-700">
              {label}
            </th>
            <td className="numeric py-2">{value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
