import Link from 'next/link';
import { Alert, Button } from '@/components/ui';
import { BedIcon } from '@/components/icons';
import { PinPad } from '@/components/ipd/pin-pad';
import { readWardDeviceCookie } from '@/lib/auth/ward-device-cookie';
import { listPinPeople, resolveWardDevice } from '@/lib/services/ward-devices';
import { unlockWardDeviceAction } from './actions';

export const metadata = { title: 'Who is recording? · Qurio Ward' };

/**
 * The shared ward tablet's lock screen (IPD plan §5.6, T1.9): tap your name,
 * enter your PIN. Outside the app shell on purpose — nobody is signed in
 * here; the device cookie alone decides what is shown, and it shows names
 * only, never a patient.
 */
export default async function WardDevicePage({ searchParams }: PageProps<'/ward-device'>) {
  const params = await searchParams;
  const device = await resolveWardDevice(await readWardDeviceCookie());

  if (!device) {
    return (
      <Shell>
        <h1 className="text-xl font-bold text-ink-900">Not a ward tablet</h1>
        <p className="text-base text-ink-600">
          This device is not registered for ward recording, or it was removed. The hospital owner can
          register it from Settings → IPD → Ward devices.
        </p>
        <Link href="/login">
          <Button variant="primary" size="lg" className="w-full">
            Sign in
          </Button>
        </Link>
      </Shell>
    );
  }

  const people = await listPinPeople(device);
  const selected = typeof params.user === 'string' ? people.find((p) => p.userId === params.user) ?? null : null;
  const error = typeof params.error === 'string' ? params.error : null;

  return (
    <Shell label={device.label}>
      {selected ? (
        <div className="space-y-5">
          <div className="text-center">
            <p className="text-sm text-ink-500">Enter the PIN for</p>
            <h1 className="text-2xl font-bold text-ink-900">{selected.name}</h1>
          </div>
          {error ? <Alert tone="error">{error}</Alert> : null}
          <PinPad action={unlockWardDeviceAction} userId={selected.userId} />
          <Link href="/ward-device" className="block text-center">
            <span className="inline-flex min-h-12 items-center font-semibold text-brand-700">Not you? Choose again</span>
          </Link>
        </div>
      ) : (
        <div className="space-y-4">
          <h1 className="text-2xl font-bold text-ink-900">Who is recording?</h1>
          {people.length === 0 ? (
            <p className="text-base text-ink-600">
              Nobody has a ward PIN yet. Each nurse sets one after signing in with their own login, on the
              Ward screen.
            </p>
          ) : (
            <ul className="grid grid-cols-2 gap-3">
              {people.map((person) => (
                <li key={person.userId}>
                  <Link
                    href={`/ward-device?user=${person.userId}`}
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
            <p className="font-bold text-ink-900">Qurio Ward</p>
            {label ? <p className="text-sm text-ink-500">{label}</p> : null}
          </div>
        </div>
        <div className="space-y-5 rounded-2xl border border-ink-200 bg-ink-50 p-5">{children}</div>
      </div>
    </main>
  );
}
