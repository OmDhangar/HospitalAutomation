'use client';

import React from 'react';
import { Card, Button, Field, Input } from '@/components/ui';
import { TemplatePreviewCard } from './template-preview-card';

export interface NoticeDetailsData {
  title: string;
  closureDate: string;
  closureDuration: string;
  reason: string;
  rescheduleInstructions: string;
  contactPhone: string;
  templateCode: string;
}

interface NoticeDetailsStepProps {
  hospitalName: string;
  data: NoticeDetailsData;
  onChange: (fields: Partial<NoticeDetailsData>) => void;
  onBack: () => void;
  onNext: () => void;
}

export function NoticeDetailsStep({
  hospitalName,
  data,
  onChange,
  onBack,
  onNext,
}: NoticeDetailsStepProps) {
  const isComplete = Boolean(
    data.title.trim() &&
    data.closureDate &&
    data.contactPhone.trim() &&
    data.reason.trim(),
  );

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-bold text-ink-900">Step 2 — Enter Notice Details</h2>
        <p className="mt-1 text-sm text-ink-600">
          Specify the hospital closure information and contact details. The approved WhatsApp template will dynamically format these fields into an official message.
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

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Closure Date" hint="Date the hospital is closed">
                <Input
                  type="date"
                  value={data.closureDate}
                  min={new Date().toISOString().split('T')[0]}
                  onChange={(e) => onChange({ closureDate: e.target.value })}
                  required
                />
              </Field>

              <Field label="Duration (Optional)" hint="e.g. Full day, Until 2:00 PM">
                <Input
                  type="text"
                  placeholder="Full day"
                  value={data.closureDuration}
                  onChange={(e) => onChange({ closureDuration: e.target.value })}
                />
              </Field>
            </div>

            <Field label="Reason / Explanation" hint="Inserted into template variable {{3}}">
              <Input
                type="text"
                placeholder="e.g. electrical maintenance work"
                value={data.reason}
                onChange={(e) => onChange({ reason: e.target.value })}
                required
              />
            </Field>

            <Field label="Hospital Contact Phone" hint="Phone number patients should call for queries or rescheduling">
              <Input
                type="tel"
                placeholder="+91 98200 12345"
                value={data.contactPhone}
                onChange={(e) => onChange({ contactPhone: e.target.value })}
                required
              />
            </Field>

            <Field label="Rescheduling Instructions (Optional)">
              <Input
                type="text"
                placeholder="Appointments will be rescheduled for the next clinic day"
                value={data.rescheduleInstructions}
                onChange={(e) => onChange({ rescheduleInstructions: e.target.value })}
              />
            </Field>
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
            reason={data.reason}
            contactPhone={data.contactPhone}
            templateCode={data.templateCode}
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
