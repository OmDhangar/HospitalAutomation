import Link from 'next/link';
import {
  Alert,
  Button,
  Card,
  CardHeader,
  EmptyState,
  Field,
  Input,
  cn,
} from '@/components/ui';
import { requireSession } from '@/lib/auth/session';
import { canConfigureHospital, listBranches } from '@/lib/services/auth';
import { listDoctors } from '@/lib/services/hospital';
import { addBranchAction, addDoctorAction, toggleDoctorAction } from './actions';

import { serviceDateIn } from '@/lib/domain/time';
import { DoctorScheduleManager } from './scheduling/doctor-schedule-manager';

export const metadata = { title: 'Settings · OPD Queue' };

export default async function SettingsPage({ searchParams }: PageProps<'/settings'>) {
  const session = await requireSession();
  const params = await searchParams;
  const today = serviceDateIn(session.timezone, new Date());

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
    listDoctors({ hospitalId: session.hospitalId, includeInactive: true }),
  ]);

  const activeCount = doctors.filter((d) => d.active).length;

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-baseline justify-between gap-1">
        <div>
          <h1 className="text-xl font-bold text-ink-900">Settings</h1>
          <p className="mt-0.5 text-xs sm:text-sm text-ink-500">
            {session.hospitalName} · <span className="font-mono text-ink-600">{session.timezone}</span>
          </p>
        </div>
      </div>

      {params.error === 'name' ? (
        <Alert tone="error">A name is required.</Alert>
      ) : null}

      <Card>
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4 sm:p-5">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-lg">💬</span>
              <h2 className="text-base font-bold text-ink-900">WhatsApp Integration</h2>
            </div>
            <p className="mt-0.5 text-xs text-ink-500">
              Automated booking, live token tracker links, and patient notifications.
            </p>
          </div>
          <Link href="/settings/whatsapp" className="w-full sm:w-auto">
            <Button size="sm" className="w-full sm:w-auto justify-center">
              Configure WhatsApp
            </Button>
          </Link>
        </div>
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        {/* Branches Card */}
        <Card>
          <CardHeader title="Branches" hint={`${branches.length} active branch${branches.length === 1 ? '' : 'es'}`} />
          {branches.length === 0 ? (
            <EmptyState
              title="No branches yet"
              hint="Add one before you can add doctors."
            />
          ) : (
            <ul className="divide-y divide-ink-200">
              {branches.map((branch) => (
                <li key={branch.id} className="px-4 py-3 sm:px-5 sm:py-3.5 text-sm text-ink-800 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-base text-ink-400">🏥</span>
                    <span className="font-semibold text-ink-900">{branch.name}</span>
                  </div>
                  <span className="rounded-full bg-ink-100 px-2 py-0.5 text-[10px] font-semibold text-ink-600">
                    Active
                  </span>
                </li>
              ))}
            </ul>
          )}
          <form action={addBranchAction} className="space-y-4 border-t border-ink-200 p-4 sm:p-5 bg-ink-50/40">
            <h3 className="text-xs font-bold uppercase tracking-wider text-ink-500">Add New Branch</h3>
            <Field label="Branch name">
              <Input name="name" required placeholder="Main building / OPD Wing" />
            </Field>
            <Field label="Address" hint="Optional">
              <Input name="address" placeholder="Station Road, Satara" />
            </Field>
            <Button type="submit" variant="primary" className="w-full sm:w-auto">
              Add branch
            </Button>
          </form>
        </Card>

        {/* Doctors Card */}
        <Card>
          <CardHeader
            title="Doctors"
            hint={`${activeCount} active · ${doctors.length} total`}
          />
          {doctors.length === 0 ? (
            <EmptyState title="No doctors yet" hint="Add a branch first, then a doctor." />
          ) : (
            <ul className="divide-y divide-ink-200">
              {doctors.map((doctor) => (
                <li
                  key={doctor.id}
                  className={cn(
                    'p-4 sm:p-5 transition-colors space-y-2.5',
                    !doctor.active && 'bg-ink-50/60 opacity-80',
                  )}
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-sm sm:text-base font-bold text-ink-900">
                          {doctor.name}
                        </p>
                        {doctor.active ? (
                          <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-800 shrink-0">
                            Active
                          </span>
                        ) : (
                          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold text-amber-900 shrink-0">
                            Inactive
                          </span>
                        )}
                      </div>
                      
                      <div className="flex flex-wrap items-center gap-1.5 mt-1.5 text-xs text-ink-600">
                        {doctor.specialty ? (
                          <span className="font-medium text-ink-800 bg-ink-100 px-2 py-0.5 rounded-md">
                            🩺 {doctor.specialty}
                          </span>
                        ) : null}
                        {doctor.branchName ? (
                          <span className="text-ink-600 bg-ink-100 px-2 py-0.5 rounded-md">
                            📍 {doctor.branchName}
                          </span>
                        ) : null}
                        <span className="text-ink-500 bg-ink-100 px-2 py-0.5 rounded-md">
                          ⏱️ ~{doctor.defaultConsultMinutes}m
                        </span>
                      </div>
                    </div>

                    <form action={toggleDoctorAction} className="shrink-0">
                      <input type="hidden" name="doctorId" value={doctor.id} />
                      <input type="hidden" name="active" value={doctor.active ? 'false' : 'true'} />
                      <Button
                        type="submit"
                        size="sm"
                        variant={doctor.active ? 'danger' : 'primary'}
                        className="w-full sm:w-auto"
                      >
                        {doctor.active ? 'Deactivate' : 'Activate'}
                      </Button>
                    </form>
                  </div>

                  {/* Mode badge */}
                  <div className="pt-0.5">
                    <span
                      className={cn(
                        'inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-[11px] font-semibold border',
                        doctor.mode === 'both'
                          ? 'bg-amber-50 text-amber-900 border-amber-200'
                          : doctor.mode === 'slot'
                          ? 'bg-emerald-50 text-emerald-900 border-emerald-200'
                          : 'bg-blue-50 text-blue-900 border-blue-200',
                      )}
                    >
                      {doctor.mode === 'both'
                        ? '🌟 Hybrid Mode (Live Queue + Time Slots)'
                        : doctor.mode === 'slot'
                        ? '🕒 Time Slots Only'
                        : '🎫 Live Running Queue (Visiting)'}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}

          {branches.length > 0 ? (
            <form action={addDoctorAction} className="space-y-4 border-t border-ink-200 p-4 sm:p-5 bg-ink-50/40">
              <h3 className="text-xs font-bold uppercase tracking-wider text-ink-500">Add New Doctor</h3>
              <Field label="Doctor name">
                <Input name="name" required placeholder="Dr. Anjali Deshmukh" />
              </Field>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Field label="Specialty" hint="Optional">
                  <Input name="specialty" placeholder="e.g. Paediatrics, Cardiology" />
                </Field>
                <Field label="Branch">
                  <select
                    name="branchId"
                    required
                    className="block w-full rounded-lg border-0 bg-white px-3 py-2.5 text-sm text-ink-900 ring-1 ring-inset ring-ink-300 focus:ring-2 focus:ring-inset focus:ring-brand-600 focus:outline-none cursor-pointer"
                  >
                    {branches.map((branch) => (
                      <option key={branch.id} value={branch.id}>
                        {branch.name}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
              <Field
                label="Practice / Schedule Mode"
                hint="Hybrid supports both live same-day tokens and advance scheduled slots."
              >
                <select
                  name="mode"
                  defaultValue="both"
                  className="block w-full rounded-lg border-0 bg-white px-3 py-2.5 text-sm text-ink-900 ring-1 ring-inset ring-ink-300 focus:ring-2 focus:ring-inset focus:ring-brand-600 focus:outline-none cursor-pointer"
                >
                  <option value="both">🌟 Hybrid (Both: Live Queue & Time Slots)</option>
                  <option value="queue">🎫 Live Running Queue Only (Visiting / Walk-ins)</option>
                  <option value="slot">🕒 Time-based Appointment Slots Only</option>
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
              <Button type="submit" variant="primary" className="w-full sm:w-auto">
                Add doctor
              </Button>
            </form>
          ) : null}
        </Card>
      </div>

      {/* Doctor Interactive Scheduling Management Section */}
      {doctors.length > 0 ? (
        <div className="pt-4 border-t border-ink-200">
          <div className="mb-4">
            <h2 className="text-lg font-bold text-ink-900">Doctor Appointment Scheduling</h2>
            <p className="text-xs sm:text-sm text-ink-500">
              Configure working hours, automatic slot intervals, slot skipping, and emergency interval deactivations.
            </p>
          </div>
          <DoctorScheduleManager doctors={doctors} initialDate={today} />
        </div>
      ) : null}
    </div>
  );
}
