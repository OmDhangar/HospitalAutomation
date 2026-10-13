import React from 'react';
import { notFound } from 'next/navigation';
import { eq, and } from 'drizzle-orm';
import { requireSession } from '@/lib/auth/session';
import { requireModule } from '@/lib/auth/modules';
import { logRecordAccess } from '@/lib/services/record-access';
import { getAdmissionSummary } from '@/lib/services/ipd-census';
import { withTenant } from '@/lib/db';
import { ipdAllergyAssessments } from '@/lib/db/schema';
import { PatientBanner, type PatientBannerData } from '@/components/ipd/shell/patient-banner';
import { TabNavigation } from '@/components/ipd/shell/tab-navigation';

export default async function PatientChartLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<any>;
}) {
  const session = await requireSession();
  await requireModule(session, 'patient_file');
  const resolvedParams = await params;
  const id = resolvedParams?.id as string;

  const admission = await getAdmissionSummary(session.hospitalId, id);
  if (!admission) notFound();

  await logRecordAccess({
    hospitalId: session.hospitalId,
    actorUserId: session.userId,
    patientId: admission.patientId,
    encounterId: admission.encounterId,
    action: 'view_admission',
    dedupeMinutes: 10,
  });

  // Fetch allergy assessment if present
  let allergyStatus: PatientBannerData['allergyStatus'] = 'unreviewed';
  let allergiesList: string[] = [];

  try {
    const [allergyRow] = await withTenant(
      session.hospitalId,
      (tx) =>
        tx
          .select({
            status: ipdAllergyAssessments.status,
            allergens: ipdAllergyAssessments.allergens,
          })
          .from(ipdAllergyAssessments)
          .where(
            and(
              eq(ipdAllergyAssessments.hospitalId, session.hospitalId),
              eq(ipdAllergyAssessments.admissionId, id),
              eq(ipdAllergyAssessments.isCurrent, true),
            ),
          )
          .limit(1),
      { clinical: true },
    );

    if (allergyRow) {
      allergyStatus = allergyRow.status as PatientBannerData['allergyStatus'];
      if (Array.isArray(allergyRow.allergens)) {
        allergiesList = allergyRow.allergens
          .map((item: any) => (typeof item === 'string' ? item : item?.substance))
          .filter(Boolean);
      }
    }
  } catch {
    // Graceful fallback to unreviewed if allergy table fails
  }

  // Calculate day of stay
  const now = new Date();
  const dayOfStay = admission.admittedAt
    ? Math.max(
        1,
        Math.floor(
          (now.getTime() - new Date(admission.admittedAt).getTime()) /
            (1000 * 60 * 60 * 24),
        ) + 1,
      )
    : 1;

  let displayStatus = 'Admitted';
  if (admission.status === 'discharge_ready') {
    displayStatus = 'Ready for discharge';
  } else if (admission.status === 'discharged') {
    displayStatus = 'Discharged';
  } else if (admission.status === 'awaiting_bed') {
    displayStatus = 'Awaiting Bed';
  }

  const bannerPatient: PatientBannerData = {
    name: admission.patientName,
    age: admission.age,
    gender: admission.gender,
    uhid: admission.mrn ?? '—',
    ipdNumber: admission.ipdNumber ?? '—',
    wardName: admission.bed?.wardName ?? null,
    bedLabel: admission.bed?.label ?? null,
    dayOfStay,
    doctorName: admission.doctorName,
    diagnosis: admission.reason,
    allergyStatus,
    allergies: allergiesList,
    status: displayStatus,
  };

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col">
      <PatientBanner admissionId={id} patient={bannerPatient} />
      <TabNavigation admissionId={id} />
      <div className="flex-1 p-4 sm:p-6 max-w-7xl w-full mx-auto">{children}</div>
    </div>
  );
}
