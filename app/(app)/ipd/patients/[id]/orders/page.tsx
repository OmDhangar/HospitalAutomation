import React from 'react';
import { notFound } from 'next/navigation';
import { requireSession } from '@/lib/auth/session';
import { can } from '@/lib/domain/permissions';
import { getAdmissionSummary } from '@/lib/services/ipd-census';
import { listActiveOrders } from '@/lib/services/ipd-medication-orders';
import { MinimalOrdersTab } from '@/components/ipd/orders/minimal-orders-tab';
import { stopMedicationOrderAction } from '@/app/(app)/ipd/actions';
import type { StopReason } from '@/constants/clinical';

export default async function OrdersPage({ params }: { params: Promise<any> }) {
  const session = await requireSession();
  const resolvedParams = await params;
  const id = resolvedParams?.id as string;

  const [admission, orders] = await Promise.all([
    getAdmissionSummary(session.hospitalId, id),
    listActiveOrders({ hospitalId: session.hospitalId, admissionId: id }),
  ]);

  if (!admission) notFound();

  const formattedOrders = orders.map((o) => ({
    id: o.id,
    medicineName: o.medicineName,
    doseAmount: o.doseAmount,
    doseUnit: o.doseUnit,
    route: o.route,
    status: o.status,
    frequencyCode: o.frequencyCode ?? 'OD',
    scheduleTimes: (o.scheduleTimes as string[]) ?? [],
    instructions: o.specialInstructions,
    startsAt: o.startsAt,
    endsAt: o.endsAt,
  }));

  const handleStopOrder = async (orderId: string, reason: StopReason, notes?: string) => {
    'use server';
    await stopMedicationOrderAction({
      admissionId: id,
      orderId,
      reason: notes ? `${reason}: ${notes}` : reason,
    });
  };

  return (
    <div className="space-y-6">
      <MinimalOrdersTab
        admissionId={id}
        orders={formattedOrders}
        patientName={admission.patientName}
        uhid={admission.mrn ?? '—'}
        bedLabel={admission.bed?.label ?? undefined}
        initialDiagnosis={admission.reason}
        canPrescribe={can(session.role, 'ipd.prescribe') && !session.readOnly}
        onStopOrder={handleStopOrder}
      />
    </div>
  );
}
