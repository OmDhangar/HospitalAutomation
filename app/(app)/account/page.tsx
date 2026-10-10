import Link from 'next/link';
import { SavedNotice } from '@/components/saved-notice';
import { Alert, Button, Card, CardHeader, Field, Input } from '@/components/ui';
import { requireSession } from '@/lib/auth/session';
import { hasPin, listUserSessions } from '@/lib/services/staff-access';
import { setOwnPinAction, signOutEverywhereAction } from './actions';

export const metadata = { title: 'My login and PIN · QuriioHQ' };

/**
 * A person's own sign-in (ADR-022): their 4-digit PIN for ward tablets and for
 * unlocking their phone, the devices they are signed in on, and "Sign out
 * everywhere" for a lost phone.
 */
export default async function AccountPage({ searchParams }: PageProps<'/account'>) {
  const session = await requireSession();
  const params = await searchParams;
  const [pin, active] = await Promise.all([
    hasPin(session.hospitalId, session.userId),
    listUserSessions(session.userId, session.hospitalId),
  ]);
  const when = (at: Date | null) =>
    at ? at.toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: session.timezone }) : '—';

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <div>
        <h1 className="text-xl font-bold text-ink-900">My login and PIN</h1>
        <p className="mt-0.5 text-sm text-ink-500">{session.name} · {session.email}</p>
      </div>

      {typeof params.error === 'string' ? <Alert tone="error">{params.error}</Alert> : null}
      {typeof params.saved === 'string' ? <SavedNotice message={params.saved} /> : null}

      <Card>
        <CardHeader
          title={pin.hasPin ? 'Change my PIN' : 'Set my PIN'}
          hint="4 digits. You use it to unlock a ward tablet as yourself, and to unlock your phone after it locks."
        />
        <form action={setOwnPinAction} className="grid gap-3 px-4 pb-4 sm:grid-cols-3 sm:px-5">
          <Field label="New PIN">
            <Input name="pin" type="password" inputMode="numeric" pattern="\d{4}" maxLength={4} required autoComplete="off" className="numeric" />
          </Field>
          <Field label="PIN again">
            <Input name="confirm" type="password" inputMode="numeric" pattern="\d{4}" maxLength={4} required autoComplete="off" className="numeric" />
          </Field>
          <Field label="Your password">
            <Input name="password" type="password" required autoComplete="current-password" />
          </Field>
          <p className="text-xs text-ink-500 sm:col-span-3">
            Not 1234, not a repeated digit, not a year. Never tell anyone your PIN: every entry made with it is recorded as yours.
          </p>
          <div className="sm:col-span-3">
            <Button type="submit" variant="primary">
              Save PIN
            </Button>
          </div>
        </form>
      </Card>

      <Card>
        <CardHeader title="Where I am signed in" hint="Ward-tablet sessions end by themselves after 10 idle minutes." />
        <ul className="divide-y divide-ink-100">
          {active.map((row) => (
            <li key={row.id} className="flex items-center justify-between gap-3 px-4 py-3 text-sm sm:px-5">
              <div>
                <p className="font-semibold text-ink-900">
                  {row.channel === 'ward_device' ? 'Ward tablet' : 'Phone or computer'}
                  {row.id === session.sessionId ? <span className="ml-2 text-xs font-normal text-brand-700">this one</span> : null}
                </p>
                <p className="text-xs text-ink-500">
                  Signed in {when(row.createdAt)} · last used {when(row.lastSeenAt)}
                  {row.lockedAt ? ' · locked' : ''}
                </p>
              </div>
            </li>
          ))}
        </ul>
        <form action={signOutEverywhereAction} className="px-4 pb-4 sm:px-5">
          <Button type="submit" variant="danger">
            Sign out everywhere
          </Button>
          <p className="mt-1 text-xs text-ink-500">For a lost or shared phone. You will sign in again here.</p>
        </form>
      </Card>

      <Link href="/change-password" className="inline-flex min-h-11 items-center text-sm font-semibold text-brand-700">
        Change my password →
      </Link>
    </div>
  );
}
