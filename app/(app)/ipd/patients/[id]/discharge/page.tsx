import React from 'react';
import { notFound, redirect } from 'next/navigation';
import { eq, and } from 'drizzle-orm';
import { requireSession } from '@/lib/auth/session';
import { getAdmissionSummary } from '@/lib/services/ipd-census';
import { can, homePathFor } from '@/lib/domain/permissions';
import { DischargeTab } from '@/components/ipd/discharge/discharge-tab';
import { toggleDischargeReadyClientAction } from '@/app/(app)/ipd/actions';
import {
  getLatestDischargeSummary,
  listHomeMedications,
} from '@/lib/services/ipd-discharge-summary';
import { getDischargeClearance } from '@/lib/services/ipd-clearance';
import { withTenant } from '@/lib/db';
import { doctors } from '@/lib/db/schema';

export default async function DischargePage({ params }: { params: Promise<any> }) {
  const session = await requireSession();
  const resolvedParams = await params;
  const id = resolvedParams?.id as string;

  if (
    !can(session.role, 'ipd.dischargeReady') &&
    !can(session.role, 'ipd.discharge') &&
    !can(session.role, 'ipd.chart') &&
    session.role !== 'nurse'
  ) {
    redirect(homePathFor(session.role));
  }

  const admission = await getAdmissionSummary(session.hospitalId, id);
  if (!admission) notFound();

  let dischargeSummary: any = null;
  let homeMedications: any[] = [];
  let attendingDoctor: any = null;
  let clearanceView: any = null;

  try {
    const [summary, homeMeds, clearanceData] = await Promise.all([
      getLatestDischargeSummary(session.hospitalId, id).catch(() => null),
      listHomeMedications(session.hospitalId, id).catch(() => []),
      getDischargeClearance(session.hospitalId, id).catch(() => null),
    ]);
    dischargeSummary = summary;
    homeMedications = homeMeds;
    clearanceView = clearanceData;
  } catch {
    // Graceful fallback
  }

  // Look up doctor registration details
  try {
    attendingDoctor = await withTenant(session.hospitalId, async (tx) => {
      if (admission.doctorId) {
        return tx.query.doctors.findFirst({
          where: and(eq(doctors.id, admission.doctorId), eq(doctors.hospitalId, session.hospitalId)),
          columns: { id: true, name: true, registrationNo: true },
        });
      }
      return tx.query.doctors.findFirst({
        where: eq(doctors.hospitalId, session.hospitalId),
        columns: { id: true, name: true, registrationNo: true },
      });
    });
  } catch {
    // Graceful fallback
  }

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
        doctorName={admission.doctorName ?? attendingDoctor?.name ?? undefined}
        patientName={admission.patientName}
        mrn={admission.mrn ?? undefined}
        ipdNumber={admission.ipdNumber != null ? String(admission.ipdNumber) : undefined}
        bedLabel={admission.bed?.label}
        wardName={admission.bed?.wardName}
        dischargeSummary={dischargeSummary}
        homeMedications={homeMedications}
        attendingDoctor={attendingDoctor}
        initialClearance={clearanceView?.clearance}
        activeMedicationLines={clearanceView?.activeMedicationLines ?? []}
        medRecCompleted={clearanceView?.medRecCompleted ?? false}
        onToggleDischargeReady={handleToggleReady}
      />
    </div>
  );
}
