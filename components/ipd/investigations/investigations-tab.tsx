'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { TestChip } from '@/lib/services/doctor-ipd';
import { OrderInvestigationModal } from './order-investigation-modal';

export interface InvestigationItem {
  id: string;
  name: string;
  category?: string;
  orderedAt: Date;
  status: 'ordered' | 'sample_collected' | 'in_lab' | 'reported';
  result?: string | null;
  normalRange?: string | null;
  isCritical?: boolean;
}

export interface InvestigationsTabProps {
  admissionId: string;
  investigations: InvestigationItem[];
  testChips?: TestChip[];
  canOrder?: boolean;
}

export function InvestigationsTab({
  admissionId,
  investigations,
  testChips = [],
  canOrder = true,
}: InvestigationsTabProps) {
  const router = useRouter();
  const [isModalOpen, setIsModalOpen] = useState(false);

  const handleRefresh = () => {
    router.refresh();
  };

  const criticalCount = investigations.filter((i) => i.isCritical).length;

  return (
    <div className="space-y-4">
      {/* Header Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 border-b border-ink-200 pb-3">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-bold text-ink-950">Laboratory &amp; Diagnostic Investigations</h2>
            {criticalCount > 0 && (
              <span className="rounded-full bg-rose-100 px-2 py-0.5 text-[10px] font-bold text-rose-800 animate-pulse">
                {criticalCount} Critical
              </span>
            )}
          </div>
          <p className="text-xs text-ink-500">
            Pathology, microbiology, and imaging reports with specimen collection tracker
          </p>
        </div>

        {canOrder && (
          <button
            type="button"
            onClick={() => setIsModalOpen(true)}
            className="inline-flex items-center rounded-lg bg-brand-700 px-3.5 py-1.5 text-xs font-bold text-white shadow-2xs hover:bg-brand-800 cursor-pointer"
          >
            + Order Tests
          </button>
        )}
      </div>

      {/* Investigations Table */}
      <div className="rounded-xl border border-ink-200/80 bg-white shadow-2xs overflow-hidden">
        {investigations.length === 0 ? (
          <div className="p-8 text-center text-xs text-ink-500">
            <p className="font-semibold text-ink-700">No laboratory or radiology tests ordered yet.</p>
            <p className="mt-1">
              Click &ldquo;+ Order Tests&rdquo; above to select diagnostics for specimen collection.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-xs">
              <thead>
                <tr className="border-b border-ink-200 bg-ink-50/80 text-[10px] font-bold uppercase tracking-wider text-ink-600">
                  <th className="px-3.5 py-2.5">Test Name</th>
                  <th className="px-3.5 py-2.5">Category</th>
                  <th className="px-3.5 py-2.5">Ordered At</th>
                  <th className="px-3.5 py-2.5">Specimen Status</th>
                  <th className="px-3.5 py-2.5">Result / Report Findings</th>
                  <th className="px-3.5 py-2.5">Normal Range</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {investigations.map((item) => {
                  const d = new Date(item.orderedAt);
                  const dateStr = d.toLocaleDateString('en-IN', {
                    day: 'numeric',
                    month: 'short',
                    hour: '2-digit',
                    minute: '2-digit',
                  });

                  return (
                    <tr
                      key={item.id}
                      className={`hover:bg-brand-50/20 transition-colors ${
                        item.isCritical
                          ? 'bg-rose-50/50'
                          : 'even:bg-ink-50/20'
                      }`}
                    >
                      {/* Name & Critical Flag */}
                      <td className="px-3.5 py-2.5 font-bold text-ink-950">
                        <div className="flex items-center gap-2">
                          <span>{item.name}</span>
                          {item.isCritical && (
                            <span className="rounded bg-rose-600 px-1.5 py-0.2 font-mono text-[9px] font-black uppercase text-white shadow-2xs">
                              CRITICAL
                            </span>
                          )}
                        </div>
                      </td>

                      {/* Category */}
                      <td className="px-3.5 py-2.5 text-ink-600 whitespace-nowrap text-[11px]">
                        <span className="rounded bg-ink-100 px-2 py-0.5 font-medium">
                          {item.category || 'General'}
                        </span>
                      </td>

                      {/* Ordered At */}
                      <td className="px-3.5 py-2.5 font-mono text-[11px] text-ink-500 whitespace-nowrap">
                        {dateStr}
                      </td>

                      {/* Specimen Status */}
                      <td className="px-3.5 py-2.5 whitespace-nowrap">
                        <span
                          className={`inline-flex items-center rounded-md px-2 py-0.5 text-[10px] font-bold ${
                            item.status === 'reported'
                              ? 'border border-emerald-300 bg-emerald-50 text-emerald-800'
                              : item.status === 'sample_collected'
                                ? 'border border-sky-300 bg-sky-50 text-sky-800'
                                : item.status === 'in_lab'
                                  ? 'border border-amber-300 bg-amber-50 text-amber-800'
                                  : 'border border-ink-200 bg-ink-100 text-ink-700'
                          }`}
                        >
                          {item.status === 'reported'
                            ? '✓ Report Ready'
                            : item.status === 'sample_collected'
                              ? 'Sample Collected'
                              : item.status === 'in_lab'
                                ? 'In Laboratory'
                                : 'Ordered'}
                        </span>
                      </td>

                      {/* Result */}
                      <td className="px-3.5 py-2.5 text-ink-800 font-mono text-xs">
                        {item.result ? (
                          <span className={item.isCritical ? 'font-bold text-rose-700' : ''}>
                            {item.result}
                          </span>
                        ) : (
                          <span className="text-ink-400 font-sans italic text-[11px]">
                            Awaiting laboratory processing…
                          </span>
                        )}
                      </td>

                      {/* Reference Range */}
                      <td className="px-3.5 py-2.5 font-mono text-[11px] text-ink-500">
                        {item.normalRange || '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Order Modal */}
      <OrderInvestigationModal
        admissionId={admissionId}
        isOpen={isModalOpen}
        testChips={testChips}
        onClose={() => setIsModalOpen(false)}
        onSuccess={handleRefresh}
      />
    </div>
  );
}
