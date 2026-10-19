import { notFound, redirect } from 'next/navigation';
import { requireSession } from '@/lib/auth/session';
import { can } from '@/lib/domain/permissions';
import { getAdmissionSummary } from '@/lib/services/ipd-census';
import { getLetterhead } from '@/lib/services/letterhead';
import { logRecordAccess } from '@/lib/services/record-access';
import { DynamicAdmissionSheet } from '@/components/ipd/print/dynamic-admission-sheet';
import { DynamicConsentSheet } from '@/components/ipd/print/dynamic-consent-sheet';
import { PrintControls } from '@/app/print/prescription/[id]/print-controls';

export const metadata = { title: 'IPD Admission Sheet & Consent' };

export default async function IpdAdmissionPrintPage({
  params,
  searchParams,
}: {
  params: Promise<{ admissionId: string }>;
  searchParams: Promise<{ autoprint?: string }>;
}) {
  const session = await requireSession();
  if (session.mustChangePassword) redirect('/change-password');
  if (!can(session.role, 'ipd.view')) notFound();

  const { admissionId } = await params;
  const query = await searchParams;

  const admission = await getAdmissionSummary(session.hospitalId, admissionId);
  if (!admission) notFound();

  const letterhead = await getLetterhead(session.hospitalId, admission.branchId);

  await logRecordAccess({
    hospitalId: session.hospitalId,
    actorUserId: session.userId,
    patientId: admission.patientId,
    encounterId: admission.encounterId,
    action: 'print_ipd_file',
  });

  const autoPrint = query.autoprint !== '0';

  return (
    <div className="min-h-screen bg-ink-100 py-6 print:bg-white print:py-0">
      <div className="mx-auto max-w-[210mm]">
        {/* On-screen Print / Close Bar */}
        <PrintControls autoPrint={autoPrint} />

        {/* Page 1: Admission Sheet */}
        <div className="bg-white shadow-lg print:shadow-none mb-8 print:mb-0">
          <DynamicAdmissionSheet admission={admission} letterhead={letterhead} />
        </div>

        {/* Page Split for A4 Printing */}
        <div className="break-before-page print:break-before-page" />

        {/* Page 2: High-Risk Informed Consent */}
        <div className="bg-white shadow-lg print:shadow-none">
          <DynamicConsentSheet admission={admission} letterhead={letterhead} />
        </div>
      </div>
    </div>
  );
}
