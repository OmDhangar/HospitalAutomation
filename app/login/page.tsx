import { redirect } from 'next/navigation';
import { Alert, Button, Field, Input } from '@/components/ui';
import { getSession, setSessionCookie } from '@/lib/auth/session';
import { clearEvents, clientIp, ipRules, isThrottled, recordEvent } from '@/lib/security/throttle';
import { login } from '@/lib/services/auth';
import { readWardDeviceCookie } from '@/lib/auth/ward-device-cookie';
import { resolveWardDevice } from '@/lib/services/ward-devices';
import Link from 'next/link';

const WINDOW_MS = 15 * 60 * 1000;

export const metadata = { title: 'Sign in · Qurio' };

async function signIn(formData: FormData) {
  'use server';

  const email = String(formData.get('email') ?? '').toLowerCase().trim();
  const password = String(formData.get('password') ?? '');

  /**
   * Failed sign-ins are counted per account and per IP, in the database.
   *
   * Per account stops a guesser working through passwords for one owner;
   * five tries in fifteen minutes is generous for a person and useless for a
   * script. Per IP stops one machine spraying a common password across many
   * accounts. Only failures count, so a busy reception desk sharing one IP
   * never locks itself out by signing in.
   *
   * The refusal happens before the password is checked, so a locked account
   * gives a guesser no signal about whether their guess was right.
   */
  const emailRule = { key: `login:email:${email}`, limit: 5, windowMs: WINDOW_MS };
  const rules = [
    emailRule,
    ...ipRules(await clientIp(), { prefix: 'login:ip', limit: 30, windowMs: WINDOW_MS }),
  ];
  if (await isThrottled(rules)) redirect('/login?error=locked');

  const token = await login(email, password);
  // Deliberately one message for both wrong email and wrong password.
  if (!token) {
    await recordEvent(rules.map((rule) => rule.key));
    redirect('/login?error=invalid');
  }

  await clearEvents([emailRule.key]);

  await setSessionCookie(token);
  redirect('/dashboard');
}

export default async function LoginPage({
  searchParams,
}: PageProps<'/login'>) {
  if (await getSession()) redirect('/dashboard');
  const { error } = await searchParams;
  // A registered ward tablet: the nurse taps her name and PIN instead (T1.9).
  const wardDevice = await resolveWardDevice(await readWardDeviceCookie());

  return (
    <main className="flex min-h-dvh items-center justify-center bg-ink-100 px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-xl bg-brand-600 text-xl font-bold text-white">
            Q
          </div>
          <h1 className="text-xl font-semibold text-ink-900">Qurio</h1>
          <p className="mt-1 text-sm text-ink-500">Sign in to your hospital dashboard</p>
        </div>

        {wardDevice ? (
          <Link
            href="/ward-device"
            className="mb-4 flex min-h-14 items-center justify-center rounded-xl bg-brand-600 px-4 text-base font-semibold text-white shadow-sm hover:bg-brand-700"
          >
            Ward tablet: tap your name to record
          </Link>
        ) : null}

        <form
          action={signIn}
          className="space-y-4 rounded-xl border border-ink-200 bg-white p-6 shadow-[var(--shadow-raised)]"
        >
          {error === 'locked' ? (
            <Alert tone="error">
              Too many failed attempts. Wait 15 minutes and try again.
            </Alert>
          ) : error ? (
            <Alert tone="error">Incorrect email or password.</Alert>
          ) : null}

          <Field label="Email">
            <Input
              name="email"
              type="email"
              autoComplete="username"
              required
              autoFocus
              placeholder="you@hospital.in"
            />
          </Field>

          <Field label="Password">
            <Input
              name="password"
              type="password"
              autoComplete="current-password"
              required
            />
          </Field>

          <Button type="submit" variant="primary" size="lg" className="w-full">
            Sign in
          </Button>
        </form>

        <p className="mt-6 text-center text-xs text-ink-400">
          Patients do not need an account. They open their queue link directly.
        </p>
      </div>
    </main>
  );
}
