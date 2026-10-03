import { SavedNotice } from '@/components/saved-notice';
import Link from 'next/link';
import { Alert, Button, Card, EmptyState, cn } from '@/components/ui';
import { requireSession } from '@/lib/auth/session';
import { dayOfStay, sinceLabel } from '@/lib/domain/admission';
import { can } from '@/lib/domain/permissions';
import { getTestChips, listMyAdmittedPatients } from '@/lib/services/doctor-ipd';
import { orderTestsAction, setDischargeReadyAction, undoIpdAction } from '../actions';

export const metadata = { title: 'My patients · IPD' };

/**
 * The doctor's phone view of IPD (IPD plan §T3.1): my admitted patients as
 * cards, each with two buttons — Discharge ready, and Tests. Nothing on the
 * page needs typing: tests are chips, and both actions are one tap.
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
  const now = new Date();
  const writable = !session.readOnly;

  return (
    <div className="mx-auto max-w-xl space-y-4">
      <h1 className="text-xl font-bold text-ink-900">
        My patients <span className="numeric font-normal text-ink-500">({patients.length})</span>
      </h1>
      {typeof params.error === 'string' ? <Alert tone="error">{params.error}</Alert> : null}
      {typeof params.saved === 'string' ? (
        <SavedNotice
          message={params.saved}
          undo={typeof params.undo === 'string' ? params.undo : null}
          action={undoIpdAction} hidden={{ _back: '/ipd/my-patients' }}
        />
      ) : null}

      {!linkedDoctor && !seeAll ? (
        <Card>
          <EmptyState
            title="Your login is not linked to a doctor."
            hint="Ask the hospital owner to link it in Settings → Doctors."
          />
        </Card>
      ) : patients.length === 0 ? (
        <Card>
          <EmptyState title="No admitted patients." hint="Patients you shift to IPD appear here once they have a bed." />
        </Card>
      ) : (
        <ul className="space-y-3">
          {patients.map((patient) => {
            const ready = patient.status === 'discharge_ready';
            return (
              <li key={patient.admissionId}>
                <Card className={cn(ready && 'ring-2 ring-emerald-300')}>
                  <Link href={`/ipd/admissions/${patient.admissionId}`} className="block px-4 pt-4">
                    <p className="text-lg font-bold text-ink-900">{patient.patientName}</p>
                    <p className="text-base text-ink-600">
                      {patient.bed ? `${patient.bed.wardName} · Bed ${patient.bed.label}` : 'No bed'}
                      {patient.admittedAt ? ` · Day ${dayOfStay(patient.admittedAt, now, session.timezone)}` : ''}
                    </p>
                    <p className="text-sm text-ink-500">
                      {patient.lastEntryAt ? `Last given ${sinceLabel(patient.lastEntryAt, now)}` : 'Nothing given yet'}
                      {ready ? ' · Marked ready to go home' : ''}
                    </p>
                  </Link>
                  {writable ? (
                    <div className="grid grid-cols-2 gap-2 p-4">
                      <form action={setDischargeReadyAction}>
                        <input type="hidden" name="admissionId" value={patient.admissionId} />
                        <input type="hidden" name="ready" value={ready ? 'false' : 'true'} />
                        <input type="hidden" name="back" value="/ipd/my-patients" />
                        <Button type="submit" size="lg" variant={ready ? 'ghost' : 'primary'} className="w-full">
                          {ready ? 'Not ready' : 'Discharge ready'}
                        </Button>
                      </form>
                      {chips.length > 0 ? (
                        <details className="group col-span-2 sm:col-span-1">
                          <summary className="flex min-h-12 cursor-pointer list-none items-center justify-center rounded-lg bg-white text-base font-semibold text-ink-800 ring-1 ring-inset ring-ink-300">
                            Tests
                          </summary>
                          <form action={orderTestsAction} className="mt-3 space-y-3">
                            <input type="hidden" name="admissionId" value={patient.admissionId} />
                            <input type="hidden" name="formKey" value={crypto.randomUUID()} />
                            <div className="flex flex-wrap gap-2">
                              {chips.map((chip) => (
                                <label key={chip.id} className="cursor-pointer">
                                  <input type="checkbox" name="test" value={chip.id} className="peer sr-only" />
                                  <span className="inline-flex min-h-12 items-center rounded-xl bg-white px-4 text-base font-semibold text-ink-800 ring-1 ring-inset ring-ink-300 peer-checked:bg-brand-600 peer-checked:text-white peer-checked:ring-brand-700 peer-focus-visible:outline-2 peer-focus-visible:outline-brand-700">
                                    {chip.name}
                                  </span>
                                </label>
                              ))}
                            </div>
                            <Button type="submit" variant="primary" size="lg" className="w-full">
                              Send tests
                            </Button>
                          </form>
                        </details>
                      ) : null}
                    </div>
                  ) : null}
                </Card>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
