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
import { canConfigureHospital, listBranches, listStaffMembers } from '@/lib/services/auth';
import { describeLimit } from '@/lib/services/entitlements';
import { listDoctors } from '@/lib/services/hospital';
import {
  addBranchAction,
  addDoctorAction,
  addStaffAction,
  toggleDoctorAction,
  toggleStaffAction,
} from './actions';

import { serviceDateIn } from '@/lib/domain/time';
import { DoctorScheduleManager } from './scheduling/doctor-schedule-manager';

export const metadata = { title: 'Settings · OPD Queue' };

export default async function SettingsPage({ searchParams }: PageProps<'/settings'>) {
  const session = await requireSession();
  const params = await searchParams;
  const today = serviceDateIn(session.timezone, new Date());

  /**
   * Recomputed here rather than passed through the redirect, so the secret of
   * what the plan allows is never a URL parameter somebody can edit, and the
   * numbers shown are the ones true at render time.
   */
  const limitKind =
    params.limit === 'branches'
      ? 'branches'
      : params.limit === 'doctors'
        ? 'doctors'
        : params.limit === 'staff'
          ? 'staff'
          : null;
  const limitHit = limitKind
    ? await describeLimit({ hospitalId: session.hospitalId, kind: limitKind })
    : null;

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

  const [branches, doctors, staff] = await Promise.all([
    listBranches(session.hospitalId),
    listDoctors({ hospitalId: session.hospitalId, includeInactive: true }),
    listStaffMembers(session.hospitalId),
  ]);

  const activeDoctorCount = doctors.filter((d) => d.active).length;
  const activeStaffCount = staff.filter((s) => s.active).length;

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

      {/*
        A plan limit is reported with both numbers and the plan that lifts it.
        "Upgrade your plan" on its own tells somebody they cannot do their job
        and not what to do about it, which produces a phone call rather than an
        upgrade. Nothing already set up is affected — the limit only stops the
        next addition.
      */}
      {limitHit ? (
        <Alert tone="warn">
          {limitHit}{' '}
          <Link href="/plans" className="font-semibold underline underline-offset-2">
            See plans
          </Link>
        </Alert>
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
            <Button variant="primary" className="w-full sm:w-auto justify-center">
              Configure WhatsApp
            </Button>
          </Link>
        </div>
      </Card>

      {/*
        items-start, or the grid stretches the shorter card to match the taller
        one and the difference shows up as dead space inside Branches.
      */}
      <div className="grid gap-5 lg:grid-cols-2 lg:items-start">
        {/* Branches Card */}
        <Card>
          {/*
            The add form sits below the list, so it drifts further down the page
            with every branch added. The header keeps a way to reach it that does
            not depend on how long the list has become.
          */}
          <CardHeader
            title="Branches"
            hint={`${branches.length} active branch${branches.length === 1 ? '' : 'es'}`}
            action={
              <a
                href="#add-branch"
                className="shrink-0 text-xs font-semibold text-brand-700 hover:text-brand-800"
              >
                + Add
              </a>
            }
          />
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
                  <span className="rounded-full bg-ink-100 px-2 py-0.5 text-xs font-semibold text-ink-600">
                    Active
                  </span>
                </li>
              ))}
            </ul>
          )}
          <form action={addBranchAction} className="space-y-4 border-t border-ink-200 p-4 sm:p-5 bg-ink-50/40">
            <h3
              id="add-branch"
              className="scroll-mt-4 text-xs font-bold uppercase tracking-wider text-ink-500"
            >
              Add New Branch
            </h3>
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
            hint={`${activeDoctorCount} active · ${doctors.length} total`}
            action={
              <a
                href="#add-doctor"
                className="shrink-0 text-xs font-semibold text-brand-700 hover:text-brand-800"
              >
                + Add
              </a>
            }
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
                          <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-bold text-emerald-800 shrink-0">
                            Active
                          </span>
                        ) : (
                          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-bold text-amber-900 shrink-0">
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
                        /*
                         * Not `danger`, despite the word: this is a toggle, and
                         * the same button turns back into Activate. Destructive
                         * styling is a promise that something cannot be undone,
                         * and spending it once per row on a reversible action
                         * both drowns out the doctor names and leaves nothing
                         * left to say when something really is irreversible.
                         */
                        variant={doctor.active ? 'secondary' : 'primary'}
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
                        'inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-semibold border',
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
              <h3
                id="add-doctor"
                className="scroll-mt-4 text-xs font-bold uppercase tracking-wider text-ink-500"
              >
                Add New Doctor
              </h3>
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

      {/* Staff & User Accounts Card */}
      <Card>
        <CardHeader
          title="Team & User Accounts"
          hint={`${activeStaffCount} active ${activeStaffCount === 1 ? 'user' : 'users'} · Receptionists, Doctors, and Administrators`}
        />

        <div className="grid gap-6 lg:grid-cols-2 lg:items-start p-5">
          {/* Staff List */}
          <div>
            <h3 className="text-xs font-bold uppercase tracking-wider text-ink-500 mb-3">
              Existing Staff Accounts
            </h3>
            {staff.length === 0 ? (
              <EmptyState title="No staff accounts" hint="Add receptionists or doctors below." />
            ) : (
              <ul className="divide-y divide-ink-200 rounded-xl border border-ink-200 overflow-hidden bg-white">
                {staff.map((member) => (
                  <li
                    key={member.id}
                    className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3.5 hover:bg-ink-50/50"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="font-semibold text-sm text-ink-900 truncate">
                          {member.name}
                        </p>
                        <span
                          className={cn(
                            'rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider',
                            member.role === 'owner'
                              ? 'bg-purple-100 text-purple-800'
                              : member.role === 'receptionist'
                                ? 'bg-emerald-100 text-emerald-800'
                                : 'bg-blue-100 text-blue-800',
                          )}
                        >
                          {member.role}
                        </span>
                        {!member.active ? (
                          <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-900">
                            Inactive
                          </span>
                        ) : null}
                      </div>
                      <p className="text-xs text-ink-500 mt-0.5">
                        {member.email} {member.branchName ? `· 📍 ${member.branchName}` : ''}
                      </p>
                    </div>

                    <form action={toggleStaffAction} className="shrink-0">
                      <input type="hidden" name="membershipId" value={member.id} />
                      <input
                        type="hidden"
                        name="active"
                        value={member.active ? 'false' : 'true'}
                      />
                      <Button
                        type="submit"
                        size="sm"
                        variant={member.active ? 'secondary' : 'primary'}
                      >
                        {member.active ? 'Deactivate' : 'Activate'}
                      </Button>
                    </form>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Add Staff Form */}
          <form
            action={addStaffAction}
            className="space-y-4 rounded-xl border border-ink-200 bg-ink-50/50 p-4"
          >
            <h3 className="text-xs font-bold uppercase tracking-wider text-ink-500">
              Create New Staff User
            </h3>
            <Field label="Full Name">
              <Input name="name" required placeholder="Priya Kulkarni" />
            </Field>
            <Field label="Email Address" hint="Used for dashboard sign-in">
              <Input name="email" type="email" required placeholder="priya@hospital.com" />
            </Field>
            <Field label="Temporary Password" hint="Optional. Defaults to Staff@123">
              <Input name="password" type="password" placeholder="••••••••" />
            </Field>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="Role">
                <select
                  name="role"
                  defaultValue="receptionist"
                  className="block w-full rounded-lg border-0 bg-white px-3 py-2.5 text-sm text-ink-900 ring-1 ring-inset ring-ink-300 focus:ring-2 focus:ring-inset focus:ring-brand-600 focus:outline-none cursor-pointer"
                >
                  <option value="receptionist">Receptionist</option>
                  <option value="doctor">Doctor</option>
                  <option value="owner">Hospital Owner / Admin</option>
                </select>
              </Field>
              <Field label="Branch" hint="Optional">
                <select
                  name="branchId"
                  className="block w-full rounded-lg border-0 bg-white px-3 py-2.5 text-sm text-ink-900 ring-1 ring-inset ring-ink-300 focus:ring-2 focus:ring-inset focus:ring-brand-600 focus:outline-none cursor-pointer"
                >
                  <option value="">All Branches / None</option>
                  {branches.map((branch) => (
                    <option key={branch.id} value={branch.id}>
                      {branch.name}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <Button type="submit" variant="primary" className="w-full sm:w-auto">
              Create Staff Account
            </Button>
          </form>
        </div>
      </Card>

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
