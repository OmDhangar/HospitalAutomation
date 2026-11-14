'use client';

import React from 'react';
import { type FormattedReceipt } from '@/lib/domain/pharmacy';

interface PharmacyReceiptModalProps {
  receipt: FormattedReceipt;
  onClose: () => void;
}

export default function PharmacyReceiptModal({
  receipt,
  onClose,
}: PharmacyReceiptModalProps) {
  const handlePrint = () => {
    if (typeof window !== 'undefined') {
      window.print();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 overflow-y-auto">
      <div className="relative w-full max-w-lg bg-white rounded-xl shadow-2xl border border-slate-200 overflow-hidden my-8">
        {/* Top Header Toolbar (Hidden in Print) */}
        <div className="flex items-center justify-between px-6 py-4 bg-slate-900 text-white print:hidden">
          <div className="flex items-center gap-2">
            <svg className="w-5 h-5 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z" />
            </svg>
            <span className="font-semibold text-sm tracking-wide">
              Pharmacy Print Receipt
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handlePrint}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-blue-600 hover:bg-blue-500 rounded-lg transition-colors shadow-sm cursor-pointer"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z" />
              </svg>
              <span>Print (80mm / A4)</span>
            </button>
            <button
              onClick={onClose}
              className="p-1.5 text-slate-400 hover:text-white rounded-lg transition-colors cursor-pointer"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* Receipt Printable Canvas */}
        <div className="p-8 space-y-6 text-slate-800 font-sans print:p-0 print:m-0 print:w-full">
          {/* Hospital Letterhead */}
          <div className="text-center space-y-1 pb-4 border-b border-dashed border-slate-300">
            <h1 className="text-xl font-bold uppercase tracking-wider text-slate-900">
              {receipt.hospitalName}
            </h1>
            <p className="text-xs text-slate-600">{receipt.hospitalAddress}</p>
            <div className="flex justify-center gap-4 text-[11px] text-slate-500 pt-1">
              {receipt.drugLicenseNo !== 'N/A' && (
                <span>DL No: {receipt.drugLicenseNo}</span>
              )}
              {receipt.gstin !== 'N/A' && <span>GSTIN: {receipt.gstin}</span>}
            </div>
            <div className="pt-2">
              <span className="inline-block px-3 py-0.5 text-xs font-bold tracking-widest uppercase bg-slate-100 border border-slate-200 text-slate-800 rounded">
                {receipt.title}
              </span>
            </div>
          </div>

          {/* Metadata Grid */}
          <div className="grid grid-cols-2 gap-2 text-xs text-slate-700 py-2 border-b border-dashed border-slate-200">
            <div>
              <span className="text-slate-500">Bill No:</span>{' '}
              <strong className="text-slate-900">{receipt.saleNo}</strong>
            </div>
            <div className="text-right">
              <span className="text-slate-500">Date:</span>{' '}
              <span>{receipt.saleDateFormatted}</span>
            </div>
            <div>
              <span className="text-slate-500">Customer:</span>{' '}
              <strong className="text-slate-900">{receipt.customerName}</strong>
            </div>
            <div className="text-right">
              <span className="text-slate-500">Phone:</span>{' '}
              <span>{receipt.customerPhone}</span>
            </div>
            <div>
              <span className="text-slate-500">Doctor:</span>{' '}
              <span>{receipt.doctorName}</span>
            </div>
            <div className="text-right">
              <span className="text-slate-500">Pay Mode:</span>{' '}
              <strong className="text-slate-900">{receipt.paymentMode}</strong>
            </div>
          </div>

          {/* Line Items Table */}
          <div className="space-y-2">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-slate-300 text-slate-600 font-semibold">
                  <th className="py-1">Item Description</th>
                  <th className="py-1 text-center">Batch / Exp</th>
                  <th className="py-1 text-center">Qty</th>
                  <th className="py-1 text-right">Price</th>
                  <th className="py-1 text-right">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {receipt.items.map((item, idx) => (
                  <tr key={idx} className="align-top">
                    <td className="py-1.5 pr-1">
                      <div className="font-medium text-slate-900">
                        {item.medicineName}
                      </div>
                      <div className="text-[10px] text-slate-500">
                        GST {item.gstRate}%
                      </div>
                    </td>
                    <td className="py-1.5 text-center text-[11px] text-slate-600">
                      <div>{item.batchNo}</div>
                      <div className="text-[10px] text-slate-400">
                        {item.expiryDate}
                      </div>
                    </td>
                    <td className="py-1.5 text-center font-medium">
                      {item.quantity}
                    </td>
                    <td className="py-1.5 text-right text-slate-600">
                      ₹{(item.unitPricePaise / 100).toFixed(2)}
                    </td>
                    <td className="py-1.5 text-right font-medium text-slate-900">
                      ₹{(item.totalAmountPaise / 100).toFixed(2)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Totals Summary */}
          <div className="pt-3 border-t border-dashed border-slate-300 space-y-1.5 text-xs">
            <div className="flex justify-between text-slate-600">
              <span>Taxable Subtotal:</span>
              <span>{receipt.subtotalFormatted}</span>
            </div>
            <div className="flex justify-between text-slate-600">
              <span>CGST:</span>
              <span>{receipt.cgstFormatted}</span>
            </div>
            <div className="flex justify-between text-slate-600">
              <span>SGST:</span>
              <span>{receipt.sgstFormatted}</span>
            </div>
            {receipt.discountFormatted !== '₹0.00' && (
              <div className="flex justify-between text-emerald-600 font-medium">
                <span>Discount:</span>
                <span>-{receipt.discountFormatted}</span>
              </div>
            )}
            <div className="flex justify-between items-center text-sm font-bold text-slate-900 pt-2 border-t border-slate-200">
              <span>NET PAYABLE:</span>
              <span className="text-base text-blue-700">
                {receipt.totalFormatted}
              </span>
            </div>
          </div>

          {/* Footer Terms */}
          <div className="pt-4 border-t border-slate-200 text-center space-y-1">
            <p className="text-[10px] text-slate-500 leading-tight">
              {receipt.termsNotice}
            </p>
            <p className="text-[11px] font-semibold text-slate-700 tracking-wide uppercase pt-1">
              Thank You! Get Well Soon!
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
