'use client';

import React from 'react';
import { Card, Button, cn } from '@/components/ui';
import type { NoticeType } from '@/lib/db/schema';
export type { NoticeType };

interface NoticeTypeStepProps {
  selectedType: NoticeType;
  onSelectType: (type: NoticeType) => void;
  onNext: () => void;
}

export function NoticeTypeStep({
  selectedType,
  onSelectType,
  onNext,
}: NoticeTypeStepProps) {
  const types: Array<{
    id: NoticeType;
    title: string;
    description: string;
    icon: string;
    available: boolean;
    badge?: string;
  }> = [
    {
      id: 'hospital_closure',
      title: 'Hospital Closure Notice',
      description:
        'Inform patients that the hospital or OPD will be closed on a specific date due to emergencies, holidays, or unforeseen events.',
      icon: '🏥',
      available: true,
      badge: 'Ready to send',
    },
    {
      id: 'doctor_schedule_change',
      title: 'Doctor Schedule Change',
      description:
        'Notify patients when a specific doctor’s consulting hours or session timing changes on an upcoming date.',
      icon: '👨‍⚕️',
      available: false,
      badge: 'Phase 2',
    },
    {
      id: 'appointment_change',
      title: 'Appointment Change Notice',
      description:
        'Send reschedule or change updates specifically targeted to booked outpatient appointments.',
      icon: '📅',
      available: false,
      badge: 'Phase 2',
    },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-bold text-ink-900">Step 1 — Select Notice Type</h2>
        <p className="mt-1 text-sm text-ink-600">
          Choose the purpose of this WhatsApp notice. Hospital closure notices prioritize affected appointment holders and recently active OPD patients.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {types.map((t) => {
          const isSelected = selectedType === t.id;
          return (
            <div
              key={t.id}
              onClick={() => {
                if (t.available) onSelectType(t.id);
              }}
              className={cn(
                'relative flex flex-col justify-between rounded-xl border p-5 transition-all',
                t.available
                  ? 'cursor-pointer hover:border-brand-500 hover:shadow-md'
                  : 'cursor-not-allowed opacity-60 bg-ink-50/50',
                isSelected
                  ? 'border-brand-600 bg-brand-50/30 ring-2 ring-brand-600 shadow-xs'
                  : 'border-ink-200 bg-white shadow-xs',
              )}
            >
              <div>
                <div className="flex items-center justify-between mb-3">
                  <span className="text-3xl">{t.icon}</span>
                  {t.badge ? (
                    <span
                      className={cn(
                        'rounded-full px-2 py-0.5 text-xs font-medium',
                        t.available
                          ? 'bg-emerald-100 text-emerald-800'
                          : 'bg-ink-200 text-ink-600',
                      )}
                    >
                      {t.badge}
                    </span>
                  ) : null}
                </div>
                <h3 className="text-base font-semibold text-ink-900">{t.title}</h3>
                <p className="mt-2 text-xs leading-relaxed text-ink-600">
                  {t.description}
                </p>
              </div>

              <div className="mt-5 pt-3 border-t border-ink-100 flex items-center justify-between text-xs font-medium">
                {isSelected ? (
                  <span className="text-brand-700 font-bold flex items-center gap-1">
                    ✓ Selected
                  </span>
                ) : t.available ? (
                  <span className="text-ink-500">Click to select</span>
                ) : (
                  <span className="text-ink-400">Coming soon</span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="flex justify-end pt-4 border-t border-ink-200">
        <Button
          variant="primary"
          onClick={onNext}
          disabled={!selectedType}
          className="min-w-32"
        >
          Continue to Notice Details →
        </Button>
      </div>
    </div>
  );
}
