import React from 'react';
import { notFound } from 'next/navigation';
import { requireSession } from '@/lib/auth/session';
import { getAdmissionSummary } from '@/lib/services/ipd-census';
import { can } from '@/lib/domain/permissions';
import { DischargeTab } from '@/components/ipd/discharge/discharge-tab';
import { toggleDischargeReadyClientAction } from '@/app/(app)/ipd/actions';

export default async function DischargePage({ params }: { params: Promise<any> }) {
  const session = await requireSession();
  const resolvedParams = await params;
  const id = resolvedParams?.id as string;

  const admission = await getAdmissionSummary(session.hospitalId, id);
  if (!admission) notFound();

  const handleToggleReady = async (ready: boolean) => {
    'use server';
    await toggleDischargeReadyClientAction({
      admissionId: id,
      ready,
    });
  };

  const canDischarge = can(session.role, 'ipd.dischargeReady') && !session.readOnly;

  return (
    <div className="space-y-6">
      <DischargeTab
        admissionId={id}
        status={admission.status}
        canDischarge={canDischarge}
        dischargeReadyAt={admission.dischargeReadyAt}
        onToggleDischargeReady={handleToggleReady}
      />
    </div>
  );
}
