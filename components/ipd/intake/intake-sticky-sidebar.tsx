'use client';

import { CheckIcon, ClockIcon, AlertCircleIcon, BedIcon } from '@/components/icons';
import { Button, Card, cn } from '@/components/ui';

export interface IntakeChecklistState {
  hasPatient: boolean;
  hasDoctor: boolean;
  hasBed: boolean;
  hasArrived: boolean;
  hasAttendant: boolean;
  hasConsent: boolean;
  hasFinancial: boolean;
  isMlc: boolean;
  hasMlcPolice: boolean;
}

export interface IntakeStickySidebarProps {
  checklist: IntakeChecklistState;
  onSubmit: () => void;
  isSubmitting: boolean;
  submitLabel?: string;
}

export function IntakeStickySidebar({
  checklist,
  onSubmit,
  isSubmitting,
  submitLabel = 'Admit Patient',
}: IntakeStickySidebarProps) {
  // Items calculation
  const items = [
    { label: 'Patient Identity', ready: checklist.hasPatient, required: true },
    { label: 'Attending Consultant', ready: checklist.hasDoctor, required: true },
    { label: 'Ward & Bed Allocated', ready: checklist.hasBed, required: true },
    { label: 'Physical Ward Arrival', ready: checklist.hasArrived, required: false },
    { label: 'Attendant / Relative Contact', ready: checklist.hasAttendant, required: false },
    { label: 'Paper Consent Attested', ready: checklist.hasConsent, required: false },
    { label: 'Advance Deposit / Pre-auth', ready: checklist.hasFinancial, required: false },
  ];

  if (checklist.isMlc) {
    items.push({
      label: 'MLC Police Intimation',
      ready: checklist.hasMlcPolice,
      required: false,
    });
  }

  const completedCount = items.filter((i) => i.ready).length;
  const totalCount = items.length;
  const progressPercent = Math.round((completedCount / totalCount) * 100);

  // MVA requirement: Patient + Doctor + Bed
  const isMvaReady = checklist.hasPatient && checklist.hasDoctor && checklist.hasBed;
  const isFullyComplete = completedCount === totalCount;

  return (
    <div className="sticky top-4 space-y-3">
      <Card className="overflow-hidden border-ink-200 shadow-sm">
        <div className="border-b border-ink-100 bg-ink-50/60 px-4 py-3">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-bold uppercase tracking-wider text-ink-900">Intake Checklist</h3>
            <span className="text-xs font-bold text-brand-700">
              {`${completedCount} of ${totalCount} ready`}
            </span>
          </div>

          {/* Progress bar */}
          <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-ink-200">
            <div
              className={cn(
                'h-full transition-all duration-300',
                isFullyComplete ? 'bg-emerald-500' : isMvaReady ? 'bg-brand-600' : 'bg-amber-500',
              )}
              style={{ width: `${progressPercent}%` }}
            />
          </div>
        </div>

        {/* Checklist items */}
        <div className="p-3.5">
          <ul className="space-y-2">
            {items.map((item, idx) => (
              <li key={idx} className="flex items-center justify-between text-xs">
                <span
                  className={cn(
                    'flex items-center gap-2',
                    item.ready
                      ? 'font-medium text-ink-900'
                      : 'text-ink-500',
                  )}
                >
                  <span
                    className={cn(
                      'flex size-4 shrink-0 items-center justify-center rounded-full text-[10px]',
                      item.ready
                        ? 'bg-emerald-100 text-emerald-800'
                        : 'bg-ink-100 text-ink-400',
                    )}
                  >
                    {item.ready ? <CheckIcon className="size-2.5" /> : '○'}
                  </span>
                  {item.label}
                </span>

                {item.required && !item.ready ? (
                  <span className="text-[10px] font-bold text-rose-600 uppercase">Required</span>
                ) : item.ready ? (
                  <span className="text-[10px] text-emerald-600 font-semibold">Done</span>
                ) : (
                  <span className="text-[10px] text-ink-400">Optional</span>
                )}
              </li>
            ))}
          </ul>

          {/* MVA Ready Indicator */}
          <div className="mt-3.5 pt-3 border-t border-ink-100">
            {isMvaReady ? (
              <div className="mb-3 rounded-lg border border-brand-200 bg-brand-50/70 p-2 text-xs text-brand-900">
                <p className="font-semibold flex items-center gap-1.5">
                  <CheckIcon className="size-3.5 text-brand-600" />
                  Ready for Minimum Viable Admission
                </p>
                {!isFullyComplete && (
                  <p className="mt-0.5 text-[11px] text-brand-700/90 leading-tight">
                    Missing consent or deposit can be completed after admission without delaying clinical care.
                  </p>
                )}
              </div>
            ) : (
              <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50/70 p-2 text-xs text-amber-900">
                <p className="font-semibold flex items-center gap-1.5">
                  <AlertCircleIcon className="size-3.5 text-amber-600" />
                  Select Patient, Doctor & Bed
                </p>
              </div>
            )}

            {/* Primary Action Button */}
            <Button
              type="button"
              variant="primary"
              size="lg"
              onClick={onSubmit}
              disabled={!isMvaReady || isSubmitting}
              isLoading={isSubmitting}
              className="w-full h-11 gap-2 shadow-xs font-semibold text-sm"
            >
              <BedIcon className="size-4" />
              {submitLabel}
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}
