import React from 'react';
import Link from 'next/link';

export default function ExternalPharmacyBanner() {
  return (
    <div className="max-w-4xl mx-auto my-8 p-6 bg-white border border-slate-200 rounded-xl shadow-sm">
      <div className="flex items-start gap-4">
        <div className="p-3 bg-blue-50 text-blue-600 rounded-lg">
          <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
          </svg>
        </div>
        <div className="flex-1 space-y-3">
          <div className="flex items-center gap-2">
            <h2 className="text-xl font-semibold text-slate-900">
              External Pharmacy Mode Active
            </h2>
            <span className="px-2.5 py-0.5 text-xs font-medium bg-amber-100 text-amber-800 rounded-full">
              External Retail
            </span>
          </div>

          <p className="text-slate-600 leading-relaxed text-sm">
            This hospital operates with an <strong>external chemist / community pharmacy</strong> for outpatient services. Outpatient prescriptions issued during doctor consultations are provided directly to patients (printed or via WhatsApp) for external chemist fulfillment.
          </p>

          <div className="p-4 bg-slate-50 border border-slate-100 rounded-lg space-y-2">
            <div className="flex items-center gap-2 text-sm font-medium text-slate-800">
              <svg className="w-4 h-4 text-emerald-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
              <span>Inpatient (IPD) Medications are fully tracked</span>
            </div>
            <p className="text-xs text-slate-500">
              Hospital ward stock, crash-cart inventories, nursing administration records (eMAR), and IPD medications and ward stocks continue to be tracked in internal hospital stock.
            </p>
          </div>

          <div className="pt-2 flex flex-wrap gap-3">
            <Link
              href="/ipd/stock"
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors shadow-sm"
            >
              <span>Manage IPD Ward Stock</span>
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5l7 7m0 0l-7 7m7-7H3" />
              </svg>
            </Link>
            <Link
              href="/settings"
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors"
            >
              <span>Hospital Configuration</span>
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
