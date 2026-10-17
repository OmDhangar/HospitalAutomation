import React from 'react';

export interface BillReceiptHeaderProps {
  hospitalName?: string;
  registrationNo?: string | null;
  isFinal?: boolean;
  patient: {
    name: string;
    age: number | null;
    gender: string | null;
    address: string | null;
    location: string | null;
    phone: string | null;
    patientId: string | null;
    roomBed?: string | null;
    doctorName: string | null;
    department: string | null;
  };
  bill: {
    billNumber: string | null;
    billDate: string;
    ipdNumber: string | null;
    admissionDate: string;
    admissionTime: string;
    dischargeDate: string;
    dischargeTime: string;
  };
}

export function BillReceiptHeader({
  hospitalName = 'GURUVED HOSPITAL & CRITICARE CENTRE',
  registrationNo = 'GHD/BNH/136/2022',
  isFinal = true,
  patient,
  bill,
}: BillReceiptHeaderProps) {
  const patientDemographics = [
    patient.name,
    patient.age || patient.gender
      ? `(${[patient.age ? `${patient.age}y` : null, patient.gender].filter(Boolean).join(', ')})`
      : null,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <header className="relative border-b-2 border-ink-950 pb-2">
      {/* Top Marketing Corner Tag */}
      <div className="absolute top-0 right-0 text-[9px] font-bold uppercase tracking-widest text-ink-400 print:text-ink-600">
        Powered by QuriioHQ
      </div>

      {/* Main Hospital Branding Row */}
      <div className="flex items-center justify-between gap-4 pt-1">
        <div className="flex items-center gap-3">
          {/* Logo Monogram */}
          <div className="flex size-14 shrink-0 items-center justify-center rounded-xl border-2 border-ink-900 bg-ink-50 font-black text-2xl tracking-tighter text-ink-900 shadow-2xs">
            GV
          </div>
          <div>
            <h1 className="text-xl font-black uppercase tracking-tight text-ink-950">
              {hospitalName}
            </h1>
          </div>
        </div>

        {/* Circular Stamp Badge */}
        <div className="flex size-20 shrink-0 flex-col items-center justify-center rounded-full border-2 border-dashed border-ink-400 p-1 text-center text-[8px] font-bold uppercase leading-tight text-ink-600">
          <span>REG NO</span>
          <span className="font-mono text-[9px] text-ink-900">{registrationNo || 'GHD/BNH/136/2022'}</span>
          <span>SHIRPUR</span>
        </div>
      </div>

      {/* Subtitle */}
      <div className="mt-2 text-center">
        <h2 className="inline-block border-b border-ink-300 pb-0.5 text-xs font-bold uppercase tracking-wider text-ink-900">
          {isFinal ? 'Bill cum Receipt' : 'Interim Bill cum Receipt (Provisional)'}
        </h2>
      </div>

      {/* 2-Column Patient & Bill Metadata Grid */}
      <div className="mt-3 grid grid-cols-2 gap-x-8 text-[11px] leading-relaxed text-ink-900">
        {/* Left Column: Patient Details */}
        <div className="space-y-0.5 font-sans">
          <div className="flex">
            <span className="w-28 shrink-0 font-bold text-ink-700">Name</span>
            <span className="w-3 shrink-0 text-center font-bold">:</span>
            <span className="font-bold text-ink-950">{patientDemographics}</span>
          </div>
          <div className="flex">
            <span className="w-28 shrink-0 font-bold text-ink-700">Address</span>
            <span className="w-3 shrink-0 text-center font-bold">:</span>
            <span className="uppercase text-ink-900">{patient.address || '—'}</span>
          </div>
          <div className="flex">
            <span className="w-28 shrink-0 font-bold text-ink-700">Location</span>
            <span className="w-3 shrink-0 text-center font-bold">:</span>
            <span className="uppercase text-ink-900">{patient.location || 'SHIRPUR'}</span>
          </div>
          <div className="flex">
            <span className="w-28 shrink-0 font-bold text-ink-700">Mobile Number</span>
            <span className="w-3 shrink-0 text-center font-bold">:</span>
            <span className="font-mono text-ink-900">{patient.phone || '—'}</span>
          </div>
          <div className="flex">
            <span className="w-28 shrink-0 font-bold text-ink-700">Patient ID</span>
            <span className="w-3 shrink-0 text-center font-bold">:</span>
            <span className="font-mono font-bold text-ink-900">{patient.patientId || '—'}</span>
          </div>
          {patient.roomBed ? (
            <div className="flex">
              <span className="w-28 shrink-0 font-bold text-ink-700">Room / Bed</span>
              <span className="w-3 shrink-0 text-center font-bold">:</span>
              <span className="font-bold uppercase text-ink-950">{patient.roomBed}</span>
            </div>
          ) : null}
          <div className="flex">
            <span className="w-28 shrink-0 font-bold text-ink-700">Incharge Doctor</span>
            <span className="w-3 shrink-0 text-center font-bold">:</span>
            <span className="font-bold text-ink-950">{patient.doctorName || 'DR VINOD R PAWARA'}</span>
          </div>
          <div className="flex">
            <span className="w-28 shrink-0 font-bold text-ink-700">Department</span>
            <span className="w-3 shrink-0 text-center font-bold">:</span>
            <span className="uppercase text-ink-900">{patient.department || 'MEDICINE'}</span>
          </div>
        </div>

        {/* Right Column: Bill Details */}
        <div className="space-y-0.5 font-sans">
          <div className="flex">
            <span className="w-32 shrink-0 font-bold text-ink-700">Bill Number</span>
            <span className="w-3 shrink-0 text-center font-bold">:</span>
            <span className="font-mono font-black text-ink-950">{bill.billNumber || 'Draft / Running'}</span>
          </div>
          <div className="flex">
            <span className="w-32 shrink-0 font-bold text-ink-700">Bill Date</span>
            <span className="w-3 shrink-0 text-center font-bold">:</span>
            <span className="font-mono text-ink-900">{bill.billDate}</span>
          </div>
          <div className="flex">
            <span className="w-32 shrink-0 font-bold text-ink-700">IPD No.</span>
            <span className="w-3 shrink-0 text-center font-bold">:</span>
            <span className="font-mono font-bold text-ink-950">{bill.ipdNumber || '—'}</span>
          </div>
          <div className="flex">
            <span className="w-32 shrink-0 font-bold text-ink-700">Admission Date</span>
            <span className="w-3 shrink-0 text-center font-bold">:</span>
            <span className="font-mono text-ink-900">{bill.admissionDate}</span>
          </div>
          <div className="flex">
            <span className="w-32 shrink-0 font-bold text-ink-700">Admission Time</span>
            <span className="w-3 shrink-0 text-center font-bold">:</span>
            <span className="font-mono text-ink-900">{bill.admissionTime}</span>
          </div>
          <div className="flex">
            <span className="w-32 shrink-0 font-bold text-ink-700">Discharged Date</span>
            <span className="w-3 shrink-0 text-center font-bold">:</span>
            <span className="font-mono text-ink-900">{bill.dischargeDate}</span>
          </div>
          <div className="flex">
            <span className="w-32 shrink-0 font-bold text-ink-700">Discharged Time</span>
            <span className="w-3 shrink-0 text-center font-bold">:</span>
            <span className="font-mono text-ink-900">{bill.dischargeTime}</span>
          </div>
        </div>
      </div>
    </header>
  );
}
