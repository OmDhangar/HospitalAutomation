import Link from 'next/link';
import { SaveButton, SaveForm } from '@/components/save-form';
import { SavedNotice } from '@/components/saved-notice';
import { Alert, Card, CardHeader, EmptyState, Field, Input } from '@/components/ui';
import { FileTextIcon } from '@/components/icons';
import { PrintLetterhead } from '@/components/print/letterhead';
import { requireModule } from '@/lib/auth/modules';
import { requireSession } from '@/lib/auth/session';
import { nextIpdNumber } from '@/lib/domain/ipd-number';
import { LETTERHEAD_LIMITS, doctorDisplayName } from '@/lib/domain/letterhead';
import { can } from '@/lib/domain/permissions';
import { getIpdNumberState } from '@/lib/services/ipd-number';
import { getLetterhead, getLetterheadSettings } from '@/lib/services/letterhead';
import { saveDoctorLetterheadAction, saveHospitalLetterheadAction, setNextIpdNumberAction } from './actions';

export const metadata = { title: 'Letterhead · Settings' };

/**
 * Settings → Letterhead (IPD sheets plan §11.1 A4-min, decision D-LH): what
 * prints at the top of every IPD sheet, and where IPD numbers continue from.
 * The preview at the top is the real component the print pages use.
 */
export default async function LetterheadSettingsPage({ searchParams }: PageProps<'/settings/letterhead'>) {
  const session = await requireSession();
  const params = await searchParams;
  if (!can(session.role, 'hospital.configure')) {
    return (
      <Card>
        <EmptyState title="Owners only" hint="Ask the hospital owner to set up the letterhead." />
      </Card>
    );
  }
  await requireModule(session, 'letterhead');

  const canNumber = can(session.role, 'ipd.configure');
  const [settings, letterhead, numbers] = await Promise.all([
    getLetterheadSettings(session.hospitalId),
    getLetterhead(session.hospitalId, session.branchId),
    canNumber ? getIpdNumberState(session.hospitalId) : Promise.resolve(null),
  ]);
  const savedId = typeof params.id === 'string' ? params.id : null;
  const activeDoctors = settings.doctors.filter((d) => d.active);

  return (
    <div className="space-y-5">
      <div>
        <Link href="/settings" className="text-sm text-ink-500 hover:text-ink-800">
          ← Settings
        </Link>
        <h1 className="mt-1 flex items-center gap-2 text-xl font-bold text-ink-900">
          <FileTextIcon className="size-5 text-brand-600" />
          Letterhead and IPD numbers
        </h1>
        <p className="mt-0.5 text-sm text-ink-500">
          Printed at the top of every IPD sheet, the way your paper forms have it.
        </p>
      </div>

      {typeof params.error === 'string' ? <Alert tone="error">{params.error}</Alert> : null}
      {typeof params.saved === 'string' ? <SavedNotice message={params.saved} /> : null}

      <Card>
        <CardHeader title="How it prints" hint="This preview is the same as the printed sheet." />
        <div className="overflow-x-auto px-4 pb-4 sm:px-5">
          <div className="min-w-[36rem] rounded-lg bg-white p-5 text-[12px] leading-snug text-ink-900 ring-1 ring-ink-200">
            <PrintLetterhead letterhead={letterhead} title="Nursing T.P.R. chart" />
          </div>
        </div>
      </Card>

      <Card>
        <CardHeader title="Hospital" hint="The address printed is each branch’s address, from Settings → Branches." />
        <SaveForm action={saveHospitalLetterheadAction} justSaved={savedId === 'hospital'} className="grid gap-3 px-4 pb-4 sm:grid-cols-2 sm:px-5">
          <Field label="Registration number" hint="As on your registration certificate">
            <Input
              name="registrationNo"
              maxLength={LETTERHEAD_LIMITS.registrationNo}
              defaultValue={settings.registrationNo ?? ''}
              placeholder="GHD/BNH/136/2022"
            />
          </Field>
          <Field label="Phone numbers" hint="Separate them with a slash">
            <Input
              name="phones"
              maxLength={LETTERHEAD_LIMITS.phones}
              defaultValue={settings.phones ?? ''}
              placeholder="02563-299446 / 96893 08335"
            />
          </Field>
          <div className="sm:col-span-2">
            <SaveButton label="Save letterhead" size="md" />
          </div>
        </SaveForm>
      </Card>

      {numbers ? (
        <Card>
          <CardHeader
            title="IPD numbers"
            hint="Each patient gets the next IPD No. when they first get a bed. Numbers are never reused."
          />
          <div className="space-y-3 px-4 pb-4 sm:px-5">
            <p className="text-sm text-ink-700">
              Next IPD No.: <span className="numeric text-base font-bold text-ink-900">{nextIpdNumber(numbers)}</span>
              {numbers.unnumbered > 0 ? (
                <span className="text-ink-600">
                  {' '}
                  · {numbers.unnumbered} patient{numbers.unnumbered === 1 ? '' : 's'} in a bed {numbers.unnumbered === 1 ? 'has' : 'have'} no
                  number yet
                </span>
              ) : null}
            </p>
            <SaveForm action={setNextIpdNumberAction} justSaved={savedId === 'ipd-number'} className="flex items-end gap-2">
              <div className="flex-1 sm:max-w-xs">
                <Field label="Continue from" hint="To carry on from your paper register, type its next number">
                  <Input name="next" inputMode="numeric" required placeholder={String(nextIpdNumber(numbers))} className="numeric" />
                </Field>
              </div>
              <SaveButton label="Set" size="lg" className="mb-[22px]" />
            </SaveForm>
            {numbers.unnumbered > 0 ? (
              <p className="text-xs text-ink-500">Setting it also numbers the patients already in a bed, oldest admission first.</p>
            ) : null}
          </div>
        </Card>
      ) : null}

      <Card>
        <CardHeader
          title="Doctors"
          hint="Tick the doctors whose name, degrees and registration number print on the letterhead."
        />
        {activeDoctors.length === 0 ? (
          <EmptyState title="No doctors yet." hint="Add doctors in Settings first." />
        ) : (
          <ul className="divide-y divide-ink-100">
            {activeDoctors.map((doctor) => (
              <li key={doctor.id} className="px-4 py-3 sm:px-5">
                <SaveForm action={saveDoctorLetterheadAction} justSaved={savedId === doctor.id} className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
                  <input type="hidden" name="doctorId" value={doctor.id} />
                  <div className="sm:col-span-3 flex flex-wrap items-center gap-2">
                    <p className="font-semibold text-ink-900">{doctorDisplayName(doctor.name)}</p>
                    {!doctor.hasLogin ? (
                      <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-900 ring-1 ring-inset ring-amber-300">
                        No login linked — cannot sign notes or orders
                      </span>
                    ) : null}
                  </div>
                  <Field label="Degrees">
                    <Input
                      name="qualification"
                      maxLength={LETTERHEAD_LIMITS.qualification}
                      defaultValue={doctor.qualification ?? ''}
                      placeholder="MBBS, MD (Medicine)"
                    />
                  </Field>
                  <Field label="Registration number">
                    <Input
                      name="registrationNo"
                      maxLength={LETTERHEAD_LIMITS.doctorRegistrationNo}
                      defaultValue={doctor.registrationNo ?? ''}
                      placeholder="2015074070"
                    />
                  </Field>
                  <div className="flex items-center gap-3 sm:pb-1">
                    <label className="inline-flex min-h-11 cursor-pointer items-center gap-2 text-sm text-ink-800">
                      <input
                        type="checkbox"
                        name="onLetterhead"
                        defaultChecked={doctor.onLetterhead}
                        className="size-5 rounded border-ink-300 text-brand-600 focus:ring-brand-600"
                      />
                      On letterhead
                    </label>
                    <SaveButton label="Save" size="md" />
                  </div>
                </SaveForm>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
