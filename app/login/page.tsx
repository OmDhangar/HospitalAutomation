import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Alert, Button, Field, Input } from '@/components/ui';
import { getSessionState, readDeviceCookie, setSessionCookie } from '@/lib/auth/session';
import { readWardDeviceCookie } from '@/lib/auth/ward-device-cookie';
import { clearEvents, clientIp, ipRules, isThrottled, recordEvent } from '@/lib/security/throttle';
import { login, logout, resolveSession } from '@/lib/services/auth';

const WINDOW_MS = 15 * 60 * 1000;

export const metadata = { title: 'Sign in · QuriioHQ' };

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

  const token = await login(email, password, { deviceId: await readDeviceCookie() });
  // Deliberately one message for both wrong email and wrong password.
  if (!token) {
    await recordEvent(rules.map((rule) => rule.key));
    redirect('/login?error=invalid');
  }

  await clearEvents([emailRule.key]);

  /**
   * The hospital may allow a role only on ward tablets (ADR-022). The rule is
   * enforced when a session resolves; resolving here turns it into a sentence
   * instead of a silent bounce back to this page.
   */
  if (!(await resolveSession(token))) {
    await logout(token);
    redirect('/login?error=mode');
  }

  await setSessionCookie(token);
  redirect('/dashboard');
}

export default async function LoginPage({
  searchParams,
}: PageProps<'/login'>) {
  const { error, staff } = await searchParams;
  const current = await getSessionState();
  if (current?.locked) redirect(current.channel === 'ward_device' ? '/ward-device' : '/unlock');
  if (current) redirect(current.channel === 'ward_device' ? '/ipd/ward' : '/dashboard');
  // An enrolled ward tablet opens on "Who is recording?", unless someone asked for the email sign-in.
  const onTablet = Boolean(await readWardDeviceCookie());
  if (onTablet && staff !== '1') redirect('/ward-device');

  return (
    <main className="flex min-h-dvh items-center justify-center bg-ink-100 px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-xl bg-brand-600 text-xl font-bold text-white">
            Q
          </div>
          <h1 className="text-xl font-semibold text-ink-900">QuriioHQ</h1>
          <p className="mt-1 text-sm text-ink-500">Sign in to your hospital dashboard</p>
        </div>

        <form
          action={signIn}
          className="space-y-4 rounded-xl border border-ink-200 bg-white p-6 shadow-[var(--shadow-raised)]"
        >
          {error === 'locked' ? (
            <Alert tone="error">
              Too many failed attempts. Wait 15 minutes and try again.
            </Alert>
          ) : error === 'mode' ? (
            <Alert tone="error">
              Your hospital has set your login to work on the ward tablet only. Use the tablet and your PIN.
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

        {onTablet ? (
          <Link href="/ward-device" className="mt-4 block text-center text-sm font-semibold text-brand-700">
            This is a ward tablet: Who is recording?
          </Link>
        ) : null}

        <p className="mt-6 text-center text-xs text-ink-400">
          Patients do not need an account. They open their queue link directly.
        </p>
      </div>
    </main>
  );
}
