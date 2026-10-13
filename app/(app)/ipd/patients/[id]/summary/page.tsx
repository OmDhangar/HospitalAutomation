import React from 'react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireSession } from '@/lib/auth/session';
import { getAdmissionSummary } from '@/lib/services/ipd-census';
import { listActiveOrders } from '@/lib/services/ipd-medication-orders';
import { formatDoctor } from '@/lib/domain/doctor';
import { can } from '@/lib/domain/permissions';
import { AlertTriangleIcon, CheckIcon, ClockIcon, PillIcon } from '@/components/icons';

interface SummaryPageProps {
  params: Promise<{ id: string }>;
}

export default async function SummaryPage({ params }: SummaryPageProps) {
  const session = await requireSession();
  const { id } = await params;

  const [admission, activeOrders] = await Promise.all([
    getAdmissionSummary(session.hospitalId, id),
    listActiveOrders({ hospitalId: session.hospitalId, admissionId: id }),
  ]);

  if (!admission) notFound();

  const formattedDoctor = formatDoctor(admission.doctorName);

  return (
    <div className="space-y-6">
      {/* Overview Grid */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Admitting Consultant & Diagnosis */}
        <div className="bg-surface p-5 rounded-lg border border-ink-100 shadow-xs space-y-3">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-ink-500">
            Clinical Care Team
          </h2>
          <div>
            <div className="text-sm font-semibold text-ink-900">{formattedDoctor}</div>
            <div className="text-xs text-ink-500">Primary Admitting Consultant</div>
          </div>
          <div className="pt-2 border-t border-ink-100">
            <div className="text-xs font-semibold text-ink-700">Admission Diagnosis</div>
            <div className="text-xs text-ink-600 mt-0.5">
              {admission.reason || 'Diagnosis not recorded'}
            </div>
          </div>
        </div>

        {/* Ward & Bed Status */}
        <div className="bg-surface p-5 rounded-lg border border-ink-100 shadow-xs space-y-3">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-ink-500">
            Location & Occupancy
          </h2>
          <div>
            <div className="text-sm font-semibold text-ink-900">
              {admission.bed
                ? `${admission.bed.wardName} · Bed ${admission.bed.label}`
                : 'Awaiting Bed Assignment'}
            </div>
            <div className="text-xs text-ink-500">Current Nursing Station</div>
          </div>
          <div className="pt-2 border-t border-ink-100">
            <div className="text-xs font-semibold text-ink-700">Admission Date</div>
            <div className="text-xs text-ink-600 mt-0.5">
              {admission.admittedAt
                ? new Date(admission.admittedAt).toLocaleDateString(undefined, {
                    dateStyle: 'medium',
                  })
                : 'Not formally admitted'}
            </div>
          </div>
        </div>

        {/* Payer & Financial Clearance */}
        <div className="bg-surface p-5 rounded-lg border border-ink-100 shadow-xs space-y-3">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-ink-500">
            Payer & Billing
          </h2>
          <div>
            <div className="text-sm font-semibold text-ink-900">
              {admission.payer?.payerName || 'Self Pay (Cash)'}
            </div>
            <div className="text-xs text-ink-500">
              {admission.payer?.kind ? `Category: ${admission.payer.kind}` : 'Standard hospital tariff'}
            </div>
          </div>
          <div className="pt-2 border-t border-ink-100">
            <Link
              href={`/ipd/patients/${id}/discharge`}
              className="text-xs font-semibold text-primary hover:underline inline-flex items-center gap-1"
            >
              <span>View Discharge & Billing Readiness →</span>
            </Link>
          </div>
        </div>
      </div>

      {/* Active Orders Quick Card */}
      <div className="bg-surface p-5 rounded-lg border border-ink-100 shadow-xs space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <PillIcon className="size-4 text-primary" />
            <h2 className="text-sm font-semibold text-ink-900">
              Active Medication Orders ({activeOrders.length})
            </h2>
          </div>
          <Link
            href={`/ipd/patients/${id}/orders`}
            className="text-xs font-semibold text-primary hover:underline"
          >
            View all orders →
          </Link>
        </div>

        {activeOrders.length === 0 ? (
          <p className="text-xs text-ink-500 italic">
            No active medication orders recorded for this patient stay.
          </p>
        ) : (
          <ul className="divide-y divide-ink-100">
            {activeOrders.slice(0, 5).map((order) => (
              <li key={order.id} className="py-2.5 flex items-center justify-between text-xs">
                <div>
                  <span className="font-semibold text-ink-900">{order.medicineName}</span>
                  <span className="text-ink-500 ml-2">
                    {order.doseAmount} {order.doseUnit} • {order.route} • {order.frequencyCode ?? 'OD'}
                  </span>
                </div>
                <div className="text-ink-600">
                  {Array.isArray(order.scheduleTimes) && order.scheduleTimes.length > 0
                    ? (order.scheduleTimes as string[]).join(', ')
                    : 'Scheduled'}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Quick Navigation to Other Tabs */}
      <div className="bg-surface p-5 rounded-lg border border-ink-100 shadow-xs">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-ink-500 mb-3">
          Patient Chart Sheets
        </h2>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs font-semibold">
          <Link
            href={`/ipd/patients/${id}/orders`}
            className="p-3 rounded-md border border-ink-200 hover:bg-ink-50 text-ink-800 transition-colors"
          >
            Orders
          </Link>
          <Link
            href={`/ipd/patients/${id}/emar`}
            className="p-3 rounded-md border border-ink-200 hover:bg-ink-50 text-ink-800 transition-colors"
          >
            eMAR
          </Link>
          <Link
            href={`/ipd/patients/${id}/vitals`}
            className="p-3 rounded-md border border-ink-200 hover:bg-ink-50 text-ink-800 transition-colors"
          >
            Vitals & I/O
          </Link>
          <Link
            href={`/ipd/patients/${id}/discharge`}
            className="p-3 rounded-md border border-ink-200 hover:bg-ink-50 text-ink-800 transition-colors"
          >
            Discharge
          </Link>
        </div>
      </div>
    </div>
  );
}
