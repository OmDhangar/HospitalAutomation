'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { VitalsFreshnessBar } from './vitals-freshness-bar';
import { AllergyBanner } from './allergy-banner';
import { ActiveOrdersReview } from './active-orders-review';
import { QuickPrescribeSection } from './quick-prescribe-section';
import { RoundNoteEditor } from './round-note-editor';
import { OrderSigningModal } from './order-signing-modal';
import type { RoundingCockpitData } from '@/lib/services/ipd-rounding-cockpit';
import type {
  DraftOrderInput,
  OrderResolution,
} from '@/lib/services/ipd-medication-orders';
import { saveRoundDraftAction } from '@/app/(app)/ipd/actions';

export interface RoundingCockpitProps {
  initialData: RoundingCockpitData;
  doctorId?: string;
  readOnly?: boolean;
}

export function RoundingCockpit({
  initialData,
  doctorId,
  readOnly = false,
}: RoundingCockpitProps) {
  const router = useRouter();
  const [data, setData] = useState<RoundingCockpitData>(initialData);

  // Round notes draft state
  const [notes, setNotes] = useState<string>(data.draftRound?.notes || '');
  const [lastDraftSavedAt, setLastDraftSavedAt] = useState<Date | null>(
    data.draftRound?.updatedAt ? new Date(data.draftRound.updatedAt) : null,
  );
  const [isDraftPending, startDraftTransition] = useTransition();

  // Resolutions state: default to 'continue' for all active orders
  const [resolutions, setResolutions] = useState<Record<string, OrderResolution>>(() => {
    const initial: Record<string, OrderResolution> = {};
    for (const order of data.activeOrders) {
      initial[order.id] = { type: 'continue', orderId: order.id };
    }
    return initial;
  });

  // New staged orders
  const [newOrders, setNewOrders] = useState<DraftOrderInput[]>([]);

  // Signing modal
  const [isSigningModalOpen, setIsSigningModalOpen] = useState(false);
  const [signedNotification, setSignedNotification] = useState<string | null>(null);

  const handleResolutionChange = (orderId: string, resolution: OrderResolution) => {
    setResolutions((prev) => ({
      ...prev,
      [orderId]: resolution,
    }));
  };

  const handleAddNewOrder = (order: DraftOrderInput) => {
    setNewOrders((prev) => [...prev, order]);
  };

  const handleRemoveNewOrder = (index: number) => {
    setNewOrders((prev) => prev.filter((_, idx) => idx !== index));
  };

  const handleSaveDraft = async () => {
    startDraftTransition(async () => {
      try {
        await saveRoundDraftAction({
          admissionId: data.admission.id,
          notes,
          doctorId,
        });
        setLastDraftSavedAt(new Date());
        router.refresh();
      } catch (err) {
        console.error('Failed to save draft round note:', err);
      }
    });
  };

  const handleSignedSuccess = (result: { roundId: string; signedOrderIds: string[] }) => {
    setSignedNotification(
      `Round successfully finalized and signed! ${result.signedOrderIds.length} orders are now live on the bedside eMAR.`,
    );
    setNewOrders([]);
    router.refresh();
  };

  // Count changed/non-continue decisions
  const changedResolutionsCount = Object.values(resolutions).filter(
    (r) => r.type !== 'continue',
  ).length;
  const totalOrdersToAuthorize =
    data.activeOrders.length + newOrders.length;

  return (
    <div className="space-y-4">
      {signedNotification && (
        <div className="flex items-center justify-between rounded-xl border border-emerald-300 bg-emerald-50 p-4 text-sm font-semibold text-emerald-950 shadow-xs">
          <div className="flex items-center gap-2">
            <span className="flex size-6 items-center justify-center rounded-full bg-emerald-600 text-white text-xs font-bold">
              ✓
            </span>
            <span>{signedNotification}</span>
          </div>
          <button
            type="button"
            onClick={() => setSignedNotification(null)}
            className="text-xs text-emerald-800 hover:text-emerald-950 font-medium"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* 1. Bedside Vitals Freshness Ribbon */}
      <VitalsFreshnessBar
        admissionId={data.admission.id}
        vitals={data.vitalsFreshness}
      />

      {/* 2. High-Priority Allergy Safety Banner */}
      <AllergyBanner
        admissionId={data.admission.id}
        assessment={data.allergyAssessment}
        readOnly={readOnly}
        onUpdated={() => router.refresh()}
      />

      {/* 2b. Urgent Nurse Administrations Banner (Awaiting Doctor Review) */}
      {data.urgentNurseAdministrations && data.urgentNurseAdministrations.length > 0 && (
        <div className="rounded-2xl border-2 border-rose-300 bg-rose-50/70 p-4 shadow-sm space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-xl">🚨</span>
              <h3 className="text-sm font-black text-rose-950 uppercase tracking-wide">
                Urgent Nurse Administrations (Awaiting Doctor Review & Co-Signature)
              </h3>
            </div>
            <span className="rounded-full bg-rose-200 px-2.5 py-0.5 text-xs font-bold text-rose-900">
              {data.urgentNurseAdministrations.length} dose(s) given
            </span>
          </div>

          <div className="space-y-2">
            {data.urgentNurseAdministrations.map((admin) => (
              <div
                key={admin.id}
                className="flex flex-col gap-1.5 rounded-xl border border-rose-200 bg-white p-3 text-xs sm:flex-row sm:items-center sm:justify-between"
              >
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <strong className="text-sm font-bold text-ink-950">
                      {admin.medicineName}
                    </strong>
                    <span className="rounded bg-rose-100 px-2 py-0.5 font-mono text-xs font-semibold text-rose-900">
                      {admin.doseGiven}
                    </span>
                    <span className="rounded bg-ink-100 px-1.5 py-0.5 text-[11px] font-medium uppercase text-ink-700">
                      {admin.routeGiven?.replace('_', ' ')}
                    </span>
                  </div>
                  <p className="mt-1 text-ink-600 font-medium">
                    Given {admin.actualTime ? new Date(admin.actualTime).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : 'recently'}
                    {admin.nurseName ? ` by ${admin.nurseName}` : ''}
                  </p>
                  {admin.clinicalNote && (
                    <p className="mt-0.5 italic text-rose-900 font-medium">
                      {admin.clinicalNote}
                    </p>
                  )}
                </div>

                <div className="flex shrink-0 items-center gap-2 pt-1 sm:pt-0">
                  <span className="rounded-md border border-amber-300 bg-amber-50 px-2 py-1 text-[11px] font-bold text-amber-900">
                    Awaiting Round Review
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 3. Active Inpatient Medication Orders Review */}
      <ActiveOrdersReview
        activeOrders={data.activeOrders}
        recentAdministrations={data.recentAdministrations}
        resolutions={resolutions}
        onChangeResolution={handleResolutionChange}
      />

      {/* 4. Accelerated Inpatient Prescribing Section */}
      {!readOnly && (
        <QuickPrescribeSection
          frequentMedicines={data.frequentMedicines}
          newOrders={newOrders}
          onAddNewOrder={handleAddNewOrder}
          onRemoveNewOrder={handleRemoveNewOrder}
          activeAllergies={data.allergyAssessment.allergens}
          existingActiveOrders={data.activeOrders}
        />
      )}

      {/* 5. Doctor Round Progress Note & Signing Trigger */}
      {!readOnly && (
        <RoundNoteEditor
          notes={notes}
          onChangeNotes={setNotes}
          onSaveDraft={handleSaveDraft}
          onOpenSigningModal={() => setIsSigningModalOpen(true)}
          isDraftPending={isDraftPending}
          lastSavedAt={lastDraftSavedAt}
          totalOrdersToAuthorize={totalOrdersToAuthorize}
        />
      )}

      {/* 6. Comprehensive Order Authorization & Signing Modal */}
      <OrderSigningModal
        isOpen={isSigningModalOpen}
        onClose={() => setIsSigningModalOpen(false)}
        admissionId={data.admission.id}
        roundNotes={notes}
        activeOrders={data.activeOrders}
        resolutions={resolutions}
        newOrders={newOrders}
        allergyAssessment={data.allergyAssessment}
        onSignedSuccess={handleSignedSuccess}
      />
    </div>
  );
}
