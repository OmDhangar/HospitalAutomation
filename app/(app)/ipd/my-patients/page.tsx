import { SavedNotice } from '@/components/saved-notice';
import { Alert, Card, EmptyState } from '@/components/ui';
import { requireSession } from '@/lib/auth/session';
import { can } from '@/lib/domain/permissions';
import { getTestChips, listMyAdmittedPatients } from '@/lib/services/doctor-ipd';
import { undoIpdAction } from '../actions';
import { MyPatientsTable } from './my-patients-table';

export const metadata = { title: 'My patients · IPD' };

/**
 * The doctor's high-density clinical roster of admitted patients.
 * Rebuilt with Excel-dense layout, instant status badges, and 1-click actions.
 */
export default async function MyPatientsPage({ searchParams }: PageProps<'/ipd/my-patients'>) {
  const session = await requireSession();
  const params = await searchParams;
  if (!can(session.role, 'ipd.dischargeReady')) {
    return (
      <Card>
        <EmptyState title="For doctors" hint="This is the doctor’s view of their admitted patients." />
      </Card>
    );
  }

  const seeAll = can(session.role, 'hospital.configure');
  const [{ linkedDoctor, patients }, chips] = await Promise.all([
    listMyAdmittedPatients({ hospitalId: session.hospitalId, userId: session.userId, seeAll }),
    can(session.role, 'ipd.orderTests') ? getTestChips(session.hospitalId) : Promise.resolve([]),
  ]);
  const writable = !session.readOnly;

  return (
    <div className="mx-auto max-w-6xl space-y-3">
      {/* Page Header */}
      <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between border-b border-ink-200 pb-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-base font-bold text-ink-950 tracking-tight">
              My Admitted Patients
            </h1>
            <span className="rounded-full bg-brand-100 px-2.5 py-0.5 font-mono text-xs font-bold text-brand-800">
              {patients.length}
            </span>
          </div>
          <p className="text-xs text-ink-500 mt-0.5">
            Active inpatient cohort under your clinical care. Click patient name or Chart to view complete chart file.
          </p>
        </div>
      </div>

      {typeof params.error === 'string' ? <Alert tone="error">{params.error}</Alert> : null}
      {typeof params.saved === 'string' ? (
        <SavedNotice
          message={params.saved}
          undo={typeof params.undo === 'string' ? params.undo : null}
          action={undoIpdAction}
          hidden={{ _back: '/ipd/my-patients' }}
        />
      ) : null}

      {!linkedDoctor && !seeAll ? (
        <Card>
          <EmptyState
            title="Your login is not linked to a doctor."
            hint="Ask the hospital owner to link it in Settings → Doctors."
          />
        </Card>
      ) : (
        <MyPatientsTable
          patients={patients}
          chips={chips}
          writable={writable}
          timezone={session.timezone}
        />
      )}
    </div>
  );
}
