import React from 'react';
import { notFound } from 'next/navigation';
import { desc, eq, and, isNull } from 'drizzle-orm';
import { requireSession } from '@/lib/auth/session';
import { withTenant, type Tx } from '@/lib/db';
import { careEntries, chargeItems } from '@/lib/db/schema';
import { getAdmissionSummary } from '@/lib/services/ipd-census';
import { getTestChips } from '@/lib/services/doctor-ipd';
import { InvestigationsTab, type InvestigationItem } from '@/components/ipd/investigations/investigations-tab';

export const metadata = { title: 'Investigations · IPD' };

export default async function PatientInvestigationsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await requireSession();
  const { id } = await params;

  const [admission, testChips] = await Promise.all([
    getAdmissionSummary(session.hospitalId, id),
    getTestChips(session.hospitalId),
  ]);

  if (!admission) notFound();

  const investigations = await withTenant(
    session.hospitalId,
    async (tx: Tx) => {
      const rows = await tx
        .select({
          id: careEntries.id,
          chargeItemId: careEntries.chargeItemId,
          testName: chargeItems.name,
          orderedAt: careEntries.occurredAt,
        })
        .from(careEntries)
        .innerJoin(chargeItems, eq(chargeItems.id, careEntries.chargeItemId))
        .where(
          and(
            eq(careEntries.hospitalId, session.hospitalId),
            eq(careEntries.admissionId, id),
            eq(chargeItems.isTest, true),
            isNull(careEntries.voidedAt),
          ),
        )
        .orderBy(desc(careEntries.occurredAt));

      return rows.map((row) => ({
        id: row.id,
        name: row.testName,
        category: 'Diagnostic Lab',
        orderedAt: new Date(row.orderedAt),
        status: 'reported' as const,
        result: 'Results archived in laboratory record',
        normalRange: 'Standard reference limits',
        isCritical: false,
      }));
    },
    { clinical: true },
  );

  return (
    <InvestigationsTab
      admissionId={id}
      investigations={investigations}
      testChips={testChips}
      canOrder={!session.readOnly}
    />
  );
}
