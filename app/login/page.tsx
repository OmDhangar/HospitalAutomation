import { redirect } from 'next/navigation';
import { Alert, Button, Field, Input } from '@/components/ui';
import { getSession, setSessionCookie } from '@/lib/auth/session';
import { login } from '@/lib/services/auth';

export const metadata = { title: 'Sign in · OPD Queue' };

async function signIn(formData: FormData) {
  'use server';

  const email = String(formData.get('email') ?? '');
  const password = String(formData.get('password') ?? '');

  const token = await login(email, password);
  // Deliberately one message for both wrong email and wrong password.
  if (!token) redirect('/login?error=invalid');

  await setSessionCookie(token);
  redirect('/dashboard');
}

export default async function LoginPage({
  searchParams,
}: PageProps<'/login'>) {
  if (await getSession()) redirect('/dashboard');
  const { error } = await searchParams;

  return (
    <main className="flex min-h-dvh items-center justify-center bg-ink-100 px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-xl bg-brand-600 text-xl font-bold text-white">
            Q
          </div>
          <h1 className="text-xl font-semibold text-ink-900">OPD Queue</h1>
          <p className="mt-1 text-sm text-ink-500">Sign in to your hospital dashboard</p>
        </div>

        <form
          action={signIn}
          className="space-y-4 rounded-xl border border-ink-200 bg-white p-6 shadow-[var(--shadow-raised)]"
        >
          {error ? <Alert tone="error">Incorrect email or password.</Alert> : null}

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
