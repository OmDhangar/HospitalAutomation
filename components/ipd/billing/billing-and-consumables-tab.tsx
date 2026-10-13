'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import type { BillLine, PaymentRow } from '@/lib/services/discharge-billing';

export interface BillingAndConsumablesTabProps {
  admissionId: string;
  lines: BillLine[];
  payments: PaymentRow[];
  totals: {
    subtotalPaise: number;
    discountPaise: number;
    taxPaise: number;
    totalPaise: number;
  };
  canManage?: boolean;
}

export function BillingAndConsumablesTab({
  admissionId,
  lines,
  payments,
  totals,
  canManage = true,
}: BillingAndConsumablesTabProps) {
  const [selectedCategory, setSelectedCategory] = useState<string>('ALL');

  // Compute payment totals
  const totalPaidPaise = payments
    .filter((p) => p.kind === 'payment' && !p.voidedAt)
    .reduce((sum, p) => sum + p.amountPaise, 0);

  const balanceDuePaise = Math.max(0, totals.totalPaise - totalPaidPaise);

  const activeLines = lines.filter((line) => {
    if (selectedCategory === 'ALL') return true;
    return line.itemType === selectedCategory;
  });

  const formatRupees = (paise: number) => {
    return (paise / 100).toLocaleString('en-IN', {
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    });
  };

  const handlePrint = () => {
    window.print();
  };

  return (
    <div className="space-y-4">
      {/* Top Header & Financial Overview */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 border-b border-ink-200 pb-3">
        <div>
          <h2 className="text-sm font-bold text-ink-950">Consumables &amp; Inpatient Billing</h2>
          <p className="text-xs text-ink-500">
            Real-time running charges ledger: bed days, medications, syringes, diagnostic tests, and doctor visits
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Link
            href={`/ipd/admissions/${admissionId}/treatment`}
            className="inline-flex items-center rounded-lg border border-ink-300 bg-white px-3 py-1.5 text-xs font-semibold text-ink-800 shadow-2xs hover:bg-ink-50"
          >
            + Bedside Supplies
          </Link>
          <button
            type="button"
            onClick={handlePrint}
            className="inline-flex items-center rounded-lg bg-brand-700 px-3.5 py-1.5 text-xs font-bold text-white shadow-2xs hover:bg-brand-800 cursor-pointer"
          >
            Print Interim Bill
          </button>
        </div>
      </div>

      {/* 3 Summary Financial Metric Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {/* Gross Total */}
        <div className="rounded-xl border border-ink-200/80 bg-white p-3.5 shadow-2xs">
          <span className="text-[10px] font-bold uppercase tracking-wider text-ink-500">
            Total Accrued Charges
          </span>
          <p className="mt-1 font-mono text-xl font-black text-ink-950">
            ₹ {formatRupees(totals.totalPaise)}
          </p>
          <p className="mt-0.5 text-[11px] text-ink-500 font-mono">
            Subtotal: ₹ {formatRupees(totals.subtotalPaise)}
            {totals.discountPaise > 0 && ` · Discount: -₹ ${formatRupees(totals.discountPaise)}`}
          </p>
        </div>

        {/* Advance Deposits Paid */}
        <div className="rounded-xl border border-emerald-200/80 bg-emerald-50/30 p-3.5 shadow-2xs">
          <span className="text-[10px] font-bold uppercase tracking-wider text-emerald-800">
            Advance Deposits Received
          </span>
          <p className="mt-1 font-mono text-xl font-black text-emerald-950">
            ₹ {formatRupees(totalPaidPaise)}
          </p>
          <p className="mt-0.5 text-[11px] text-emerald-700 font-mono">
            {payments.length} {payments.length === 1 ? 'payment receipt' : 'payment receipts'} recorded
          </p>
        </div>

        {/* Estimated Balance Due */}
        <div className="rounded-xl border border-brand-200/80 bg-brand-50/30 p-3.5 shadow-2xs">
          <span className="text-[10px] font-bold uppercase tracking-wider text-brand-800">
            Current Balance Due
          </span>
          <p className="mt-1 font-mono text-xl font-black text-brand-950">
            ₹ {formatRupees(balanceDuePaise)}
          </p>
          <p className="mt-0.5 text-[11px] text-brand-700 font-mono">
            Interim estimate · Subject to final discharge audit
          </p>
        </div>
      </div>

      {/* Category Filter Pills */}
      <div className="flex items-center gap-1.5 overflow-x-auto pb-1 text-xs">
        <span className="text-[11px] font-bold uppercase tracking-wider text-ink-500 mr-1">Filter:</span>
        {[
          { key: 'ALL', label: 'All Items' },
          { key: 'room', label: 'Room & Bed' },
          { key: 'medicine', label: 'Medicines' },
          { key: 'consumable', label: 'Consumables & Syringes' },
          { key: 'procedure', label: 'Procedures' },
          { key: 'service', label: 'Consultations' },
        ].map((cat) => (
          <button
            key={cat.key}
            type="button"
            onClick={() => setSelectedCategory(cat.key)}
            className={`rounded-lg px-2.5 py-1 text-xs font-semibold transition cursor-pointer ${
              selectedCategory === cat.key
                ? 'bg-ink-900 text-white shadow-2xs'
                : 'bg-white text-ink-700 border border-ink-200 hover:bg-ink-50'
            }`}
          >
            {cat.label}
          </button>
        ))}
      </div>

      {/* Itemized Running Ledger Table */}
      <div className="rounded-xl border border-ink-200/80 bg-white shadow-2xs overflow-hidden">
        {activeLines.length === 0 ? (
          <div className="p-8 text-center text-xs text-ink-500">
            <p className="font-semibold text-ink-700">No billable lines recorded for this category.</p>
            <p className="mt-1">
              Bed charges and medication entries are automatically posted into the running ledger as care is delivered.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-xs">
              <thead>
                <tr className="border-b border-ink-200 bg-ink-50/80 text-[10px] font-bold uppercase tracking-wider text-ink-600">
                  <th className="px-3.5 py-2.5">Date / Day</th>
                  <th className="px-3.5 py-2.5">Item Description</th>
                  <th className="px-3.5 py-2.5">Category</th>
                  <th className="px-3.5 py-2.5 text-right">Qty</th>
                  <th className="px-3.5 py-2.5 text-right">Unit Price</th>
                  <th className="px-3.5 py-2.5 text-right">Total Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100 font-mono text-[11px]">
                {activeLines.map((line) => {
                  const isVoided = Boolean(line.voidedAt);
                  return (
                    <tr
                      key={line.id}
                      className={`hover:bg-brand-50/20 transition-colors ${
                        isVoided
                          ? 'bg-ink-50/50 opacity-60'
                          : 'even:bg-ink-50/20'
                      }`}
                    >
                      {/* Date */}
                      <td className="px-3.5 py-2 text-ink-500 whitespace-nowrap">
                        {line.day || '—'}
                      </td>

                      {/* Description */}
                      <td className="px-3.5 py-2 font-sans font-bold text-ink-950">
                        <span className={isVoided ? 'line-through' : ''}>
                          {line.description}
                        </span>
                        {isVoided && (
                          <span className="ml-2 rounded bg-rose-100 px-1.5 py-0.2 font-mono text-[9px] font-bold text-rose-800">
                            VOIDED
                          </span>
                        )}
                      </td>

                      {/* Category */}
                      <td className="px-3.5 py-2 whitespace-nowrap">
                        <span
                          className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${
                            line.itemType === 'room'
                              ? 'bg-purple-100 text-purple-800'
                              : line.itemType === 'medicine'
                                ? 'bg-emerald-100 text-emerald-800'
                                : line.itemType === 'consumable'
                                  ? 'bg-sky-100 text-sky-800'
                                  : line.itemType === 'procedure'
                                    ? 'bg-amber-100 text-amber-800'
                                    : 'bg-brand-100 text-brand-800'
                          }`}
                        >
                          {line.itemType === 'room'
                            ? 'Bed & Room'
                            : line.itemType === 'medicine'
                              ? 'Medicine'
                              : line.itemType === 'consumable'
                                ? 'Consumable'
                                : line.itemType === 'procedure'
                                  ? 'Procedure'
                                  : 'Consultation'}
                        </span>
                      </td>

                      {/* Qty */}
                      <td className="px-3.5 py-2 text-right font-bold text-ink-900">
                        {line.quantity}
                      </td>

                      {/* Unit Price */}
                      <td className="px-3.5 py-2 text-right text-ink-700">
                        ₹ {formatRupees(line.unitPricePaise)}
                      </td>

                      {/* Total */}
                      <td className="px-3.5 py-2 text-right font-black text-ink-950">
                        <span className={isVoided ? 'line-through text-ink-400' : ''}>
                          ₹ {formatRupees(line.totalPaise)}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Advance Payments List */}
      {payments.length > 0 && (
        <div className="rounded-xl border border-ink-200/80 bg-white shadow-2xs overflow-hidden">
          <div className="border-b border-ink-200 bg-ink-50/60 px-4 py-2.5">
            <h3 className="text-xs font-bold uppercase tracking-wider text-ink-800">
              Advance Payments &amp; Deposit Receipts ({payments.length})
            </h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-xs">
              <thead>
                <tr className="border-b border-ink-200 bg-ink-50/40 text-[10px] font-bold uppercase tracking-wider text-ink-600">
                  <th className="px-3.5 py-2">Receipt Date</th>
                  <th className="px-3.5 py-2">Payment Type</th>
                  <th className="px-3.5 py-2">Payment Mode</th>
                  <th className="px-3.5 py-2 text-right">Amount Paid</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100 font-mono text-[11px]">
                {payments.map((p) => (
                  <tr key={p.id} className="hover:bg-brand-50/20">
                    <td className="px-3.5 py-2 text-ink-600 whitespace-nowrap">
                      {new Date(p.receivedAt).toLocaleDateString('en-IN', {
                        day: 'numeric',
                        month: 'short',
                        year: 'numeric',
                      })}
                    </td>
                    <td className="px-3.5 py-2 uppercase font-bold text-emerald-800">
                      {p.kind}
                    </td>
                    <td className="px-3.5 py-2 uppercase text-ink-700">
                      {p.method}
                    </td>
                    <td className="px-3.5 py-2 text-right font-black text-emerald-900">
                      ₹ {formatRupees(p.amountPaise)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
