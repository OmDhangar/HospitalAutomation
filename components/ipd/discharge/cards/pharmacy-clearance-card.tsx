'use client';

import React from 'react';
import Link from 'next/link';
import { StatusBadge } from '@/components/ipd/status-badge';
import { CheckIcon, FileTextIcon } from '@/components/icons';
import type { PharmacyReturnItem } from '@/lib/db/schema';

export interface PharmacyClearanceCardProps {
  admissionId: string;
  isCleared: boolean;
  pharmacyReturnedAt?: string | Date | null;
  pharmacyCreditNoteNo?: string | null;
  pharmacyCreditAmountPaise?: number;
  returnItems?: PharmacyReturnItem[];
  takeHomeCount?: number;
  takeHomeCounseled?: boolean;
  medRecCompleted?: boolean;
  onOpenDrawer: () => void;
}

export function PharmacyClearanceCard({
  admissionId,
  isCleared,
  pharmacyReturnedAt,
  pharmacyCreditNoteNo,
  pharmacyCreditAmountPaise = 0,
  returnItems = [],
  takeHomeCount = 0,
  takeHomeCounseled = false,
  medRecCompleted = false,
  onOpenDrawer,
}: PharmacyClearanceCardProps) {
  const creditAmountRupees = (pharmacyCreditAmountPaise / 100).toFixed(2);

  return (
    <div className="bg-surface p-4 rounded-xl border border-ink-200/80 shadow-2xs space-y-3.5 flex flex-col justify-between">
      <div className="space-y-2.5">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="size-5 rounded-full bg-primary/10 text-primary font-bold text-2xs flex items-center justify-center">
              2
            </span>
            <h3 className="text-xs font-bold text-ink-900">Pharmacy Clearance &amp; Returns</h3>
          </div>
          <StatusBadge
            status={
              isCleared
                ? 'Returns Cleared'
                : returnItems.length > 0
                  ? 'Returns Logged'
                  : 'Check Bedside'
            }
            variant={isCleared ? 'green' : returnItems.length > 0 ? 'amber' : 'blue'}
          />
        </div>

        <p className="text-2xs text-ink-500">
          Return unconsumed bedside medications, reconcile home medicines, and verify take-home counseling.
        </p>

        {/* 3 Structured Sub-sections */}
        <div className="pt-2 border-t border-ink-100 text-2xs space-y-2">
          {/* A. Bedside Return Slip & Credit Note */}
          <div className="p-2.5 bg-ink-50/70 rounded-lg border border-ink-200/80 space-y-1">
            <div className="flex items-center justify-between">
              <span className="font-bold text-ink-900">Bedside Return Slip:</span>
              <span className="font-semibold text-emerald-800">
                {returnItems.length > 0 ? `${returnItems.length} items returned` : '0 returned items'}
              </span>
            </div>
            {pharmacyCreditNoteNo ? (
              <div className="flex items-center justify-between text-3xs text-ink-600 font-mono">
                <span>Note: <strong className="text-ink-900">{pharmacyCreditNoteNo}</strong></span>
                <span className="text-emerald-700 font-bold">Credit: ₹{creditAmountRupees}</span>
              </div>
            ) : (
              <div className="text-3xs text-ink-500">No credit note issued yet</div>
            )}
          </div>

          {/* B. MedRec & Take-Home Prescriptions */}
          <div className="grid grid-cols-2 gap-2 text-2xs">
            <div className="p-2 rounded bg-ink-50 border border-ink-100">
              <span className="text-ink-500 block text-3xs">Clinical MedRec:</span>
              <span className={`font-semibold text-2xs ${medRecCompleted ? 'text-emerald-700' : 'text-amber-800'}`}>
                {medRecCompleted ? 'Reconciled ✓' : 'Review Needed'}
              </span>
            </div>
            <div className="p-2 rounded bg-ink-50 border border-ink-100">
              <span className="text-ink-500 block text-3xs">Take-Home Prescriptions:</span>
              <span className="font-bold text-ink-900 text-2xs">
                {takeHomeCount} medicine{takeHomeCount === 1 ? '' : 's'}
              </span>
            </div>
          </div>

          {/* C. Bedside Counseling Indicator */}
          <div className="flex items-center gap-1.5 text-2xs">
            {takeHomeCounseled ? (
              <div className="flex items-center gap-1 text-emerald-800 font-semibold">
                <CheckIcon className="size-3.5 text-emerald-600" />
                <span>Patient &amp; family counseled on take-home medications</span>
              </div>
            ) : (
              <span className="text-amber-800 font-medium">⚠️ Bedside medication counseling not yet documented</span>
            )}
          </div>
        </div>
      </div>

      <div className="pt-2 border-t border-ink-100 flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={onOpenDrawer}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded bg-primary text-white hover:bg-primary/90 shadow-2xs"
        >
          <FileTextIcon className="size-3.5" />
          <span>{isCleared ? 'View Return Slip & Counseling' : 'Log / View Return Slip'}</span>
        </button>

        <Link
          href={`/ipd/admissions/${admissionId}/medicines`}
          className="text-2xs font-semibold text-primary hover:underline"
        >
          MedRec File →
        </Link>
      </div>
    </div>
  );
}
