'use client';

import React, { useState } from 'react';

export type ActionModalProps = {
  claimId: string;
  expectedVersion: number;
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (action: string, payload: Record<string, any>) => Promise<void>;
};

export function RecordPreauthModal({
  claimId,
  expectedVersion,
  isOpen,
  onClose,
  onSubmit,
}: ActionModalProps) {
  const [rupees, setRupees] = useState('');
  const [submitting, setSubmitting] = useState(false);

  if (!isOpen) return null;

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    const amount = parseFloat(rupees);
    if (isNaN(amount) || amount <= 0) return;
    setSubmitting(true);
    try {
      await onSubmit('recordPreauthApproved', {
        claimId,
        expectedVersion,
        amountPaise: Math.round(amount * 100),
      });
      onClose();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-xs p-4">
      <div className="bg-white rounded-xl shadow-xl max-w-md w-full p-6 border border-ink-100">
        <h3 className="text-lg font-bold text-ink-900">Record Pre-Auth Approval</h3>
        <p className="text-xs text-ink-500 mt-1">
          Enter approved pre-authorization amount from insurer portal / guarantee letter.
        </p>

        <form onSubmit={handleSave} className="mt-4 space-y-4">
          <div>
            <label className="block text-xs font-semibold text-ink-700">Approved Amount (₹)</label>
            <input
              type="number"
              step="1"
              required
              value={rupees}
              onChange={(e) => setRupees(e.target.value)}
              placeholder="e.g. 50000"
              className="mt-1 w-full rounded-lg border border-ink-200 px-3 py-2 text-sm text-ink-900 focus:outline-hidden focus:ring-2 focus:ring-brand-500"
            />
          </div>

          <div className="flex items-center justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="px-4 py-2 text-xs font-medium text-ink-700 hover:bg-ink-50 rounded-lg"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="px-4 py-2 text-xs font-semibold text-white bg-brand-600 hover:bg-brand-700 rounded-lg disabled:opacity-50"
            >
              {submitting ? 'Saving...' : 'Confirm Approval'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export function LogQueryModal({
  claimId,
  expectedVersion,
  isOpen,
  onClose,
  onSubmit,
}: ActionModalProps) {
  const [category, setCategory] = useState('medical_necessity');
  const [description, setDescription] = useState('');
  const [slaMinutes, setSlaMinutes] = useState('120');
  const [submitting, setSubmitting] = useState(false);

  if (!isOpen) return null;

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!description.trim()) return;
    setSubmitting(true);
    try {
      await onSubmit('logQuery', {
        claimId,
        expectedVersion,
        queryCategory: category,
        queryDescription: description.trim(),
        slaMinutes: parseInt(slaMinutes, 10) || 120,
      });
      onClose();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-xs p-4">
      <div className="bg-white rounded-xl shadow-xl max-w-md w-full p-6 border border-ink-100">
        <h3 className="text-lg font-bold text-ink-900">Log Incoming TPA Query</h3>
        <p className="text-xs text-ink-500 mt-1">
          Record deficiency letter or portal query. Starts countdown timer.
        </p>

        <form onSubmit={handleSave} className="mt-4 space-y-4">
          <div>
            <label className="block text-xs font-semibold text-ink-700">Query Category</label>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="mt-1 w-full rounded-lg border border-ink-200 px-3 py-2 text-sm text-ink-900 bg-white"
            >
              <option value="medical_necessity">Medical Necessity & Justification</option>
              <option value="line_item_breakup">Line-item / Pharmacy Bill Breakup</option>
              <option value="past_medical_history_and_ped">Past History / Pre-Existing Disease</option>
              <option value="identity_mismatch">Identity / Card Mismatch</option>
              <option value="tariff_discrepancy">Hospital Tariff Non-Compliance</option>
              <option value="other">Other Administrative Deficiency</option>
            </select>
          </div>

          <div>
            <label className="block text-xs font-semibold text-ink-700">Query Description</label>
            <textarea
              required
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Paste exact query text from TPA portal..."
              className="mt-1 w-full rounded-lg border border-ink-200 px-3 py-2 text-sm text-ink-900"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-ink-700">SLA Window (Minutes)</label>
            <input
              type="number"
              required
              value={slaMinutes}
              onChange={(e) => setSlaMinutes(e.target.value)}
              className="mt-1 w-full rounded-lg border border-ink-200 px-3 py-2 text-sm text-ink-900"
            />
          </div>

          <div className="flex items-center justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="px-4 py-2 text-xs font-medium text-ink-700 hover:bg-ink-50 rounded-lg"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="px-4 py-2 text-xs font-semibold text-white bg-rose-600 hover:bg-rose-700 rounded-lg disabled:opacity-50"
            >
              {submitting ? 'Logging...' : 'Start SLA Countdown'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
