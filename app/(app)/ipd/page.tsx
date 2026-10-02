import Link from 'next/link';
import { redirect } from 'next/navigation';
import { AutoRefresh } from '@/components/auto-refresh';
import { Button, Card, CardHeader, EmptyState, cn } from '@/components/ui';
import { BedIcon, ClockIcon } from '@/components/icons';
import { BedGrid } from '@/components/ipd/bed-grid';
import { requireSession } from '@/lib/auth/session';
import { dayOfStay, sinceLabel } from '@/lib/domain/admission';
import { can, homePathFor } from '@/lib/domain/permissions';
import { getIpdCensus, type CensusPatient } from '@/lib/services/ipd-census';

export const metadata = { title: 'IPD' };

type Tab = 'awaiting' | 'wards' | 'ready';

/**
 * The IPD home (IPD plan §5.2): Awaiting bed · Wards · Discharge ready.
 *
 * Opens on Awaiting bed when someone is waiting — that is the desk's next
 * job — and on Wards otherwise. Refreshes every 15 seconds; nothing here is a
 * form, so a refresh never loses anyone's typing.
 */
export default async function IpdHomePage({ searchParams }: PageProps<'/ipd'>) {
  const session = await requireSession();
  // A nurse's home is the ward grid, where she records.
  if (!can(session.role, 'queue.mutate')) redirect(homePathFor(session.role));
  const params = await searchParams;
  const now = new Date();

  const census = await getIpdCensus({ hospitalId: session.hospitalId, branchId: session.branchId });
  const canAdmit = can(session.role, 'ipd.admit') && !session.readOnly;
  const requested = params.tab;
  const tab: Tab =
    requested === 'awaiting' || requested === 'wards' || requested === 'ready'
      ? requested
      : census.awaitingBed.length > 0
        ? 'awaiting'
        : 'wards';
  const bedForAssign = typeof params.bed === 'string' ? params.bed : null;

  const tabs: { value: Tab; label: string; count?: number }[] = [
    { value: 'awaiting', label: 'Awaiting bed', count: census.awaitingBed.length },
    { value: 'wards', label: 'Wards' },
    { value: 'ready', label: 'Discharge ready', count: census.dischargeReady.length },
  ];
  const totalBeds = census.wards.reduce((sum, ward) => sum + ward.beds.length, 0);
  const occupied = census.wards.reduce((sum, ward) => sum + ward.occupied, 0);

  return (
    <>
      <AutoRefresh seconds={15} />

      <div
        role="tablist"
        aria-label="IPD overview"
        className="grid grid-cols-3 gap-1 rounded-xl bg-ink-200/60 p-1 sm:inline-grid sm:w-auto"
      >
        {tabs.map((option) => (
          <Link
            key={option.value}
            role="tab"
            aria-selected={tab === option.value}
            href={`/ipd?tab=${option.value}`}
            className={cn(
              'flex min-h-11 items-center justify-center gap-1.5 rounded-lg px-2 text-center text-sm font-semibold sm:px-4',
              tab === option.value ? 'bg-white text-ink-900 shadow-xs' : 'text-ink-600 hover:text-ink-900',
            )}
          >
            <span className="truncate">{option.label}</span>
            {option.count !== undefined ? (
              <span
                className={cn(
                  'numeric rounded-full px-1.5 text-xs',
                  option.count > 0 && option.value === 'awaiting'
                    ? 'bg-amber-500 text-white'
                    : 'bg-ink-100 text-ink-700',
                )}
              >
                {option.count}
              </span>
            ) : null}
          </Link>
        ))}
      </div>

      {tab === 'awaiting' ? (
        <AwaitingBed patients={census.awaitingBed} now={now} canAdmit={canAdmit} bedForAssign={bedForAssign} />
      ) : null}

      {tab === 'wards' ? (
        census.wards.length === 0 ? (
          <Card>
            <EmptyState
              title="No wards set up yet"
              hint={
                can(session.role, 'ipd.configure')
                  ? 'Add wards and beds in Settings → IPD.'
                  : 'Ask the hospital owner to set up wards and beds.'
              }
            />
            {can(session.role, 'ipd.configure') ? (
              <div className="pb-6 text-center">
                <Link href="/settings/ipd">
                  <Button variant="primary" size="lg">
                    Set up wards
                  </Button>
                </Link>
              </div>
            ) : null}
          </Card>
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-ink-600">
              <span className="numeric font-semibold text-ink-900">{occupied}</span> of{' '}
              <span className="numeric">{totalBeds}</span> beds occupied
            </p>
            {census.wards.map((ward) => (
              <Card key={ward.id}>
                <CardHeader
                  title={ward.name}
                  hint={`${ward.occupied} of ${ward.beds.length} beds`}
                />
                <div className="p-3 sm:p-4">
                  <BedGrid
                    label={`Beds in ${ward.name}`}
                    beds={ward.beds}
                    timezone={session.timezone}
                    now={now}
                    hrefFor={(bed) => `/ipd/admissions/${bed.occupant!.admissionId}`}
                    emptyHrefFor={
                      canAdmit && census.awaitingBed.length > 0
                        ? (bed) => `/ipd?tab=awaiting&bed=${bed.id}`
                        : undefined
                    }
                  />
                </div>
              </Card>
            ))}
          </div>
        )
      ) : null}

      {tab === 'ready' ? (
        <DischargeReady patients={census.dischargeReady} now={now} timezone={session.timezone} canDischarge={can(session.role, 'ipd.discharge') && !session.readOnly} />
      ) : null}
    </>
  );
}

function AwaitingBed({
  patients,
  now,
  canAdmit,
  bedForAssign,
}: {
  patients: CensusPatient[];
  now: Date;
  canAdmit: boolean;
  bedForAssign: string | null;
}) {
  if (patients.length === 0) {
    return (
      <Card>
        <EmptyState title="No one is waiting for a bed." hint="Patients shifted from OPD appear here." />
      </Card>
    );
  }
  return (
    <div className="space-y-3">
      {bedForAssign ? (
        <p className="rounded-lg bg-brand-50 px-3 py-2 text-sm text-brand-900 ring-1 ring-brand-200">
          Choose who goes into the bed you tapped.
        </p>
      ) : null}
      <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {patients.map((patient) => (
          <li key={patient.admissionId}>
            <Card className="flex h-full flex-col">
              <div className="flex-1 space-y-1 p-4">
                <p className="truncate text-lg font-bold text-ink-900">{patient.patientName}</p>
                <p className="text-sm text-ink-600">
                  {[patient.age !== null ? String(patient.age) : null, patient.gender?.[0]?.toUpperCase()]
                    .filter(Boolean)
                    .join(' ')}
                  {patient.age !== null || patient.gender ? ' · ' : ''}
                  {patient.doctorName}
                </p>
                <p className="flex items-center gap-1.5 text-xs text-ink-500">
                  <ClockIcon className="size-3.5" />
                  Requested {sinceLabel(patient.requestedAt, now)}
                </p>
                {patient.reason ? <p className="text-sm text-ink-700">{patient.reason}</p> : null}
              </div>
              <div className="border-t border-ink-200 p-3">
                {canAdmit ? (
                  <Link
                    href={`/ipd/admissions/${patient.admissionId}/assign${bedForAssign ? `?bed=${bedForAssign}` : ''}`}
                    className="block"
                  >
                    <Button variant="primary" size="lg" className="w-full gap-2">
                      <BedIcon className="size-5" />
                      Assign bed
                    </Button>
                  </Link>
                ) : (
                  <Link href={`/ipd/admissions/${patient.admissionId}`} className="block">
                    <Button size="lg" className="w-full">
                      Open
                    </Button>
                  </Link>
                )}
              </div>
            </Card>
          </li>
        ))}
      </ul>
    </div>
  );
}

function DischargeReady({
  patients,
  now,
  timezone,
  canDischarge,
}: {
  patients: CensusPatient[];
  now: Date;
  timezone: string;
  canDischarge: boolean;
}) {
  if (patients.length === 0) {
    return (
      <Card>
        <EmptyState
          title="No one is ready to go home yet."
          hint="When a doctor marks a patient Discharge ready, they appear here for billing."
        />
      </Card>
    );
  }
  return (
    <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {patients.map((patient) => (
        <li key={patient.admissionId}>
          <Card className="flex h-full flex-col">
            <div className="flex-1 space-y-1 p-4">
              <p className="truncate text-lg font-bold text-ink-900">{patient.patientName}</p>
              <p className="text-sm text-ink-600">
                {patient.bed ? `${patient.bed.wardName} · Bed ${patient.bed.label}` : 'No bed'}
                {patient.admittedAt ? ` · Day ${dayOfStay(patient.admittedAt, now, timezone)}` : ''}
              </p>
              <p className="text-xs text-ink-500">
                Ready {patient.dischargeReadyAt ? sinceLabel(patient.dischargeReadyAt, now) : ''} · {patient.doctorName}
              </p>
            </div>
            <div className="border-t border-ink-200 p-3">
              <Link
                href={canDischarge ? `/ipd/admissions/${patient.admissionId}/bill` : `/ipd/admissions/${patient.admissionId}`}
                className="block"
              >
                <Button variant={canDischarge ? 'primary' : 'secondary'} size="lg" className="w-full">
                  {canDischarge ? 'Start discharge bill' : 'Open'}
                </Button>
              </Link>
            </div>
          </Card>
        </li>
      ))}
    </ul>
  );
}
