import Link from 'next/link';
import { Alert, Button, Field, Input } from '@/components/ui';
import { BedIcon } from '@/components/icons';
import { PinPad } from '@/components/pin-pad';
import { readWardDeviceCookie } from '@/lib/auth/ward-device-cookie';
import { isLocked } from '@/lib/domain/staff-access';
import { listPinPeople, resolveWardDevice } from '@/lib/services/staff-access';
import { enrolWardDeviceAction, unlockWardDeviceAction } from './actions';

export const metadata = { title: 'Who is recording? · QuriioHQ Ward', robots: { index: false, follow: false } };

/**
 * The shared ward tablet's front screen (ADR-022). Outside the app shell:
 * nobody is signed in here. A tablet that is not enrolled asks for the
 * owner's one-time code; an enrolled one shows "Who is recording?" — names
 * only, never a patient — and then that person's PIN pad.
 */
export default async function WardDevicePage({ searchParams }: PageProps<'/ward-device'>) {
  const params = await searchParams;
  const error = typeof params.error === 'string' ? params.error : null;
  const device = await resolveWardDevice(await readWardDeviceCookie());

  if (!device) {
    return (
      <Shell>
        <h1 className="text-xl font-bold text-ink-900">Set up this tablet for the ward</h1>
        <p className="text-base text-ink-600">
          Type the 8-character code the hospital owner created in Settings → Staff access → Ward tablets. The code works once
          and for 15 minutes.
        </p>
        {error ? <Alert tone="error">{error}</Alert> : null}
        <form action={enrolWardDeviceAction} className="space-y-3">
          <Field label="Tablet code">
            <Input
              name="code"
              required
              autoComplete="off"
              autoCapitalize="characters"
              placeholder="ABCD-EFGH"
              className="numeric text-center text-2xl tracking-[0.3em]"
            />
          </Field>
          <Button type="submit" variant="primary" size="lg" className="w-full">
            Set up tablet
          </Button>
        </form>
        <Link href="/login?staff=1" className="block text-center text-sm text-ink-500 underline">
          Sign in with email instead
        </Link>
      </Shell>
    );
  }

  const people = await listPinPeople(device);
  const selected = typeof params.user === 'string' ? (people.find((p) => p.userId === params.user) ?? null) : null;
  const next = typeof params.next === 'string' ? params.next : '';
  const deviceLocked = isLocked(device.lockedUntil, new Date());

  return (
    <Shell label={device.name}>
      {params.enrolled ? <Alert tone="success">This tablet is set up. Each person now unlocks it with their own PIN.</Alert> : null}
      {deviceLocked ? (
        <Alert tone="error">
          This tablet is locked for an hour after too many wrong PINs. The owner can unlock it in Settings → Staff access.
        </Alert>
      ) : selected ? (
        <div className="space-y-5">
          <div className="text-center">
            <p className="text-sm text-ink-500">Enter the PIN for</p>
            <h1 className="text-2xl font-bold text-ink-900">{selected.name}</h1>
          </div>
          {error ? <Alert tone="error">{error}</Alert> : null}
          <PinPad action={unlockWardDeviceAction} hidden={{ userId: selected.userId, next }} />
          <Link href={`/ward-device${next ? `?next=${encodeURIComponent(next)}` : ''}`} className="block text-center">
            <span className="inline-flex min-h-12 items-center font-semibold text-brand-700">Not you? Choose again</span>
          </Link>
        </div>
      ) : (
        <div className="space-y-4">
          <h1 className="text-2xl font-bold text-ink-900">Who is recording?</h1>
          {error ? <Alert tone="error">{error}</Alert> : null}
          {people.length === 0 ? (
            <p className="text-base text-ink-600">
              Nobody can use this tablet yet. Each nurse or doctor sets a PIN once, signed in with their own login, under
              “My login and PIN”.
            </p>
          ) : (
            <ul className="grid grid-cols-2 gap-3">
              {people.map((person) => (
                <li key={person.userId}>
                  <Link
                    href={`/ward-device?user=${person.userId}${next ? `&next=${encodeURIComponent(next)}` : ''}`}
                    className="flex min-h-20 items-center justify-center rounded-2xl bg-white px-3 text-center text-lg font-bold text-ink-900 shadow-xs ring-1 ring-ink-200 hover:ring-brand-500"
                  >
                    {person.name}
                  </Link>
                </li>
              ))}
            </ul>
          )}
          <Link href="/login?staff=1" className="block text-center text-sm text-ink-500 underline">
            Sign in with email instead
          </Link>
        </div>
      )}
    </Shell>
  );
}

function Shell({ children, label }: { children: React.ReactNode; label?: string }) {
  return (
    <main className="min-h-dvh bg-ink-100 px-4 py-8">
      <div className="mx-auto max-w-md space-y-6">
        <div className="flex items-center gap-2.5">
          <span className="flex size-10 items-center justify-center rounded-xl bg-brand-600 text-white">
            <BedIcon className="size-6" />
          </span>
          <div>
            <p className="font-bold text-ink-900">QuriioHQ Ward</p>
            {label ? <p className="text-sm text-ink-500">{label}</p> : null}
          </div>
        </div>
        <div className="space-y-5 rounded-2xl border border-ink-200 bg-ink-50 p-5">{children}</div>
      </div>
    </main>
  );
}
