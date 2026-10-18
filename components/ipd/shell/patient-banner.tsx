'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { formatDoctor, toTitleCase } from '@/lib/domain/doctor';
import { StatusBadge } from '@/components/ipd/status-badge';
import { Drawer } from '@/components/ipd/drawer';
import { PrinterIcon, FileTextIcon, ArrowLeftIcon } from '@/components/icons';
import type { BadgeColorKey } from '@/constants/clinical';

export interface PatientBannerData {
  name: string;
  age?: number | null;
  gender?: string | null;
  uhid: string;
  ipdNumber: number | string;
  wardName?: string | null;
  bedLabel?: string | null;
  dayOfStay?: number | null;
  doctorName?: string | null;
  diagnosis?: string | null;
  allergyStatus?: 'unreviewed' | 'allergies_documented' | 'nkda' | null;
  allergies?: string[] | null;
  weightKg?: number | null;
  heightCm?: number | null;
  bmi?: number | null;
  news2Score?: number | null;
  isNews2Escalated?: boolean;
  status: string;
}

export interface PatientBannerProps {
  admissionId: string;
  patient: PatientBannerData;
  className?: string;
  userRole?: string;
  backHref?: string;
}

function resolveStatusVariant(status: string): BadgeColorKey {
  const s = status.toLowerCase();
  if (s.includes('ready')) return 'green';
  if (s.includes('planned')) return 'amber';
  if (s.includes('admitted')) return 'blue';
  if (s.includes('discharged')) return 'grey';
  return 'neutral';
}

export function PatientBanner({
  admissionId,
  patient,
  className = '',
  userRole,
  backHref,
}: PatientBannerProps) {
  const [isHistoryDrawerOpen, setIsHistoryDrawerOpen] = useState(false);

  const formattedName = toTitleCase(patient.name);
  const formattedDoctor = formatDoctor(patient.doctorName);
  const statusVariant = resolveStatusVariant(patient.status);

  const bedString = [
    patient.wardName,
    patient.bedLabel ? `Bed ${patient.bedLabel}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  const ageGenderString = [
    patient.age != null ? `${patient.age} yrs` : null,
    patient.gender,
  ]
    .filter(Boolean)
    .join(' · ');

  // Allergy Chip logic:
  // - Allergies: <list> (red)
  // - No known allergies (grey)
  const patientDrawerContext = {
    name: formattedName,
    uhid: patient.uhid,
    bedLabel: patient.bedLabel ? `Bed ${patient.bedLabel}` : null,
  };

  return (
    <>
      <section
        aria-label="Patient Banner"
        className={`sticky top-0 z-30 bg-surface border-b border-ink-100 shadow-xs px-3.5 py-1.5 sm:px-5 ${className}`}
      >
        {((patient.news2Score != null && patient.news2Score >= 5) || patient.isNews2Escalated) && (
          <div
            role="alert"
            className="w-full bg-rose-600 text-white px-3 py-1 text-xs font-semibold flex items-center justify-between rounded mb-1.5 shadow-xs"
          >
            <div className="flex items-center gap-1.5">
              <span className="text-sm">🚨</span>
              <span>
                {`CRITICAL NEWS2: Score ${patient.news2Score ?? 5} (High Risk Clinical Escalation) — Doctor bedside review required`}
              </span>
            </div>
            <span className="text-[10px] uppercase tracking-wider bg-rose-800 px-1.5 py-0.5 rounded font-mono font-bold">
              High Risk
            </span>
          </div>
        )}
        <div className="flex flex-col gap-1.5 lg:flex-row lg:items-center lg:justify-between">
          {/* Main demographics block */}
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs">
            {/* Back Navigation */}
            <Link
              href={backHref || (userRole === 'nurse' ? `/ipd/patients/${admissionId}/emar` : '/ipd/my-patients')}
              className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-semibold text-ink-700 bg-surface rounded border border-ink-200 hover:bg-ink-100 hover:text-ink-950 transition-colors shadow-2xs mr-1"
              aria-label="Back"
              title={userRole === 'nurse' ? (backHref?.includes('ward') ? 'Back to Ward' : 'Back to Medication Chart') : 'Back to patient list'}
            >
              <ArrowLeftIcon className="size-3.5 text-ink-500" />
              <span>Back</span>
            </Link>

            {/* Patient Name */}
            <h1 className="text-sm font-semibold text-ink-950 tracking-tight">
              {formattedName}
            </h1>

            {/* Age / Gender */}
            {ageGenderString && (
              <span className="text-ink-600 text-xs font-normal">
                {ageGenderString}
              </span>
            )}

            <span className="text-ink-300 hidden sm:inline" aria-hidden="true">
              |
            </span>

            {/* UHID */}
            <span className="font-semibold text-ink-700 text-xs tracking-wide">
              {patient.uhid}
            </span>

            {/* IPD # */}
            <span className="text-ink-500 text-xs">
              {`IPD #${patient.ipdNumber}`}
            </span>

            <span className="text-ink-300 hidden sm:inline" aria-hidden="true">
              |
            </span>

            {/* Ward · Bed */}
            {bedString && (
              <span className="font-semibold text-ink-800 text-xs">
                {bedString}
              </span>
            )}

            {/* Day of Stay */}
            {patient.dayOfStay != null && (
              <span className="inline-flex items-center px-1.5 py-0.2 rounded text-[11px] font-semibold bg-sky-50 text-sky-700 ring-1 ring-inset ring-sky-200">
                {`Day ${patient.dayOfStay}`}
              </span>
            )}

            <span className="text-ink-300 hidden sm:inline" aria-hidden="true">
              |
            </span>

            {/* Consultant */}
            <span className="text-xs text-ink-600">
              Consultant: <span className="font-semibold text-ink-800">{formattedDoctor}</span>
            </span>
          </div>

          {/* Essential clinical details, status badge, action buttons */}
          <div className="flex flex-wrap items-center gap-1.5">
            {/* Diagnosis (if present) */}
            {patient.diagnosis && (
              <span
                className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-normal bg-ink-50 text-ink-800 ring-1 ring-inset ring-ink-200 min-h-[26px]"
                title="Admission diagnosis"
              >
                <span className="font-semibold text-ink-600 mr-1">Dx:</span>
                <span className="truncate max-w-[200px]">{patient.diagnosis}</span>
              </span>
            )}

            {/* NEWS2 Escalation Chip */}
            {((patient.news2Score != null && patient.news2Score >= 5) || patient.isNews2Escalated) && (
              <span
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold bg-rose-100 text-rose-800 ring-1 ring-inset ring-rose-400 min-h-[26px]"
                title={`NEWS2 score is ${patient.news2Score ?? 5}. Clinical escalation triggered.`}
              >
                <span className="size-1.5 rounded-full bg-rose-600 animate-pulse" />
                <span>{`NEWS2: ${patient.news2Score ?? 5} (Escalated)`}</span>
              </span>
            )}

            {/* Status Badge */}
            <StatusBadge status={patient.status} variant={statusVariant} />

            {/* History Action (Doctor / Admin only) */}
            {userRole !== 'nurse' && (
              <button
                type="button"
                onClick={() => setIsHistoryDrawerOpen(true)}
                className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-semibold text-ink-700 bg-surface rounded border border-ink-200 hover:bg-ink-50 focus:outline-none focus:ring-1 focus:ring-primary min-h-[28px] cursor-pointer"
                aria-label="View admission history"
              >
                <FileTextIcon className="h-3 w-3" />
                <span>History</span>
              </button>
            )}

            {/* Print File Action (Doctor / Admin only) */}
            {userRole !== 'nurse' && (
              <button
                type="button"
                onClick={() => {
                  if (typeof window !== 'undefined') {
                    window.print();
                  }
                }}
                className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-semibold text-ink-700 bg-surface rounded border border-ink-200 hover:bg-ink-50 focus:outline-none focus:ring-1 focus:ring-primary min-h-[28px] cursor-pointer"
                aria-label="Print patient file"
              >
                <PrinterIcon className="h-3 w-3" />
                <span>Print file</span>
              </button>
            )}
          </div>
        </div>
      </section>

      {/* History Drawer */}
      <Drawer
        isOpen={isHistoryDrawerOpen}
        onClose={() => setIsHistoryDrawerOpen(false)}
        title="Admission History"
        patient={patientDrawerContext}
        footer={
          <button
            type="button"
            onClick={() => setIsHistoryDrawerOpen(false)}
            className="px-4 py-2 text-xs font-semibold rounded-md border border-ink-200 text-ink-700 hover:bg-ink-50 min-h-[44px]"
          >
            Close
          </button>
        }
      >
        <div className="space-y-4 text-xs text-ink-700">
          <p>
            Admission timeline for <span className="font-semibold">{formattedName}</span> (IPD #{patient.ipdNumber}).
          </p>
          <div className="rounded-md border border-ink-200 p-3 bg-surface space-y-1.5">
            <div className="font-semibold text-ink-800">Current Stay: Day {patient.dayOfStay ?? 1}</div>
            <div className="text-ink-600">Ward: {bedString || 'Unassigned'}</div>
            <div className="text-ink-600">Admitting Consultant: {formattedDoctor}</div>
            <div className="text-ink-600">Current Status: {patient.status}</div>
          </div>
        </div>
      </Drawer>
    </>
  );
}
