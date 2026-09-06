import Link from 'next/link';
import {
  Alert,
  Button,
  Card,
  CardHeader,
  EmptyState,
  Field,
  Input,
} from '@/components/ui';
import { requireSession } from '@/lib/auth/session';
import { canConfigureHospital, listBranches } from '@/lib/services/auth';
import { listDoctors } from '@/lib/services/hospital';
import { addBranchAction, addDoctorAction, toggleDoctorAction } from './actions';

export const metadata = { title: 'Settings · OPD Queue' };

export default async function SettingsPage({ searchParams }: PageProps<'/settings'>) {
  const session = await requireSession();
  const params = await searchParams;

  if (!canConfigureHospital(session.role)) {
    return (
      <Card>
        <EmptyState
          title="Only the hospital owner can change settings"
          hint="Ask your administrator if a doctor or branch needs adding."
        />
      </Card>
    );
  }

  const [branches, doctors] = await Promise.all([
    listBranches(session.hospitalId),
    listDoctors({ hospitalId: session.hospitalId }),
  ]);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-lg font-semibold text-ink-900">Settings</h1>
        <p className="mt-0.5 text-sm text-ink-500">
          {session.hospitalName} · {session.timezone}
        </p>
      </div>

      {params.error === 'name' ? (
        <Alert tone="error">A name is required.</Alert>
      ) : null}

      <Card>
        <CardHeader
          title="WhatsApp"
          hint="Booking, queue links and notifications"
          action={
            <Link href="/settings/whatsapp">
              <Button size="sm">Configure</Button>
            </Link>
          }
        />
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader title="Branches" hint={`${branches.length} active`} />
          {branches.length === 0 ? (
            <EmptyState
              title="No branches yet"
              hint="Add one before you can add doctors."
            />
          ) : (
            <ul className="divide-y divide-ink-200">
              {branches.map((branch) => (
                <li key={branch.id} className="px-5 py-3 text-sm text-ink-800">
                  {branch.name}
                </li>
              ))}
            </ul>
          )}
          <form action={addBranchAction} className="space-y-4 border-t border-ink-200 p-5">
            <Field label="Branch name">
              <Input name="name" required placeholder="Main building" />
            </Field>
            <Field label="Address" hint="Optional">
              <Input name="address" placeholder="Station Road, Satara" />
            </Field>
            <Button type="submit" variant="primary">
              Add branch
            </Button>
          </form>
        </Card>

        <Card>
          <CardHeader title="Doctors" hint={`${doctors.length} active`} />
          {doctors.length === 0 ? (
            <EmptyState title="No doctors yet" hint="Add a branch first, then a doctor." />
          ) : (
            <ul className="divide-y divide-ink-200">
              {doctors.map((doctor) => (
                <li key={doctor.id} className="flex items-center gap-3 px-5 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-ink-900">
                      {doctor.name}
                    </p>
                    <p className="truncate text-xs text-ink-500">
                      {[doctor.specialty, doctor.branchName]
                        .filter(Boolean)
                        .join(' · ')}{' '}
                      · ~{doctor.defaultConsultMinutes} min
                    </p>
                  </div>
                  <form action={toggleDoctorAction}>
                    <input type="hidden" name="doctorId" value={doctor.id} />
                    <input type="hidden" name="active" value="false" />
                    <Button type="submit" size="sm" variant="danger">
                      Deactivate
                    </Button>
                  </form>
                </li>
              ))}
            </ul>
          )}

          {branches.length > 0 ? (
            <form action={addDoctorAction} className="space-y-4 border-t border-ink-200 p-5">
              <Field label="Doctor name">
                <Input name="name" required placeholder="Dr Kulkarni" />
              </Field>
              <Field label="Specialty" hint="Optional">
                <Input name="specialty" placeholder="General medicine" />
              </Field>
              <Field label="Branch">
                <select
                  name="branchId"
                  required
                  className="block w-full rounded-lg border-0 bg-white px-3 py-2.5 text-ink-900 ring-1 ring-inset ring-ink-300 focus:ring-2 focus:ring-inset focus:ring-brand-600 focus:outline-none"
                >
                  {branches.map((branch) => (
                    <option key={branch.id} value={branch.id}>
                      {branch.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field
                label="Typical consultation length"
                hint="Only used until real consultations are recorded."
              >
                <Input
                  name="defaultConsultMinutes"
                  type="number"
                  min={1}
                  max={120}
                  defaultValue={10}
                />
              </Field>
              <Button type="submit" variant="primary">
                Add doctor
              </Button>
            </form>
          ) : null}
        </Card>
      </div>
    </div>
  );
}
