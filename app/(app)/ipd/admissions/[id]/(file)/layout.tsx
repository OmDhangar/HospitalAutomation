import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CompactPatientBar } from '@/components/ipd/shell/compact-patient-bar';
import { PrinterIcon } from '@/components/icons';
import { SheetTabs } from '@/components/ipd/sheet-tabs';
import { requireModule } from '@/lib/auth/modules';
import { requireSession } from '@/lib/auth/session';
import { can } from '@/lib/domain/permissions';
import { fileTabsFor, moduleAllows, printSheetsFor } from '@/lib/modules/registry';
import { getAllergies } from '@/lib/services/allergy';
import { logRecordAccess } from '@/lib/services/record-access';
import { loadAdmission } from './data';

/**
 * The patient file (IPD sheets plan §4.1, phase A4-min): the patient's header,
 * then the sheets of their paper file as tabs, in paper order — generated from
 * the module registry, so a sheet the hospital has switched off is not listed.
 *
 * Opening the file is one read of the patient's record (DPDP). It is logged
 * here, not per sheet: moving between tabs keeps this layout, and a refresh
 * within 10 minutes adds nothing, so the log answers "who opened whose file"
 * without a row per click.
 *
 * Assign, Transfer and Bill sit outside this route group: they are steps, not
 * sheets, and keep their own headers.
 */
export default async function PatientFileLayout({ children, params }: LayoutProps<'/ipd/admissions/[id]'>) {
  const session = await requireSession();
  const states = await requireModule(session, 'patient_file');
  const { id } = await params;
  const admission = await loadAdmission(session.hospitalId, id);
  if (!admission) notFound();

  await logRecordAccess({
    hospitalId: session.hospitalId,
    actorUserId: session.userId,
    patientId: admission.patientId,
    encounterId: admission.encounterId,
    action: 'view_admission',
    dedupeMinutes: 10,
  });

  const base = `/ipd/admissions/${id}`;
  const tabs = fileTabsFor(states, session.role).map((tab) => ({
    label: tab.label,
    href: tab.slug ? `${base}/${tab.slug}` : base,
  }));
  const printable = printSheetsFor(states, session.role);
  const inBed = admission.status === 'admitted' || admission.status === 'discharge_ready';
  return (
    <div className="mx-auto max-w-4xl space-y-3">
      <CompactPatientBar
        name={admission.patientName}
        age={admission.age}
        gender={admission.gender}
        phoneE164={admission.phoneE164}
        bed={admission.bed && inBed ? admission.bed : null}
        admittedAt={admission.admittedAt}
        doctorName={admission.doctorName}
        status={admission.status}
        timezone={session.timezone}
        now={new Date()}
        ipdNumber={admission.ipdNumber}
        backHref={
          session.role === 'nurse'
            ? admission.bed?.wardId
              ? `/ipd/ward/${admission.bed.wardId}`
              : '/ipd/ward'
            : session.role === 'doctor'
              ? '/ipd/my-patients'
              : '/ipd'
        }
        backLabel={
          session.role === 'nurse'
            ? '← Ward'
            : session.role === 'doctor'
              ? '← My patients'
              : '← IPD'
        }
        actions={
          <>
            {can(session.role, 'acct.view') && !session.readOnly ? (
              <Link
                href={`/accountability/record/admission/${id}`}
                className="inline-flex min-h-8 items-center rounded-lg px-2.5 text-xs font-semibold text-ink-700 ring-1 ring-ink-300 hover:bg-ink-50"
              >
                History
              </Link>
            ) : null}
            {printable.length > 0 ? (
              <Link
                href={`/print/ipd-file/${id}?sheets=${printable.map((sheet) => sheet.id).join(',')}`}
                target="_blank"
                className="inline-flex min-h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs font-semibold text-ink-700 ring-1 ring-ink-300 hover:bg-ink-50"
              >
                <PrinterIcon className="size-3.5" />
                Print file
              </Link>
            ) : null}
          </>
        }
      />

      {tabs.length > 1 ? <SheetTabs tabs={tabs} base={base} /> : null}

      {children}
    </div>
  );
}
