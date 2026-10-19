'use client';

import { useMemo, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AlertCircleIcon, BedIcon, CheckIcon, ClockIcon, SearchIcon, XIcon } from '@/components/icons';
import { Alert, Button, Card, cn } from '@/components/ui';
import { BedPicker } from '@/components/ipd/bed-picker';
import { formatIndianPhone } from '@/lib/domain/phone';
import { executePatientIntakeAction } from '@/app/(app)/ipd/actions';
import { IntakeSmartSearch } from './intake-smart-search';
import { IntakeStickySidebar, type IntakeChecklistState } from './intake-sticky-sidebar';
import { IntakeSuccessModal } from './intake-success-modal';
import type { FreeWard } from '@/components/ipd/bed-picker';

export interface DoctorOption {
  id: string;
  name: string;
  active?: boolean;
}

export interface UnifiedIntakeFormProps {
  mode: 'opd_prefilled' | 'direct';
  branchId: string;
  freeWards: FreeWard[];
  doctors: DoctorOption[];
  preselectedBedId?: string | null;
  // For OPD-prefilled mode
  initialAdmission?: {
    admissionId: string;
    patientId: string;
    patientName: string;
    phoneE164: string;
    age: number | null;
    gender: string | null;
    address?: string | null;
    mrn?: string | null;
    qid?: string | null;
    doctorId: string;
    doctorName: string;
    urgency?: 'emergency' | 'same_day' | 'planned' | null;
    advisedWardKind?: 'general' | 'special' | 'hdu' | 'icu' | null;
    reason?: string | null;
    receptionNotes?: string | null;
  } | null;
}

const DEFAULT_GENERAL_CONSENT_MR = `मी खालील सही करणार रुग्ण / रुग्णाचा नातेवाईक, याद्वारे संमती देतो/देते की वरील नमूद रुग्णास उपचारासाठी रुग्णालयात दाखल करण्यात येत आहे. मला डॉक्टरांनी आजाराचे स्वरूप, संभाव्य धोके आणि उपचारांची माहिती समजावून सांगितली आहे. मी रुग्णालयाचे नियम पाळण्यास आणि बिलाची वेळेवर पूर्तता करण्यास बांधील आहे.`;
const DEFAULT_GENERAL_CONSENT_EN = `I, the undersigned patient / legal relative, hereby give consent for admission and medical treatment. The admitting physician has explained the nature of the condition, potential risks, and proposed management. I agree to comply with hospital policies and settle all charges.`;

export function UnifiedIntakeForm({
  mode,
  branchId,
  freeWards,
  doctors,
  preselectedBedId,
  initialAdmission,
}: UnifiedIntakeFormProps) {
  const router = useRouter();
  const [isSubmitting, startSubmit] = useTransition();
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successResult, setSuccessResult] = useState<any | null>(null);

  // 1. Patient State
  const [selectedPatient, setSelectedPatient] = useState<{
    id?: string;
    name: string;
    phoneE164: string;
    age: number | null;
    gender: string | null;
    address: string | null;
    mrn: string | null;
    qid: string | null;
  } | null>(() => {
    if (mode === 'opd_prefilled' && initialAdmission) {
      return {
        id: initialAdmission.patientId,
        name: initialAdmission.patientName,
        phoneE164: initialAdmission.phoneE164,
        age: initialAdmission.age,
        gender: initialAdmission.gender,
        address: initialAdmission.address ?? null,
        mrn: initialAdmission.mrn ?? null,
        qid: initialAdmission.qid ?? null,
      };
    }
    return null;
  });

  // Manual new patient inputs if not selected from smart search
  const [manualName, setManualName] = useState('');
  const [manualPhone, setManualPhone] = useState('');
  const [manualAge, setManualAge] = useState<number | ''>('');
  const [manualGender, setManualGender] = useState<'male' | 'female' | 'other'>('male');
  const [manualAddress, setManualAddress] = useState('');

  // 2. Consultant & Bed State
  const [doctorId, setDoctorId] = useState<string>(() => {
    if (initialAdmission?.doctorId) return initialAdmission.doctorId;
    return doctors[0]?.id ?? '';
  });
  const [urgency, setUrgency] = useState<'emergency' | 'same_day' | 'planned'>(
    initialAdmission?.urgency ?? 'same_day',
  );
  const [selectedBedId, setSelectedBedId] = useState<string | null>(preselectedBedId ?? null);
  const [reason, setReason] = useState(initialAdmission?.reason ?? '');

  // Physical Ward Arrival
  const [patientArrived, setPatientArrived] = useState(true);
  const [arrivedAtTime, setArrivedAtTime] = useState<string>(() => {
    const d = new Date();
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  });
  const [arrivalBackdateReason, setArrivalBackdateReason] = useState('');

  // 3. Attendant & Contact State
  const [attendantName, setAttendantName] = useState('');
  const [attendantRelation, setAttendantRelation] = useState('Son');
  const [attendantPhone, setAttendantPhone] = useState('');
  const [attendantAddress, setAttendantAddress] = useState('');
  const [isFinancialGuarantor, setIsFinancialGuarantor] = useState(true);

  // 4. Versioned Consent State
  const [consentTemplate, setConsentTemplate] = useState<'general' | 'high_risk' | 'surgery'>('general');
  const [consentLang, setConsentLang] = useState<'mr' | 'en'>('mr');
  const [isPaperConsentAttested, setIsPaperConsentAttested] = useState(false);
  const [consentSignatoryRelation, setConsentSignatoryRelation] = useState('Self');

  // 5. Financial / Deposit State
  const [payerType, setPayerType] = useState<'self_pay' | 'insurance_tpa' | 'ayushman' | 'corporate'>('self_pay');
  const [depositAmountRupees, setDepositAmountRupees] = useState<number | ''>(5000);
  const [depositPaymentMode, setDepositPaymentMode] = useState<'cash' | 'upi' | 'card' | 'bank_transfer' | 'cheque'>('cash');
  const [tpaName, setTpaName] = useState('');
  const [preAuthNumber, setPreAuthNumber] = useState('');
  const [waiveDeposit, setWaiveDeposit] = useState(false);
  const [waiverReason, setWaiverReason] = useState('');

  // 6. MLC State
  const [isMlc, setIsMlc] = useState(false);
  const [mlcCategory, setMlcCategory] = useState<'rta' | 'assault' | 'poisoning' | 'snake_bite' | 'burns' | 'industrial' | 'hanging' | 'unnatural' | 'other'>('rta');
  const [mlcNarrative, setMlcNarrative] = useState('');
  const [policeStationName, setPoliceStationName] = useState('');
  const [policeIntimated, setPoliceIntimated] = useState(false);
  const [policeIntimationMode, setPoliceIntimationMode] = useState<'written_slip' | 'phone_call' | 'in_person_constable'>('written_slip');
  const [constableName, setConstableName] = useState('');
  const [constableBuckleNo, setConstableBuckleNo] = useState('');

  // Derive Checklist State for Sticky Sidebar
  const effectivePatientName = selectedPatient ? selectedPatient.name : manualName.trim();
  const hasPatient = Boolean(effectivePatientName && (selectedPatient ? selectedPatient.phoneE164 : manualPhone.trim()));
  const hasDoctor = Boolean(doctorId);
  const hasBed = Boolean(selectedBedId);
  const hasAttendant = Boolean(attendantName.trim() && attendantPhone.trim());
  const hasConsent = isPaperConsentAttested;
  const hasFinancial = payerType === 'self_pay' ? (Boolean(depositAmountRupees && depositAmountRupees > 0) || waiveDeposit) : Boolean(tpaName.trim());
  const hasMlcPolice = !isMlc || policeIntimated;

  const checklist: IntakeChecklistState = {
    hasPatient,
    hasDoctor,
    hasBed,
    hasArrived: patientArrived,
    hasAttendant,
    hasConsent,
    hasFinancial,
    isMlc,
    hasMlcPolice,
  };

  // Find bed details
  const selectedBedDetails = useMemo(() => {
    if (!selectedBedId) return null;
    for (const ward of freeWards) {
      const b = ward.beds.find((bed: { id: string; label: string }) => bed.id === selectedBedId);
      if (b) return { bedLabel: b.label, wardName: ward.wardName };
    }
    return null;
  }, [selectedBedId, freeWards]);

  const handleSubmit = () => {
    setErrorMessage(null);
    startSubmit(async () => {
      // Calculate effective arrivedAt
      let effectiveArrivedAt: string | null = null;
      if (patientArrived) {
        const now = new Date();
        const [hours, mins] = arrivedAtTime.split(':').map((v) => parseInt(v, 10));
        const arrDate = new Date(now);
        arrDate.setHours(hours || 0, mins || 0, 0, 0);
        effectiveArrivedAt = arrDate.toISOString();
      }

      const res = await executePatientIntakeAction({
        mode,
        admissionId: initialAdmission?.admissionId,
        branchId,
        doctorId,
        bedId: selectedBedId!,
        urgency,
        reason: reason.trim() || null,
        patientArrived,
        arrivedAt: effectiveArrivedAt ? new Date(effectiveArrivedAt) : null,
        backdateReason: arrivalBackdateReason.trim() || null,
        patientInput: selectedPatient?.id
          ? { kind: 'existing', patientId: selectedPatient.id }
          : {
              kind: 'details',
              details: {
                name: manualName.trim(),
                phoneE164: manualPhone.startsWith('+91') ? manualPhone : `+91${manualPhone.replace(/\D/g, '')}`,
                age: typeof manualAge === 'number' ? manualAge : null,
                gender: manualGender,
                address: manualAddress.trim() || null,
              },
            },
        attendant: attendantName.trim()
          ? {
              name: attendantName.trim(),
              relationship: attendantRelation,
              phoneE164: attendantPhone.startsWith('+91') ? attendantPhone : `+91${attendantPhone.replace(/\D/g, '')}`,
              address: attendantAddress.trim() || null,
              isFinancialGuarantor,
            }
          : null,
        consent: {
          templateCode: consentTemplate,
          templateTitle: consentTemplate === 'general' ? 'General Admission Consent' : consentTemplate === 'high_risk' ? 'High Risk Consent' : 'Surgical Consent',
          templateBody: consentLang === 'mr' ? DEFAULT_GENERAL_CONSENT_MR : DEFAULT_GENERAL_CONSENT_EN,
          status: isPaperConsentAttested ? 'attested_paper' : 'pending',
          signatoryName: attendantName.trim() || effectivePatientName,
          signatoryRelation: consentSignatoryRelation,
          signatoryPhone: attendantPhone.trim() || (selectedPatient?.phoneE164 ?? manualPhone),
          doctorExplainedId: doctorId,
        },
        mlc: isMlc
          ? {
              isMlc: true,
              category: mlcCategory,
              narrative: mlcNarrative.trim() || null,
              policeStationName: policeStationName.trim() || null,
              policeIntimatedAt: policeIntimated ? new Date() : null,
              policeIntimationMode,
              constableName: constableName.trim() || null,
              constableBuckleNo: constableBuckleNo.trim() || null,
            }
          : { isMlc: false },
        financial: {
          payerType,
          depositAmountRupees: !waiveDeposit && typeof depositAmountRupees === 'number' ? depositAmountRupees : null,
          depositPaymentMode,
          preAuthNumber: preAuthNumber.trim() || null,
          tpaName: tpaName.trim() || null,
          waiverReason: waiveDeposit ? waiverReason.trim() : null,
        },
      });

      if (!res.ok || !res.data) {
        setErrorMessage(res.error || 'Failed to complete admission intake');
        window.scrollTo({ top: 0, behavior: 'smooth' });
        return;
      }

      setSuccessResult({
        ...res.data,
        bedLabel: selectedBedDetails?.bedLabel,
        wardName: selectedBedDetails?.wardName,
      });
    });
  };

  return (
    <div className="mx-auto max-w-7xl pb-24">
      {/* Top Breadcrumb & Title */}
      <div className="mb-6 flex items-center justify-between">
        <div>
          <Link href="/ipd" className="text-xs font-semibold text-ink-500 hover:text-ink-800">
            ← Back to IPD Census
          </Link>
          <h1 className="mt-1 text-2xl font-bold text-ink-900 dark:text-ink-50">
            {mode === 'opd_prefilled' ? 'Complete IPD Intake & Assign Bed' : 'Direct Inpatient Admission (Casualty / Walk-in)'}
          </h1>
          <p className="text-xs text-ink-500">
            Clinical-grade intake: Bed allocation, physical arrival, legal consent, and financial recording.
          </p>
        </div>
      </div>

      {errorMessage && (
        <div className="mb-6">
          <Alert tone="error">{errorMessage}</Alert>
        </div>
      )}

      {/* 2-Column Responsive Layout */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        {/* Left Form Stream (8 columns) */}
        <div className="space-y-6 lg:col-span-8">
          {/* CARD 1: PATIENT IDENTITY */}
          <Card className="overflow-hidden border-ink-200 shadow-xs dark:border-ink-800">
            <div className="border-b border-ink-100 bg-ink-50/50 px-5 py-3.5 dark:border-ink-800 dark:bg-ink-900/50">
              <h2 className="text-sm font-bold uppercase tracking-wider text-ink-800 dark:text-ink-200">
                1. Patient Identity & Demographics
              </h2>
            </div>

            <div className="p-5">
              {mode === 'opd_prefilled' && selectedPatient ? (
                /* Locked OPD Patient Banner */
                <div className="rounded-xl border border-brand-200 bg-brand-50/40 p-4 dark:border-brand-900 dark:bg-brand-950/20">
                  <div className="flex items-start justify-between">
                    <div>
                      <span className="inline-flex rounded-full bg-brand-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-brand-800">
                        OPD Consultation Carry-over
                      </span>
                      <h3 className="mt-1 text-lg font-bold text-ink-900 dark:text-ink-50">
                        {selectedPatient.name}
                      </h3>
                      <p className="text-xs text-ink-600 dark:text-ink-400">
                        {[selectedPatient.age ? `${selectedPatient.age}y` : null, selectedPatient.gender?.[0]?.toUpperCase()]
                          .filter(Boolean)
                          .join(' ')}{' '}
                        · 📞 {selectedPatient.phoneE164}
                      </p>
                      {initialAdmission?.reason && (
                        <p className="mt-2 text-xs font-medium text-brand-900 dark:text-brand-200">
                          <span className="font-semibold">Provisional Diagnosis: </span>
                          {initialAdmission.reason}
                        </p>
                      )}
                    </div>
                    {selectedPatient.qid && (
                      <span className="font-mono text-xs font-semibold text-purple-700 bg-purple-50 px-2 py-1 rounded">
                        {selectedPatient.qid}
                      </span>
                    )}
                  </div>
                </div>
              ) : selectedPatient ? (
                /* Picked Patient from Search */
                <div className="flex items-start justify-between rounded-xl border border-emerald-200 bg-emerald-50/40 p-4">
                  <div>
                    <span className="inline-flex rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-emerald-800">
                      Existing Patient Selected
                    </span>
                    <h3 className="mt-1 text-lg font-bold text-ink-900">{selectedPatient.name}</h3>
                    <p className="text-xs text-ink-600">
                      {[selectedPatient.age ? `${selectedPatient.age}y` : null, selectedPatient.gender?.[0]?.toUpperCase()]
                        .filter(Boolean)
                        .join(' ')}{' '}
                      · 📞 {selectedPatient.phoneE164}
                    </p>
                    {selectedPatient.mrn && (
                      <p className="mt-1 text-xs text-ink-500 font-mono">MRN: {selectedPatient.mrn}</p>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => setSelectedPatient(null)}
                    className="text-xs font-semibold text-ink-600 hover:text-ink-900 hover:underline"
                  >
                    Change Patient
                  </button>
                </div>
              ) : (
                /* Direct Smart Search & Registration */
                <div className="space-y-4">
                  <IntakeSmartSearch onSelectPatient={(p) => setSelectedPatient(p)} />

                  <div className="relative my-4">
                    <div className="absolute inset-0 flex items-center">
                      <div className="w-full border-t border-ink-200" />
                    </div>
                    <div className="relative flex justify-center text-xs uppercase">
                      <span className="bg-white px-2 font-semibold text-ink-400">or enter details for new patient</span>
                    </div>
                  </div>

                  {/* Manual Patient Inputs */}
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div>
                      <label className="block text-xs font-semibold text-ink-700">Patient Full Name *</label>
                      <input
                        type="text"
                        value={manualName}
                        onChange={(e) => setManualName(e.target.value)}
                        placeholder="e.g. Ramesh Patil"
                        className="mt-1 w-full rounded-lg border border-ink-300 px-3 py-2 text-sm text-ink-900 focus:border-brand-500 focus:outline-none"
                      />
                    </div>

                    <div>
                      <label className="block text-xs font-semibold text-ink-700">Mobile Phone (10 digits) *</label>
                      <input
                        type="tel"
                        value={manualPhone}
                        onChange={(e) => setManualPhone(e.target.value)}
                        placeholder="9876543210"
                        className="mt-1 w-full rounded-lg border border-ink-300 px-3 py-2 text-sm text-ink-900 focus:border-brand-500 focus:outline-none"
                      />
                    </div>

                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="block text-xs font-semibold text-ink-700">Age</label>
                        <input
                          type="number"
                          value={manualAge}
                          onChange={(e) => setManualAge(e.target.value === '' ? '' : parseInt(e.target.value, 10))}
                          placeholder="Years"
                          className="mt-1 w-full rounded-lg border border-ink-300 px-3 py-2 text-sm text-ink-900"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-semibold text-ink-700">Gender</label>
                        <select
                          value={manualGender}
                          onChange={(e) => setManualGender(e.target.value as any)}
                          className="mt-1 w-full rounded-lg border border-ink-300 bg-white px-3 py-2 text-sm text-ink-900"
                        >
                          <option value="male">Male</option>
                          <option value="female">Female</option>
                          <option value="other">Other</option>
                        </select>
                      </div>
                    </div>

                    <div>
                      <label className="block text-xs font-semibold text-ink-700">Residential Address / Village</label>
                      <input
                        type="text"
                        value={manualAddress}
                        onChange={(e) => setManualAddress(e.target.value)}
                        placeholder="e.g. Dondaicha, Dhule"
                        className="mt-1 w-full rounded-lg border border-ink-300 px-3 py-2 text-sm text-ink-900"
                      />
                    </div>
                  </div>
                </div>
              )}
            </div>
          </Card>

          {/* CARD 2: CONSULTANT & BED ALLOCATION */}
          <Card className="overflow-hidden border-ink-200 shadow-xs dark:border-ink-800">
            <div className="border-b border-ink-100 bg-ink-50/50 px-5 py-3.5 dark:border-ink-800 dark:bg-ink-900/50">
              <h2 className="text-sm font-bold uppercase tracking-wider text-ink-800 dark:text-ink-200">
                2. Attending Consultant & Bed Allocation
              </h2>
            </div>

            <div className="p-5 space-y-4">
              {/* Doctor Selection & Urgency */}
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <label className="block text-xs font-semibold text-ink-700">Admitting Consultant *</label>
                  <select
                    value={doctorId}
                    onChange={(e) => setDoctorId(e.target.value)}
                    disabled={mode === 'opd_prefilled'}
                    className="mt-1 w-full rounded-lg border border-ink-300 bg-white px-3 py-2 text-sm text-ink-900 focus:border-brand-500 focus:outline-none"
                  >
                    {doctors.map((doc) => (
                      <option key={doc.id} value={doc.id}>
                        Dr. {doc.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-ink-700">Clinical Urgency</label>
                  <div className="mt-1 grid grid-cols-3 gap-2">
                    {(['emergency', 'same_day', 'planned'] as const).map((u) => (
                      <button
                        key={u}
                        type="button"
                        onClick={() => setUrgency(u)}
                        className={cn(
                          'rounded-lg border py-1.5 text-xs font-semibold capitalize transition-all',
                          urgency === u
                            ? u === 'emergency'
                              ? 'border-rose-500 bg-rose-50 text-rose-800 ring-2 ring-rose-500/20'
                              : u === 'same_day'
                                ? 'border-amber-500 bg-amber-50 text-amber-800 ring-2 ring-amber-500/20'
                                : 'border-blue-500 bg-blue-50 text-blue-800 ring-2 ring-blue-500/20'
                            : 'border-ink-200 bg-white text-ink-700 hover:bg-ink-50',
                        )}
                      >
                        {u === 'same_day' ? 'Same-Day' : u}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {/* Bed Picker */}
              <div>
                <label className="block text-xs font-semibold text-ink-700 mb-1.5">
                  Select Available Bed *
                </label>
                {freeWards.length === 0 ? (
                  <p className="rounded-lg bg-rose-50 p-3 text-xs font-semibold text-rose-800">
                    No free beds available in this branch. Please discharge a patient or transfer to free up a bed.
                  </p>
                ) : (
                  <BedPicker
                    wards={freeWards}
                    selectedBedId={selectedBedId}
                    onChange={(id) => setSelectedBedId(id)}
                  />
                )}
              </div>

              {/* Physical Ward Arrival Split */}
              <div className="rounded-xl border border-ink-200 bg-ink-50/40 p-4">
                <div className="flex items-start gap-3">
                  <input
                    id="patient-arrived"
                    type="checkbox"
                    checked={patientArrived}
                    onChange={(e) => setPatientArrived(e.target.checked)}
                    className="mt-1 size-4 rounded border-ink-300 text-brand-600 focus:ring-brand-500"
                  />
                  <div className="space-y-1">
                    <label htmlFor="patient-arrived" className="text-sm font-bold text-ink-900 cursor-pointer">
                      Patient has physically reached the ward
                    </label>
                    <p className="text-xs text-ink-500">
                      Room charges, initial clinical assessment, and doctor ward arrival notifications start strictly when arrival is confirmed.
                    </p>
                  </div>
                </div>

                {patientArrived && (
                  <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 pt-3 border-t border-ink-200/60">
                    <div>
                      <label className="block text-xs font-semibold text-ink-700">Arrival Time</label>
                      <input
                        type="time"
                        value={arrivedAtTime}
                        onChange={(e) => setArrivedAtTime(e.target.value)}
                        className="mt-1 w-full rounded-lg border border-ink-300 bg-white px-3 py-1.5 text-sm text-ink-900"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-ink-700">
                        Backdate Reason (Mandatory if &gt; 15 mins in past)
                      </label>
                      <input
                        type="text"
                        value={arrivalBackdateReason}
                        onChange={(e) => setArrivalBackdateReason(e.target.value)}
                        placeholder="e.g. Immediate casualty resuscitation"
                        className="mt-1 w-full rounded-lg border border-ink-300 bg-white px-3 py-1.5 text-sm text-ink-900 placeholder:text-ink-400"
                      />
                    </div>
                  </div>
                )}
              </div>

              {/* Reason / Provisional Diagnosis */}
              <div>
                <label className="block text-xs font-semibold text-ink-700">Provisional Diagnosis / Admission Reason</label>
                <input
                  type="text"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="e.g. Acute Gastroenteritis, Severe Dehydration"
                  className="mt-1 w-full rounded-lg border border-ink-300 px-3 py-2 text-sm text-ink-900"
                />
              </div>
            </div>
          </Card>

          {/* CARD 3: ATTENDANT & PRIMARY CONTACT */}
          <Card className="overflow-hidden border-ink-200 shadow-xs dark:border-ink-800">
            <div className="border-b border-ink-100 bg-ink-50/50 px-5 py-3.5 dark:border-ink-800 dark:bg-ink-900/50">
              <h2 className="text-sm font-bold uppercase tracking-wider text-ink-800 dark:text-ink-200">
                3. Attendant / Relative / Emergency Contact
              </h2>
            </div>

            <div className="p-5 space-y-3">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div className="sm:col-span-2">
                  <label className="block text-xs font-semibold text-ink-700">Attendant Full Name</label>
                  <input
                    type="text"
                    value={attendantName}
                    onChange={(e) => {
                      setAttendantName(e.target.value);
                      if (consentSignatoryRelation === 'Self' && e.target.value) {
                        setConsentSignatoryRelation(attendantRelation);
                      }
                    }}
                    placeholder="e.g. Anil Ramesh Patil"
                    className="mt-1 w-full rounded-lg border border-ink-300 px-3 py-2 text-sm text-ink-900"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-ink-700">Relationship to Patient</label>
                  <select
                    value={attendantRelation}
                    onChange={(e) => {
                      setAttendantRelation(e.target.value);
                      setConsentSignatoryRelation(e.target.value);
                    }}
                    className="mt-1 w-full rounded-lg border border-ink-300 bg-white px-3 py-2 text-sm text-ink-900"
                  >
                    <option value="Father">Father</option>
                    <option value="Mother">Mother</option>
                    <option value="Spouse">Spouse</option>
                    <option value="Son">Son</option>
                    <option value="Daughter">Daughter</option>
                    <option value="Brother">Brother</option>
                    <option value="Sister">Sister</option>
                    <option value="Guardian">Guardian</option>
                    <option value="Other">Other</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className="block text-xs font-semibold text-ink-700">Attendant Mobile Phone (10 digits)</label>
                  <input
                    type="tel"
                    value={attendantPhone}
                    onChange={(e) => setAttendantPhone(e.target.value)}
                    placeholder="9876543210"
                    className="mt-1 w-full rounded-lg border border-ink-300 px-3 py-2 text-sm text-ink-900"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-ink-700">Address / Contact Town</label>
                  <input
                    type="text"
                    value={attendantAddress}
                    onChange={(e) => setAttendantAddress(e.target.value)}
                    placeholder="e.g. Same as patient"
                    className="mt-1 w-full rounded-lg border border-ink-300 px-3 py-2 text-sm text-ink-900"
                  />
                </div>
              </div>

              <div className="flex items-center gap-2 pt-1">
                <input
                  id="financial-guarantor"
                  type="checkbox"
                  checked={isFinancialGuarantor}
                  onChange={(e) => setIsFinancialGuarantor(e.target.checked)}
                  className="size-4 rounded border-ink-300 text-brand-600 focus:ring-brand-500"
                />
                <label htmlFor="financial-guarantor" className="text-xs text-ink-700 cursor-pointer">
                  Attendant acts as Financial Guarantor & primary decision maker
                </label>
              </div>
            </div>
          </Card>

          {/* CARD 4: VERSIONED LEGAL CONSENT */}
          <Card className="overflow-hidden border-ink-200 shadow-xs dark:border-ink-800">
            <div className="border-b border-ink-100 bg-ink-50/50 px-5 py-3.5 dark:border-ink-800 dark:bg-ink-900/50 flex items-center justify-between">
              <h2 className="text-sm font-bold uppercase tracking-wider text-ink-800 dark:text-ink-200">
                4. Versioned Legal Consent (Default Pending)
              </h2>
              <span className={cn(
                'rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider',
                isPaperConsentAttested ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'
              )}>
                {isPaperConsentAttested ? '✓ Attested & Filed' : '⏳ Pending Paperwork'}
              </span>
            </div>

            <div className="p-5 space-y-4">
              {/* Template & Language row */}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className="block text-xs font-semibold text-ink-700">Consent Form Template</label>
                  <select
                    value={consentTemplate}
                    onChange={(e) => setConsentTemplate(e.target.value as any)}
                    className="mt-1 w-full rounded-lg border border-ink-300 bg-white px-3 py-2 text-sm text-ink-900"
                  >
                    <option value="general">General Inpatient Admission Consent</option>
                    <option value="high_risk">High-Risk / ICU Care Consent</option>
                    <option value="surgery">Surgical & Anesthetic Procedure Consent</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-ink-700">Language</label>
                  <div className="mt-1 flex gap-2">
                    <button
                      type="button"
                      onClick={() => setConsentLang('mr')}
                      className={cn(
                        'flex-1 rounded-lg border py-2 text-xs font-semibold',
                        consentLang === 'mr'
                          ? 'border-brand-600 bg-brand-50 text-brand-900'
                          : 'border-ink-200 bg-white text-ink-700 hover:bg-ink-50',
                      )}
                    >
                      मराठी (Marathi)
                    </button>
                    <button
                      type="button"
                      onClick={() => setConsentLang('en')}
                      className={cn(
                        'flex-1 rounded-lg border py-2 text-xs font-semibold',
                        consentLang === 'en'
                          ? 'border-brand-600 bg-brand-50 text-brand-900'
                          : 'border-ink-200 bg-white text-ink-700 hover:bg-ink-50',
                      )}
                    >
                      English
                    </button>
                  </div>
                </div>
              </div>

              {/* Exact Text Snapshot Preview */}
              <div className="rounded-xl border border-ink-200 bg-ink-50/50 p-3.5 text-xs text-ink-800 leading-relaxed font-serif">
                {consentLang === 'mr' ? DEFAULT_GENERAL_CONSENT_MR : DEFAULT_GENERAL_CONSENT_EN}
              </div>

              {/* Signatory relation */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-ink-700">Signatory Name</label>
                  <input
                    type="text"
                    readOnly
                    value={attendantName.trim() || effectivePatientName || 'Patient / Relative'}
                    className="mt-1 w-full rounded-lg border border-ink-200 bg-ink-100/50 px-3 py-1.5 text-xs text-ink-700"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-ink-700">Signatory Relationship</label>
                  <input
                    type="text"
                    value={consentSignatoryRelation}
                    onChange={(e) => setConsentSignatoryRelation(e.target.value)}
                    placeholder="e.g. Self, Son, Father"
                    className="mt-1 w-full rounded-lg border border-ink-300 bg-white px-3 py-1.5 text-xs text-ink-900"
                  />
                </div>
              </div>

              {/* Staff Attestation Checkbox */}
              <div className="rounded-xl border border-brand-200 bg-brand-50/30 p-3.5">
                <div className="flex items-start gap-2.5">
                  <input
                    id="consent-attested"
                    type="checkbox"
                    checked={isPaperConsentAttested}
                    onChange={(e) => setIsPaperConsentAttested(e.target.checked)}
                    className="mt-0.5 size-4 rounded border-brand-300 text-brand-600 focus:ring-brand-500"
                  />
                  <div>
                    <label htmlFor="consent-attested" className="text-xs font-bold text-ink-900 cursor-pointer">
                      I attest that the physical consent form was explained, signed by the patient/relative, and is placed in the case folder.
                    </label>
                    <p className="mt-0.5 text-[11px] text-ink-500">
                      Stamps your user account as staff witness with server-side SHA-256 text fingerprinting.
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </Card>

          {/* CARD 5: FINANCIAL & PAYER INTAKE */}
          <Card className="overflow-hidden border-ink-200 shadow-xs dark:border-ink-800">
            <div className="border-b border-ink-100 bg-ink-50/50 px-5 py-3.5 dark:border-ink-800 dark:bg-ink-900/50">
              <h2 className="text-sm font-bold uppercase tracking-wider text-ink-800 dark:text-ink-200">
                5. Payer & Financial Intake
              </h2>
            </div>

            <div className="p-5 space-y-4">
              {/* Payer Type Selector */}
              <div>
                <label className="block text-xs font-semibold text-ink-700">Payer Kind</label>
                <div className="mt-1.5 grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {(['self_pay', 'insurance_tpa', 'ayushman', 'corporate'] as const).map((p) => (
                    <button
                      key={p}
                      type="button"
                      onClick={() => setPayerType(p)}
                      className={cn(
                        'rounded-lg border p-2 text-xs font-semibold capitalize transition-colors',
                        payerType === p
                          ? 'border-brand-600 bg-brand-50 text-brand-900'
                          : 'border-ink-200 bg-white text-ink-700 hover:bg-ink-50',
                      )}
                    >
                      {p === 'self_pay'
                        ? 'Self-Pay'
                        : p === 'insurance_tpa'
                          ? 'Insurance / TPA'
                          : p === 'ayushman'
                            ? 'Ayushman (Govt)'
                            : 'Corporate'}
                    </button>
                  ))}
                </div>
              </div>

              {/* Self-Pay: Advance Deposit vs Waiver */}
              {payerType === 'self_pay' && (
                <div className="rounded-xl border border-ink-200 bg-ink-50/30 p-4 space-y-3">
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div>
                      <label className="block text-xs font-semibold text-ink-700">Advance Deposit Amount (₹)</label>
                      <input
                        type="number"
                        min="0"
                        step="500"
                        disabled={waiveDeposit}
                        value={depositAmountRupees}
                        onChange={(e) => setDepositAmountRupees(e.target.value === '' ? '' : parseInt(e.target.value, 10))}
                        placeholder="e.g. 5000"
                        className="mt-1 w-full rounded-lg border border-ink-300 bg-white px-3 py-2 text-sm text-ink-900 disabled:opacity-50"
                      />
                    </div>

                    <div>
                      <label className="block text-xs font-semibold text-ink-700">Payment Mode</label>
                      <select
                        disabled={waiveDeposit}
                        value={depositPaymentMode}
                        onChange={(e) => setDepositPaymentMode(e.target.value as any)}
                        className="mt-1 w-full rounded-lg border border-ink-300 bg-white px-3 py-2 text-sm text-ink-900 disabled:opacity-50"
                      >
                        <option value="cash">Cash (Counter)</option>
                        <option value="upi">UPI / QR Code</option>
                        <option value="card">Card (POS Terminal)</option>
                        <option value="bank_transfer">NEFT / Net Banking</option>
                        <option value="cheque">Cheque</option>
                      </select>
                    </div>
                  </div>

                  {/* Non-blocking Waiver */}
                  <div className="pt-2 border-t border-ink-200/60">
                    <div className="flex items-center gap-2">
                      <input
                        id="waive-deposit"
                        type="checkbox"
                        checked={waiveDeposit}
                        onChange={(e) => setWaiveDeposit(e.target.checked)}
                        className="size-4 rounded border-ink-300 text-amber-600 focus:ring-amber-500"
                      />
                      <label htmlFor="waive-deposit" className="text-xs font-semibold text-amber-900 cursor-pointer">
                        Waive advance deposit for emergency intake (non-blocking)
                      </label>
                    </div>

                    {waiveDeposit && (
                      <input
                        type="text"
                        value={waiverReason}
                        onChange={(e) => setWaiverReason(e.target.value)}
                        placeholder="Enter reason for deposit waiver (e.g. Emergency admission approved by Dr. Pawara)"
                        className="mt-2 w-full rounded-lg border border-amber-300 bg-amber-50/50 px-3 py-1.5 text-xs text-amber-950 placeholder:text-amber-500"
                      />
                    )}
                  </div>
                </div>
              )}

              {/* Insurance / TPA fields */}
              {payerType !== 'self_pay' && (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div>
                    <label className="block text-xs font-semibold text-ink-700">TPA / Insurance Company Name</label>
                    <input
                      type="text"
                      value={tpaName}
                      onChange={(e) => setTpaName(e.target.value)}
                      placeholder="e.g. Star Health, Vidal Health TPA, PMJAY"
                      className="mt-1 w-full rounded-lg border border-ink-300 px-3 py-2 text-sm text-ink-900"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-ink-700">Pre-Authorization / Claim Number</label>
                    <input
                      type="text"
                      value={preAuthNumber}
                      onChange={(e) => setPreAuthNumber(e.target.value)}
                      placeholder="e.g. PRE-2026-99120"
                      className="mt-1 w-full rounded-lg border border-ink-300 px-3 py-2 text-sm text-ink-900"
                    />
                  </div>
                </div>
              )}
            </div>
          </Card>

          {/* CARD 6: MEDICO-LEGAL CASE (MLC) */}
          <Card className="overflow-hidden border-ink-200 shadow-xs dark:border-ink-800">
            <div className="border-b border-ink-100 bg-ink-50/50 px-5 py-3.5 dark:border-ink-800 dark:bg-ink-900/50 flex items-center justify-between">
              <h2 className="text-sm font-bold uppercase tracking-wider text-ink-800 dark:text-ink-200">
                6. Medico-Legal Case (MLC) & Police Intimation
              </h2>
              {isMlc && (
                <span className="rounded-full bg-rose-100 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-rose-800 animate-pulse">
                  MLC Active
                </span>
              )}
            </div>

            <div className="p-5 space-y-4">
              <div className="flex items-center gap-2.5">
                <input
                  id="is-mlc-toggle"
                  type="checkbox"
                  checked={isMlc}
                  onChange={(e) => setIsMlc(e.target.checked)}
                  className="size-4 rounded border-ink-300 text-rose-600 focus:ring-rose-500"
                />
                <label htmlFor="is-mlc-toggle" className="text-sm font-semibold text-ink-900 cursor-pointer">
                  Flag as Medico-Legal Case (Road Accident, Assault, Poisoning, Burns, Snake Bite)
                </label>
              </div>

              {isMlc && (
                <div className="rounded-xl border border-rose-200 bg-rose-50/30 p-4 space-y-3">
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div>
                      <label className="block text-xs font-semibold text-rose-900">MLC Category *</label>
                      <select
                        value={mlcCategory}
                        onChange={(e) => setMlcCategory(e.target.value as any)}
                        className="mt-1 w-full rounded-lg border border-rose-300 bg-white px-3 py-2 text-xs text-ink-900"
                      >
                        <option value="rta">Road Traffic Accident (RTA)</option>
                        <option value="assault">Physical Assault / Trauma</option>
                        <option value="poisoning">Poisoning / Chemical Ingestion</option>
                        <option value="snake_bite">Snake Bite / Animal Attack</option>
                        <option value="burns">Burns / Fire Injury</option>
                        <option value="industrial">Industrial Workplace Accident</option>
                        <option value="other">Other Unnatural Injury</option>
                      </select>
                    </div>

                    <div>
                      <label className="block text-xs font-semibold text-rose-900">Police Station Jurisdiction</label>
                      <input
                        type="text"
                        value={policeStationName}
                        onChange={(e) => setPoliceStationName(e.target.value)}
                        placeholder="e.g. Dondaicha Police Station"
                        className="mt-1 w-full rounded-lg border border-rose-300 bg-white px-3 py-2 text-xs text-ink-900"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-rose-900">Brief Incident Narrative</label>
                    <textarea
                      rows={2}
                      value={mlcNarrative}
                      onChange={(e) => setMlcNarrative(e.target.value)}
                      placeholder="e.g. 2-wheeler collision near toll plaza at ~1:30 PM. Brought by 108 ambulance."
                      className="mt-1 w-full rounded-lg border border-rose-300 bg-white px-3 py-1.5 text-xs text-ink-900"
                    />
                  </div>

                  {/* Police Intimation Status */}
                  <div className="pt-2 border-t border-rose-200">
                    <div className="flex items-center gap-2">
                      <input
                        id="police-intimated"
                        type="checkbox"
                        checked={policeIntimated}
                        onChange={(e) => setPoliceIntimated(e.target.checked)}
                        className="size-4 rounded border-rose-300 text-rose-600 focus:ring-rose-500"
                      />
                      <label htmlFor="police-intimated" className="text-xs font-bold text-rose-900 cursor-pointer">
                        Police Intimation Sent / Received by Constable
                      </label>
                    </div>

                    {policeIntimated && (
                      <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
                        <div>
                          <label className="block text-[11px] font-semibold text-ink-700">Intimation Mode</label>
                          <select
                            value={policeIntimationMode}
                            onChange={(e) => setPoliceIntimationMode(e.target.value as any)}
                            className="mt-1 w-full rounded border border-ink-300 bg-white p-1.5 text-xs text-ink-900"
                          >
                            <option value="written_slip">Written Intimation Slip</option>
                            <option value="phone_call">Phone Call to Station Diary</option>
                            <option value="in_person_constable">In-Person Constable</option>
                          </select>
                        </div>
                        <div>
                          <label className="block text-[11px] font-semibold text-ink-700">Constable Name</label>
                          <input
                            type="text"
                            value={constableName}
                            onChange={(e) => setConstableName(e.target.value)}
                            placeholder="e.g. HC Pawar"
                            className="mt-1 w-full rounded border border-ink-300 bg-white p-1.5 text-xs text-ink-900"
                          />
                        </div>
                        <div>
                          <label className="block text-[11px] font-semibold text-ink-700">Buckle No / B.No</label>
                          <input
                            type="text"
                            value={constableBuckleNo}
                            onChange={(e) => setConstableBuckleNo(e.target.value)}
                            placeholder="e.g. 1482"
                            className="mt-1 w-full rounded border border-ink-300 bg-white p-1.5 text-xs text-ink-900"
                          />
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </Card>
        </div>

        {/* Right Sticky Sidebar (4 columns) */}
        <div className="lg:col-span-4">
          <IntakeStickySidebar
            checklist={checklist}
            onSubmit={handleSubmit}
            isSubmitting={isSubmitting}
            submitLabel={mode === 'opd_prefilled' ? 'Confirm Bed & Complete Intake' : 'Admit Patient to IPD'}
          />
        </div>
      </div>

      {/* Success Modal */}
      {successResult && (
        <IntakeSuccessModal
          isOpen={true}
          onClose={() => setSuccessResult(null)}
          result={successResult}
        />
      )}
    </div>
  );
}
