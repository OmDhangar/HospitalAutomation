'use client';

import React from 'react';
import { Card } from '@/components/ui';

export function TemplatePreviewCard({
  hospitalName,
  closureDate,
  reason,
  contactPhone,
  templateCode,
}: {
  hospitalName: string;
  closureDate?: string;
  reason?: string;
  contactPhone?: string;
  templateCode: string;
}) {
  const displayHospital = hospitalName || 'Hospital';
  const displayDate = closureDate || 'DD-MM-YYYY';
  const displayReason = reason || 'unforeseen circumstances';
  const displayContact = contactPhone || '+91 98765 43210';

  const currentTime = new Intl.DateTimeFormat('en-IN', {
    hour: 'numeric',
    minute: 'numeric',
    hour12: true,
  }).format(new Date());

  return (
    <Card className="overflow-hidden border-ink-200 bg-slate-50 shadow-sm">
      <div className="border-b border-ink-200 bg-emerald-800 px-4 py-2.5 text-white flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="flex size-7 items-center justify-center rounded-full bg-white/20 font-bold text-xs">
            WA
          </div>
          <div>
            <p className="text-xs font-semibold leading-tight">{displayHospital}</p>
            <p className="text-[10px] text-emerald-200 leading-tight">Official WhatsApp Notice</p>
          </div>
        </div>
        <span className="rounded bg-emerald-700/60 px-1.5 py-0.5 text-[10px] uppercase font-mono tracking-wider">
          Template Preview
        </span>
      </div>

      <div className="p-4 sm:p-5">
        <div className="max-w-md rounded-2xl rounded-tl-sm bg-white p-3.5 shadow-sm border border-emerald-100 text-ink-900">
          <p className="text-xs font-semibold text-emerald-800 mb-1">
            📢 Hospital Notice
          </p>
          <p className="text-sm leading-relaxed whitespace-pre-wrap">
            Hospital Notice: <strong className="text-ink-900">{displayHospital}</strong> will be closed on{' '}
            <strong className="text-ink-900">{displayDate}</strong> due to{' '}
            <span className="italic text-ink-700">{displayReason}</span>. For assistance or rescheduling please contact{' '}
            <strong className="text-ink-900">{displayContact}</strong> on phone.
          </p>
          <div className="mt-2 flex items-center justify-end gap-1 text-[10px] text-ink-400">
            <span>{currentTime}</span>
            <span>✓✓</span>
          </div>
        </div>

        <div className="mt-3 flex items-center gap-2 text-xs text-ink-500">
          <span className="inline-block size-2 rounded-full bg-emerald-500"></span>
          <span>Category: <strong className="text-ink-700">UTILITY</strong> (Approved for direct delivery outside 24h window)</span>
        </div>
      </div>
    </Card>
  );
}
