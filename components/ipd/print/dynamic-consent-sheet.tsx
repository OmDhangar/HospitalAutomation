import { PrintLetterhead } from '@/components/print/letterhead';
import type { Letterhead } from '@/lib/domain/letterhead';
import type { AdmissionSummary } from '@/lib/services/ipd-census';
import { formatIndianPhone } from '@/lib/domain/phone';

export interface DynamicConsentSheetProps {
  admission: AdmissionSummary;
  letterhead: Letterhead;
}

export function DynamicConsentSheet({ admission, letterhead }: DynamicConsentSheetProps) {
  const signerName = admission.consent?.signerName || admission.attendant?.name || admission.patientName;
  const signerRelation = admission.consent?.signerRelationship || admission.attendant?.relation || 'Relative';
  const obtainedDate = admission.consent?.obtainedAt
    ? new Date(admission.consent.obtainedAt).toLocaleString('en-IN', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: true,
      })
    : new Date().toLocaleString('en-IN', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: true,
      });

  return (
    <article className="sheet consent-sheet bg-white p-6 text-ink-950 font-sans text-xs leading-normal">
      {/* Hospital Letterhead */}
      <PrintLetterhead
        letterhead={letterhead}
        title="INFORMED ADMISSION & HIGH-RISK CONSENT / संमती व हमीपत्र"
      />

      {/* Patient Header Identification Strip */}
      <div className="mt-3 border border-ink-800 bg-ink-50/60 p-2 text-xs">
        <div className="grid grid-cols-3 gap-2">
          <div>
            <span className="text-ink-600 font-semibold">Patient Name:</span>{' '}
            <strong className="text-ink-950">{admission.patientName.toUpperCase()}</strong>
          </div>
          <div>
            <span className="text-ink-600 font-semibold">IPD / Adm. No:</span>{' '}
            <strong className="font-mono">{admission.admissionNumber || (admission.ipdNumber ? `IPD #${admission.ipdNumber}` : '—')}</strong>
          </div>
          <div>
            <span className="text-ink-600 font-semibold">Ward & Bed:</span>{' '}
            <strong>{admission.bed ? `Bed ${admission.bed.label} (${admission.bed.wardName})` : 'Awaiting Bed'}</strong>
          </div>
        </div>
        <div className="mt-1 grid grid-cols-3 gap-2 text-[11px]">
          <div>
            <span className="text-ink-600">Age / Sex:</span> {admission.age ? `${admission.age} Yrs` : '—'} / {admission.gender || '—'}
          </div>
          <div>
            <span className="text-ink-600">Admitting Consultant:</span> Dr. {admission.doctorName}
          </div>
          <div>
            <span className="text-ink-600">Provisional Diagnosis:</span> {admission.reason || 'Medical / Critical Care'}
          </div>
        </div>
      </div>

      {/* Dual Language Legal Consent Clause */}
      <div className="mt-4 space-y-3">
        {/* Marathi Clause */}
        <div className="border border-ink-300 rounded-lg p-3 bg-white">
          <h3 className="font-bold text-[11px] uppercase tracking-wide text-ink-800 mb-1 border-b border-ink-200 pb-1">
            मराठी संमती मजकूर (Patient / Relative Declaration in Marathi)
          </h3>
          <p className="text-[11px] leading-relaxed text-ink-900 text-justify">
            मी / आम्ही खाली सही करणारे श्री/श्रीमती <strong>{signerName}</strong> (नाते: <strong>{signerRelation}</strong>), अशी स्वेच्छेने संमती देतो/देते की, मी माझ्या रुग्णास उपचारासाठी या रुग्णालयात दाखल करत आहे. डॉक्टरांनी मला रुग्णाच्या आजाराचे गांभीर्य, स्वरूप, उपचारांची दिशा व त्यातील संभाव्य धोके माझ्या मातृभाषेत नीट समजावून सांगितले आहेत. अतिदक्षता विभागात (ICU) किंवा वॉर्डात उपचार सुरू असताना अचानक उद्भवू शकणाऱ्या कोणत्याही वैद्यकीय गुंतागुंतींची मला पूर्ण जाणीव आहे. आपत्कालीन किंवा गंभीर परिस्थितीत डॉक्टरांनी रुग्णाच्या हितासाठी आवश्यक ते सर्व जीवनरक्षक उपचार, औषधोपचार, रक्तसंक्रमण व आणीबाणीच्या प्रक्रिया करण्यास माझी/आमची पूर्ण संमती आहे.
          </p>
        </div>

        {/* English Clause */}
        <div className="border border-ink-300 rounded-lg p-3 bg-white">
          <h3 className="font-bold text-[11px] uppercase tracking-wide text-ink-800 mb-1 border-b border-ink-200 pb-1">
            English Consent Statement & High-Risk Authorization
          </h3>
          <p className="text-[11px] leading-relaxed text-ink-900 text-justify">
            I/We the undersigned, <strong>{signerName}</strong>, being the patient / authorized next-of-kin (relationship: <strong>{signerRelation}</strong>), hereby accord voluntary, informed consent for the admission and complete clinical management of the patient named herein. The attending doctor and medical staff have lucidly explained the preliminary diagnosis, potential risks, adverse events, invasive monitoring, and therapeutic interventions in a language understood by me. I recognize that medicine is not an exact science and despite all professional competence and standard protocol, unexpected complications or adverse reactions can occur. I authorize the clinical and nursing team to administer necessary medicines, infusions, and critical emergency procedures.
          </p>
        </div>
      </div>

      {/* Doctor Explanation Stamp */}
      <div className="mt-3 border border-ink-400 bg-amber-50/40 p-2.5 rounded-lg text-xs">
        <h4 className="font-bold text-ink-900 text-[11px] uppercase">
          Doctor Explanation & Counselling Certification / डॉक्टरांचे प्रमाणीकरण
        </h4>
        <p className="mt-0.5 text-[11px] text-ink-700">
          I confirm that I have personally explained the diagnosis, nature of the illness, critical risks, and treatment options to the patient / relative in their primary language. All doubts raised were clarified.
        </p>
        <div className="mt-3 flex items-center justify-between text-xs font-semibold">
          <div>Consultant: Dr. {admission.doctorName}</div>
          <div>Date & Time: {obtainedDate}</div>
          <div className="border-t border-ink-800 pt-1 px-4 text-center">Doctor Signature & Stamp</div>
        </div>
      </div>

      {/* Attestation & Signatures Grid */}
      <div className="mt-5 border-t border-ink-400 pt-4">
        <div className="grid grid-cols-3 gap-6 text-center text-xs">
          {/* Attendant Sign */}
          <div className="flex flex-col justify-end">
            <div className="border-t border-ink-800 pt-1">
              <p className="font-bold">{signerName}</p>
              <p className="text-[10px] text-ink-600">
                Patient / Relative Signature (स्वाक्षरी / अंगठा)
              </p>
              <p className="text-[10px] text-ink-500 font-mono">
                Phone: {admission.attendant?.phoneE164 ? formatIndianPhone(admission.attendant.phoneE164) : formatIndianPhone(admission.phoneE164)}
              </p>
            </div>
          </div>

          {/* Witness */}
          <div className="flex flex-col justify-end">
            <div className="border-t border-ink-800 pt-1">
              <p className="font-bold text-ink-400">________________________</p>
              <p className="font-bold mt-1">Witness Signature</p>
              <p className="text-[10px] text-ink-600">साक्षीदाराची स्वाक्षरी व नाव</p>
            </div>
          </div>

          {/* Admission Staff / Integrity Hash */}
          <div className="flex flex-col justify-end">
            <div className="border-t border-ink-800 pt-1">
              <p className="font-bold">Admission Desk Staff</p>
              <p className="text-[10px] text-ink-600">दस्तऐवज नोंदणी कर्मचारी</p>
              <p className="text-[10px] text-emerald-800 font-bold mt-0.5">
                {admission.consent?.status === 'obtained' || admission.consent?.status === 'attested_paper'
                  ? '✓ Physical Signed Paper Verified & Archived'
                  : 'Pending Physical Attestation'}
              </p>
            </div>
          </div>
        </div>
      </div>
    </article>
  );
}
