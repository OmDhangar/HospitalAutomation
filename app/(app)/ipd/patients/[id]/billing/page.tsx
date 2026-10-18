import React from 'react';
import { notFound, redirect } from 'next/navigation';
import { requireSession } from '@/lib/auth/session';
import { can, homePathFor } from '@/lib/domain/permissions';
import { getDischargeBillView } from '@/lib/services/discharge-billing';
import { BillingAndConsumablesTab } from '@/components/ipd/billing/billing-and-consumables-tab';

export const metadata = { title: 'Billing & Consumables · IPD' };

export default async function PatientBillingPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await requireSession();
  if (!can(session.role, 'billing.collect') && !can(session.role, 'ipd.discharge') && !can(session.role, 'billing.price')) {
    redirect(homePathFor(session.role));
  }
  const { id } = await params;

  const billView = await getDischargeBillView({
    hospitalId: session.hospitalId,
    admissionId: id,
  });

  if (!billView) notFound();

  return (
    <BillingAndConsumablesTab
      admissionId={id}
      lines={billView.lines}
      payments={billView.payments}
      totals={billView.totals}
      canManage={!session.readOnly}
    />
  );
}
