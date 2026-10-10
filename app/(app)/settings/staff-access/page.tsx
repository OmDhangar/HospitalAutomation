import Link from 'next/link';
import { cookies } from 'next/headers';
import { SavedNotice } from '@/components/saved-notice';
import { Alert, Button, Card, CardHeader, EmptyState, Field, Input, cn } from '@/components/ui';
import { ShieldIcon } from '@/components/icons';
import { requireSession } from '@/lib/auth/session';
import { MONITORING_NOTICE_IS_DRAFT } from '@/lib/domain/monitoring-notice';
import { STAFF_ROLES, can, type StaffRole } from '@/lib/domain/permissions';
import { CLINICAL_LOCK_MAX_MINUTES, CLINICAL_LOCK_MIN_MINUTES, formatEnrolCode, isLocked } from '@/lib/domain/staff-access';
import { listBranches } from '@/lib/services/auth';
import { getAccessSettings, listNoticeAcceptance, listPinStatus, listWardDevices } from '@/lib/services/staff-access';
import { ENROL_FLASH_COOKIE } from '@/lib/auth/ward-device-cookie';
import {
  addWardDeviceAction,
  clearWardDeviceLockAction,
  renewWardDeviceCodeAction,
  resetPinAction,
  revokeWardDeviceAction,
  saveAccessSettingsAction,
  signOutStaffEverywhereAction,
} from './actions';

export const metadata = { title: 'Staff access · Settings' };

const SELECT_CLASS =
  'block w-full rounded-lg border-0 bg-white px-3 py-2.5 text-sm text-ink-900 ring-1 ring-inset ring-ink-300 focus:ring-2 focus:ring-inset focus:ring-brand-600 focus:outline-none cursor-pointer';

const ROLE_LABELS: Record<StaffRole, string> = { owner: 'Owner', receptionist: 'Reception', doctor: 'Doctor', nurse: 'Nurse' };

/**
 * Settings → Staff access (ADR-022): the ward tablets, who may use a tablet
 * or their own device, how soon a phone locks, the monitoring notice, and
 * each person's PIN — with "sign out everywhere" for a lost phone or someone
 * who has left.
 */
export default async function StaffAccessPage({ searchParams }: PageProps<'/settings/staff-access'>) {
  const session = await requireSession();
  const params = await searchParams;
  if (!can(session.role, 'hospital.configure')) {
    return (
      <Card>
        <EmptyState title="Owners only" hint="Ask the hospital owner to change how staff sign in." />
      </Card>
    );
  }

  const [settings, devices, branchRows, people, accepted] = await Promise.all([
    getAccessSettings(session.hospitalId),
    listWardDevices(session.hospitalId),
    listBranches(session.hospitalId),
    listPinStatus(session.hospitalId),
    listNoticeAcceptance(session.hospitalId),
  ]);
  const flash = readFlash((await cookies()).get(ENROL_FLASH_COOKIE)?.value);
  const now = new Date();
  const when = (at: Date | null) =>
    at ? at.toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: session.timezone }) : '—';

  return (
    <div className="space-y-5">
      <div>
        <Link href="/settings" className="text-sm text-ink-500 hover:text-ink-800">
          ← Settings
        </Link>
        <h1 className="mt-1 flex items-center gap-2 text-xl font-bold text-ink-900">
          <ShieldIcon className="size-5 text-brand-600" />
          Staff access
        </h1>
        <p className="mt-0.5 text-sm text-ink-500">
          Ward tablets with a PIN for each person, and the lock on nurses’ and doctors’ own phones.
        </p>
      </div>

      {typeof params.error === 'string' ? <Alert tone="error">{params.error}</Alert> : null}
      {typeof params.saved === 'string' ? <SavedNotice message={params.saved} /> : null}

      {flash && new Date(flash.expiresAt) > now ? (
        <Alert tone="info">
          <p className="font-semibold">Code for {devices.find((d) => d.id === flash.deviceId)?.name ?? 'the tablet'}:</p>
          <p className="numeric my-2 text-3xl font-bold tracking-[0.25em] text-ink-900">{formatEnrolCode(flash.code)}</p>
          <p>
            On the tablet, open <span className="font-semibold">/ward-device</span> on this site and type the code. It works
            once, until {when(new Date(flash.expiresAt))}.
          </p>
        </Alert>
      ) : null}

      <Card>
        <CardHeader title="Ward tablets" hint="A tablet stays set up until you remove it, or it is not used for 90 days." />
        {devices.length === 0 ? (
          <EmptyState title="No ward tablets yet." hint="Add one below, then type its code on the tablet." />
        ) : (
          <ul className="divide-y divide-ink-100">
            {devices.map((device) => {
              const status = device.revokedAt
                ? { text: 'Removed', tone: 'text-ink-500' }
                : isLocked(device.lockedUntil, now)
                  ? { text: `Locked until ${when(device.lockedUntil)} (too many wrong PINs)`, tone: 'text-rose-700' }
                  : device.enrolledAt
                    ? { text: `Set up · last used ${when(device.lastSeenAt)}`, tone: 'text-ink-600' }
                    : { text: `Waiting for its code (until ${when(device.enrolExpiresAt)})`, tone: 'text-amber-800' };
              return (
                <li key={device.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-5">
                  <div className="min-w-0">
                    <p className="font-semibold text-ink-900">{device.name}</p>
                    <p className={cn('text-xs', status.tone)}>
                      {device.branchName} · {status.text}
                    </p>
                  </div>
                  {!device.revokedAt ? (
                    <div className="flex flex-wrap gap-2">
                      {isLocked(device.lockedUntil, now) ? (
                        <form action={clearWardDeviceLockAction}>
                          <input type="hidden" name="deviceId" value={device.id} />
                          <Button type="submit" size="sm">Unlock tablet</Button>
                        </form>
                      ) : null}
                      <form action={renewWardDeviceCodeAction}>
                        <input type="hidden" name="deviceId" value={device.id} />
                        <Button type="submit" size="sm">{device.enrolledAt ? 'Move to a new tablet' : 'New code'}</Button>
                      </form>
                      <form action={revokeWardDeviceAction}>
                        <input type="hidden" name="deviceId" value={device.id} />
                        <Button type="submit" size="sm" variant="danger">Remove</Button>
                      </form>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
        <form action={addWardDeviceAction} className="grid gap-3 border-t border-ink-100 px-4 py-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end sm:px-5">
          <Field label="Tablet name">
            <Input name="name" required maxLength={60} placeholder="Ward A tablet" />
          </Field>
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-ink-700">Branch</span>
            <select name="branchId" className={SELECT_CLASS} defaultValue={session.branchId ?? branchRows[0]?.id}>
              {branchRows.map((branch) => (
                <option key={branch.id} value={branch.id}>
                  {branch.name}
                </option>
              ))}
            </select>
          </label>
          <Button type="submit" variant="primary">Add tablet</Button>
        </form>
      </Card>

      <Card>
        <CardHeader title="Sign-in rules" hint="They apply at once, on the server, to everyone already signed in." />
        <form action={saveAccessSettingsAction} className="space-y-4 px-4 pb-4 sm:px-5">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-ink-500">
                <th className="py-2 font-semibold">Role</th>
                <th className="py-2 font-semibold">Ward tablet (PIN)</th>
                <th className="py-2 font-semibold">Own phone or computer</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {STAFF_ROLES.map((role) => (
                <tr key={role}>
                  <td className="py-2 font-semibold text-ink-800">{ROLE_LABELS[role]}</td>
                  <td className="py-2">
                    <input type="checkbox" name="wardDeviceRoles" value={role} defaultChecked={settings.wardDeviceRoles.includes(role)} className="size-5" aria-label={`${ROLE_LABELS[role]} on ward tablet`} />
                  </td>
                  <td className="py-2">
                    {role === 'owner' ? (
                      <>
                        <input type="hidden" name="personalRoles" value="owner" />
                        <span className="text-xs text-ink-500">Always</span>
                      </>
                    ) : (
                      <input type="checkbox" name="personalRoles" value={role} defaultChecked={settings.personalRoles.includes(role)} className="size-5" aria-label={`${ROLE_LABELS[role]} on own device`} />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-xs text-ink-500">
            On a ward tablet an owner works as a doctor and reception as a nurse: settings, prices and money are never reachable from a shared tablet.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Lock nurses’ and doctors’ phones after (minutes idle)" hint={`${CLINICAL_LOCK_MIN_MINUTES}–${CLINICAL_LOCK_MAX_MINUTES}. Also after 5 minutes in the background.`}>
              <Input name="clinicalLockMinutes" type="number" min={CLINICAL_LOCK_MIN_MINUTES} max={CLINICAL_LOCK_MAX_MINUTES} defaultValue={settings.clinicalLockMinutes} required className="numeric" />
            </Field>
            <label className="block text-sm">
              <span className="mb-1 block font-medium text-ink-700">Staff monitoring notice</span>
              <select name="monitoringNotice" defaultValue={settings.monitoringNotice} className={SELECT_CLASS}>
                <option value="off">Off</option>
                <option value="required">Everyone must accept it once</option>
              </select>
              <span className="mt-1 block text-xs text-ink-500">
                <Link href="/notice?lang=mr" className="underline">Preview</Link>
                {MONITORING_NOTICE_IS_DRAFT ? ' · Draft wording: switch on only after your lawyer has approved it.' : ''}
              </span>
            </label>
          </div>
          <Button type="submit" variant="primary">Save rules</Button>
        </form>
      </Card>

      <Card>
        <CardHeader title="Staff PINs and sign-in" hint="Each person sets their own PIN under “My login and PIN”. You can only clear one." />
        <ul className="divide-y divide-ink-100">
          {people.map((person) => (
            <li key={person.userId} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-5">
              <div className="min-w-0">
                <p className="font-semibold text-ink-900">{person.name}</p>
                <p className="text-xs text-ink-500">
                  {ROLE_LABELS[person.role]} ·{' '}
                  {person.pinSetAt
                    ? isLocked(person.pinLockedUntil, now)
                      ? `PIN locked until ${when(person.pinLockedUntil)}`
                      : `PIN set ${when(person.pinSetAt)}`
                    : 'No PIN yet'}
                  {settings.monitoringNotice === 'required' ? (accepted.has(person.userId) ? ' · notice accepted' : ' · notice not yet accepted') : ''}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                {person.pinSetAt ? (
                  <form action={resetPinAction}>
                    <input type="hidden" name="userId" value={person.userId} />
                    <Button type="submit" size="sm">Clear PIN</Button>
                  </form>
                ) : null}
                <form action={signOutStaffEverywhereAction}>
                  <input type="hidden" name="userId" value={person.userId} />
                  <Button type="submit" size="sm" variant="ghost">Sign out everywhere</Button>
                </form>
              </div>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

function readFlash(raw: string | undefined): { deviceId: string; code: string; expiresAt: string } | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as { deviceId?: unknown; code?: unknown; expiresAt?: unknown };
    return typeof value.deviceId === 'string' && typeof value.code === 'string' && typeof value.expiresAt === 'string'
      ? { deviceId: value.deviceId, code: value.code, expiresAt: value.expiresAt }
      : null;
  } catch {
    return null;
  }
}
