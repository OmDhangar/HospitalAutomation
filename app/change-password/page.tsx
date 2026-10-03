import { redirect } from 'next/navigation';
import { Alert, Button, Field, Input } from '@/components/ui';
import Link from 'next/link';
import { clearSessionCookie, requireSession } from '@/lib/auth/session';
import { AccountAdminError, changeOwnPassword } from '@/lib/services/platform-admin';

export const metadata = { title: 'Choose a password · QuriioHQ' };

const ERRORS: Record<string, string> = {
  mismatch: 'The two passwords do not match.',
  weak: 'Use at least 10 characters, and not an old default password.',
  current: 'Your current password is not correct.',
};

/**
 * Where a user lands after we issued them a temporary password.
 *
 * Outside the `(app)` group on purpose: that layout is what redirects here,
 * and rendering this page inside it would loop. It also has no navigation,
 * because there is nothing else to do until the password is replaced.
 */
async function submit(formData: FormData) {
  'use server';

  const session = await requireSession();
  // A read-only support session must not change anyone's password. Not
  // requireWritableSession, which refuses the forced-change state this page
  // exists to resolve.
  if (session.readOnly) redirect('/dashboard');
  const password = String(formData.get('password') ?? '');
  const confirm = String(formData.get('confirm') ?? '');
  const current = formData.get('current');

  if (password !== confirm) redirect('/change-password?error=mismatch');

  try {
    await changeOwnPassword({
      userId: session.userId,
      newPassword: password,
      currentPassword: typeof current === 'string' ? current : undefined,
    });
  } catch (error) {
    if (error instanceof AccountAdminError && error.code === 'WEAK_PASSWORD') {
      redirect('/change-password?error=weak');
    }
    if (error instanceof AccountAdminError && error.code === 'WRONG_PASSWORD') {
      redirect('/change-password?error=current');
    }
    throw error;
  }

  /**
   * Changing a password ends every session, this one included, so the cookie
   * here is already dead. Clearing it and sending them to sign in is the
   * honest outcome — and it proves the new password works before they rely
   * on it.
   */
  await clearSessionCookie();
  redirect('/login?changed=1');
}

export default async function ChangePasswordPage({
  searchParams,
}: PageProps<'/change-password'>) {
  const session = await requireSession();
  // Forced after a temporary password; otherwise an ordinary, voluntary change.
  const forced = session.mustChangePassword;

  const { error } = await searchParams;

  return (
    <main className="flex min-h-dvh items-center justify-center bg-ink-100 px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-xl bg-brand-600 text-xl font-bold text-white">
            Q
          </div>
          <h1 className="text-xl font-semibold text-ink-900">
            {forced ? 'Choose a password' : 'Change your password'}
          </h1>
          <p className="mt-1 text-sm text-ink-500">
            {forced
              ? 'The password you were given is temporary. Pick your own to carry on.'
              : 'Enter your current password, then the new one.'}
          </p>
        </div>

        <form
          action={submit}
          className="space-y-4 rounded-xl border border-ink-200 bg-white p-6 shadow-[var(--shadow-raised)]"
        >
          {typeof error === 'string' && ERRORS[error] ? (
            <Alert tone="error">{ERRORS[error]}</Alert>
          ) : null}

          {forced ? null : (
            <Field label="Current password">
              <Input name="current" type="password" autoComplete="current-password" required />
            </Field>
          )}

          <Field label="New password" hint="At least 10 characters">
            <Input
              name="password"
              type="password"
              autoComplete="new-password"
              required
              minLength={10}
              autoFocus={forced}
            />
          </Field>

          <Field label="Confirm">
            <Input name="confirm" type="password" autoComplete="new-password" required />
          </Field>

          <Button type="submit" variant="primary" size="lg" className="w-full">
            Save and sign in again
          </Button>

          <p className="text-xs text-ink-500">
            Signed in as {session.email}. Saving signs you out everywhere, so the new
            password is proved before anything depends on it.
          </p>

          {forced ? null : (
            <Link href="/dashboard" className="block text-center text-sm text-ink-600 underline">
              Cancel
            </Link>
          )}
        </form>
      </div>
    </main>
  );
}
