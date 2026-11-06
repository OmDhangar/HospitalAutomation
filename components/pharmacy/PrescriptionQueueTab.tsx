'use client';

import React, { useState, useEffect } from 'react';
import {
  getQueueAction,
  getBatchesAction,
  completeSaleAction,
} from '@/app/(app)/pharmacy/actions';
import { type FormattedReceipt } from '@/lib/domain/pharmacy';

interface PrescriptionQueueTabProps {
  onSaleCompleted: (receipt: FormattedReceipt) => void;
}

export default function PrescriptionQueueTab({
  onSaleCompleted,
}: PrescriptionQueueTabProps) {
  const [loading, setLoading] = useState(true);
  const [queue, setQueue] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Dispense Drawer State
  const [activePrescription, setActivePrescription] = useState<any | null>(null);
  const [dispenseItems, setDispenseItems] = useState<any[]>([]);
  const [paymentMode, setPaymentMode] = useState<'cash' | 'upi' | 'card'>('cash');
  const [submitting, setSubmitting] = useState(false);

  const loadQueue = async () => {
    setLoading(true);
    setError(null);
    const res = await getQueueAction();
    if (res.success && res.queue) {
      setQueue(res.queue);
    } else {
      setError(res.error || 'Failed to load queue');
    }
    setLoading(false);
  };

  useEffect(() => {
    loadQueue();
  }, []);

  const handleOpenDispense = async (rx: any) => {
    setActivePrescription(rx);
    // Prepare items with batch fetch
    const prepared = [];
    for (const item of rx.items) {
      const batchRes = await getBatchesAction(item.medicineId);
      const batches = batchRes.batches || [];
      const selectedBatch = batches[0] || null; // FEFO selection

      prepared.push({
        medicineId: item.medicineId,
        medicineName: item.medicineName,
        dose: item.dose,
        frequency: item.frequency,
        durationDays: item.durationDays,
        instructions: item.instructions,
        availableBatches: batches,
        selectedBatchId: selectedBatch?.batchId || '',
        selectedBatchNo: selectedBatch?.batchNo || 'N/A',
        selectedExpiry: selectedBatch?.expiry || 'N/A',
        quantity: Math.max(1, (item.durationDays || 3) * 2), // Default standard estimation
        unitPricePaise: Math.round((selectedBatch?.mrpPaise || 2000) * 0.9), // Net price approx
        mrpPaise: selectedBatch?.mrpPaise || 2000,
        gstRate: 12,
        discountPercent: 0,
      });
    }
    setDispenseItems(prepared);
  };

  const handleBatchChange = (index: number, batchId: string) => {
    setDispenseItems((prev) => {
      const next = [...prev];
      const batch = next[index].availableBatches.find((b: any) => b.batchId === batchId);
      if (batch) {
        next[index].selectedBatchId = batch.batchId;
        next[index].selectedBatchNo = batch.batchNo;
        next[index].selectedExpiry = batch.expiry;
        next[index].mrpPaise = batch.mrpPaise || 2000;
      }
      return next;
    });
  };

  const handleQuantityChange = (index: number, qty: number) => {
    setDispenseItems((prev) => {
      const next = [...prev];
      next[index].quantity = Math.max(1, qty);
      return next;
    });
  };

  const handleCompleteDispense = async () => {
    if (!activePrescription) return;
    setSubmitting(true);
    setError(null);

    const payload = {
      saleType: 'prescription' as const,
      prescriptionId: activePrescription.prescriptionId,
      patientId: activePrescription.patientId,
      customerName: activePrescription.patientName,
      customerPhone: activePrescription.patientPhone,
      doctorName: activePrescription.prescriberName,
      paymentMode,
      items: dispenseItems
        .filter((i) => i.selectedBatchId)
        .map((i) => ({
          medicineId: i.medicineId,
          batchId: i.selectedBatchId,
          batchNo: i.selectedBatchNo,
          expiryDate: i.selectedExpiry,
          quantity: i.quantity,
          unitPricePaise: i.unitPricePaise,
          mrpPaise: i.mrpPaise,
          gstRate: i.gstRate,
          discountPercent: i.discountPercent,
        })),
    };

    const res = await completeSaleAction(payload);
    setSubmitting(false);

    if (res.success && res.receipt) {
      setActivePrescription(null);
      loadQueue();
      onSaleCompleted(res.receipt);
    } else {
      setError(res.error || 'Failed to complete dispensing');
    }
  };

  return (
    <div className="space-y-6">
      {/* Top Header & Refresh */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">
            Outpatient Prescription Fulfillment Queue
          </h2>
          <p className="text-xs text-slate-500">
            Pending prescriptions issued by OPD doctors awaiting medicine dispensing
          </p>
        </div>
        <button
          onClick={loadQueue}
          disabled={loading}
          className="px-3 py-1.5 text-xs font-medium bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg transition-colors cursor-pointer"
        >
          {loading ? 'Refreshing...' : 'Refresh Queue'}
        </button>
      </div>

      {error && (
        <div className="p-4 bg-rose-50 border border-rose-200 text-rose-800 rounded-lg text-sm">
          {error}
        </div>
      )}

      {/* Prescription Queue Table */}
      {loading ? (
        <div className="p-12 text-center text-slate-400 text-sm">
          Loading active pharmacy queue...
        </div>
      ) : queue.length === 0 ? (
        <div className="p-12 text-center bg-white border border-slate-200 rounded-xl space-y-2">
          <div className="text-slate-400 text-sm">
            No pending outpatient prescriptions in the queue.
          </div>
          <p className="text-xs text-slate-500">
            New prescriptions generated during OPD doctor consultations will appear here automatically.
          </p>
        </div>
      ) : (
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-sm">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 border-b border-slate-200 text-xs font-semibold text-slate-600">
              <tr>
                <th className="py-3 px-4">Time</th>
                <th className="py-3 px-4">Patient / MRN</th>
                <th className="py-3 px-4">Doctor</th>
                <th className="py-3 px-4">Prescribed Medicines</th>
                <th className="py-3 px-4 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {queue.map((rx) => (
                <tr key={rx.prescriptionId} className="hover:bg-slate-50/50">
                  <td className="py-3 px-4 text-xs text-slate-500">
                    {new Date(rx.createdAt).toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </td>
                  <td className="py-3 px-4">
                    <div className="font-medium text-slate-900">
                      {rx.patientName}
                    </div>
                    <div className="text-xs text-slate-500 font-mono">
                      {rx.patientMrn || rx.patientPhone || 'No MRN'}
                    </div>
                  </td>
                  <td className="py-3 px-4 text-xs text-slate-700">
                    {rx.prescriberName}
                  </td>
                  <td className="py-3 px-4">
                    <div className="text-xs font-medium text-slate-800">
                      {rx.items.length} medication{rx.items.length === 1 ? '' : 's'}
                    </div>
                    <div className="text-[11px] text-slate-500 truncate max-w-xs">
                      {rx.items.map((i: any) => i.medicineName).join(', ')}
                    </div>
                  </td>
                  <td className="py-3 px-4 text-right">
                    <button
                      onClick={() => handleOpenDispense(rx)}
                      className="px-3 py-1.5 text-xs font-medium bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors shadow-sm cursor-pointer"
                    >
                      Dispense & Bill
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Dispense Modal Dialog */}
      {activePrescription && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="bg-white rounded-xl shadow-xl border border-slate-200 w-full max-w-3xl max-h-[90vh] overflow-y-auto p-6 space-y-6">
            <div className="flex justify-between items-start border-b pb-4">
              <div>
                <h3 className="text-lg font-semibold text-slate-900">
                  Dispense Prescription — {activePrescription.patientName}
                </h3>
                <p className="text-xs text-slate-500">
                  Doctor: {activePrescription.prescriberName} • MRN: {activePrescription.patientMrn || 'N/A'}
                </p>
              </div>
              <button
                onClick={() => setActivePrescription(null)}
                className="text-slate-400 hover:text-slate-600 cursor-pointer"
              >
                ✕
              </button>
            </div>

            {/* Prescribed Items Table with Batch & Quantity override */}
            <div className="space-y-4">
              <h4 className="text-xs font-semibold text-slate-700 uppercase tracking-wider">
                Prescribed Medications & FEFO Batch Allocation
              </h4>
              <div className="space-y-3">
                {dispenseItems.map((item, idx) => (
                  <div
                    key={idx}
                    className="p-3 bg-slate-50 border border-slate-200 rounded-lg flex flex-col md:flex-row md:items-center justify-between gap-3 text-xs"
                  >
                    <div className="flex-1">
                      <div className="font-medium text-slate-900 text-sm">
                        {item.medicineName}
                      </div>
                      <div className="text-slate-500">
                        {item.dose} • {item.frequency} • {item.durationDays ? `${item.durationDays} days` : 'Ongoing'}
                      </div>
                      {item.instructions && (
                        <div className="text-slate-600 italic">
                          "{item.instructions}"
                        </div>
                      )}
                    </div>

                    <div className="flex items-center gap-2">
                      <div>
                        <label className="block text-[10px] text-slate-500 mb-0.5">
                          Batch (FEFO)
                        </label>
                        <select
                          value={item.selectedBatchId}
                          onChange={(e) => handleBatchChange(idx, e.target.value)}
                          className="px-2 py-1 bg-white border border-slate-300 rounded text-xs font-mono"
                        >
                          {item.availableBatches.length === 0 ? (
                            <option value="">No stock available</option>
                          ) : (
                            item.availableBatches.map((b: any) => (
                              <option key={b.batchId} value={b.batchId}>
                                {b.batchNo} (Exp: {b.expiry}, Qty: {b.quantity})
                              </option>
                            ))
                          )}
                        </select>
                      </div>

                      <div className="w-20">
                        <label className="block text-[10px] text-slate-500 mb-0.5">
                          Quantity
                        </label>
                        <input
                          type="number"
                          min="1"
                          value={item.quantity}
                          onChange={(e) => handleQuantityChange(idx, parseInt(e.target.value) || 1)}
                          className="w-full px-2 py-1 bg-white border border-slate-300 rounded text-xs text-center"
                        />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Payment & Checkout Section */}
            <div className="p-4 bg-slate-100 rounded-xl space-y-4">
              <div className="flex flex-col sm:flex-row justify-between items-center gap-3">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-slate-700">
                    Payment Mode:
                  </span>
                  {(['cash', 'upi', 'card'] as const).map((mode) => (
                    <button
                      key={mode}
                      onClick={() => setPaymentMode(mode)}
                      className={`px-3 py-1.5 text-xs font-medium rounded-lg uppercase tracking-wider transition-colors cursor-pointer ${
                        paymentMode === mode
                          ? 'bg-blue-600 text-white shadow-sm'
                          : 'bg-white text-slate-700 border border-slate-200'
                      }`}
                    >
                      {mode}
                    </button>
                  ))}
                </div>

                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setActivePrescription(null)}
                    className="px-4 py-2 text-xs font-medium text-slate-600 hover:bg-slate-200 rounded-lg cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleCompleteDispense}
                    disabled={submitting}
                    className="px-5 py-2 text-xs font-medium bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg shadow-sm transition-colors cursor-pointer"
                  >
                    {submitting ? 'Dispensing...' : 'Confirm & Print Receipt'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
