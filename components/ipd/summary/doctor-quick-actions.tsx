'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { AddClinicalNoteModal } from '@/components/ipd/notes/add-clinical-note-modal';
import { CreateTreatmentPlanModal } from '@/components/ipd/prescriptions/create-treatment-plan-modal';
import { OrderInvestigationModal } from '@/components/ipd/investigations/order-investigation-modal';
import type { TestChip } from '@/lib/services/doctor-ipd';

export interface DoctorQuickActionsProps {
  admissionId: string;
  patientName: string;
  initialDiagnosis?: string | null;
  testChips?: TestChip[];
  canPrescribe?: boolean;
  activeOrders?: Array<{
    id: string;
    medicineName: string;
    strength?: string | null;
    form?: string | null;
    route: string;
    frequency?: string | null;
  }>;
}

export function DoctorQuickActions({
  admissionId,
  patientName,
  initialDiagnosis,
  testChips = [],
  canPrescribe = true,
  activeOrders = [],
}: DoctorQuickActionsProps) {
  const router = useRouter();
  const [isNoteOpen, setIsNoteOpen] = useState(false);
  const [isPrescribeOpen, setIsPrescribeOpen] = useState(false);
  const [isOrderTestOpen, setIsOrderTestOpen] = useState(false);

  const handleSuccess = () => {
    router.refresh();
  };

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setIsNoteOpen(true)}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-brand-300 bg-brand-50 text-brand-900 text-xs font-bold shadow-2xs hover:bg-brand-100 transition-colors cursor-pointer"
          title="Add a daily progress note or SOAP documentation"
        >
          <span>✍️ + Progress Note</span>
        </button>

        {canPrescribe && (
          <button
            type="button"
            onClick={() => setIsPrescribeOpen(true)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-emerald-300 bg-emerald-50 text-emerald-950 text-xs font-bold shadow-2xs hover:bg-emerald-100 transition-colors cursor-pointer"
            title="Prescribe new medications or IV fluid treatment plan"
          >
            <span>💊 + Prescribe Medicine</span>
          </button>
        )}

        {canPrescribe && testChips.length > 0 && (
          <button
            type="button"
            onClick={() => setIsOrderTestOpen(true)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-purple-300 bg-purple-50 text-purple-950 text-xs font-bold shadow-2xs hover:bg-purple-100 transition-colors cursor-pointer"
            title="Order laboratory tests or diagnostic imaging"
          >
            <span>🧪 + Order Test</span>
          </button>
        )}
      </div>

      {/* 1. Add Clinical Note Modal */}
      <AddClinicalNoteModal
        admissionId={admissionId}
        isOpen={isNoteOpen}
        onClose={() => setIsNoteOpen(false)}
        onSuccess={() => {
          setIsNoteOpen(false);
          handleSuccess();
        }}
      />

      {/* 2. Prescribe Treatment Plan Modal */}
      <CreateTreatmentPlanModal
        admissionId={admissionId}
        patientName={patientName}
        initialDiagnosis={initialDiagnosis}
        isOpen={isPrescribeOpen}
        onClose={() => setIsPrescribeOpen(false)}
        activeOrders={activeOrders}
      />

      {/* 3. Order Investigation Modal */}
      <OrderInvestigationModal
        admissionId={admissionId}
        isOpen={isOrderTestOpen}
        testChips={testChips}
        onClose={() => setIsOrderTestOpen(false)}
        onSuccess={() => {
          setIsOrderTestOpen(false);
          handleSuccess();
        }}
      />
    </>
  );
}
