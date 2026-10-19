import { PrintLetterhead } from '@/components/print/letterhead';
import type { Letterhead } from '@/lib/domain/letterhead';
import type { AdmissionSummary } from '@/lib/services/ipd-census';
import { formatIndianPhone } from '@/lib/domain/phone';
import { toTitleCase } from '@/lib/domain/doctor';

export interface DynamicAdmissionSheetProps {
  admission: AdmissionSummary;
  letterhead: Letterhead;
}

export function DynamicAdmissionSheet({ admission, letterhead }: DynamicAdmissionSheetProps) {
  const formattedDobOrAge = admission.age ? `${admission.age} Yrs` : '—';
  const sexLabel = admission.gender ? toTitleCase(admission.gender) : '—';
  const doa = admission.admittedAt || admission.requestedAt;
  const formattedDoa = new Date(doa).toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });

  return (
    <article className="sheet admission-sheet bg-white p-6 text-ink-950 font-sans text-xs leading-normal">
      {/* Hospital Letterhead */}
      <PrintLetterhead letterhead={letterhead} title="INPATIENT ADMISSION RECORD / आंतररुग्ण प्रवेश नोंद" />

      {/* Top Core Metrics Grid */}
      <div className="mt-4 grid grid-cols-4 border border-ink-900 divide-x divide-ink-900 text-center font-mono">
        <div className="p-2">
          <p className="text-[10px] uppercase font-bold text-ink-600">IPD / Adm. No.</p>
          <p className="font-bold text-sm text-ink-950">
            {admission.admissionNumber || (admission.ipdNumber ? `IPD #${admission.ipdNumber}` : '—')}
          </p>
        </div>
        <div className="p-2">
          <p className="text-[10px] uppercase font-bold text-ink-600">OPD / QID No.</p>
          <p className="font-bold text-sm text-ink-950">{admission.qid || admission.mrn || '—'}</p>
        </div>
        <div className="p-2">
          <p className="text-[10px] uppercase font-bold text-ink-600">Date & Time of Adm.</p>
          <p className="font-bold text-xs text-ink-950">{formattedDoa}</p>
        </div>
        <div className="p-2">
          <p className="text-[10px] uppercase font-bold text-ink-600">Ward & Bed</p>
          <p className="font-bold text-xs text-ink-950">
            {admission.bed ? `Bed ${admission.bed.label} (${admission.bed.wardName})` : 'Awaiting Bed'}
          </p>
        </div>
      </div>

      {/* MLC Banner if Applicable */}
      {admission.isMlc ? (
        <div className="mt-2 border-2 border-red-700 bg-red-50 p-2 text-red-950">
          <div className="flex items-center justify-between font-bold text-xs">
            <span className="text-red-700">MEDICO-LEGAL CASE (MLC) · फॉरेन्सिक/कायदेशीर प्रकरण</span>
            <span>MLC No: {admission.mlcNumber || 'Pending'}</span>
          </div>
          <div className="mt-1 grid grid-cols-3 text-[11px] gap-2">
            <div>Police Station: <span className="font-semibold">{admission.policeStationName || '—'}</span></div>
            <div>Intimation: <span className="font-semibold">{admission.policeIntimationMode || '—'}</span></div>
            <div>Officer/Buckle: <span className="font-semibold">{[admission.constableName, admission.constableBuckleNo].filter(Boolean).join(' / ') || '—'}</span></div>
          </div>
        </div>
      ) : null}

      {/* Section 1: Demographics */}
      <section className="mt-3">
        <h2 className="bg-ink-100 px-2 py-1 font-bold text-[11px] uppercase border border-ink-400">
          1. Patient Demographics / रुग्णाची माहिती
        </h2>
        <table className="w-full border-collapse border border-t-0 border-ink-300 text-xs">
          <tbody>
            <tr className="border-b border-ink-200">
              <td className="w-1/4 p-2 font-semibold text-ink-700 bg-ink-50/50">Patient Full Name:</td>
              <td className="w-3/4 p-2 font-bold text-sm text-ink-950" colSpan={3}>
                {admission.patientName.toUpperCase()}
              </td>
            </tr>
            <tr className="border-b border-ink-200">
              <td className="w-1/4 p-2 font-semibold text-ink-700 bg-ink-50/50">Age / Sex:</td>
              <td className="w-1/4 p-2 font-medium">{formattedDobOrAge} / {sexLabel}</td>
              <td className="w-1/4 p-2 font-semibold text-ink-700 bg-ink-50/50">Contact Mobile:</td>
              <td className="w-1/4 p-2 font-mono font-medium">{formatIndianPhone(admission.phoneE164)}</td>
            </tr>
            <tr className="border-b border-ink-200">
              <td className="w-1/4 p-2 font-semibold text-ink-700 bg-ink-50/50">Residential Address:</td>
              <td className="w-3/4 p-2" colSpan={3}>{admission.address || '—'}</td>
            </tr>
            <tr>
              <td className="w-1/4 p-2 font-semibold text-ink-700 bg-ink-50/50">Billing Category / Payer:</td>
              <td className="w-1/4 p-2 font-medium">
                {admission.payer?.kind === 'insurer' || admission.payer?.kind === 'tpa'
                  ? `Insurance (${admission.payer.payerName || 'TPA'})`
                  : 'Self-Pay / Cash'}
              </td>
              <td className="w-1/4 p-2 font-semibold text-ink-700 bg-ink-50/50">Admission Urgency:</td>
              <td className="w-1/4 p-2 font-bold uppercase">
                {admission.urgency === 'emergency' ? 'EMERGENCY' : 'Routine / Planned'}
              </td>
            </tr>
          </tbody>
        </table>
      </section>

      {/* Section 2: Clinical Details */}
      <section className="mt-3">
        <h2 className="bg-ink-100 px-2 py-1 font-bold text-[11px] uppercase border border-ink-400">
          2. Clinical Details / वैद्यकीय माहिती
        </h2>
        <table className="w-full border-collapse border border-t-0 border-ink-300 text-xs">
          <tbody>
            <tr className="border-b border-ink-200">
              <td className="w-1/4 p-2 font-semibold text-ink-700 bg-ink-50/50">Consultant In-Charge:</td>
              <td className="w-3/4 p-2 font-bold text-ink-950" colSpan={3}>
                Dr. {admission.doctorName}
              </td>
            </tr>
            <tr className="border-b border-ink-200">
              <td className="w-1/4 p-2 font-semibold text-ink-700 bg-ink-50/50">Provisional Diagnosis:</td>
              <td className="w-3/4 p-2 font-semibold text-ink-900" colSpan={3}>
                {admission.reason || 'Clinical observation & active inpatient management'}
              </td>
            </tr>
            <tr>
              <td className="w-1/4 p-2 font-semibold text-ink-700 bg-ink-50/50">Advised Ward Category:</td>
              <td className="w-1/4 p-2 font-medium capitalize">{admission.advisedWardKind || 'General'}</td>
              <td className="w-1/4 p-2 font-semibold text-ink-700 bg-ink-50/50">Est. Duration of Stay:</td>
              <td className="w-1/4 p-2 font-medium">
                {admission.estimatedStayDays ? `${admission.estimatedStayDays} Days` : 'As advised by doctor'}
              </td>
            </tr>
          </tbody>
        </table>
      </section>

      {/* Section 3: Relative / Attendant */}
      <section className="mt-3">
        <h2 className="bg-ink-100 px-2 py-1 font-bold text-[11px] uppercase border border-ink-400">
          3. Next of Kin / Attendant Particulars / नातेवाईकाचा तपशील
        </h2>
        <table className="w-full border-collapse border border-t-0 border-ink-300 text-xs">
          <tbody>
            <tr className="border-b border-ink-200">
              <td className="w-1/4 p-2 font-semibold text-ink-700 bg-ink-50/50">Attendant Name:</td>
              <td className="w-1/4 p-2 font-bold">{admission.attendant?.name || '—'}</td>
              <td className="w-1/4 p-2 font-semibold text-ink-700 bg-ink-50/50">Relationship to Patient:</td>
              <td className="w-1/4 p-2 font-medium">{admission.attendant?.relation || '—'}</td>
            </tr>
            <tr>
              <td className="w-1/4 p-2 font-semibold text-ink-700 bg-ink-50/50">Contact Phone:</td>
              <td className="w-1/4 p-2 font-mono font-medium">
                {admission.attendant?.phoneE164 ? formatIndianPhone(admission.attendant.phoneE164) : '—'}
              </td>
              <td className="w-1/4 p-2 font-semibold text-ink-700 bg-ink-50/50">Attendant Address:</td>
              <td className="w-1/4 p-2">{admission.attendant?.address || 'Same as patient'}</td>
            </tr>
          </tbody>
        </table>
      </section>

      {/* Section 4: Advance Payment */}
      <section className="mt-3">
        <h2 className="bg-ink-100 px-2 py-1 font-bold text-[11px] uppercase border border-ink-400">
          4. Advance Deposit / आगाऊ अनामत रक्कम
        </h2>
        <table className="w-full border-collapse border border-t-0 border-ink-300 text-xs">
          <tbody>
            <tr>
              <td className="w-1/4 p-2 font-semibold text-ink-700 bg-ink-50/50">Advance Deposited:</td>
              <td className="w-1/4 p-2 font-bold text-ink-950 font-mono">
                {admission.deposit ? `₹${(admission.deposit.amountPaise / 100).toLocaleString('en-IN')}` : 'Nil / Waived'}
              </td>
              <td className="w-1/4 p-2 font-semibold text-ink-700 bg-ink-50/50">Receipt Number / Mode:</td>
              <td className="w-1/4 p-2 font-mono">
                {admission.deposit?.receiptNumber
                  ? `${admission.deposit.receiptNumber} (${(admission.deposit.method || 'cash').toUpperCase()})`
                  : '—'}
              </td>
            </tr>
          </tbody>
        </table>
      </section>

      {/* Declaration & Signatures */}
      <footer className="mt-6 pt-4 border-t border-ink-400 text-xs">
        <p className="text-[11px] text-ink-600 italic">
          Declaration: I hereby verify that all the information furnished above is accurate to the best of my knowledge. I agree to abide by the hospital rules, visiting hours, and payment schedule.
        </p>
        <div className="mt-12 grid grid-cols-3 gap-6 text-center text-xs">
          <div className="border-t border-ink-800 pt-2 font-bold">
            Patient / Relative Signature
            <p className="text-[10px] font-normal text-ink-500">(रुग्ण / नातेवाईकाची स्वाक्षरी)</p>
          </div>
          <div className="border-t border-ink-800 pt-2 font-bold">
            Admission Desk Staff
            <p className="text-[10px] font-normal text-ink-500">(प्रवेश कक्षातील कर्मचारी)</p>
          </div>
          <div className="border-t border-ink-800 pt-2 font-bold">
            Admitting Consultant
            <p className="text-[10px] font-normal text-ink-500">(सल्लागार डॉक्टरांची स्वाक्षरी)</p>
          </div>
        </div>
      </footer>
    </article>
  );
}
