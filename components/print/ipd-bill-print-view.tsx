'use client';

import React, { useState } from 'react';
import { BillPrintControls } from './bill-print-controls';
import { BillReceiptHeader, type BillReceiptHeaderProps } from './bill-receipt-header';
import { BillReceiptTable, type BillReceiptTableProps } from './bill-receipt-table';
import { BillReceiptFooter, type BillReceiptFooterProps } from './bill-receipt-footer';
import { PatientMedicalReport } from './patient-medical-report';
import type { PrintableMedicalReport } from '@/lib/services/medical-report';

export interface IpdBillPrintViewProps {
  hospitalName?: string;
  registrationNo?: string | null;
  isFinal?: boolean;
  patient: BillReceiptHeaderProps['patient'];
  bill: BillReceiptHeaderProps['bill'];
  doctorStamp: {
    name: string;
    qualification?: string;
    designation?: string;
    registrationNo?: string;
  };
  groups: BillReceiptTableProps['groups'];
  summary: BillReceiptTableProps['summary'];
  medicalReport: PrintableMedicalReport;
  defaultIncludeReport?: boolean;
  autoPrint?: boolean;
  backHref?: string;
}

export function IpdBillPrintView({
  hospitalName = 'GURUVED HOSPITAL & CRITICARE CENTRE',
  registrationNo = 'GHD/BNH/136/2022',
  isFinal = true,
  patient,
  bill,
  doctorStamp,
  groups,
  summary,
  medicalReport,
  defaultIncludeReport = false,
  autoPrint = false,
  backHref,
}: IpdBillPrintViewProps) {
  const [includeReport, setIncludeReport] = useState(defaultIncludeReport);

  return (
    <main className="min-h-dvh bg-ink-100 py-8 print:bg-white print:py-0">
      <style>
        {`@page { size: A4 portrait; margin: 10mm 12mm 12mm; }
          @media print {
            .page-number::after { content: counter(page); }
            .break-before-page { break-before: page; page-break-before: always; }
          }`}
      </style>

      <div className="mx-auto max-w-[210mm] print:max-w-none">
        {/* Print & Report Toggle Controls (Screen Only) */}
        <BillPrintControls
          autoPrint={autoPrint}
          includeReport={includeReport}
          onToggleReport={setIncludeReport}
          backHref={backHref}
          patientName={patient.name}
        />

        {/* Printable Document Article */}
        <article className="bg-white p-8 text-[12px] leading-snug text-ink-900 shadow-sm print:p-0 print:shadow-none">
          {/* Page 1: Official Bill cum Receipt */}
          <BillReceiptHeader
            hospitalName={hospitalName}
            registrationNo={registrationNo}
            isFinal={isFinal}
            patient={patient}
            bill={bill}
          />

          <BillReceiptTable groups={groups} summary={summary} />

          <BillReceiptFooter
            patientName={patient.name}
            doctorName={doctorStamp.name}
            doctorQualification={doctorStamp.qualification}
            doctorDesignation={doctorStamp.designation}
            doctorRegistrationNo={doctorStamp.registrationNo}
            hospitalRegistrationNo={registrationNo || 'GHD/BNH/136/2022'}
          />

          {/* Subsequent Pages: Medical Dossier & Diagnostic Report */}
          {includeReport && (
            <PatientMedicalReport
              hospitalName={hospitalName}
              patient={{
                name: patient.name,
                age: patient.age,
                gender: patient.gender,
                ipdNumber: bill.ipdNumber,
                doctorName: patient.doctorName,
                roomBed: patient.roomBed,
              }}
              report={medicalReport}
            />
          )}
        </article>
      </div>
    </main>
  );
}
