import Link from 'next/link';
import { Alert, Button, Card, CardHeader, EmptyState, Field, Input, cn } from '@/components/ui';
import { requirePlatformAdmin } from '@/lib/auth/platform';
import {
  INTEGRATION_ERROR_CODES,
  integrationErrorMessage,
  type IntegrationErrorCode,
} from '@/lib/domain/whatsapp-integration';
import {
  listAllNumbers,
  listHospitalsAwaitingNumber,
  listUnassignedNumbers,
} from '@/lib/services/whatsapp-numbers';
import { assignNumber, refreshHealth, releaseNumber } from '../actions';
import { ConfirmWord } from '../ui';

export const metadata = { title: 'WhatsApp · Platform' };

export default async function WhatsAppPage({ searchParams }: PageProps<'/admin/whatsapp'>) {
  await requirePlatformAdmin();
  const params = await searchParams;

  const [numbers, awaiting, inventory] = await Promise.all([
    listAllNumbers(),
    listHospitalsAwaitingNumber(),
    listUnassignedNumbers(),
  ]);

  return (
    <div className="space-y-5">
      <Notices params={params} />

      <Card>
        <CardHeader
          title="Waiting on a number"
          hint="Hospitals paying for WhatsApp that cannot yet send anything"
        />
        {awaiting.length === 0 ? (
          <EmptyState title="Every hospital has a number" hint="Nothing is waiting on onboarding." />
        ) : (
          <>
            <ul className="divide-y divide-ink-200">
              {awaiting.map((hospital) => (
                <li key={hospital.id} className="px-5 py-2.5">
                  <Link
                    href={`/admin/hospitals/${hospital.id}`}
                    className="text-sm font-medium text-ink-900 underline-offset-2 hover:underline"
                  >
                    {hospital.name}
                  </Link>
                </li>
              ))}
            </ul>

            <form action={assignNumber} className="space-y-3 border-t border-ink-200 bg-ink-50/50 p-5">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field
                  label="Hospital"
                  hint="The number is verified against our WABA before it is attached."
                >
                  <select
                    name="hospitalId"
                    required
                    className="block w-full rounded-lg border-0 bg-white px-3 py-2.5 text-sm text-ink-900 ring-1 ring-inset ring-ink-300 focus:ring-2 focus:ring-inset focus:ring-brand-600 focus:outline-none"
                  >
                    <option value="">Select a hospital…</option>
                    {awaiting.map((hospital) => (
                      <option key={hospital.id} value={hospital.id}>
                        {hospital.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field
                  label="Phone number id"
                  hint={
                    inventory.length > 0
                      ? `Unassigned: ${inventory
                          .map((n) => n.displayPhoneNumber ?? n.phoneNumberId)
                          .join(', ')}`
                      : 'Meta’s numeric id, from WhatsApp → API Setup.'
                  }
                >
                  <Input name="phoneNumberId" placeholder="123456789012345" required />
                </Field>
              </div>
              <Button type="submit" variant="primary">
                Assign number
              </Button>
            </form>
          </>
        )}
      </Card>

      <Card>
        <CardHeader
          title="Sender numbers"
          hint="One number per hospital, all on our WhatsApp Business Account"
        />
        {numbers.length === 0 ? (
          <EmptyState title="No numbers yet" hint="Nothing has been added to the WABA." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-ink-200 text-left text-xs uppercase tracking-wide text-ink-500">
                  <th className="px-5 py-2.5 font-medium">Hospital</th>
                  <th className="px-5 py-2.5 font-medium">Patients see</th>
                  <th className="px-5 py-2.5 font-medium">Number</th>
                  <th className="px-5 py-2.5 font-medium">Status</th>
                  <th className="px-5 py-2.5 font-medium">Quality</th>
                  <th className="px-5 py-2.5 font-medium">Tier</th>
                  <th className="px-5 py-2.5 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-200">
                {numbers.map((number) => (
                  <tr key={number.id}>
                    <td className="px-5 py-3 font-medium text-ink-900">
                      {number.hospitalId ? (
                        <Link
                          href={`/admin/hospitals/${number.hospitalId}`}
                          className="underline-offset-2 hover:underline"
                        >
                          {number.hospitalName}
                        </Link>
                      ) : (
                        <span className="text-ink-400">Unassigned</span>
                      )}
                    </td>
                    <td className="px-5 py-3 text-ink-700">
                      {number.verifiedName ?? <span className="text-ink-400">—</span>}
                    </td>
                    <td className="numeric px-5 py-3 text-ink-600">
                      {number.displayPhoneNumber ?? number.phoneNumberId}
                    </td>
                    <td className="px-5 py-3">
                      <span
                        className={cn(
                          'inline-flex rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset',
                          number.status === 'registered'
                            ? 'bg-emerald-50 text-emerald-800 ring-emerald-200'
                            : number.status === 'pending'
                              ? 'bg-ink-100 text-ink-600 ring-ink-200'
                              : 'bg-rose-50 text-rose-800 ring-rose-200',
                        )}
                      >
                        {number.status}
                      </span>
                    </td>
                    <td className="px-5 py-3">
                      <span
                        className={cn(
                          'text-xs font-medium',
                          number.qualityRating === 'GREEN'
                            ? 'text-emerald-700'
                            : number.qualityRating === 'YELLOW'
                              ? 'text-amber-700'
                              : number.qualityRating === 'RED'
                                ? 'text-rose-700'
                                : 'text-ink-400',
                        )}
                      >
                        {number.qualityRating ?? '—'}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-xs text-ink-500">
                      {number.messagingTier ?? '—'}
                    </td>
                    <td className="px-5 py-3">
                      <div className="flex items-center justify-end gap-3">
                        <form action={refreshHealth}>
                          <input type="hidden" name="phoneNumberId" value={number.phoneNumberId} />
                          <button
                            type="submit"
                            className="text-xs font-medium text-ink-600 underline-offset-2 hover:underline"
                            title="Ask Meta for the current quality rating and tier"
                          >
                            Refresh
                          </button>
                        </form>
                        {number.hospitalId ? (
                          <form action={releaseNumber} className="flex items-center gap-1.5">
                            <input type="hidden" name="phoneNumberId" value={number.phoneNumberId} />
                            <ConfirmWord word="RELEASE" name="confirm" />
                            <button
                              type="submit"
                              className="text-xs font-medium text-rose-700 underline-offset-2 hover:underline"
                            >
                              Release
                            </button>
                          </form>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="border-t border-ink-200 px-5 py-3 text-xs leading-relaxed text-ink-500">
          Quality is scored per number, but Meta&rsquo;s throughput limit applies across the
          whole business portfolio — one hospital whose patients block messages can slow
          sending for every other hospital. That shared fate is the reason the message
          budget is kept low and consent is enforced.
        </p>
      </Card>
    </div>
  );
}

function Notices({ params }: { params: Record<string, string | string[] | undefined> }) {
  const error = typeof params.error === 'string' ? params.error : null;
  const known = INTEGRATION_ERROR_CODES.find((code) => code === error);

  return (
    <>
      {params.assigned ? (
        <Alert tone="success">Number assigned and verified against our WABA.</Alert>
      ) : null}
      {params.refreshed ? <Alert tone="success">Health refreshed from Meta.</Alert> : null}
      {params.released ? (
        <Alert tone="success">Number returned to unassigned inventory.</Alert>
      ) : null}
      {known ? (
        <Alert tone="error">{integrationErrorMessage(known as IntegrationErrorCode)}</Alert>
      ) : null}
      {error === 'CONFIRM' ? (
        <Alert tone="error">Type RELEASE exactly to confirm. Nothing has been changed.</Alert>
      ) : null}
      {error === 'PERMISSION_DENIED' && !known ? <Alert tone="error">Not permitted.</Alert> : null}
    </>
  );
}
