'use client';

import React, { useState } from 'react';
import PrescriptionQueueTab from '@/components/pharmacy/PrescriptionQueueTab';
import CounterSaleTab from '@/components/pharmacy/CounterSaleTab';
import PharmacyReceiptModal from '@/components/pharmacy/PharmacyReceiptModal';
import { type FormattedReceipt } from '@/lib/domain/pharmacy';

export default function PharmacyCockpit() {
  const [activeTab, setActiveTab] = useState<'queue' | 'counter'>('queue');
  const [receipt, setReceipt] = useState<FormattedReceipt | null>(null);

  return (
    <div className="space-y-6">
      {/* Tab Navigation Toolbar */}
      <div className="flex border-b border-slate-200">
        <button
          onClick={() => setActiveTab('queue')}
          className={`pb-3 px-4 text-sm font-semibold transition-colors cursor-pointer border-b-2 -mb-px ${
            activeTab === 'queue'
              ? 'border-blue-600 text-blue-600'
              : 'border-transparent text-slate-500 hover:text-slate-800'
          }`}
        >
          OPD Prescription Queue
        </button>
        <button
          onClick={() => setActiveTab('counter')}
          className={`pb-3 px-4 text-sm font-semibold transition-colors cursor-pointer border-b-2 -mb-px ${
            activeTab === 'counter'
              ? 'border-blue-600 text-blue-600'
              : 'border-transparent text-slate-500 hover:text-slate-800'
          }`}
        >
          Walk-in Counter Sale (POS)
        </button>
      </div>

      {/* Active Tab View */}
      {activeTab === 'queue' ? (
        <PrescriptionQueueTab onSaleCompleted={(rec) => setReceipt(rec)} />
      ) : (
        <CounterSaleTab onSaleCompleted={(rec) => setReceipt(rec)} />
      )}

      {/* Printable Receipt Modal */}
      {receipt && (
        <PharmacyReceiptModal
          receipt={receipt}
          onClose={() => setReceipt(null)}
        />
      )}
    </div>
  );
}
