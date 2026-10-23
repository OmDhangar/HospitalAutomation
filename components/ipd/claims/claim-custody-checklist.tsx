'use client';

import { useState, useTransition } from 'react';
import { claimActionHandler } from '@/app/(app)/ipd/claims/actions';

export interface DocumentChecklistItem {
  docCategory: string;
  label: string;
  description: string;
  isPaperFiled: boolean;
  paperFiledAt?: string | null;
  physicalBoxOrFileNo?: string | null;
  notes?: string | null;
}

const DEFAULT_CATEGORIES: { category: string; label: string; description: string }[] = [
  { category: 'aadhaar_card', label: 'Patient Identity (Aadhaar / Govt ID)', description: 'Copy of Government Photo ID proof of patient & policyholder' },
  { category: 'insurance_card', label: 'Health Insurance Card / E-Card', description: 'TPA or Insurer card copy with active policy details' },
  { category: 'signed_claim_form', label: 'Signed Cashless / CKYC Form', description: 'Duly signed IRDAI cashless pre-authorization form' },
  { category: 'preauth_letter', label: 'Initial Pre-Auth Authorization', description: 'Approval / Denial letter from Payer/TPA' },
  { category: 'doctor_notes', label: 'Indoor Case Sheet & Vital Charts', description: 'Admission note, clinical examination, and TPR records' },
  { category: 'investigation_reports', label: 'Diagnostic Reports & Films', description: 'Lab blood reports, Radiology (USG/CT/X-ray), ECG' },
  { category: 'discharge_summary', label: 'Signed Discharge Summary', description: 'Attending consultant signed clinical discharge record' },
  { category: 'final_hospital_bill', label: 'Final Itemized Bill & Receipts', description: 'Detailed break-up bill with authorized hospital seal' },
  { category: 'pharmacy_slips', label: 'Pharmacy Slips & Implant Stickers', description: 'Original medicine purchase slips and manufacturer stickers' },
  { category: 'settlement_voucher', label: 'Settlement Voucher / Remittance', description: 'Final claim settlement letter and bank reference' },
];

export function ClaimCustodyChecklist({
  claimCaseId,
  admissionId,
  records,
  canEdit,
}: {
  claimCaseId: string;
  admissionId: string;
  records: Array<{
    docCategory: string;
    isPaperFiled: boolean;
    paperFiledAt?: Date | string | null;
    physicalBoxOrFileNo?: string | null;
    notes?: string | null;
  }>;
  canEdit: boolean;
}) {
  const [isPending, startTransition] = useTransition();
  const [editingCategory, setEditingCategory] = useState<string | null>(null);
  const [boxNumber, setBoxNumber] = useState('');
  const [notes, setNotes] = useState('');

  // Map existing records by category
  const recordMap = new Map(records.map((r) => [r.docCategory, r]));

  const items: DocumentChecklistItem[] = DEFAULT_CATEGORIES.map((cat) => {
    const existing = recordMap.get(cat.category);
    return {
      docCategory: cat.category,
      label: cat.label,
      description: cat.description,
      isPaperFiled: existing?.isPaperFiled ?? false,
      paperFiledAt: existing?.paperFiledAt ? new Date(existing.paperFiledAt).toLocaleString() : null,
      physicalBoxOrFileNo: existing?.physicalBoxOrFileNo ?? null,
      notes: existing?.notes ?? null,
    };
  });

  const filedCount = items.filter((i) => i.isPaperFiled).length;

  const handleToggle = (item: DocumentChecklistItem) => {
    if (!canEdit || isPending) return;
    const nextState = !item.isPaperFiled;
    startTransition(async () => {
      await claimActionHandler('updateCustodyRecord', {
        claimCaseId,
        admissionId,
        docCategory: item.docCategory,
        isPaperFiled: nextState,
        physicalBoxOrFileNo: item.physicalBoxOrFileNo,
        notes: item.notes,
      });
    });
  };

  const handleSaveDetails = (docCategory: string) => {
    if (!canEdit || isPending) return;
    const item = items.find((i) => i.docCategory === docCategory);
    startTransition(async () => {
      await claimActionHandler('updateCustodyRecord', {
        claimCaseId,
        admissionId,
        docCategory,
        isPaperFiled: item?.isPaperFiled ?? false,
        physicalBoxOrFileNo: boxNumber.trim() || null,
        notes: notes.trim() || null,
      });
      setEditingCategory(null);
    });
  };

  return (
    <div className="rounded-xl border border-ink-200 bg-white p-5 shadow-sm space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-ink-100 pb-3">
        <div>
          <h3 className="text-sm font-bold text-ink-900">Physical Document Custody Checklist</h3>
          <p className="text-xs text-ink-500">Track physical custody of paper proofs, reports, and box file numbers.</p>
        </div>
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200">
            {filedCount} / {items.length} Filed
          </span>
        </div>
      </div>

      <div className="divide-y divide-ink-100">
        {items.map((item) => (
          <div key={item.docCategory} className="py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="flex items-start gap-3">
              <input
                type="checkbox"
                checked={item.isPaperFiled}
                disabled={!canEdit || isPending}
                onChange={() => handleToggle(item)}
                className="mt-1 h-4 w-4 rounded border-ink-300 text-brand-600 focus:ring-brand-500 cursor-pointer disabled:cursor-not-allowed"
              />
              <div>
                <p className={`text-sm font-medium ${item.isPaperFiled ? 'text-ink-900 font-semibold' : 'text-ink-700'}`}>
                  {item.label}
                </p>
                <p className="text-xs text-ink-400">{item.description}</p>
                {item.isPaperFiled && (
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-ink-500">
                    {item.paperFiledAt && <span>Filed: {item.paperFiledAt}</span>}
                    {item.physicalBoxOrFileNo && (
                      <span className="inline-flex items-center px-2 py-0.5 rounded bg-ink-100 text-ink-800 font-mono">
                        Box/File: {item.physicalBoxOrFileNo}
                      </span>
                    )}
                    {item.notes && <span className="italic">"{item.notes}"</span>}
                  </div>
                )}
              </div>
            </div>

            {canEdit && (
              <div className="flex items-center self-end sm:self-center">
                {editingCategory === item.docCategory ? (
                  <div className="flex items-center gap-2 bg-ink-50 p-2 rounded-lg border border-ink-200">
                    <input
                      type="text"
                      placeholder="Box / File No."
                      value={boxNumber}
                      onChange={(e) => setBoxNumber(e.target.value)}
                      className="px-2 py-1 text-xs border border-ink-300 rounded bg-white w-28"
                    />
                    <input
                      type="text"
                      placeholder="Remarks"
                      value={notes}
                      onChange={(e) => setNotes(e.target.value)}
                      className="px-2 py-1 text-xs border border-ink-300 rounded bg-white w-32"
                    />
                    <button
                      type="button"
                      disabled={isPending}
                      onClick={() => handleSaveDetails(item.docCategory)}
                      className="px-2 py-1 text-xs bg-brand-600 text-white rounded font-medium hover:bg-brand-700"
                    >
                      Save
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditingCategory(null)}
                      className="px-2 py-1 text-xs text-ink-600 hover:text-ink-900"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      setEditingCategory(item.docCategory);
                      setBoxNumber(item.physicalBoxOrFileNo ?? '');
                      setNotes(item.notes ?? '');
                    }}
                    className="text-xs text-brand-600 hover:text-brand-800 font-medium px-2 py-1"
                  >
                    {item.physicalBoxOrFileNo ? 'Edit File #' : '+ Add File #'}
                  </button>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
