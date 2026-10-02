import Link from 'next/link';
import { Alert, Button, Card, EmptyState, Field, Input, cn } from '@/components/ui';
import { SearchIcon } from '@/components/icons';
import { AdmissionExtras } from '@/components/ipd/admission-extras';
import { BedPicker } from '@/components/ipd/bed-picker';
import { requireSession } from '@/lib/auth/session';
import { can } from '@/lib/domain/permissions';
import { formatIndianPhone, normalizeIndianPhone } from '@/lib/domain/phone';
import { listBranches } from '@/lib/services/auth';
import { listDoctors } from '@/lib/services/hospital';
import { findPatientsByPhone, listFreeBeds } from '@/lib/services/ipd-census';
import { createDirectAdmissionAction } from '../actions';

export const metadata = { title: 'New admission · IPD' };

const SELECT_CLASS =
  'block w-full rounded-lg border-0 bg-white px-3 py-2.5 text-ink-900 ring-1 ring-inset ring-ink-300 focus:ring-2 focus:ring-inset focus:ring-brand-600 focus:outline-none';

/**
 * New admission for a patient who never had an OPD token — an emergency
 * (IPD plan §5.4). Three steps on one page: patient, doctor, bed.
 *
 * The phone search runs first, so a returning patient is admitted on their
 * existing record (matched on phone + name, exactly as a walk-in is) and
 * nothing is retyped.
 */
export default async function NewAdmissionPage({ searchParams }: PageProps<'/ipd/new'>) {
  const session = await requireSession();
  const query = await searchParams;

  if (!can(session.role, 'ipd.admit')) {
    return (
      <Card>
        <EmptyState title="The desk admits patients" hint="Ask reception to admit this patient." />
      </Card>
    );
  }

  const typedPhone = typeof query.phone === 'string' ? query.phone : '';
  const phoneE164 = typedPhone ? normalizeIndianPhone(typedPhone) : null;
  const branchRows = await listBranches(session.hospitalId);
  const branchId = session.branchId ?? branchRows[0]?.id ?? '';
  const [matches, doctorRows, freeWards] = await Promise.all([
    phoneE164 ? findPatientsByPhone(session.hospitalId, phoneE164) : Promise.resolve([]),
    listDoctors({ hospitalId: session.hospitalId, branchId }),
    branchId ? listFreeBeds({ hospitalId: session.hospitalId, branchId }) : Promise.resolve([]),
  ]);
  const picked = typeof query.pick === 'string' ? matches.find((m) => m.id === query.pick) ?? null : null;
  const typedName = typeof query.name === 'string' ? query.name : '';

  return (
    <div className="mx-auto max-w-3xl space-y-4 pb-28 sm:pb-6">
      <Link href="/ipd" className="inline-flex min-h-11 items-center text-sm text-ink-500 hover:text-ink-800">
        ← IPD
      </Link>
      <h1 className="text-xl font-bold text-ink-900">New admission</h1>

      {typeof query.error === 'string' ? <Alert tone="error">{query.error}</Alert> : null}

      <Card>
        <div className="border-b border-ink-200 px-4 py-3 sm:px-5">
          <h2 className="text-base font-bold text-ink-900">1. Patient</h2>
          <p className="text-sm text-ink-500">Search by mobile number first.</p>
        </div>
        <form className="flex gap-2 p-4 sm:px-5">
          <Input
            name="phone"
            type="tel"
            inputMode="tel"
            required
            defaultValue={typedPhone}
            placeholder="98765 43210"
            className="h-12 text-lg"
            aria-label="Mobile number"
          />
          <Button type="submit" size="lg" className="gap-1.5">
            <SearchIcon className="size-4" />
            Search
          </Button>
        </form>
        {typedPhone && !phoneE164 ? (
          <p className="px-4 pb-4 text-sm text-rose-700 sm:px-5">Enter a 10-digit mobile number.</p>
        ) : null}
        {phoneE164 && matches.length > 0 ? (
          <div className="space-y-2 px-4 pb-4 sm:px-5">
            <p className="text-sm text-ink-600">On file for {formatIndianPhone(phoneE164)} — tap to use:</p>
            <ul className="flex flex-wrap gap-2">
              {matches.map((match) => (
                <li key={match.id}>
                  <Link
                    href={`/ipd/new?phone=${encodeURIComponent(typedPhone)}&pick=${match.id}`}
                    className={cn(
                      'inline-flex min-h-11 items-center rounded-lg px-3 text-sm font-semibold ring-1 ring-inset',
                      picked?.id === match.id
                        ? 'bg-brand-600 text-white ring-brand-700'
                        : 'bg-white text-ink-800 ring-ink-300 hover:bg-ink-50',
                    )}
                  >
                    {match.name}
                    {match.age !== null ? ` · ${match.age}` : ''}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ) : phoneE164 ? (
          <p className="px-4 pb-4 text-sm text-ink-600 sm:px-5">New patient — fill in the details below.</p>
        ) : null}
      </Card>

      {phoneE164 ? (
        <form action={createDirectAdmissionAction} className="space-y-4">
          <input type="hidden" name="phone" value={phoneE164} />
          <input type="hidden" name="branchId" value={branchId} />

          <Card>
            <div className="grid gap-3 p-4 sm:grid-cols-2 sm:p-5">
              <Field label="Patient name">
                <Input name="name" required defaultValue={picked?.name ?? typedName} placeholder="Full name" />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Age">
                  <Input name="age" inputMode="numeric" defaultValue={picked?.age ?? ''} placeholder="42" />
                </Field>
                <Field label="Sex">
                  <select name="gender" className={SELECT_CLASS} defaultValue={picked?.gender ?? ''}>
                    <option value="">—</option>
                    <option value="male">Male</option>
                    <option value="female">Female</option>
                    <option value="other">Other</option>
                  </select>
                </Field>
              </div>
              <div className="sm:col-span-2">
                <Field label="Address" hint="Optional">
                  <Input name="address" defaultValue={picked?.address ?? ''} />
                </Field>
              </div>
            </div>
          </Card>

          <Card>
            <div className="border-b border-ink-200 px-4 py-3 sm:px-5">
              <h2 className="text-base font-bold text-ink-900">2. Doctor</h2>
            </div>
            <div className="p-4 sm:p-5">
              {doctorRows.length === 0 ? (
                <p className="text-sm text-ink-600">Add a doctor in Settings first.</p>
              ) : (
                <select name="doctorId" required className={cn(SELECT_CLASS, 'h-12')} defaultValue="">
                  <option value="" disabled>
                    Choose the admitting doctor
                  </option>
                  {doctorRows.map((doctor) => (
                    <option key={doctor.id} value={doctor.id}>
                      {doctor.name}
                      {doctor.specialty ? ` · ${doctor.specialty}` : ''}
                    </option>
                  ))}
                </select>
              )}
            </div>
          </Card>

          <Card>
            <div className="border-b border-ink-200 px-4 py-3 sm:px-5">
              <h2 className="text-base font-bold text-ink-900">3. Bed</h2>
            </div>
            <div className="p-4 sm:p-5">
              <BedPicker wards={freeWards} optional />
            </div>
          </Card>

          <AdmissionExtras canCollect={can(session.role, 'billing.collect')} />

          <div className="fixed inset-x-0 bottom-0 z-40 border-t border-ink-200 bg-white/95 px-3.5 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur sm:static sm:border-0 sm:bg-transparent sm:p-0">
            <Button type="submit" variant="primary" size="xl" className="w-full">
              Admit patient
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
