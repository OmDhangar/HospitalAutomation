import { notFound, redirect } from 'next/navigation';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { requireSession } from '@/lib/auth/session';
import { withTenant } from '@/lib/db';
import {
  admissions,
  bedAssignments,
  beds,
  encounters,
  patientPayments,
  patients,
  users,
  wards,
} from '@/lib/db/schema';
import { getLetterhead } from '@/lib/services/letterhead';
import { logRecordAccess } from '@/lib/services/record-access';
import { PrintLetterhead } from '@/components/print/letterhead';
import { PrintControls } from '@/app/print/prescription/[id]/print-controls';
import { numberToIndianRupeesInWords } from '@/lib/domain/currency';
import { formatIndianPhone } from '@/lib/domain/phone';

export const metadata = { title: 'Advance Deposit Receipt' };

export default async function DepositReceiptPrintPage({
  params,
  searchParams,
}: {
  params: Promise<{ paymentId: string }>;
  searchParams: Promise<{ autoprint?: string }>;
}) {
  const session = await requireSession();
  if (session.mustChangePassword) redirect('/change-password');

  const { paymentId } = await params;
  const query = await searchParams;

  const data = await withTenant(
    session.hospitalId,
    async (tx) => {
      const [payment] = await tx
        .select({
          paymentId: patientPayments.id,
          amountPaise: patientPayments.amountPaise,
          method: patientPayments.method,
          reference: patientPayments.reference,
          receivedAt: patientPayments.receivedAt,
          encounterId: patientPayments.encounterId,
          patientId: patientPayments.patientId,
          receivedByUserName: users.name,
        })
        .from(patientPayments)
        .leftJoin(users, eq(users.id, patientPayments.receivedByUserId))
        .where(
          and(
            eq(patientPayments.hospitalId, session.hospitalId),
            eq(patientPayments.id, paymentId),
            isNull(patientPayments.voidedAt),
          ),
        );

      if (!payment) return null;

      const [patient] = await tx
        .select({
          name: patients.name,
          age: patients.age,
          gender: patients.gender,
          mrn: patients.mrn,
          qid: patients.qid,
          phoneE164: patients.phoneE164,
          address: patients.address,
        })
        .from(patients)
        .where(eq(patients.id, payment.patientId));

      const [admission] = await tx
        .select({
          admissionId: admissions.id,
          admissionNumber: admissions.admissionNumber,
          ipdNumber: admissions.ipdNumber,
          branchId: admissions.branchId,
        })
        .from(admissions)
        .where(eq(admissions.encounterId, payment.encounterId))
        .limit(1);

      let bedDetails: { label: string; wardName: string } | null = null;
      if (admission) {
        const [bed] = await tx
          .select({ label: beds.label, wardName: wards.name })
          .from(bedAssignments)
          .innerJoin(beds, eq(beds.id, bedAssignments.bedId))
          .innerJoin(wards, eq(wards.id, beds.wardId))
          .where(eq(bedAssignments.admissionId, admission.admissionId))
          .orderBy(sql`${bedAssignments.toAt} is null desc`, sql`${bedAssignments.fromAt} desc`)
          .limit(1);
        if (bed) bedDetails = bed;
      }

      return { payment, patient, admission, bedDetails };
    },
    { clinical: true },
  );

  if (!data || !data.patient) notFound();

  const { payment, patient, admission, bedDetails } = data;
  const branchId = admission?.branchId || session.branchId || '';
  const letterhead = await getLetterhead(session.hospitalId, branchId);

  await logRecordAccess({
    hospitalId: session.hospitalId,
    actorUserId: session.userId,
    patientId: payment.patientId,
    encounterId: payment.encounterId,
    action: 'print_ipd_bill',
  });

  const autoPrint = query.autoprint !== '0';
  const amountRupees = payment.amountPaise / 100;
  const amountWords = numberToIndianRupeesInWords(amountRupees);
  const formattedDate = new Date(payment.receivedAt).toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });

  return (
    <div className="min-h-screen bg-ink-100 py-6 print:bg-white print:py-0">
      <div className="mx-auto max-w-[210mm]">
        {/* Print / Close controls */}
        <PrintControls autoPrint={autoPrint} />

        {/* Receipt Container */}
        <article className="sheet bg-white p-6 shadow-lg print:shadow-none text-ink-950 font-sans text-xs">
          {/* Hospital Letterhead */}
          <PrintLetterhead
            letterhead={letterhead}
            title="ADVANCE DEPOSIT RECEIPT / आगाऊ अनामत पावती"
          />

          {/* Receipt Meta Bar */}
          <div className="mt-4 flex items-center justify-between border-b-2 border-ink-900 pb-2">
            <div>
              <p className="text-[11px] font-bold uppercase text-ink-600">Receipt No.</p>
              <p className="font-mono text-base font-extrabold text-ink-950">
                {payment.reference || `REC-${payment.paymentId.slice(0, 8).toUpperCase()}`}
              </p>
            </div>
            <div className="text-right">
              <p className="text-[11px] font-bold uppercase text-ink-600">Date & Time</p>
              <p className="font-mono text-xs font-bold text-ink-900">{formattedDate}</p>
            </div>
          </div>

          {/* Patient Details */}
          <div className="mt-4 grid grid-cols-2 gap-4 rounded-lg border border-ink-300 p-3 bg-ink-50/40">
            <div className="space-y-1">
              <p>
                <span className="text-ink-600 font-semibold">Patient Name:</span>{' '}
                <strong className="text-ink-950 text-sm">{patient.name.toUpperCase()}</strong>
              </p>
              <p className="text-[11px]">
                <span className="text-ink-600 font-semibold">Age / Sex:</span>{' '}
                {patient.age ? `${patient.age} Yrs` : '—'} / {patient.gender || '—'}
              </p>
              <p className="text-[11px]">
                <span className="text-ink-600 font-semibold">Phone:</span>{' '}
                <span className="font-mono">{formatIndianPhone(patient.phoneE164)}</span>
              </p>
            </div>

            <div className="space-y-1 text-right">
              <p>
                <span className="text-ink-600 font-semibold">IPD / Adm No:</span>{' '}
                <strong className="font-mono text-ink-950">
                  {admission?.admissionNumber || (admission?.ipdNumber ? `IPD #${admission.ipdNumber}` : '—')}
                </strong>
              </p>
              <p className="text-[11px]">
                <span className="text-ink-600 font-semibold">OPD / QID:</span>{' '}
                <span className="font-mono">{patient.qid || patient.mrn || '—'}</span>
              </p>
              <p className="text-[11px]">
                <span className="text-ink-600 font-semibold">Ward & Bed:</span>{' '}
                <strong>{bedDetails ? `Bed ${bedDetails.label} (${bedDetails.wardName})` : 'Awaiting Bed'}</strong>
              </p>
            </div>
          </div>

          {/* Payment Particulars Table */}
          <div className="mt-5">
            <table className="w-full border-collapse border border-ink-800 text-xs">
              <thead>
                <tr className="bg-ink-100 border-b border-ink-800 text-ink-900 font-bold uppercase text-[11px]">
                  <th className="p-2.5 text-left">Sr.</th>
                  <th className="p-2.5 text-left">Particulars / विवरण</th>
                  <th className="p-2.5 text-center">Payment Mode</th>
                  <th className="p-2.5 text-right">Amount (₹)</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-b border-ink-300">
                  <td className="p-2.5 text-center font-mono">1</td>
                  <td className="p-2.5">
                    <p className="font-bold text-ink-950">Advance Deposit for IPD Admission</p>
                    <p className="text-[11px] text-ink-500">आंतररुग्ण विभाग प्रवेश आगाऊ अनामत रक्कम</p>
                  </td>
                  <td className="p-2.5 text-center font-mono font-bold uppercase">
                    {payment.method}
                  </td>
                  <td className="p-2.5 text-right font-mono font-bold text-sm">
                    ₹{amountRupees.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                  </td>
                </tr>
                {/* Total row */}
                <tr className="bg-ink-50/80 font-bold text-ink-950">
                  <td className="p-2.5 text-right uppercase" colSpan={3}>
                    Total Amount Received / एकूण मिळालेली रक्कम:
                  </td>
                  <td className="p-2.5 text-right font-mono text-base font-extrabold text-brand-900">
                    ₹{amountRupees.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          {/* Amount in words */}
          <div className="mt-3 rounded-md border border-ink-300 bg-white p-2.5 text-xs">
            <span className="text-ink-600 font-semibold">Amount in Words:</span>{' '}
            <strong className="text-ink-950 italic">{amountWords}</strong>
          </div>

          {/* Footer & Signatures */}
          <footer className="mt-12 pt-4 border-t border-ink-400 text-xs">
            <div className="flex items-end justify-between">
              <div>
                <p className="text-[11px] text-ink-600">
                  Received By: <strong className="text-ink-900">{payment.receivedByUserName || session.name}</strong>
                </p>
                <p className="text-[10px] text-ink-500 mt-0.5">
                  This deposit will be credited against the patient's final hospital discharge bill.
                </p>
              </div>

              <div className="text-center">
                <div className="w-48 border-t border-ink-800 pt-1 font-bold">
                  Authorized Cashier / Signatory
                  <p className="text-[10px] font-normal text-ink-500">(अधिकृत रोखपाल / सही व शिक्का)</p>
                </div>
              </div>
            </div>
          </footer>
        </article>
      </div>
    </div>
  );
}
