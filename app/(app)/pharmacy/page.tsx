import React from 'react';
import { requireWritableSession } from '@/lib/auth/session';
import { getEntitlements } from '@/lib/services/entitlements';
import ExternalPharmacyBanner from '@/components/pharmacy/ExternalPharmacyBanner';
import PharmacyCockpit from '@/components/pharmacy/PharmacyCockpit';

export default async function PharmacyPage() {
  const session = await requireWritableSession();
  const entitlements = await getEntitlements(session.hospitalId);

  return (
    <div className="max-w-7xl mx-auto px-4 py-8 space-y-6">
      {/* Top Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-slate-200">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 tracking-tight">
            Pharmacy Dispensing & POS
          </h1>
          <p className="text-sm text-slate-500">
            Outpatient prescription fulfillment, walk-in counter retail, and batch-level FEFO inventory
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium bg-emerald-100 text-emerald-800">
            <span className="w-2 h-2 rounded-full bg-emerald-500" />
            Active Pharmacy Counter
          </span>
        </div>
      </div>

      {/* Entitlement Gating Check */}
      {!entitlements.hasInhousePharmacy ? (
        <ExternalPharmacyBanner />
      ) : (
        <PharmacyCockpit />
      )}
    </div>
  );
}
