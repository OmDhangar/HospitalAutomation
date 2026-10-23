'use client';

import React, { useEffect } from 'react';
import { Card, Button, Field, Input } from '@/components/ui';
import { TemplatePreviewCard } from './template-preview-card';
import { addDays } from '@/lib/domain/notice-dates';

import type { NoticeType } from './notice-type-step';

export interface NoticeDetailsData {
  title: string;
  isDateRange?: boolean;
  closureDate: string;
  closureEndDate: string;
  closureDuration: string;
  reopenDate?: string;
  reason: string;
  customMessage?: string;
  rescheduleInstructions: string;
  contactPhone: string;
  templateCode: string;
}

interface NoticeDetailsStepProps {
  hospitalName: string;
  noticeType?: NoticeType;
  data: NoticeDetailsData;
  onChange: (fields: Partial<NoticeDetailsData>) => void;
  onBack: () => void;
  onNext: () => void;
}

export function NoticeDetailsStep({
  hospitalName,
  noticeType = 'hospital_closure',
  data,
  onChange,
  onBack,
  onNext,
}: NoticeDetailsStepProps) {
  const isGeneral = noticeType === 'general_announcement';
  const isDateRange = Boolean(data.isDateRange);

  // Compute number of days between two dates
  const calculateDays = (startStr = data.closureDate, endStr = data.closureEndDate) => {
    if (!startStr) return 1;
    const targetEnd = endStr || startStr;
    const start = new Date(startStr).getTime();
    const end = new Date(targetEnd).getTime();
    if (isNaN(start) || isNaN(end) || end < start) return 1;
    return Math.round((end - start) / (1000 * 60 * 60 * 24)) + 1;
  };

  const dayCount = calculateDays();

  // Keep duration synced if range changes
  const handleRangeToggle = (range: boolean) => {
    if (range) {
      const end = data.closureEndDate && data.closureEndDate >= data.closureDate
        ? data.closureEndDate
        : data.closureDate;
      const days = calculateDays(data.closureDate, end);
      onChange({
        isDateRange: true,
        closureEndDate: end,
        closureDuration: days === 1 ? '1 day' : `${days} days`,
        reopenDate: addDays(end, 1),
      });
    } else {
      onChange({
        isDateRange: false,
        closureEndDate: data.closureDate,
        closureDuration: '1 day',
        reopenDate: addDays(data.closureDate, 1),
      });
    }
  };

  const handleStartDateChange = (val: string) => {
    if (!isDateRange) {
      onChange({
        closureDate: val,
        closureEndDate: val,
        closureDuration: '1 day',
        reopenDate: addDays(val, 1),
      });
      return;
    }

    const end = data.closureEndDate && data.closureEndDate >= val
      ? data.closureEndDate
      : val;
    const days = calculateDays(val, end);

    onChange({
      closureDate: val,
      closureEndDate: end,
      closureDuration: days === 1 ? '1 day' : `${days} days`,
      reopenDate: addDays(end, 1),
    });
  };

  const handleEndDateChange = (val: string) => {
    const days = calculateDays(data.closureDate, val);
    onChange({
      closureEndDate: val,
      closureDuration: days === 1 ? '1 day' : `${days} days`,
      reopenDate: addDays(val, 1),
    });
  };

  const isComplete = isGeneral
    ? Boolean(data.title.trim() && (data.customMessage || '').trim() && data.contactPhone.trim())
    : Boolean(
        data.title.trim() &&
        data.closureDate &&
        (!isDateRange || (data.closureEndDate && data.closureEndDate >= data.closureDate)) &&
        data.contactPhone.trim(),
      );

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-bold text-ink-900">
          {isGeneral ? 'Step 2 — Compose Announcement Message' : 'Step 2 — Enter Notice Details'}
        </h2>
        <p className="mt-1 text-sm text-ink-600">
          {isGeneral
            ? 'Draft your specialized message or announcement. The text will be formatted dynamically into the approved Meta WhatsApp template.'
            : 'Specify whether the hospital is closed for a single day or across a multi-day date interval. The approved WhatsApp template will dynamically format these fields into an official message.'}
        </p>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        {/* Form Inputs */}
        <div className="space-y-4 lg:col-span-7">
          <Card className="p-5 space-y-4">
            <Field label="Campaign Internal Title" hint="Visible to hospital administrators only">
              <Input
                type="text"
                placeholder="e.g. Emergency Closure - 24 Oct"
                value={data.title}
                onChange={(e) => onChange({ title: e.target.value })}
                required
              />
            </Field>

            {isGeneral ? (
              <>
                <Field
                  label="Custom Specialized Message"
                  hint="Type your complete notice or specialized announcement here. It will be delivered directly to the patient's WhatsApp."
                >
                  <textarea
                    className="w-full rounded-lg border border-ink-200 p-3 text-sm focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600 bg-white"
                    rows={6}
                    placeholder="e.g. Our hospital is organizing a Free Cardiac & Diabetes Checkup Camp this Sunday from 9:00 AM to 2:00 PM in the OPD block. Prior registration is recommended."
                    value={data.customMessage || ''}
                    onChange={(e) => onChange({ customMessage: e.target.value })}
                    maxLength={1000}
                    required
                  />
                  <div className="flex justify-between items-center text-[11px] text-ink-500 mt-1">
                    <span>Supports multi-line text, operational announcements, and instructions.</span>
                    <span>{(data.customMessage || '').length} / 1000 characters</span>
                  </div>
                </Field>

                <Field
                  label="Hospital Contact Phone"
                  hint="Helpline phone number patients should call for queries"
                >
                  <Input
                    type="tel"
                    placeholder="+91 98200 12345"
                    value={data.contactPhone}
                    onChange={(e) => onChange({ contactPhone: e.target.value })}
                    required
                  />
                </Field>

                <Field label="Additional Instructions (Optional)" hint="e.g. Special instructions for patients">
                  <Input
                    type="text"
                    placeholder="e.g. Please bring past medical reports or photo ID"
                    value={data.rescheduleInstructions}
                    onChange={(e) => onChange({ rescheduleInstructions: e.target.value })}
                  />
                </Field>
              </>
            ) : (
              <>
                {/* Single Day vs Date Interval Toggle */}
                <div className="space-y-1.5">
                  <label className="block text-sm font-medium text-ink-700">Closure Type</label>
                  <div className="grid grid-cols-2 gap-3">
                    <button
                      type="button"
                      onClick={() => handleRangeToggle(false)}
                      className={`flex flex-col p-3 rounded-lg border text-left transition-colors ${
                        !isDateRange
                          ? 'border-brand-600 bg-brand-50/50 ring-1 ring-brand-600 text-brand-900'
                          : 'border-ink-200 hover:bg-ink-50 text-ink-700'
                      }`}
                    >
                      <span className="text-xs font-bold">Single Day</span>
                      <span className="text-[11px] text-ink-500 mt-0.5">Closed on one specific date</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => handleRangeToggle(true)}
                      className={`flex flex-col p-3 rounded-lg border text-left transition-colors ${
                        isDateRange
                          ? 'border-brand-600 bg-brand-50/50 ring-1 ring-brand-600 text-brand-900'
                          : 'border-ink-200 hover:bg-ink-50 text-ink-700'
                      }`}
                    >
                      <span className="text-xs font-bold">Multi-Day Date Range</span>
                      <span className="text-[11px] text-ink-500 mt-0.5">Closed across an interval of days</span>
                    </button>
                  </div>
                </div>

                {/* Date Pickers */}
                {!isDateRange ? (
                  <div className="space-y-2">
                    <Field label="Closure Date" hint="Date the hospital is closed">
                      <Input
                        type="date"
                        value={data.closureDate}
                        min={new Date().toISOString().split('T')[0]}
                        onChange={(e) => handleStartDateChange(e.target.value)}
                        required
                      />
                    </Field>

                    <div className="flex items-center gap-2 p-2.5 rounded-lg bg-emerald-50/60 border border-emerald-200 text-xs text-emerald-800">
                      <span className="font-semibold">🗓️ Closure Duration:</span>
                      <span className="font-bold bg-white px-2 py-0.5 rounded border border-emerald-200 shadow-xs">
                        1 day
                      </span>
                      <span>({data.closureDate || 'Select date'})</span>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-3 p-3.5 rounded-lg bg-brand-50/30 border border-brand-100">
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                      <Field label="Closure Start Date" hint="First day of closure">
                        <Input
                          type="date"
                          value={data.closureDate}
                          min={new Date().toISOString().split('T')[0]}
                          onChange={(e) => handleStartDateChange(e.target.value)}
                          required
                        />
                      </Field>

                      <Field label="Closure End Date (Inclusive)" hint="Last day hospital remains closed">
                        <Input
                          type="date"
                          value={data.closureEndDate || data.closureDate}
                          min={data.closureDate || new Date().toISOString().split('T')[0]}
                          onChange={(e) => handleEndDateChange(e.target.value)}
                          required
                        />
                      </Field>
                    </div>

                    <div className="flex items-center gap-2 p-2.5 rounded-lg bg-brand-50/80 border border-brand-200 text-xs text-brand-900">
                      <span className="font-semibold">🗓️ Closure Duration:</span>
                      <span className="font-bold text-brand-700 bg-white px-2 py-0.5 rounded border border-brand-200 shadow-xs">
                        {dayCount} {dayCount === 1 ? 'day' : 'days'}
                      </span>
                      <span className="text-brand-700">
                        ({data.closureDate} to {data.closureEndDate || data.closureDate})
                      </span>
                    </div>
                  </div>
                )}

                <Field
                  label="Hospital Services Resume On (Reopening Date)"
                  hint="Date normal OPD and operations resume (inserted into template variable {{3}})"
                >
                  <Input
                    type="date"
                    value={data.reopenDate || addDays(data.closureEndDate || data.closureDate, 1)}
                    min={data.closureEndDate || data.closureDate}
                    onChange={(e) => onChange({ reopenDate: e.target.value })}
                    required
                  />
                </Field>

                <Field label="Hospital Contact Phone" hint="Helpline phone number patients can call for assistance (inserted into variable {{4}})">
                  <Input
                    type="tel"
                    placeholder="+91 98200 12345"
                    value={data.contactPhone}
                    onChange={(e) => onChange({ contactPhone: e.target.value })}
                    required
                  />
                </Field>

                <Field label="Internal Reason / Notes (Optional)" hint="For hospital administrative records">
                  <Input
                    type="text"
                    placeholder="e.g. Annual maintenance / Public holiday"
                    value={data.reason}
                    onChange={(e) => onChange({ reason: e.target.value })}
                  />
                </Field>
              </>
            )}
          </Card>
        </div>

        {/* Live Template Preview */}
        <div className="space-y-3 lg:col-span-5">
          <p className="text-xs font-semibold uppercase tracking-wider text-ink-500">
            Live Template Preview
          </p>
          <TemplatePreviewCard
            hospitalName={hospitalName}
            closureDate={data.closureDate}
            closureEndDate={isDateRange ? data.closureEndDate : undefined}
            reopenDate={data.reopenDate}
            reason={data.reason}
            customMessage={data.customMessage}
            contactPhone={data.contactPhone}
            templateCode={isGeneral ? 'general_announcement' : data.templateCode}
          />
        </div>
      </div>

      <div className="flex items-center justify-between pt-4 border-t border-ink-200">
        <Button variant="secondary" onClick={onBack}>
          ← Back to Notice Type
        </Button>
        <Button
          variant="primary"
          onClick={onNext}
          disabled={!isComplete}
          className="min-w-32"
        >
          Continue to Select Recipients →
        </Button>
      </div>
    </div>
  );
}
