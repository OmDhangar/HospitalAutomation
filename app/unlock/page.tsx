import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Alert, Button, Field, Input } from '@/components/ui';
import { PinPad } from '@/components/pin-pad';
import { getSessionState } from '@/lib/auth/session';
import { isLocked } from '@/lib/domain/staff-access';
import { hasPin } from '@/lib/services/staff-access';
import { signOutFromLockAction, unlockWithPasswordAction, unlockWithPinAction } from './actions';

export const metadata = { title: 'Locked · QuriioHQ', robots: { index: false, follow: false } };

/**
 * A personal phone that locked itself after idle or background time
 * (ADR-022). Nothing about any patient is shown here: just whose phone it is,
 * and the PIN pad — or the password, if the person has no PIN or typed it
 * wrong too often.
 */
export default async function UnlockPage({ searchParams }: PageProps<'/unlock'>) {
  const params = await searchParams;
  const session = await getSessionState();
  if (!session) redirect('/login');
  const next = typeof params.next === 'string' ? params.next : '/dashboard';
  if (!session.locked) redirect(next.startsWith('/') ? next : '/dashboard');
  if (session.channel === 'ward_device') redirect('/ward-device');

  const pin = await hasPin(session.hospitalId, session.userId);
  const pinUsable = pin.hasPin && !isLocked(pin.lockedUntil, new Date());
  const usePassword = !pinUsable || params.use === 'password';
  const error = typeof params.error === 'string' ? params.error : null;

  return (
    <main className="min-h-dvh bg-ink-100 px-4 py-8">
      <div className="mx-auto max-w-sm space-y-6">
        <div className="text-center">
          <div className="mx-auto mb-3 flex size-12 items-center justify-center rounded-xl bg-brand-600 text-xl font-bold text-white">Q</div>
          <p className="text-sm text-ink-500">Locked to protect patient details</p>
          <h1 className="text-2xl font-bold text-ink-900">{session.name}</h1>
        </div>
        <div className="space-y-5 rounded-2xl border border-ink-200 bg-white p-5 shadow-xs">
          {error ? <Alert tone="error">{error}</Alert> : null}
          {usePassword ? (
            <form action={unlockWithPasswordAction} className="space-y-3">
              <input type="hidden" name="next" value={next} />
              <Field label="Password">
                <Input name="password" type="password" required autoComplete="current-password" />
              </Field>
              <Button type="submit" variant="primary" size="lg" className="w-full">
                Unlock
              </Button>
              {pinUsable ? (
                <Link href={`/unlock?next=${encodeURIComponent(next)}`} className="block text-center text-sm font-semibold text-brand-700">
                  Use my PIN instead
                </Link>
              ) : (
                <p className="text-center text-xs text-ink-500">Set a PIN under “My login and PIN” to unlock with 4 taps.</p>
              )}
            </form>
          ) : (
            <div className="space-y-4">
              <p className="text-center text-sm text-ink-600">Enter your PIN</p>
              <PinPad action={unlockWithPinAction} hidden={{ next }} />
              <Link
                href={`/unlock?use=password&next=${encodeURIComponent(next)}`}
                className="block text-center text-sm font-semibold text-brand-700"
              >
                Use my password instead
              </Link>
            </div>
          )}
        </div>
        <form action={signOutFromLockAction} className="text-center">
          <button type="submit" className="min-h-11 text-sm text-ink-500 underline">
            Not you? Sign out
          </button>
        </form>
      </div>
    </main>
  );
}
