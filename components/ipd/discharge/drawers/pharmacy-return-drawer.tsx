'use client';

import React, { useState } from 'react';
import { Drawer } from '@/components/ipd/drawer';
import { CheckIcon, PlusIcon, XIcon } from '@/components/icons';
import type { PharmacyReturnItem } from '@/lib/db/schema';

export interface PharmacyReturnDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  admissionId: string;
  patientName?: string;
  initialItems?: PharmacyReturnItem[];
  activeOrders?: {
    id: string;
    medicineName: string;
    dose: string;
    route: string;
    frequency: string;
  }[];
  initialCreditNoteNo?: string | null;
  initialCreditAmountPaise?: number;
  initialCounseled?: boolean;
  initialCounselingNotes?: string | null;
  onSave: (data: {
    returnItems: PharmacyReturnItem[];
    creditNoteNo: string;
    creditAmountPaise: number;
    takeHomeCounseled: boolean;
    takeHomeCounselingNotes: string;
    cleared: boolean;
  }) => Promise<void>;
}

export function PharmacyReturnDrawer({
  isOpen,
  onClose,
  admissionId,
  patientName,
  initialItems = [],
  activeOrders = [],
  initialCreditNoteNo = '',
  initialCreditAmountPaise = 0,
  initialCounseled = false,
  initialCounselingNotes = '',
  onSave,
}: PharmacyReturnDrawerProps) {
  const [items, setItems] = useState<PharmacyReturnItem[]>(initialItems);
  const [creditNoteNo, setCreditNoteNo] = useState(initialCreditNoteNo || '');
  const [takeHomeCounseled, setTakeHomeCounseled] = useState(initialCounseled);
  const [counselingNotes, setCounselingNotes] = useState(initialCounselingNotes || '');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // New item draft inputs
  const [newItemName, setNewItemName] = useState('');
  const [newBatch, setNewBatch] = useState('');
  const [newDispensed, setNewDispensed] = useState<number>(1);
  const [newReturned, setNewReturned] = useState<number>(1);
  const [newUnitPrice, setNewUnitPrice] = useState<number>(0);
  const [newReason, setNewReason] = useState<'unconsumed' | 'discontinued' | 'changed_dose' | 'other'>('unconsumed');

  const totalCreditPaise = items.reduce((sum, item) => sum + (item.creditPaise || (item.returnedQty * (item.unitPricePaise || 0))), 0);

  const handleAddItem = () => {
    if (!newItemName.trim()) return;
    const creditPaise = newReturned * (newUnitPrice * 100);
    setItems([
      ...items,
      {
        medicineName: newItemName.trim(),
        batchNumber: newBatch.trim() || undefined,
        dispensedQty: Number(newDispensed) || 1,
        returnedQty: Number(newReturned) || 1,
        unitPricePaise: newUnitPrice * 100,
        creditPaise,
        reason: newReason,
      },
    ]);
    setNewItemName('');
    setNewBatch('');
    setNewDispensed(1);
    setNewReturned(1);
    setNewUnitPrice(0);
  };

  const handleRemoveItem = (index: number) => {
    setItems(items.filter((_, i) => i !== index));
  };

  const handleSelectFromActive = (order: (typeof activeOrders)[0]) => {
    setNewItemName(order.medicineName);
  };

  const handleSubmit = async (markCleared: boolean) => {
    setIsSubmitting(true);
    setError(null);
    try {
      await onSave({
        returnItems: items,
        creditNoteNo,
        creditAmountPaise: totalCreditPaise,
        takeHomeCounseled,
        takeHomeCounselingNotes: counselingNotes,
        cleared: markCleared,
      });
      onClose();
    } catch (err: any) {
      setError(err?.message || 'Failed to save pharmacy return records');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Drawer
      isOpen={isOpen}
      onClose={onClose}
      title="Pharmacy Returns & Dispensing Clearance"
      subtitle={`Inpatient Ward Stock Returns & Take-Home Counseling · ${patientName ?? 'Patient'}`}
      size="lg"
      footer={
        <div className="flex items-center justify-between gap-3 w-full">
          <button
            type="button"
            disabled={isSubmitting}
            onClick={() => handleSubmit(false)}
            className="px-3.5 py-2 text-xs font-semibold rounded border border-ink-200 text-ink-700 bg-surface hover:bg-ink-50 shadow-2xs"
          >
            {isSubmitting ? 'Saving...' : 'Save Draft'}
          </button>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-2 text-xs font-semibold text-ink-600 hover:text-ink-900"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={isSubmitting}
              onClick={() => handleSubmit(true)}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded bg-emerald-600 text-white hover:bg-emerald-700 shadow-2xs"
            >
              <CheckIcon className="size-4" />
              <span>{isSubmitting ? 'Saving...' : 'Sign off Pharmacy Clearance'}</span>
            </button>
          </div>
        </div>
      }
    >
      <div className="p-4 space-y-5 text-ink-900">
        {error && (
          <div className="p-3 bg-rose-50 border border-rose-200 text-rose-800 text-xs rounded-lg">
            {error}
          </div>
        )}

        {/* Section 1: Bedside Medicine Returns */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-xs font-bold text-ink-900">1. Bedside Medicine Returns to Pharmacy</h3>
              <p className="text-2xs text-ink-500">
                Log unconsumed ampoules, vials, and oral strips returned to the inpatient pharmacy desk.
              </p>
            </div>
            <span className="text-2xs font-bold px-2 py-0.5 rounded bg-amber-100 text-amber-800">
              {items.length} returned line{items.length === 1 ? '' : 's'}
            </span>
          </div>

          {/* Quick Select from Active IPD Orders */}
          {activeOrders.length > 0 && (
            <div className="p-2.5 bg-ink-50 rounded-lg border border-ink-200/80 space-y-1.5">
              <span className="text-2xs font-semibold text-ink-600">Quick-fill from active bedside orders:</span>
              <div className="flex flex-wrap gap-1.5">
                {activeOrders.map((order) => (
                  <button
                    key={order.id}
                    type="button"
                    onClick={() => handleSelectFromActive(order)}
                    className="text-2xs px-2 py-0.5 rounded border border-ink-300 bg-surface text-ink-800 hover:bg-brand-50 hover:border-brand-300"
                  >
                    + {order.medicineName} ({order.dose})
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Table of items */}
          {items.length > 0 ? (
            <div className="border border-ink-200 rounded-lg overflow-hidden">
              <table className="min-w-full divide-y divide-ink-200 text-2xs">
                <thead className="bg-ink-50 text-ink-600 font-semibold">
                  <tr>
                    <th className="px-2.5 py-2 text-left">Medicine Name</th>
                    <th className="px-2 py-2 text-center">Batch</th>
                    <th className="px-2 py-2 text-center">Disp / Ret</th>
                    <th className="px-2 py-2 text-right">Credit (₹)</th>
                    <th className="px-2 py-2 text-center">Reason</th>
                    <th className="px-2 py-2 text-right"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-100 bg-surface">
                  {items.map((item, idx) => (
                    <tr key={idx} className="hover:bg-ink-50/50">
                      <td className="px-2.5 py-2 font-medium text-ink-900">{item.medicineName}</td>
                      <td className="px-2 py-2 text-center text-ink-500 font-mono">{item.batchNumber || '—'}</td>
                      <td className="px-2 py-2 text-center font-bold">
                        <span className="text-ink-500">{item.dispensedQty}</span> /{' '}
                        <span className="text-emerald-700">{item.returnedQty}</span>
                      </td>
                      <td className="px-2 py-2 text-right font-semibold text-emerald-800">
                        ₹{((item.creditPaise || (item.returnedQty * (item.unitPricePaise || 0))) / 100).toFixed(2)}
                      </td>
                      <td className="px-2 py-2 text-center capitalize text-ink-600">{item.reason || 'unconsumed'}</td>
                      <td className="px-2 py-2 text-right">
                        <button
                          type="button"
                          onClick={() => handleRemoveItem(idx)}
                          className="text-rose-600 hover:text-rose-800 p-1"
                        >
                          <XIcon className="size-3.5" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="p-3 text-center border border-dashed border-ink-200 rounded-lg text-2xs text-ink-500">
              No return items logged. Add unused ampoules or tablets below, or confirm zero unconsumed bedside balance.
            </div>
          )}

          {/* Add New Line Form */}
          <div className="p-3 bg-surface rounded-lg border border-ink-200 space-y-2.5">
            <span className="text-2xs font-bold text-ink-700">Add returned item to slip:</span>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <input
                type="text"
                placeholder="Medicine Name (e.g. Inj Pantop 40mg)"
                value={newItemName}
                onChange={(e) => setNewItemName(e.target.value)}
                className="col-span-2 px-2.5 py-1.5 text-xs rounded border border-ink-200 focus:outline-none focus:ring-1 focus:ring-primary"
              />
              <input
                type="text"
                placeholder="Batch (optional)"
                value={newBatch}
                onChange={(e) => setNewBatch(e.target.value)}
                className="px-2.5 py-1.5 text-xs rounded border border-ink-200 focus:outline-none focus:ring-1 focus:ring-primary font-mono"
              />
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-2xs">
              <div>
                <label className="text-ink-500">Dispensed Qty</label>
                <input
                  type="number"
                  min="1"
                  value={newDispensed}
                  onChange={(e) => setNewDispensed(Number(e.target.value))}
                  className="w-full px-2 py-1 text-xs rounded border border-ink-200"
                />
              </div>
              <div>
                <label className="text-ink-500">Returned Qty</label>
                <input
                  type="number"
                  min="1"
                  value={newReturned}
                  onChange={(e) => setNewReturned(Number(e.target.value))}
                  className="w-full px-2 py-1 text-xs rounded border border-ink-200 font-bold text-emerald-800"
                />
              </div>
              <div>
                <label className="text-ink-500">Unit Rate (₹)</label>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={newUnitPrice || ''}
                  placeholder="0.00"
                  onChange={(e) => setNewUnitPrice(Number(e.target.value))}
                  className="w-full px-2 py-1 text-xs rounded border border-ink-200"
                />
              </div>
              <div>
                <label className="text-ink-500">Return Reason</label>
                <select
                  value={newReason}
                  onChange={(e) => setNewReason(e.target.value as any)}
                  className="w-full px-2 py-1 text-xs rounded border border-ink-200 bg-surface"
                >
                  <option value="unconsumed">Unconsumed</option>
                  <option value="discontinued">Discontinued</option>
                  <option value="changed_dose">Changed Dose</option>
                  <option value="other">Other</option>
                </select>
              </div>
            </div>
            <button
              type="button"
              onClick={handleAddItem}
              disabled={!newItemName.trim()}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-2xs font-semibold rounded bg-primary text-white hover:bg-primary/90 disabled:opacity-50"
            >
              <PlusIcon className="size-3" />
              <span>Add to Return Slip</span>
            </button>
          </div>

          {/* Credit Note & Settlement Summary */}
          <div className="p-3 bg-emerald-50/70 border border-emerald-200/80 rounded-lg flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 text-xs">
            <div>
              <span className="font-bold text-emerald-950">Total Return Credit:</span>{' '}
              <span className="font-extrabold text-sm text-emerald-800">₹{(totalCreditPaise / 100).toFixed(2)}</span>
              <p className="text-2xs text-emerald-700">Deducts automatically from running inpatient ledger.</p>
            </div>
            <div className="flex items-center gap-2">
              <label className="text-2xs font-bold text-emerald-900 whitespace-nowrap">Credit Note #:</label>
              <input
                type="text"
                placeholder="e.g. CR-2026-0891"
                value={creditNoteNo}
                onChange={(e) => setCreditNoteNo(e.target.value)}
                className="px-2.5 py-1 text-xs rounded border border-emerald-300 bg-surface font-mono font-bold text-emerald-900 focus:outline-none focus:ring-1 focus:ring-emerald-500"
              />
            </div>
          </div>
        </div>

        {/* Section 2: Take-Home Medication Counseling */}
        <div className="space-y-3 pt-3 border-t border-ink-200">
          <div>
            <h3 className="text-xs font-bold text-ink-900">2. Discharge Medication Dispensing &amp; Bedside Counseling</h3>
            <p className="text-2xs text-ink-500">
              Ensure take-home medications are explained before the patient departs the ward.
            </p>
          </div>

          <label className="flex items-start gap-2.5 text-xs text-ink-900 cursor-pointer p-3 rounded-lg border border-ink-200 bg-ink-50/50 hover:bg-ink-50">
            <input
              type="checkbox"
              checked={takeHomeCounseled}
              onChange={(e) => setTakeHomeCounseled(e.target.checked)}
              className="mt-0.5 size-4 rounded border-ink-300 text-primary focus:ring-primary"
            />
            <div>
              <span className="font-semibold">Patient &amp; Attendant Counseling Completed</span>
              <p className="text-2xs text-ink-500 mt-0.5">
                Dosage, timings, food interactions (empty stomach vs after meals), and high-alert warnings explained.
              </p>
            </div>
          </label>

          <div>
            <label className="text-2xs font-semibold text-ink-700">Counseling &amp; Handover Notes (optional):</label>
            <textarea
              rows={2}
              placeholder="e.g. Insulin pen usage demonstrated to son; warned about hypoglycemia signs."
              value={counselingNotes}
              onChange={(e) => setCounselingNotes(e.target.value)}
              className="w-full mt-1 p-2 text-xs rounded border border-ink-200 focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>
        </div>
      </div>
    </Drawer>
  );
}
