'use client';

import { useState, useTransition, useMemo } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { cn, Button } from '@/components/ui';
import { ArrowLeftIcon, CheckIcon, SearchIcon, UndoIcon, WifiOffIcon } from '@/components/icons';
import { AdministerModal } from '@/components/ipd/emar/administer-modal';
import { ExceptionModal } from '@/components/ipd/emar/exception-modal';
import { PrnAdminModal } from '@/components/ipd/emar/prn-admin-modal';
import { AdjustScheduleTimingModal } from '@/components/ipd/emar/adjust-schedule-timing-modal';
import { NurseUrgentAdminModal } from '@/components/ipd/emar/nurse-urgent-admin-modal';
import { voidAdministrationAction } from '@/app/(app)/ipd/actions';
import { queueEntries, sendEntries, type OutboxEntry } from '@/components/ipd/outbox';
import { useOnline } from '@/components/ipd/use-online';
import { DUPLICATE_WINDOW_MS, UNDO_WINDOW_MS } from '@/lib/domain/care-entry';
import type {
  BedsideDueItem,
  BedsidePrnItem,
  BedsideEmarView,
} from '@/lib/services/ipd-emar';
import type { AllergenItem } from '@/lib/services/ipd-rounding-cockpit';
import { formatDoctor } from '@/lib/domain/doctor';
import { formatRoutePlain } from '@/lib/domain/medicine';

export type Pick = { ref: { type: 'medicine' | 'charge'; id: string }; label: string; unit: string };
type NewItem = { type: 'new'; kind: 'medicine' | 'consumable' | 'procedure'; name: string };
type Chosen = { item: Pick['ref'] | NewItem; label: string; unit: string };

export interface BedsideTreatmentChartProps {
  admissionId: string;
  patient: {
    name: string;
    ageSex: string;
    bedLabel: string;
    wardName: string;
    wardId: string;
    day: number | null;
    ipdNumber?: string | null;
    doctorName?: string | null;
    diagnosis?: string | null;
  };
  emarData: BedsideEmarView;
  allergyStatus?: 'unreviewed' | 'nkda' | 'allergies_documented';
  allergies?: AllergenItem[];
  chartHref?: string | null;
  recentSupplies: Pick[];
  commonSupplies?: Pick[];
  canAdminister?: boolean;
  userRole?: string;
}

export { formatRoutePlain } from '@/lib/domain/medicine';

export function formatSlotTime(date: Date | string): string {
  const d = new Date(date);
  const hours = d.getHours();
  let periodOfDay = '';
  if (hours >= 5 && hours < 12) periodOfDay = 'Morning';
  else if (hours >= 12 && hours < 17) periodOfDay = 'Afternoon';
  else if (hours >= 17 && hours < 21) periodOfDay = 'Evening';
  else periodOfDay = 'Night';

  const timeStr = d.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });

  return `${timeStr} (${periodOfDay})`;
}

export function BedsideTreatmentChart({
  admissionId,
  patient,
  emarData,
  allergyStatus = 'unreviewed',
  allergies = [],
  chartHref,
  recentSupplies: initialRecentSupplies,
  commonSupplies = [],
  canAdminister = true,
  userRole,
}: BedsideTreatmentChartProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  // Active section tab: 'daily' (Daily Routine Medicines) | 'sos' (As Needed SOS) | 'supplies' (Ward Supplies)
  const [activeTab, setActiveTab] = useState<'daily' | 'sos' | 'supplies'>('daily');

  // Modal states for medication administration
  const [administerItem, setAdministerItem] = useState<BedsideDueItem | null>(null);
  const [exceptionItem, setExceptionItem] = useState<BedsideDueItem | null>(null);
  const [prnItem, setPrnItem] = useState<BedsidePrnItem | null>(null);
  const [adjustTimingItem, setAdjustTimingItem] = useState<{
    orderId: string;
    medicineName: string;
    scheduleTimes: string[];
  } | null>(null);
  const [isUrgentModalOpen, setIsUrgentModalOpen] = useState(false);
  const [actionNotice, setActionNotice] = useState<{
    tone: 'success' | 'error';
    text: string;
  } | null>(null);

  // Consumables / Supplies states
  const [suppliesList, setSuppliesList] = useState(initialRecentSupplies);
  const [supplyQuery, setSupplyQuery] = useState('');
  const [chosenSupply, setChosenSupply] = useState<Chosen | null>(null);
  const [supplyQuantity, setSupplyQuantity] = useState(1);
  const [savingSupply, setSavingSupply] = useState(false);
  const [supplyConfirmation, setSupplyConfirmation] = useState<string | null>(null);
  const online = useOnline();

  // Combine scheduled doses into daily lists
  // Urgent doses to give: overdue first, then dueNow
  const activeDosesToGive = useMemo(
    () => [...emarData.overdue, ...emarData.dueNow],
    [emarData.overdue, emarData.dueNow],
  );

  const upcomingDoses = emarData.upcoming;
  const onHoldOrders = emarData.onHold;
  const recentHistory = emarData.recentHistory;
  const sosMedicines = emarData.prn;

  const totalDailyDosesCount =
    activeDosesToGive.length + upcomingDoses.length;

  const handleRefresh = () => {
    startTransition(() => {
      router.refresh();
    });
  };

  const handleVoid = async (administrationId: string, reason: string) => {
    try {
      const res = await voidAdministrationAction({
        admissionId,
        administrationId,
        reason,
      });
      if (res.ok) {
        setActionNotice({ tone: 'success', text: 'Marked entry as voided.' });
        startTransition(() => {
          router.refresh();
        });
      }
    } catch (err) {
      setActionNotice({
        tone: 'error',
        text: err instanceof Error ? err.message : 'Failed to void administration.',
      });
    }
  };

  const handleSaveSupply = async () => {
    if (!chosenSupply || savingSupply) return;
    setSavingSupply(true);
    const occurredAt = new Date().toISOString();
    const entry: OutboxEntry = {
      clientId: crypto.randomUUID(),
      admissionId,
      item: chosenSupply.item,
      quantity: supplyQuantity,
      occurredAt,
      label: chosenSupply.label,
      patientName: patient.name,
      queuedAt: occurredAt,
    };

    const outcome = await sendEntries([entry]);
    setSavingSupply(false);
    if (outcome.kind === 'sent') {
      setSupplyConfirmation(`Recorded: ${chosenSupply.label} × ${supplyQuantity}`);
      setChosenSupply(null);
      setSupplyQuantity(1);
      setTimeout(() => setSupplyConfirmation(null), 4000);
    } else {
      queueEntries([entry]);
      setSupplyConfirmation(`Saved to phone outbox: ${chosenSupply.label} × ${supplyQuantity}`);
      setChosenSupply(null);
      setSupplyQuantity(1);
      setTimeout(() => setSupplyConfirmation(null), 4000);
    }
  };

  return (
    <div className="mx-auto w-full max-w-full lg:max-w-7xl overflow-hidden space-y-2.5">
      {/* 1. Unified Action Bar & Collapsed Patient Strip */}
      <div className="w-full max-w-full overflow-hidden rounded-xl border border-slate-200 bg-white p-2 sm:p-2.5 shadow-2xs space-y-1.5">
        {/* Line 1: Patient info & subtle allergy tag */}
        <div className="flex items-center justify-between gap-1.5 text-xs">
          <div className="flex items-center gap-1.5 min-w-0">
            <Link
              href={`/ipd/ward/${patient.wardId}`}
              className="inline-flex items-center text-slate-500 hover:text-slate-800 shrink-0"
              title={`Back to ${patient.wardName}`}
            >
              <ArrowLeftIcon className="size-3.5" />
            </Link>
            <span className="inline-flex items-center rounded bg-teal-800 px-1.5 py-0.2 font-mono text-[11px] font-bold text-white shrink-0">
              {`Bed ${patient.bedLabel}`}
            </span>
            <h1 className="font-bold text-xs sm:text-sm text-slate-900 truncate">
              {patient.name}
            </h1>
            {patient.ipdNumber && (
              <span className="hidden sm:inline-block rounded bg-slate-100 px-1 py-0.2 font-mono text-[10px] text-slate-600 border border-slate-200 shrink-0">
                #{patient.ipdNumber}
              </span>
            )}
            <span className="hidden md:inline-block text-slate-300">·</span>
            <span className="hidden md:inline-block text-[11px] text-slate-500 truncate max-w-xs">
              {[
                patient.ageSex,
                patient.day ? `Day ${patient.day}` : null,
                patient.doctorName ? `Admitted by ${formatDoctor(patient.doctorName)}` : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </span>
          </div>

          {/* Allergy indicator: subtle compact pill */}
          <div className="shrink-0 text-[10px]">
            {allergyStatus === 'nkda' && (
              <span className="inline-flex items-center gap-0.5 rounded-full border border-emerald-300 bg-emerald-50 px-2 py-0.2 font-semibold text-emerald-800">
                ✓ No allergies
              </span>
            )}
            {allergyStatus === 'unreviewed' && (
              <span className="inline-flex items-center gap-0.5 rounded-full border border-amber-300 bg-amber-50 px-2 py-0.2 font-semibold text-amber-900">
                ⚠️ Allergies Unreviewed
              </span>
            )}
            {allergyStatus === 'allergies_documented' && (
              <div className="flex flex-wrap gap-1">
                {allergies.length > 0 ? (
                  allergies.map((all, i) => (
                    <span
                      key={i}
                      className="inline-flex items-center rounded-full border border-rose-300 bg-rose-50 px-2 py-0.2 font-semibold text-rose-900"
                    >
                      ⚠️ Allergic to {all.substance} {all.severity ? `(${all.severity})` : ''}
                    </span>
                  ))
                ) : (
                  <span className="inline-flex items-center rounded-full border border-rose-300 bg-rose-50 px-2 py-0.2 font-semibold text-rose-900">
                    ⚠️ Specific Allergies Documented
                  </span>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Line 2: Single-row Compact Action Bar (All buttons h-7 sm:h-8, nowrap) */}
        <div className="flex items-center gap-1 sm:gap-1.5 pt-1 border-t border-slate-100">
          {canAdminister && (
            <button
              type="button"
              onClick={() => setIsUrgentModalOpen(true)}
              className="flex-1 sm:flex-none inline-flex h-7 sm:h-8 items-center justify-center gap-1 rounded-md bg-rose-600 px-2 sm:px-3 text-[11px] sm:text-xs font-bold text-white shadow-2xs hover:bg-rose-700 active:scale-95 transition cursor-pointer whitespace-nowrap"
              title="Give extra medicine under verbal order or standing protocol"
            >
              <span className="hidden sm:inline">+ Give Extra Medicine</span>
              <span className="sm:hidden">+ Give Extra Medicine</span>
            </button>
          )}
          <Link
            href={chartHref ?? `/ipd/patients/${admissionId}/vitals`}
            className="flex-1 sm:flex-none inline-flex h-7 sm:h-8 items-center justify-center gap-1 rounded-md bg-emerald-600 px-2 sm:px-3 text-[11px] sm:text-xs font-bold text-white shadow-2xs hover:bg-emerald-700 active:scale-95 transition cursor-pointer whitespace-nowrap"
            title="Open TPR sheet to view chart and record vital signs"
          >
            <span>+ Record TPR</span>
          </Link>
          {userRole !== 'nurse' && (
            <Link
              href={`/ipd/patients/${admissionId}/summary`}
              className="hidden md:inline-flex h-7 sm:h-8 items-center rounded-md border border-slate-200 bg-white px-2.5 text-[11px] sm:text-xs font-semibold text-slate-700 shadow-2xs hover:bg-slate-50 transition whitespace-nowrap"
            >
              Patient File &rarr;
            </Link>
          )}
          <button
            type="button"
            onClick={handleRefresh}
            disabled={isPending}
            className="inline-flex h-7 sm:h-8 items-center justify-center gap-1 rounded-md border border-slate-200 bg-white px-2 text-[11px] sm:text-xs font-semibold text-slate-700 shadow-2xs hover:bg-slate-50 disabled:opacity-50 transition cursor-pointer shrink-0 whitespace-nowrap ml-auto"
            title="Refresh bed data"
          >
            {isPending ? 'Syncing…' : '↻ Refresh'}
          </button>
        </div>

        {/* Diagnosis Strip (Hidden on mobile to save vertical space, visible on md+) */}
        <div className="hidden md:flex items-center gap-1.5 pt-1.5 border-t border-slate-100 text-[11px] text-slate-700">
          <span className="font-semibold text-slate-500">Diagnosis:</span>
          <span className="font-medium text-slate-900 bg-slate-50 px-2 py-0.5 rounded border border-slate-200">
            {patient.diagnosis ? patient.diagnosis : 'No formal diagnosis noted.'}
          </span>
          <span className="text-slate-500 ml-1">
            {patient.doctorName ? `· Admitted by ${formatDoctor(patient.doctorName)}` : ''}
          </span>
        </div>

        {/* Hidden screen-reader & test fallback for mobile view */}
        <div className="md:hidden sr-only">
          {patient.diagnosis ? `Diagnosis: ${patient.diagnosis}` : ''}
          {patient.doctorName ? ` · Admitted by ${formatDoctor(patient.doctorName)}` : ''}
        </div>
      </div>

      {/* Action Notice Banner */}
      {actionNotice && (
        <div
          className={cn(
            'flex items-center justify-between rounded-lg p-2 text-xs font-medium shadow-2xs',
            actionNotice.tone === 'success'
              ? 'border border-emerald-300 bg-emerald-50 text-emerald-900'
              : 'border border-rose-300 bg-rose-50 text-rose-900',
          )}
        >
          <span>{actionNotice.text}</span>
          <button
            type="button"
            onClick={() => setActionNotice(null)}
            className="text-xs font-bold underline hover:opacity-75 cursor-pointer ml-2"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Patient Care Tabs: Single row, no awkward second row */}
      <div className="flex items-center gap-1.5 border-b border-slate-200 pb-1.5 overflow-x-auto no-scrollbar whitespace-nowrap">
        <button
          type="button"
          onClick={() => setActiveTab('daily')}
          className={cn(
            'inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-bold transition shadow-2xs cursor-pointer shrink-0',
            activeTab === 'daily'
              ? 'bg-slate-900 text-white'
              : 'bg-white text-slate-700 border border-slate-200 hover:bg-slate-50',
          )}
        >
          <span>1. Daily Medicines</span>
          <span
            className={cn(
              'rounded-full px-1.5 py-0.2 text-[10px] font-extrabold',
              activeTab === 'daily'
                ? 'bg-white/20 text-white'
                : activeDosesToGive.length > 0
                  ? 'bg-rose-100 text-rose-800'
                  : 'bg-slate-100 text-slate-700',
            )}
          >
            {totalDailyDosesCount}
          </span>
        </button>

        <button
          type="button"
          onClick={() => setActiveTab('sos')}
          className={cn(
            'inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-bold transition shadow-2xs cursor-pointer shrink-0',
            activeTab === 'sos'
              ? 'bg-sky-700 text-white'
              : 'bg-white text-slate-700 border border-slate-200 hover:bg-slate-50',
          )}
        >
          <span>2. As Needed (SOS)</span>
          <span
            className={cn(
              'rounded-full px-1.5 py-0.2 text-[10px] font-extrabold',
              activeTab === 'sos'
                ? 'bg-white/20 text-white'
                : 'bg-sky-100 text-sky-800',
            )}
          >
            {sosMedicines.length}
          </span>
        </button>

        <button
          type="button"
          onClick={() => setActiveTab('supplies')}
          className={cn(
            'ml-auto inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-semibold transition cursor-pointer shrink-0',
            activeTab === 'supplies'
              ? 'bg-slate-800 text-white'
              : 'text-slate-600 hover:bg-slate-100 hover:text-slate-800 border border-slate-200 bg-white',
          )}
        >
          <span>+ Syringes &amp; Items</span>
        </button>
      </div>

      {/* ========================================================================= */}
      {/* WINDOW 1: DAILY SCHEDULED MEDICATIONS (2-COLUMN RESPONSIVE BENTO GRID)    */}
      {/* ========================================================================= */}
      {activeTab === 'daily' && (
        <div className="grid grid-cols-1 md:grid-cols-12 gap-3 items-start">
          {/* Primary Column (md: 7 cols, lg: 8 cols): Doses to Give Now & Scheduled Later */}
          <div className="md:col-span-7 lg:col-span-8 space-y-3">
            {/* Urgent: Doses to Give Right Now or Overdue */}
            {activeDosesToGive.length > 0 && (
              <div className="rounded-xl border border-slate-200 bg-white p-2.5 sm:p-3 shadow-2xs space-y-2">
                {/* Single-Line Clean Section Header */}
                <div className="flex items-center justify-between border-b border-slate-100 pb-1.5 gap-2">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span className="size-2 rounded-full bg-rose-600 animate-pulse shrink-0" />
                    <h2 className="text-xs font-bold uppercase tracking-wider text-rose-800 truncate">
                      Medications to Give Now ({activeDosesToGive.length})
                    </h2>
                  </div>
                  <span className="text-[10px] font-medium text-slate-400 shrink-0">
                    Immediate
                  </span>
                </div>

                <div className="max-h-[380px] lg:max-h-[440px] overflow-y-auto space-y-2 pr-0.5">
                  {activeDosesToGive.map((item) => {
                    const isOverdue = item.status === 'overdue';
                    return (
                      <div
                        key={`${item.orderId}-${new Date(item.scheduledTime).getTime()}`}
                        className={cn(
                          'group w-full max-w-full rounded-lg border bg-white p-2.5 sm:p-3 shadow-2xs transition-all hover:shadow-xs space-y-2',
                          isOverdue
                            ? 'border-rose-200 bg-rose-50/15 border-l-4 border-l-rose-500'
                            : 'border-slate-200 bg-white border-l-4 border-l-emerald-500',
                        )}
                      >
                        {/* Row 1: Name + Dose Badge on Left, Route on Right */}
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-baseline gap-1.5">
                              <span className="text-sm sm:text-base font-bold text-slate-900 tracking-tight">
                                {item.medicineName}
                              </span>
                              <span className="inline-flex items-center rounded px-1.5 py-0.2 font-mono text-[11px] font-semibold bg-slate-100 text-slate-700 border border-slate-200 shrink-0">
                                {item.doseAmount} {item.doseUnit}
                              </span>
                            </div>
                          </div>
                          <span className="inline-flex items-center rounded px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider bg-slate-800 text-white shrink-0">
                            {formatRoutePlain(item.route)}
                          </span>
                        </div>

                        {/* Row 2: Timing & Status Badge */}
                        <div className="flex items-center justify-between text-xs text-slate-600 gap-2">
                          <div className="flex items-center gap-1.5 truncate">
                            <span className="text-slate-500 text-[11px]">Scheduled:</span>
                            <strong className="text-slate-800 font-semibold text-xs">
                              {formatSlotTime(item.scheduledTime)}
                            </strong>
                          </div>
                          {isOverdue ? (
                            <span className="inline-flex items-center gap-1 rounded-full bg-rose-100 px-2 py-0.5 text-[10px] font-bold text-rose-800 shrink-0">
                              <span className="size-1.5 rounded-full bg-rose-600" />
                              Overdue
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-800 shrink-0">
                              <span className="size-1.5 rounded-full bg-emerald-600" />
                              Due Now
                            </span>
                          )}
                        </div>

                        {/* Row 3: Action Buttons in a Single Crisp 32px Line */}
                        {canAdminister && (
                          <div className="flex items-center justify-between gap-2 pt-1 border-t border-slate-100">
                            {/* Secondary Actions Segmented Control */}
                            <div className="inline-flex items-center rounded-md border border-slate-200 bg-slate-50/70 p-0.5 shadow-2xs">
                              <button
                                type="button"
                                onClick={() =>
                                  setAdjustTimingItem({
                                    orderId: item.orderId,
                                    medicineName: item.medicineName,
                                    scheduleTimes: [
                                      new Date(item.scheduledTime).toLocaleTimeString(undefined, {
                                        hour: '2-digit',
                                        minute: '2-digit',
                                        hour12: false,
                                      }),
                                    ],
                                  })
                                }
                                className="h-7 sm:h-8 rounded px-2 text-[11px] font-medium text-slate-700 hover:bg-white hover:text-slate-900 transition-colors cursor-pointer whitespace-nowrap"
                                title="Adjust scheduled timing with reason"
                              >
                                Change Time
                              </button>
                              <div className="h-3.5 w-px bg-slate-200" />
                              <button
                                type="button"
                                onClick={() => setExceptionItem(item)}
                                className="h-7 sm:h-8 rounded px-2 text-[11px] font-medium text-slate-700 hover:bg-white hover:text-rose-700 transition-colors cursor-pointer whitespace-nowrap"
                              >
                                Skip Dose
                              </button>
                            </div>

                            {/* Primary Action Button */}
                            <button
                              type="button"
                              onClick={() => setAdministerItem(item)}
                              className="h-7 sm:h-8 inline-flex items-center justify-center gap-1 rounded-md bg-emerald-600 px-3.5 text-xs font-bold text-white shadow-2xs hover:bg-emerald-700 active:scale-95 transition-all cursor-pointer shrink-0 whitespace-nowrap"
                            >
                              ✓ Give Medicine
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Upcoming Doses Scheduled Later Today */}
            {upcomingDoses.length > 0 && (
              <div className="rounded-xl border border-slate-200 bg-white p-2.5 sm:p-3 shadow-2xs space-y-2">
                <div className="flex items-center justify-between border-b border-slate-100 pb-1.5">
                  <h2 className="text-xs font-bold uppercase tracking-wider text-slate-600 flex items-center gap-1.5">
                    <span>Scheduled Later Today ({upcomingDoses.length})</span>
                  </h2>
                  <span className="text-[10px] font-medium text-slate-400">Later</span>
                </div>

                <div className="max-h-[300px] overflow-y-auto space-y-2 pr-0.5">
                  {upcomingDoses.map((item) => (
                    <div
                      key={`${item.orderId}-${new Date(item.scheduledTime).getTime()}`}
                      className="group w-full max-w-full rounded-lg border border-slate-200 bg-white p-2.5 sm:p-3 shadow-2xs transition-all hover:shadow-xs space-y-2"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-baseline gap-1.5">
                            <span className="text-sm sm:text-base font-bold text-slate-900 tracking-tight">
                              {item.medicineName}
                            </span>
                            <span className="inline-flex items-center rounded px-1.5 py-0.2 font-mono text-[11px] font-semibold bg-slate-100 text-slate-700 border border-slate-200 shrink-0">
                              {item.doseAmount} {item.doseUnit}
                            </span>
                          </div>
                        </div>
                        <span className="inline-flex items-center rounded px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider bg-slate-800 text-white shrink-0">
                          {formatRoutePlain(item.route)}
                        </span>
                      </div>

                      <p className="text-xs text-slate-500">
                        Scheduled for: <strong className="text-slate-800 font-semibold">{formatSlotTime(item.scheduledTime)}</strong>
                      </p>

                      {canAdminister && (
                        <div className="flex items-center justify-between gap-2 pt-1 border-t border-slate-100">
                          <div className="inline-flex items-center rounded-md border border-slate-200 bg-slate-50/70 p-0.5 shadow-2xs">
                            <button
                              type="button"
                              onClick={() =>
                                setAdjustTimingItem({
                                  orderId: item.orderId,
                                  medicineName: item.medicineName,
                                  scheduleTimes: [
                                    new Date(item.scheduledTime).toLocaleTimeString(undefined, {
                                      hour: '2-digit',
                                      minute: '2-digit',
                                      hour12: false,
                                    }),
                                  ],
                                })
                              }
                              className="h-7 sm:h-8 rounded px-2 text-[11px] font-medium text-slate-700 hover:bg-white hover:text-slate-900 transition-colors cursor-pointer whitespace-nowrap"
                              title="Change scheduled timing with reason"
                            >
                              Change Time
                            </button>
                            <div className="h-3.5 w-px bg-slate-200" />
                            <button
                              type="button"
                              onClick={() => setExceptionItem(item)}
                              className="h-7 sm:h-8 rounded px-2 text-[11px] font-medium text-slate-700 hover:bg-white hover:text-rose-700 transition-colors cursor-pointer whitespace-nowrap"
                            >
                              Skip Dose
                            </button>
                          </div>
                          <button
                            type="button"
                            onClick={() => setAdministerItem(item)}
                            className="h-7 sm:h-8 inline-flex items-center justify-center gap-1 rounded-md border border-emerald-300 bg-emerald-50 px-3 text-xs font-bold text-emerald-800 hover:bg-emerald-100 active:scale-95 transition cursor-pointer whitespace-nowrap"
                          >
                            ✓ Give Early
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* On Hold Medications (if any) */}
            {onHoldOrders.length > 0 && (
              <div className="rounded-xl border border-amber-300 bg-amber-50/50 p-3 shadow-2xs space-y-2">
                <h2 className="text-xs font-bold uppercase tracking-wider text-amber-900 flex items-center justify-between">
                  <span>On Hold by Doctor ({onHoldOrders.length})</span>
                  <span className="rounded-full bg-amber-200 px-2 py-0.5 text-[10px] font-bold text-amber-900">
                    ⏸ Suspended
                  </span>
                </h2>
                <div className="space-y-1.5">
                  {onHoldOrders.map((ord) => (
                    <div
                      key={ord.id}
                      className="rounded-lg border border-amber-200 bg-white p-2.5 text-xs text-amber-950"
                    >
                      <div className="flex items-center justify-between">
                        <strong className="text-sm font-bold text-slate-900">{ord.medicineName}</strong>
                        <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold uppercase text-amber-900">
                          On Hold
                        </span>
                      </div>
                      {ord.specialInstructions && (
                        <p className="mt-1 text-slate-600 font-medium text-[11px]">
                          Doctor’s Note: {ord.specialInstructions}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Empty State for Daily Medicines */}
            {totalDailyDosesCount === 0 && onHoldOrders.length === 0 && (
              <div className="rounded-xl border border-dashed border-slate-200 bg-white p-8 text-center shadow-2xs">
                <p className="text-sm font-bold text-slate-800">
                  No daily scheduled medicines due right now.
                </p>
                <p className="mt-1 text-xs text-slate-500">
                  All daily medications have been administered or none are scheduled for this shift.
                </p>
              </div>
            )}
          </div>

          {/* Right Column (md: 5 cols, lg: 4 cols): Given Today Log & SOS Card */}
          <div className="md:col-span-5 lg:col-span-4 space-y-3.5">
            {/* Doses Given Today (Matching SummaryAdministeredCard) */}
            <div className="bg-white rounded-xl border border-slate-200 shadow-2xs p-3 space-y-2.5">
              <div className="flex items-center justify-between border-b border-slate-100 pb-2">
                <div className="flex items-center gap-1.5">
                  <h3 className="text-xs font-bold text-slate-900 tracking-tight flex items-center gap-1.5">
                    <span>✓ Given Today</span>
                  </h3>
                  <span className="inline-flex items-center px-1.5 py-0.2 rounded-full text-[10px] font-bold bg-emerald-50 text-emerald-800 ring-1 ring-inset ring-emerald-200">
                    {`${recentHistory.length} given`}
                  </span>
                </div>
                <span className="text-[10px] text-slate-500 font-medium">Dose Log</span>
              </div>

              {recentHistory.length === 0 ? (
                <div className="py-6 text-center text-xs text-slate-400 italic">
                  No doses recorded yet for today.
                </div>
              ) : (
                <div className="max-h-[380px] overflow-y-auto space-y-1.5 pr-1">
                  {recentHistory.map((entry) => {
                    const isVoided = Boolean(entry.voidedAt);
                    const isGiven = entry.outcome === 'administered';
                    return (
                      <div
                        key={entry.id}
                        className={cn(
                          'flex items-center justify-between rounded-lg border p-2 text-xs transition-colors',
                          isVoided
                            ? 'border-slate-200 bg-slate-50 text-slate-400 line-through'
                            : isGiven
                              ? 'border-slate-200 bg-slate-50/70 text-slate-900'
                              : 'border-amber-200 bg-amber-50/50 text-amber-950',
                        )}
                      >
                        <div className="min-w-0 flex-1 pr-2">
                          <div className="font-bold text-slate-900 truncate">
                            {entry.doseGiven || 'Dose'}
                            {entry.routeGiven && (
                              <span className="ml-1 text-[11px] font-normal text-slate-600">
                                ({formatRoutePlain(entry.routeGiven)})
                              </span>
                            )}
                          </div>
                          <div className="text-[11px] text-slate-500">
                            {entry.actualTime
                              ? new Date(entry.actualTime).toLocaleTimeString(undefined, {
                                hour: '2-digit',
                                minute: '2-digit',
                              })
                              : 'Logged'}
                            {entry.clinicalNote && (
                              <span className="ml-1 italic text-slate-600">· {entry.clinicalNote}</span>
                            )}
                          </div>
                        </div>

                        <div className="flex shrink-0 items-center gap-1.5">
                          <span
                            className={cn(
                              'inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold capitalize',
                              isVoided
                                ? 'bg-slate-100 text-slate-600'
                                : isGiven
                                  ? 'bg-emerald-100 text-emerald-800'
                                  : 'bg-amber-100 text-amber-800',
                            )}
                          >
                            {isVoided ? 'Voided' : entry.outcome === 'administered' ? '✓ Given' : entry.outcome}
                          </span>
                          {!isVoided && canAdminister && (
                            <button
                              type="button"
                              onClick={() => {
                                const reason = window.prompt(
                                  'Enter reason to mark this entry as void / entered in error:',
                                );
                                if (reason && reason.trim()) {
                                  void handleVoid(entry.id, reason.trim());
                                }
                              }}
                              className="rounded px-1.5 py-0.5 text-[10px] font-bold text-rose-600 hover:bg-rose-50 cursor-pointer"
                              title="Void administration entry"
                            >
                              Void
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* SOS / As-Needed Available Orders Quick Card */}
            <div className="bg-white rounded-xl border border-slate-200 shadow-2xs p-3 space-y-2">
              <div className="flex items-center justify-between border-b border-slate-100 pb-2">
                <div className="flex items-center gap-1.5">
                  <h3 className="text-xs font-bold text-slate-900 tracking-tight">
                    SOS / As-Needed
                  </h3>
                  <span className="inline-flex items-center px-1.5 py-0.2 rounded-full text-[10px] font-bold bg-sky-50 text-sky-800 ring-1 ring-inset ring-sky-200">
                    {sosMedicines.length}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => setActiveTab('sos')}
                  className="text-[11px] font-semibold text-teal-700 hover:underline cursor-pointer"
                >
                  View SOS &rarr;
                </button>
              </div>

              <div className="max-h-48 overflow-y-auto space-y-1.5 pr-1 text-xs">
                {sosMedicines.length === 0 ? (
                  <div className="py-4 text-center text-xs text-slate-400 italic">
                    No PRN orders prescribed.
                  </div>
                ) : (
                  sosMedicines.map((med) => (
                    <div
                      key={med.orderId}
                      className="p-2 rounded-lg bg-sky-50/50 border border-sky-100 flex items-center justify-between"
                    >
                      <div className="min-w-0 flex-1 pr-2">
                        <div className="font-bold text-slate-900 truncate">{med.medicineName}</div>
                        <div className="text-[10px] text-slate-600 font-medium">
                          {med.doseAmount} {med.doseUnit} · {formatRoutePlain(med.route)}
                        </div>
                        {med.prnIndication && (
                          <div className="text-[10px] text-sky-800 italic truncate">
                            For: {med.prnIndication}
                          </div>
                        )}
                      </div>
                      <span
                        className={cn(
                          'shrink-0 px-1.5 py-0.5 rounded text-[10px] font-bold',
                          med.eligibility.eligible
                            ? 'bg-emerald-100 text-emerald-800'
                            : 'bg-slate-100 text-slate-600',
                        )}
                      >
                        {med.eligibility.eligible ? 'Ready' : 'Wait'}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* WINDOW 2: AS NEEDED (SOS) MEDICINES                                       */}
      {/* ========================================================================= */}
      {activeTab === 'sos' && (
        <div className="space-y-3">
          <div className="rounded-xl border border-sky-200 bg-sky-50/50 p-2.5 sm:p-3 text-xs text-sky-900">
            <strong>How SOS Works:</strong> Give these medicines only when the patient has the specific symptoms documented by the doctor below (e.g., fever, pain, vomiting).
          </div>

          {sosMedicines.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-200 bg-white p-8 text-center shadow-2xs">
              <p className="text-sm font-bold text-slate-800">
                No As-Needed (SOS) medications prescribed.
              </p>
              <p className="mt-1 text-xs text-slate-500">
                The doctor has not ordered any SOS medications for this patient.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {sosMedicines.map((item) => {
                const eligible = item.eligibility.eligible;
                const remaining = item.eligibility.dosesRemainingToday ?? 0;

                return (
                  <div
                    key={item.orderId}
                    className="rounded-xl border border-slate-200 bg-white p-3 shadow-2xs space-y-2.5 hover:shadow-xs transition"
                  >
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <h3 className="text-sm font-bold text-slate-900 tracking-tight">
                            {item.medicineName}
                          </h3>
                          <span className="rounded px-1.5 py-0.5 font-mono text-[11px] font-semibold bg-sky-100 text-sky-900">
                            {item.doseAmount} {item.doseUnit}
                          </span>
                          <span className="rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider bg-slate-800 text-white">
                            {formatRoutePlain(item.route)}
                          </span>
                        </div>

                        {/* Doctor's Documented Note / Reason to Give */}
                        <div className="mt-2 rounded-lg border border-sky-200 bg-sky-50/70 p-2 text-xs">
                          <strong className="text-sky-950">🩺 Give When: </strong>
                          <span className="font-semibold text-sky-900">
                            {item.prnIndication || 'As advised by doctor'}
                          </span>
                        </div>
                      </div>

                      {canAdminister && (
                        <div className="shrink-0 pt-0.5">
                          {eligible ? (
                            <button
                              type="button"
                              onClick={() => setPrnItem(item)}
                              className="w-full sm:w-auto min-h-[44px] sm:min-h-[32px] rounded-lg bg-sky-600 px-3.5 py-1.5 text-xs font-bold text-white shadow-2xs hover:bg-sky-700 active:scale-95 transition cursor-pointer"
                            >
                              ✓ Give SOS Dose
                            </button>
                          ) : (
                            <span className="inline-block rounded-lg bg-amber-100 px-2.5 py-1 text-xs font-bold text-amber-900">
                              ⏳ {item.eligibility.reason || 'Cannot give yet'}
                            </span>
                          )}
                        </div>
                      )}
                    </div>

                    {/* Limits and Allowances */}
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-500 border-t border-slate-100 pt-1.5">
                      {item.prnMinIntervalHours && (
                        <span>
                          Cooldown: Minimum <strong className="text-slate-800">{item.prnMinIntervalHours}h</strong>
                        </span>
                      )}
                      {item.prnMaxDailyDoses && (
                        <span>
                          Allowance: <strong className="text-slate-800">{remaining} doses remaining</strong> today
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ========================================================================= */}
      {/* WINDOW 3: WARD SUPPLIES & CONSUMABLES (SYRINGES, CANNULAS)                */}
      {/* ========================================================================= */}
      {activeTab === 'supplies' && (
        <div className="space-y-3.5 rounded-xl border border-slate-200 bg-white p-4 shadow-2xs">
          <div>
            <h3 className="text-sm font-bold text-slate-900">
              Log Ward Supplies & Consumables
            </h3>
            <p className="text-xs text-slate-500">
              Tap an item to charge it to this patient’s bed (e.g. syringes, cannulas, saline fluids).
            </p>
          </div>

          {!online && (
            <p className="flex items-center gap-2 rounded-lg bg-amber-100 px-3 py-2 text-xs font-medium text-amber-950">
              <WifiOffIcon className="size-4 shrink-0" />
              Offline mode: entries will be saved on this device and synced when connected.
            </p>
          )}

          {supplyConfirmation && (
            <div className="rounded-lg border border-emerald-300 bg-emerald-50 p-2.5 text-xs font-bold text-emerald-900">
              ✓ {supplyConfirmation}
            </div>
          )}

          {/* Quick Common Items */}
          {commonSupplies.length > 0 && (
            <div>
              <p className="mb-2 text-xs font-bold uppercase text-slate-400">
                Common Ward Supplies
              </p>
              <div className="flex flex-wrap gap-2">
                {commonSupplies.map((p, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() => setChosenSupply({ item: p.ref, label: p.label, unit: p.unit })}
                    className="min-h-[44px] sm:min-h-[32px] rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-semibold text-slate-800 hover:border-teal-500 hover:bg-teal-50 hover:text-teal-900 transition-colors cursor-pointer"
                  >
                    + {p.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Selected Item Confirmation Panel */}
          {chosenSupply && (
            <div className="rounded-lg border border-teal-300 bg-teal-50/40 p-3 space-y-2.5">
              <div className="flex items-center justify-between">
                <div>
                  <span className="text-[10px] font-bold uppercase text-teal-800">
                    Ready to Charge
                  </span>
                  <h4 className="text-sm font-bold text-teal-950">
                    {chosenSupply.label}
                  </h4>
                </div>
                <button
                  type="button"
                  onClick={() => setChosenSupply(null)}
                  className="text-xs text-slate-500 hover:text-slate-800 cursor-pointer"
                >
                  Cancel
                </button>
              </div>

              <div className="flex items-center gap-3">
                <label className="text-xs font-semibold text-slate-700">Quantity:</label>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => setSupplyQuantity((q) => Math.max(1, q - 1))}
                    className="size-7 rounded border border-slate-300 bg-white font-bold text-slate-800 hover:bg-slate-100"
                  >
                    -
                  </button>
                  <span className="w-8 text-center font-bold text-slate-900 text-xs">{supplyQuantity}</span>
                  <button
                    type="button"
                    onClick={() => setSupplyQuantity((q) => q + 1)}
                    className="size-7 rounded border border-slate-300 bg-white font-bold text-slate-800 hover:bg-slate-100"
                  >
                    +
                  </button>
                </div>

                <button
                  type="button"
                  onClick={handleSaveSupply}
                  disabled={savingSupply}
                  className="ml-auto min-h-[44px] sm:min-h-[32px] rounded-lg bg-teal-600 px-4 py-1.5 text-xs font-bold text-white shadow-2xs hover:bg-teal-700 disabled:opacity-50 transition cursor-pointer"
                >
                  {savingSupply ? 'Saving…' : '✓ Charge to Bed'}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Dose Administration Modal */}
      {administerItem && (
        <AdministerModal
          isOpen={true}
          onClose={() => setAdministerItem(null)}
          admissionId={admissionId}
          dueItem={administerItem}
          patientName={patient.name}
          bedLabel={patient.bedLabel}
          activeAllergies={allergies}
          onSuccess={() => {
            setActionNotice({
              tone: 'success',
              text: `Given: ${administerItem.medicineName} recorded successfully.`,
            });
            startTransition(() => {
              router.refresh();
            });
          }}
        />
      )}

      {/* Exception Recording Modal */}
      {exceptionItem && (
        <ExceptionModal
          isOpen={true}
          onClose={() => setExceptionItem(null)}
          admissionId={admissionId}
          dueItem={exceptionItem}
          onSuccess={() => {
            setActionNotice({
              tone: 'success',
              text: `Recorded not given for ${exceptionItem.medicineName}.`,
            });
            startTransition(() => {
              router.refresh();
            });
          }}
        />
      )}

      {/* PRN Administration Modal */}
      {prnItem && (
        <PrnAdminModal
          isOpen={true}
          onClose={() => setPrnItem(null)}
          admissionId={admissionId}
          prnItem={prnItem}
          patientName={patient.name}
          onSuccess={() => {
            setActionNotice({
              tone: 'success',
              text: `Given SOS dose: ${prnItem.medicineName} recorded.`,
            });
            startTransition(() => {
              router.refresh();
            });
          }}
        />
      )}

      {/* Adjust Timing Modal */}
      {adjustTimingItem && (
        <AdjustScheduleTimingModal
          isOpen={true}
          onClose={() => setAdjustTimingItem(null)}
          admissionId={admissionId}
          orderId={adjustTimingItem.orderId}
          medicineName={adjustTimingItem.medicineName}
          currentScheduleTimes={adjustTimingItem.scheduleTimes}
          onSuccess={(newTimes) => {
            setActionNotice({
              tone: 'success',
              text: `Timing updated for ${adjustTimingItem.medicineName} to [${newTimes.join(', ')}].`,
            });
            startTransition(() => {
              router.refresh();
            });
          }}
        />
      )}

      {/* Nurse Urgent Administration Modal */}
      {isUrgentModalOpen && (
        <NurseUrgentAdminModal
          isOpen={true}
          onClose={() => setIsUrgentModalOpen(false)}
          admissionId={admissionId}
          patientName={patient.name}
          bedLabel={patient.bedLabel}
          activeAllergies={allergies}
          onSuccess={() => {
            setActionNotice({
              tone: 'success',
              text: `Urgent medication administered & recorded. Billed and queued for doctor review.`,
            });
            startTransition(() => {
              router.refresh();
            });
          }}
        />
      )}

    </div>
  );
}

export { BedsideTreatmentChart as MedicationChart };
export type MedicationChartProps = BedsideTreatmentChartProps;

