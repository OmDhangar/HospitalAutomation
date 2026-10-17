import React from 'react';

export interface BillReceiptFooterProps {
  patientName?: string;
  doctorName?: string;
  doctorQualification?: string;
  doctorDesignation?: string;
  doctorRegistrationNo?: string;
  hospitalRegistrationNo?: string;
}

export function BillReceiptFooter({
  patientName = 'Dinesh Dhangar',
  doctorName = 'DR. VINOD RAJESH PAWARA',
  doctorQualification = 'MBBS, MD-MEDICINE',
  doctorDesignation = 'CONSULTANT PHYSICIAN',
  doctorRegistrationNo = '2015074070',
  hospitalRegistrationNo = 'GHD/BNH/136/2022',
}: BillReceiptFooterProps) {
  return (
    <footer className="mt-12 break-inside-avoid">
      {/* 3-Column Signatures Row */}
      <div className="grid grid-cols-3 items-end gap-6 text-ink-900">
        {/* Left: Patient Signature */}
        <div className="space-y-2">
          <div className="font-serif italic text-base text-ink-800">
            {patientName}
          </div>
          <div className="w-48 border-t border-ink-400 pt-1 text-[10px] font-bold uppercase tracking-wider text-ink-600">
            Signature of Patient / Relative
          </div>
        </div>

        {/* Center: Hospital Official Round Stamp */}
        <div className="flex justify-center">
          <div className="flex size-24 flex-col items-center justify-center rounded-full border-2 border-dashed border-ink-400 p-2 text-center text-[8px] font-bold uppercase leading-tight text-ink-700">
            <span className="text-[7px]">GURUVED HOSPITAL</span>
            <span className="my-0.5 font-mono text-[9px] text-ink-950 font-black">
              REG NO
              <br />
              {hospitalRegistrationNo}
            </span>
            <span className="text-[7px]">SHIRPUR</span>
          </div>
        </div>

        {/* Right: Incharge Doctor Signature & Stamp */}
        <div className="flex flex-col items-end text-right">
          <div className="mb-1 text-[11px] font-semibold text-ink-500">
            Signature
          </div>
          <div className="font-serif italic text-lg leading-tight text-ink-950">
            {doctorName.split(' ').slice(-1)[0]}
          </div>
          <div className="mt-1 text-[11px] font-black uppercase text-ink-950">
            {doctorName}
          </div>
          <div className="text-[10px] font-bold text-ink-800">
            {doctorQualification}
          </div>
          <div className="text-[9px] uppercase tracking-wider text-ink-700">
            {doctorDesignation}
          </div>
          <div className="font-mono text-[9px] font-bold text-ink-900">
            {`REG.NO.${doctorRegistrationNo}`}
          </div>
        </div>
      </div>

      {/* Very Bottom Page Footer */}
      <div className="mt-10 flex items-center justify-between border-t border-ink-200 pt-2 text-[9px] font-bold uppercase tracking-wider text-ink-500 print:text-ink-600">
        <span>Powered by QuriioHQ</span>
        <span>Page 1 of 1</span>
      </div>
    </footer>
  );
}
