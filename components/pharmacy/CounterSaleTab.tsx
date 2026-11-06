'use client';

import React, { useState } from 'react';
import {
  searchMedicinesAction,
  getBatchesAction,
  completeSaleAction,
} from '@/app/(app)/pharmacy/actions';
import { calculateItemTax, calculateSaleTotals, type FormattedReceipt } from '@/lib/domain/pharmacy';

interface CounterSaleTabProps {
  onSaleCompleted: (receipt: FormattedReceipt) => void;
}

export default function CounterSaleTab({
  onSaleCompleted,
}: CounterSaleTabProps) {
  const [customerName, setCustomerName] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [doctorName, setDoctorName] = useState('');
  const [paymentMode, setPaymentMode] = useState<'cash' | 'upi' | 'card'>('cash');

  // Search & Cart State
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [searching, setSearching] = useState(false);
  const [cartItems, setCartItems] = useState<any[]>([]);
  const [billDiscountPaise, setBillDiscountPaise] = useState(0);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSearch = async (query: string) => {
    setSearchQuery(query);
    if (!query.trim()) {
      setSearchResults([]);
      return;
    }
    setSearching(true);
    const res = await searchMedicinesAction(query);
    setSearchResults(res.medicines || []);
    setSearching(false);
  };

  const handleSelectMedicine = async (med: any) => {
    setSearchQuery('');
    setSearchResults([]);

    // Fetch batches
    const batchRes = await getBatchesAction(med.id);
    const batches = batchRes.batches || [];
    const selected = batches[0] || null;

    if (!selected) {
      alert(`No active stock batches found for ${med.name}`);
      return;
    }

    const price = med.sellingPricePaise || selected.mrpPaise || 2000;
    const tax = calculateItemTax({
      unitPricePaise: price,
      quantity: 1,
      discountPercent: 0,
      gstRate: 12,
    });

    setCartItems((prev) => [
      ...prev,
      {
        medicineId: med.id,
        medicineName: med.name,
        availableBatches: batches,
        selectedBatchId: selected.batchId,
        selectedBatchNo: selected.batchNo,
        selectedExpiry: selected.expiry,
        quantity: 1,
        unitPricePaise: price,
        mrpPaise: selected.mrpPaise || price,
        discountPercent: 0,
        gstRate: 12,
        tax,
      },
    ]);
  };

  const handleItemBatchChange = (index: number, batchId: string) => {
    setCartItems((prev) => {
      const next = [...prev];
      const batch = next[index].availableBatches.find((b: any) => b.batchId === batchId);
      if (batch) {
        next[index].selectedBatchId = batch.batchId;
        next[index].selectedBatchNo = batch.batchNo;
        next[index].selectedExpiry = batch.expiry;
      }
      return next;
    });
  };

  const handleItemQtyChange = (index: number, qty: number) => {
    setCartItems((prev) => {
      const next = [...prev];
      const validQty = Math.max(1, qty);
      next[index].quantity = validQty;
      next[index].tax = calculateItemTax({
        unitPricePaise: next[index].unitPricePaise,
        quantity: validQty,
        discountPercent: next[index].discountPercent,
        gstRate: next[index].gstRate,
      });
      return next;
    });
  };

  const handleRemoveItem = (index: number) => {
    setCartItems((prev) => prev.filter((_, i) => i !== index));
  };

  const totals = calculateSaleTotals(
    cartItems.map((i) => i.tax),
    billDiscountPaise
  );

  const handleCompleteSale = async () => {
    if (!customerName.trim()) {
      setError('Please enter Customer / Patient Name');
      return;
    }
    if (cartItems.length === 0) {
      setError('Please add at least one item to the sale');
      return;
    }

    setSubmitting(true);
    setError(null);

    const payload = {
      saleType: 'counter' as const,
      customerName: customerName.trim(),
      customerPhone: customerPhone.trim() || undefined,
      doctorName: doctorName.trim() || undefined,
      paymentMode,
      billDiscountPaise,
      items: cartItems.map((i) => ({
        medicineId: i.medicineId,
        batchId: i.selectedBatchId,
        batchNo: i.selectedBatchNo,
        expiryDate: i.selectedExpiry,
        quantity: i.quantity,
        unitPricePaise: i.unitPricePaise,
        mrpPaise: i.mrpPaise,
        discountPercent: i.discountPercent,
        gstRate: i.gstRate,
      })),
    };

    const res = await completeSaleAction(payload);
    setSubmitting(false);

    if (res.success && res.receipt) {
      // Clear form
      setCartItems([]);
      setCustomerName('');
      setCustomerPhone('');
      setDoctorName('');
      onSaleCompleted(res.receipt);
    } else {
      setError(res.error || 'Failed to complete sale');
    }
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      {/* Left 2 Cols: Search & Item Register */}
      <div className="lg:col-span-2 space-y-4">
        {/* Search Medicine Input */}
        <div className="relative">
          <label className="block text-xs font-semibold text-slate-700 uppercase tracking-wider mb-1">
            Quick Medicine Search (Brand or Generic Molecule)
          </label>
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => handleSearch(e.target.value)}
            placeholder="Type medicine name (e.g. Paracetamol, Amoxicillin, Pantoprazole)..."
            className="w-full px-4 py-2.5 bg-white border border-slate-300 rounded-xl text-sm focus:ring-2 focus:ring-blue-500 focus:outline-none shadow-sm"
          />

          {/* Autocomplete Dropdown */}
          {searchResults.length > 0 && (
            <div className="absolute left-0 right-0 top-full mt-1 bg-white border border-slate-200 rounded-xl shadow-xl z-20 max-h-60 overflow-y-auto divide-y divide-slate-100">
              {searchResults.map((med) => (
                <div
                  key={med.id}
                  onClick={() => handleSelectMedicine(med)}
                  className="p-3 hover:bg-blue-50 cursor-pointer flex justify-between items-center text-sm"
                >
                  <div>
                    <div className="font-semibold text-slate-900">{med.name}</div>
                    <div className="text-xs text-slate-500">
                      {med.genericName || 'Generic'} • {med.form || 'Tablet'}
                    </div>
                  </div>
                  <div className="text-right">
                    <span className="text-xs font-semibold text-blue-700">
                      ₹{((med.sellingPricePaise || 0) / 100).toFixed(2)}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {error && (
          <div className="p-3 bg-rose-50 border border-rose-200 text-rose-700 rounded-lg text-xs">
            {error}
          </div>
        )}

        {/* Counter Cart Line Items */}
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-sm">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 border-b border-slate-200 text-slate-600 font-semibold">
              <tr>
                <th className="py-3 px-3">Item Description</th>
                <th className="py-3 px-2">Batch (FEFO)</th>
                <th className="py-3 px-2 text-center w-20">Qty</th>
                <th className="py-3 px-2 text-right">Price</th>
                <th className="py-3 px-2 text-right">GST %</th>
                <th className="py-3 px-3 text-right">Total</th>
                <th className="py-3 px-2 text-center w-8"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {cartItems.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-10 text-center text-slate-400">
                    Cart is empty. Search and add medicines above for instant counter sale.
                  </td>
                </tr>
              ) : (
                cartItems.map((item, idx) => (
                  <tr key={idx} className="hover:bg-slate-50/50">
                    <td className="py-2.5 px-3 font-medium text-slate-900">
                      {item.medicineName}
                    </td>
                    <td className="py-2.5 px-2">
                      <select
                        value={item.selectedBatchId}
                        onChange={(e) => handleItemBatchChange(idx, e.target.value)}
                        className="px-2 py-1 bg-white border border-slate-200 rounded text-[11px] font-mono"
                      >
                        {item.availableBatches.map((b: any) => (
                          <option key={b.batchId} value={b.batchId}>
                            {b.batchNo} (Exp: {b.expiry}, Qty: {b.quantity})
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="py-2.5 px-2 text-center">
                      <input
                        type="number"
                        min="1"
                        value={item.quantity}
                        onChange={(e) => handleItemQtyChange(idx, parseInt(e.target.value) || 1)}
                        className="w-16 px-1 py-1 border border-slate-200 rounded text-center text-xs"
                      />
                    </td>
                    <td className="py-2.5 px-2 text-right text-slate-600">
                      ₹{(item.unitPricePaise / 100).toFixed(2)}
                    </td>
                    <td className="py-2.5 px-2 text-right text-slate-500">
                      {item.gstRate}%
                    </td>
                    <td className="py-2.5 px-3 text-right font-semibold text-slate-900">
                      ₹{(item.tax.totalAmountPaise / 100).toFixed(2)}
                    </td>
                    <td className="py-2.5 px-2 text-center">
                      <button
                        onClick={() => handleRemoveItem(idx)}
                        className="text-slate-400 hover:text-rose-600 text-sm cursor-pointer"
                      >
                        ×
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Right Col: Customer & Checkout Panel */}
      <div className="space-y-4">
        {/* Customer Information Card */}
        <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-3 shadow-sm text-xs">
          <h3 className="font-semibold text-slate-900 text-sm border-b pb-2">
            Customer / Patient Info
          </h3>
          <div>
            <label className="block text-slate-600 mb-1">
              Customer Name <span className="text-rose-500">*</span>
            </label>
            <input
              type="text"
              value={customerName}
              onChange={(e) => setCustomerName(e.target.value)}
              placeholder="e.g. Walk-in Customer"
              className="w-full px-3 py-1.5 border border-slate-300 rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-500 text-xs"
            />
          </div>
          <div>
            <label className="block text-slate-600 mb-1">Phone Number (Optional)</label>
            <input
              type="tel"
              value={customerPhone}
              onChange={(e) => setCustomerPhone(e.target.value)}
              placeholder="+91..."
              className="w-full px-3 py-1.5 border border-slate-300 rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-500 text-xs"
            />
          </div>
          <div>
            <label className="block text-slate-600 mb-1">Prescribing Doctor (Optional)</label>
            <input
              type="text"
              value={doctorName}
              onChange={(e) => setDoctorName(e.target.value)}
              placeholder="Dr..."
              className="w-full px-3 py-1.5 border border-slate-300 rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-500 text-xs"
            />
          </div>
        </div>

        {/* Payment & Summary Card */}
        <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-4 shadow-sm text-xs">
          <h3 className="font-semibold text-slate-900 text-sm border-b pb-2">
            Payment & Billing Summary
          </h3>

          <div className="space-y-2">
            <div className="flex justify-between text-slate-600">
              <span>Taxable Value:</span>
              <span>₹{(totals.subtotalPaise / 100).toFixed(2)}</span>
            </div>
            <div className="flex justify-between text-slate-600">
              <span>CGST:</span>
              <span>₹{(totals.totalCgstPaise / 100).toFixed(2)}</span>
            </div>
            <div className="flex justify-between text-slate-600">
              <span>SGST:</span>
              <span>₹{(totals.totalSgstPaise / 100).toFixed(2)}</span>
            </div>
            <div className="flex justify-between items-center text-sm font-bold text-slate-900 pt-2 border-t border-dashed">
              <span>GRAND TOTAL:</span>
              <span className="text-base text-blue-700">
                ₹{(totals.totalPaise / 100).toFixed(2)}
              </span>
            </div>
          </div>

          <div className="space-y-2 pt-2 border-t">
            <label className="block text-slate-600 font-medium">Payment Mode</label>
            <div className="grid grid-cols-3 gap-2">
              {(['cash', 'upi', 'card'] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setPaymentMode(mode)}
                  className={`py-2 text-xs font-semibold rounded-lg uppercase tracking-wider transition-colors cursor-pointer ${
                    paymentMode === mode
                      ? 'bg-blue-600 text-white shadow-sm'
                      : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                  }`}
                >
                  {mode}
                </button>
              ))}
            </div>
          </div>

          <button
            onClick={handleCompleteSale}
            disabled={submitting || cartItems.length === 0}
            className="w-full py-3 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white font-semibold text-sm rounded-xl shadow transition-colors cursor-pointer"
          >
            {submitting ? 'Processing Sale...' : 'Complete & Print Cash Memo'}
          </button>
        </div>
      </div>
    </div>
  );
}
