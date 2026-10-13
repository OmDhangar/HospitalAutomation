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
import type { SelectIpdMedicationOrder, SelectIpdMedicationAdministration } from '@/lib/db/schema';
import type { AllergenItem } from '@/lib/services/ipd-rounding-cockpit';

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
  commonSupplies: Pick[];
  canAdminister?: boolean;
}

export function formatRoutePlain(route: string): string {
  const r = route.toLowerCase().trim();
  switch (r) {
    case 'oral':
      return 'By Mouth (Oral)';
    case 'iv_push':
      return 'IV Injection (Direct)';
    case 'iv_piggyback':
      return 'IV Drip (Infusion)';
    case 'im':
      return 'IM Injection (Muscle)';
    case 'sc':
    case 'subcutaneous':
      return 'SC Injection (Under skin)';
    case 'nebulization':
      return 'Nebulization (Inhalation)';
    case 'topical':
      return 'Apply to Skin (Topical)';
    case 'sublingual':
      return 'Under Tongue (Sublingual)';
    case 'rectal':
      return 'Rectal';
    default:
      return route.replace(/_/g, ' ');
  }
}

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
  commonSupplies,
  canAdminister = true,
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
    <div className="mx-auto max-w-4xl space-y-4">
      {/* Top Navigation & Bed Header */}
      <div className="flex items-center justify-between">
        <Link
          href={`/ipd/ward/${patient.wardId}`}
          className="inline-flex min-h-11 items-center gap-1.5 text-sm font-semibold text-ink-600 hover:text-ink-900"
        >
          <ArrowLeftIcon className="size-4" />
          Back to {patient.wardName}
        </Link>
        <div className="flex items-center gap-2">
          {canAdminister && (
            <button
              type="button"
              onClick={() => setIsUrgentModalOpen(true)}
              className="inline-flex min-h-10 items-center gap-1 rounded-lg bg-rose-600 px-3 text-xs font-bold text-white shadow-2xs hover:bg-rose-700 cursor-pointer"
              title="Give extra medicine under verbal order or standing protocol"
            >
              + Give Extra Medicine
            </button>
          )}
          {chartHref && (
            <Link
              href={chartHref}
              className="inline-flex min-h-10 items-center rounded-lg border border-ink-200 bg-white px-3 text-xs font-semibold text-ink-700 shadow-2xs hover:bg-ink-50"
            >
              Fever &amp; BP (TPR)
            </Link>
          )}
          <Link
            href={`/ipd/admissions/${admissionId}`}
            className="inline-flex min-h-10 items-center rounded-lg border border-ink-200 bg-white px-3 text-xs font-semibold text-ink-700 shadow-2xs hover:bg-ink-50"
          >
            Patient File &rarr;
          </Link>
          <button
            type="button"
            onClick={handleRefresh}
            disabled={isPending}
            className="inline-flex min-h-10 items-center gap-1 rounded-lg border border-ink-200 bg-white px-3 text-xs font-semibold text-ink-700 shadow-2xs hover:bg-ink-50 disabled:opacity-50"
            title="Refresh bed data"
          >
            {isPending ? 'Syncing…' : '↻ Refresh'}
          </button>
        </div>
      </div>

      {/* Main Patient Identification Card */}
      <div className="rounded-xl border border-brand-200 bg-white p-3.5 sm:p-4 shadow-2xs">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-md bg-brand-700 px-2.5 py-0.5 font-mono text-xs font-bold text-white shadow-2xs">
                {`Bed ${patient.bedLabel}`}
              </span>
              <h1 className="text-lg font-black text-ink-950 tracking-tight">
                {patient.name}
              </h1>
              {patient.ipdNumber && (
                <span className="rounded bg-ink-100 px-2 py-0.5 font-mono text-xs font-semibold text-ink-600">
                  IPD #{patient.ipdNumber}
                </span>
              )}
            </div>

            <p className="mt-1 text-xs font-medium text-ink-600">
              {[
                patient.ageSex,
                patient.wardName,
                patient.day ? `Day ${patient.day} of stay` : null,
                patient.doctorName ? `Admitted by Dr. ${patient.doctorName}` : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>

            <div className="mt-2 flex items-baseline gap-1.5 text-xs text-ink-800">
              <span className="font-semibold text-ink-600 shrink-0">Diagnosis:</span>
              <span className="font-medium text-ink-900 bg-sky-50 px-2 py-0.5 rounded border border-sky-200">
                {patient.diagnosis ? patient.diagnosis : 'No formal diagnosis noted.'}
              </span>
            </div>
          </div>

          {/* Allergy Pill */}
          <div className="shrink-0">
            {allergyStatus === 'nkda' && (
              <span className="inline-flex items-center gap-1 rounded-md border border-emerald-300 bg-emerald-50 px-2.5 py-0.5 text-xs font-bold text-emerald-800">
                ✓ No allergies
              </span>
            )}
            {allergyStatus === 'unreviewed' && (
              <span className="inline-flex items-center gap-1 rounded-md border border-amber-300 bg-amber-50 px-2.5 py-0.5 text-xs font-bold text-amber-900">
                ⚠️ Allergies Unreviewed
              </span>
            )}
            {allergyStatus === 'allergies_documented' && (
              <div className="flex flex-wrap gap-1">
                {allergies.length > 0 ? (
                  allergies.map((all, i) => (
                    <span
                      key={i}
                      className="inline-flex items-center rounded-md border border-rose-300 bg-rose-50 px-2 py-0.5 text-xs font-bold text-rose-900"
                    >
                      ⚠️ Allergic to {all.substance} {all.severity ? `(${all.severity})` : ''}
                    </span>
                  ))
                ) : (
                  <span className="inline-flex items-center rounded-md border border-rose-300 bg-rose-50 px-2 py-0.5 text-xs font-bold text-rose-900">
                    ⚠️ Specific Allergies Documented
                  </span>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Action Notice Banner */}
      {actionNotice && (
        <div
          className={cn(
            'flex items-center justify-between rounded-xl p-3 text-xs font-medium',
            actionNotice.tone === 'success'
              ? 'border border-emerald-300 bg-emerald-50 text-emerald-900'
              : 'border border-rose-300 bg-rose-50 text-rose-900',
          )}
        >
          <span>{actionNotice.text}</span>
          <button
            type="button"
            onClick={() => setActionNotice(null)}
            className="text-xs font-bold underline hover:opacity-75 cursor-pointer"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Patient Care Tabs */}
      <div className="flex items-center gap-2 border-b border-ink-200 pb-2">
        <button
          type="button"
          onClick={() => setActiveTab('daily')}
          className={cn(
            'flex items-center gap-2 rounded-lg px-3.5 py-2 text-xs font-bold transition shadow-2xs cursor-pointer',
            activeTab === 'daily'
              ? 'bg-brand-700 text-white shadow-sm'
              : 'bg-white text-ink-700 border border-ink-200 hover:bg-ink-50',
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
                : 'bg-ink-100 text-ink-700',
            )}
          >
            {totalDailyDosesCount}
          </span>
        </button>

        <button
          type="button"
          onClick={() => setActiveTab('sos')}
          className={cn(
            'flex items-center gap-2 rounded-lg px-3.5 py-2 text-xs font-bold transition shadow-2xs cursor-pointer',
            activeTab === 'sos'
              ? 'bg-sky-700 text-white shadow-sm'
              : 'bg-white text-ink-700 border border-ink-200 hover:bg-ink-50',
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
            'ml-auto flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition cursor-pointer',
            activeTab === 'supplies'
              ? 'bg-ink-800 text-white'
              : 'text-ink-600 hover:bg-ink-100 hover:text-ink-800 border border-ink-200',
          )}
        >
          <span>+ Syringes &amp; Items</span>
        </button>
      </div>

      {/* ========================================================================= */}
      {/* WINDOW 1: DAILY SCHEDULED MEDICATIONS */}
      {/* ========================================================================= */}
      {activeTab === 'daily' && (
        <div className="space-y-4">
          {/* Urgent: Doses to Give Right Now or Overdue */}
          {activeDosesToGive.length > 0 && (
            <div className="space-y-2.5">
              <h2 className="text-xs font-bold uppercase tracking-wider text-rose-800 flex items-center gap-1.5">
                <span className="size-2 rounded-full bg-rose-600 animate-pulse" />
                Medications to Give Now ({activeDosesToGive.length})
              </h2>

              <div className="space-y-3">
                {activeDosesToGive.map((item) => {
                  const isOverdue = item.status === 'overdue';
                  return (
                    <div
                      key={`${item.orderId}-${new Date(item.scheduledTime).getTime()}`}
                      className={cn(
                        'flex flex-col gap-3 rounded-2xl border-2 p-4 shadow-xs transition sm:flex-row sm:items-center sm:justify-between',
                        isOverdue
                          ? 'border-rose-400 bg-rose-50/50'
                          : 'border-emerald-400 bg-emerald-50/50',
                      )}
                    >
                      <div className="space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-base font-black text-ink-950">
                            {item.medicineName}
                          </span>
                          <span className="rounded-md bg-white px-2 py-0.5 font-mono text-xs font-bold text-ink-900 border border-ink-200">
                            {item.doseAmount} {item.doseUnit}
                          </span>
                          <span className="rounded-md bg-ink-900 px-2 py-0.5 text-xs font-bold uppercase text-white">
                            {formatRoutePlain(item.route)}
                          </span>
                        </div>

                        <div className="flex flex-wrap items-center gap-2 text-xs text-ink-700">
                          <span className="font-semibold">
                            Scheduled: {formatSlotTime(item.scheduledTime)}
                          </span>
                          {isOverdue ? (
                            <span className="rounded bg-rose-200 px-1.5 py-0.5 font-bold text-rose-900">
                              Overdue
                            </span>
                          ) : (
                            <span className="rounded bg-emerald-200 px-1.5 py-0.5 font-bold text-emerald-900">
                              Due Now
                            </span>
                          )}
                        </div>
                      </div>

                      {canAdminister && (
                        <div className="flex shrink-0 items-center gap-2">
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
                            className="rounded-xl border border-ink-300 bg-white px-2.5 py-2 text-xs font-semibold text-ink-700 shadow-2xs hover:bg-ink-100"
                            title="Adjust scheduled timing with reason"
                          >
                            Change Time
                          </button>
                          <button
                            type="button"
                            onClick={() => setExceptionItem(item)}
                            className="rounded-xl border border-ink-300 bg-white px-3 py-2 text-xs font-bold text-ink-700 shadow-2xs hover:bg-ink-100 cursor-pointer"
                          >
                            Skip Dose
                          </button>
                          <button
                            type="button"
                            onClick={() => setAdministerItem(item)}
                            className="rounded-xl bg-emerald-600 px-5 py-2.5 text-sm font-black text-white shadow-sm hover:bg-emerald-700 transition cursor-pointer"
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
            <div className="space-y-2.5">
              <h2 className="text-xs font-bold uppercase tracking-wider text-ink-600">
                Scheduled Later Today ({upcomingDoses.length})
              </h2>

              <div className="space-y-2.5">
                {upcomingDoses.map((item) => (
                  <div
                    key={`${item.orderId}-${new Date(item.scheduledTime).getTime()}`}
                    className="flex flex-col gap-3 rounded-xl border border-ink-200 bg-white p-3.5 shadow-2xs transition sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-bold text-ink-900">
                          {item.medicineName}
                        </span>
                        <span className="rounded bg-ink-100 px-2 py-0.5 font-mono text-xs font-semibold text-ink-800">
                          {item.doseAmount} {item.doseUnit}
                        </span>
                        <span className="rounded bg-ink-100 px-1.5 py-0.5 text-[11px] font-semibold text-ink-700">
                          {formatRoutePlain(item.route)}
                        </span>
                      </div>
                      <p className="text-xs text-ink-500">
                        Scheduled for: <strong className="text-ink-800">{formatSlotTime(item.scheduledTime)}</strong>
                      </p>
                    </div>

                    {canAdminister && (
                      <div className="flex shrink-0 items-center gap-2">
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
                          className="rounded-lg border border-ink-200 bg-white px-2.5 py-1.5 text-xs font-medium text-ink-700 hover:bg-ink-50 cursor-pointer"
                          title="Change scheduled timing with reason"
                        >
                          Change Time
                        </button>
                        <button
                          type="button"
                          onClick={() => setExceptionItem(item)}
                          className="rounded-lg border border-ink-200 bg-white px-2.5 py-1.5 text-xs font-medium text-ink-600 hover:bg-ink-50 cursor-pointer"
                        >
                          Skip Dose
                        </button>
                        <button
                          type="button"
                          onClick={() => setAdministerItem(item)}
                          className="rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-1.5 text-xs font-bold text-emerald-800 hover:bg-emerald-100 cursor-pointer"
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
            <div className="space-y-2.5">
              <h2 className="text-xs font-bold uppercase tracking-wider text-amber-900">
                On Hold by Doctor ({onHoldOrders.length})
              </h2>
              <div className="space-y-2">
                {onHoldOrders.map((ord) => (
                  <div
                    key={ord.id}
                    className="rounded-xl border border-amber-300 bg-amber-50/60 p-3 text-xs text-amber-950"
                  >
                    <div className="flex items-center justify-between">
                      <strong className="text-sm">{ord.medicineName}</strong>
                      <span className="rounded bg-amber-200 px-2 py-0.5 font-bold uppercase text-amber-900">
                        ⏸ On Hold
                      </span>
                    </div>
                    {ord.specialInstructions && (
                      <p className="mt-1 text-amber-800 font-medium">
                        Doctor’s Note / Hold Reason: {ord.specialInstructions}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Empty State for Daily Medicines */}
          {totalDailyDosesCount === 0 && onHoldOrders.length === 0 && (
            <div className="rounded-2xl border border-dashed border-ink-200 bg-white p-8 text-center">
              <p className="text-base font-bold text-ink-800">
                No daily scheduled medicines due right now.
              </p>
              <p className="mt-1 text-xs text-ink-500">
                All daily medications have been administered or none are scheduled for this shift.
              </p>
            </div>
          )}

          {/* Doses Given Today (Recent Log) */}
          {recentHistory.length > 0 && (
            <div className="mt-6 border-t border-ink-200 pt-4 space-y-2">
              <h3 className="text-xs font-bold uppercase tracking-wider text-ink-500">
                Given Today / Recent Doses ({recentHistory.length})
              </h3>
              <div className="space-y-1.5">
                {recentHistory.slice(0, 5).map((entry) => {
                  const isVoided = Boolean(entry.voidedAt);
                  const isGiven = entry.outcome === 'administered';
                  return (
                    <div
                      key={entry.id}
                      className={cn(
                        'flex items-center justify-between rounded-lg border px-3 py-2 text-xs',
                        isVoided
                          ? 'border-ink-200 bg-ink-50 text-ink-400 line-through'
                          : isGiven
                          ? 'border-emerald-200 bg-emerald-50/40 text-emerald-950'
                          : 'border-amber-200 bg-amber-50/40 text-amber-950',
                      )}
                    >
                      <div>
                        <span className="font-bold">
                          {entry.doseGiven || 'Dose'} ({formatRoutePlain(entry.routeGiven || 'oral')})
                        </span>
                        <span className="mx-2 text-ink-400">•</span>
                        <span>
                          {entry.actualTime
                            ? new Date(entry.actualTime).toLocaleTimeString(undefined, {
                                hour: '2-digit',
                                minute: '2-digit',
                              })
                            : 'Logged'}
                        </span>
                        {entry.clinicalNote && (
                          <span className="ml-2 italic text-ink-500">({entry.clinicalNote})</span>
                        )}
                      </div>

                      <div className="flex items-center gap-2">
                        <span className="font-semibold capitalize">
                          {isVoided ? 'Voided' : entry.outcome}
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
                            className="rounded px-1.5 py-0.5 text-[11px] font-bold text-rose-600 hover:bg-rose-50"
                          >
                            Void
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ========================================================================= */}
      {/* WINDOW 2: AS NEEDED (SOS) MEDICINES */}
      {/* ========================================================================= */}
      {activeTab === 'sos' && (
        <div className="space-y-3">
          <div className="rounded-xl border border-sky-200 bg-sky-50/50 p-3 text-xs text-sky-900">
            <strong>How SOS Works:</strong> Give these medicines only when the patient has the specific symptoms documented by the doctor below (e.g., fever, pain, vomiting).
          </div>

          {sosMedicines.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-ink-200 bg-white p-8 text-center">
              <p className="text-base font-bold text-ink-800">
                No As-Needed (SOS) medications prescribed.
              </p>
              <p className="mt-1 text-xs text-ink-500">
                The doctor has not ordered any SOS medications for this patient.
              </p>
            </div>
          ) : (
            sosMedicines.map((item) => {
              const eligible = item.eligibility.eligible;
              const remaining = item.eligibility.dosesRemainingToday ?? 0;

              return (
                <div
                  key={item.orderId}
                  className="rounded-2xl border-2 border-sky-200 bg-white p-4 shadow-xs space-y-3"
                >
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="text-lg font-black text-ink-950">
                          {item.medicineName}
                        </h3>
                        <span className="rounded bg-sky-100 px-2 py-0.5 font-mono text-xs font-bold text-sky-900">
                          {item.doseAmount} {item.doseUnit}
                        </span>
                        <span className="rounded bg-ink-900 px-2 py-0.5 text-xs font-bold uppercase text-white">
                          {formatRoutePlain(item.route)}
                        </span>
                      </div>

                      {/* Doctor's Documented Note / Reason to Give */}
                      <div className="mt-2 rounded-lg border border-sky-200 bg-sky-50/70 p-2.5 text-xs">
                        <strong className="text-sky-950">🩺 Give When Patient Has: </strong>
                        <span className="font-semibold text-sky-900">
                          {item.prnIndication || 'As advised by doctor'}
                        </span>
                      </div>
                    </div>

                    {canAdminister && (
                      <div className="shrink-0 pt-1">
                        {eligible ? (
                          <button
                            type="button"
                            onClick={() => setPrnItem(item)}
                            className="w-full sm:w-auto rounded-xl bg-sky-600 px-5 py-2.5 text-sm font-black text-white shadow-sm hover:bg-sky-700 transition"
                          >
                            ✓ Give SOS Dose
                          </button>
                        ) : (
                          <div className="text-right">
                            <span className="inline-block rounded-lg bg-amber-100 px-3 py-1.5 text-xs font-bold text-amber-900">
                              ⏳ {item.eligibility.reason || 'Cannot give yet'}
                            </span>
                          </div>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Limits and Allowances */}
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-600 border-t border-ink-100 pt-2">
                    {item.prnMinIntervalHours && (
                      <span>
                        Cooldown: Minimum <strong className="text-ink-800">{item.prnMinIntervalHours}h</strong> between doses
                      </span>
                    )}
                    {item.prnMaxDailyDoses && (
                      <span>
                        Daily Allowance: <strong className="text-ink-800">{remaining} doses remaining</strong> today
                      </span>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}

      {/* ========================================================================= */}
      {/* WINDOW 3: WARD SUPPLIES & CONSUMABLES (SYRINGES, CANNULAS) */}
      {/* ========================================================================= */}
      {activeTab === 'supplies' && (
        <div className="space-y-4 rounded-2xl border border-ink-200 bg-white p-5 shadow-xs">
          <div>
            <h3 className="text-sm font-bold text-ink-900">
              Log Ward Supplies & Consumables
            </h3>
            <p className="text-xs text-ink-500">
              Tap an item to charge it to this patient’s bed (e.g. syringes, cannulas, saline fluids).
            </p>
          </div>

          {!online && (
            <p className="flex items-center gap-2 rounded-xl bg-amber-100 px-4 py-2.5 text-xs font-medium text-amber-950">
              <WifiOffIcon className="size-4 shrink-0" />
              Offline mode: entries will be saved on this device and synced when connected.
            </p>
          )}

          {supplyConfirmation && (
            <div className="rounded-xl border border-emerald-300 bg-emerald-50 p-3 text-xs font-bold text-emerald-900">
              ✓ {supplyConfirmation}
            </div>
          )}

          {/* Quick Common Items */}
          {commonSupplies.length > 0 && (
            <div>
              <p className="mb-2 text-xs font-bold uppercase text-ink-400">
                Common Ward Supplies
              </p>
              <div className="flex flex-wrap gap-2">
                {commonSupplies.map((p, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() => setChosenSupply({ item: p.ref, label: p.label, unit: p.unit })}
                    className="rounded-xl border border-ink-200 bg-ink-50/70 px-3 py-2 text-xs font-semibold text-ink-800 hover:border-brand-400 hover:bg-brand-50 hover:text-brand-900"
                  >
                    + {p.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Selected Item Confirmation Panel */}
          {chosenSupply && (
            <div className="rounded-xl border-2 border-brand-300 bg-brand-50/40 p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <span className="text-[11px] font-bold uppercase text-brand-800">
                    Ready to Charge
                  </span>
                  <h4 className="text-base font-bold text-brand-950">
                    {chosenSupply.label}
                  </h4>
                </div>
                <button
                  type="button"
                  onClick={() => setChosenSupply(null)}
                  className="text-xs text-ink-500 hover:text-ink-800"
                >
                  Cancel
                </button>
              </div>

              <div className="flex items-center gap-3">
                <label className="text-xs font-semibold text-ink-700">Quantity:</label>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => setSupplyQuantity((q) => Math.max(1, q - 1))}
                    className="size-8 rounded-lg border border-ink-300 bg-white font-bold text-ink-800"
                  >
                    -
                  </button>
                  <span className="w-8 text-center font-bold text-ink-900">{supplyQuantity}</span>
                  <button
                    type="button"
                    onClick={() => setSupplyQuantity((q) => q + 1)}
                    className="size-8 rounded-lg border border-ink-300 bg-white font-bold text-ink-800"
                  >
                    +
                  </button>
                </div>

                <button
                  type="button"
                  onClick={handleSaveSupply}
                  disabled={savingSupply}
                  className="ml-auto rounded-xl bg-brand-600 px-5 py-2 text-xs font-bold text-white shadow-xs hover:bg-brand-700 disabled:opacity-50"
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
