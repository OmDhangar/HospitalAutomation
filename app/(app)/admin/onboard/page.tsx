import { Alert, Button, Card, CardHeader, Field, Input } from '@/components/ui';
import { requirePlatformAdmin } from '@/lib/auth/platform';
import { listActiveTiers } from '@/lib/services/subscriptions';
import { listUnassignedNumbers } from '@/lib/services/whatsapp-numbers';
import { createHospitalAction } from '../actions';
import { rupees } from '../ui';

export const metadata = { title: 'Onboard · Platform' };

const SELECT_CLASS =
  'block w-full rounded-lg border-0 bg-white px-3 py-2.5 text-sm text-ink-900 ' +
  'ring-1 ring-inset ring-ink-300 focus:ring-2 focus:ring-inset focus:ring-brand-600 focus:outline-none';

const ERRORS: Record<string, string> = {
  REQUIRED_FIELDS: 'Hospital name, owner name and owner email are all required.',
  INVALID_TRIAL_DAYS: 'A free trial is 1 to 90 whole days. Leave it blank for a paid plan.',
  CREATION_FAILED: 'Onboarding failed. Check the details and try again.',
  EMAIL_IN_USE:
    'That email already has a login. Each login belongs to one hospital — use a different email for this owner.',
  WEAK_PASSWORD:
    'The initial password must be at least 10 characters and not an old default. Or leave it blank.',
  WABA_INCOMPLETE:
    'Give all five WhatsApp fields or none. A partial binding cannot receive messages.',
  INVALID_PHONE_NUMBER_ID: 'That phone number ID does not look like one of Meta’s.',
  NUMBER_TAKEN: 'That phone number ID is already bound to another hospital.',
  MISSING_FIELD: 'A required WhatsApp field was blank.',
  NO_ENCRYPTION_KEY:
    'WHATSAPP_ENCRYPTION_KEY is not set on this server, so credentials cannot be sealed.',
};

/**
 * One form that produces a hospital somebody can actually sign into.
 *
 * Everything optional is genuinely optional: a hospital can be created and put
 * on a plan today, and given a doctor and a WhatsApp number next week. What is
 * not optional is the owner login, because a tenant nobody can sign into is a
 * support ticket that arrives the same afternoon.
 */
export default async function OnboardPage({ searchParams }: PageProps<'/admin/onboard'>) {
  await requirePlatformAdmin();
  const params = await searchParams;

  const [tiers, inventory] = await Promise.all([
    listActiveTiers().catch(() => []),
    listUnassignedNumbers().catch(() => []),
  ]);

  const error = typeof params.error === 'string' ? ERRORS[params.error] : undefined;

  return (
    <div className="space-y-5">
      {error ? <Alert tone="error">{error}</Alert> : null}

      <Card>
        <CardHeader
          title="Onboard a new hospital"
          hint="Creates the tenant, its first branch, an owner login and a subscription in one step"
        />
        <form action={createHospitalAction} className="space-y-5 p-5">
          <fieldset className="grid gap-4 md:grid-cols-2">
            <legend className="sr-only">Hospital</legend>
            <Field label="Hospital name" hint="Official name, shown to patients">
              <Input name="name" required placeholder="Sanjeevani Care Hospital" />
            </Field>
            <Field label="Plan tier" hint="Sets daily capacity, allowances and feature limits">
              <select name="planTierCode" defaultValue={tiers[0]?.code ?? 'solo'} className={SELECT_CLASS}>
                {tiers.length > 0 ? (
                  tiers.map((tier) => (
                    <option key={tier.code} value={tier.code}>
                      {tier.name} · {rupees(tier.monthlyPricePaise)}/mo ·{' '}
                      {tier.patientsPerDay} patients/day ·{' '}
                      {tier.maxDoctors === null ? 'unlimited' : tier.maxDoctors} doctors
                    </option>
                  ))
                ) : (
                  <option value="solo">Solo</option>
                )}
              </select>
            </Field>
          </fieldset>

          <fieldset className="grid gap-4 border-t border-ink-200 pt-4 md:grid-cols-3">
            <legend className="sr-only">Billing</legend>
            <Field label="Billing cycle" hint="Annual is ten months for twelve and waives setup">
              <select name="billingCycle" defaultValue="monthly" className={SELECT_CLASS}>
                <option value="monthly">Monthly</option>
                <option value="annual">Annual</option>
              </select>
            </Field>
            <Field label="Free trial (days)" hint="Blank for a paid plan. 15 or 20 gives a trial at ₹0">
              <Input name="trialDays" type="number" inputMode="numeric" min={1} max={90} placeholder="15" />
            </Field>
            <Field label="Owner mobile (WhatsApp)" hint="Where the monthly owner summary goes">
              <Input name="ownerPhoneE164" type="tel" placeholder="+919876543210" />
            </Field>
          </fieldset>

          <fieldset className="grid gap-4 border-t border-ink-200 pt-4 md:grid-cols-3">
            <legend className="mb-2 text-sm font-semibold text-ink-800">Owner login</legend>
            <Field label="Full name">
              <Input name="ownerName" required placeholder="Dr. Rajesh Sharma" />
            </Field>
            <Field label="Email" hint="This is their sign-in">
              <Input name="ownerEmail" type="email" required placeholder="admin@sanjeevani.in" />
            </Field>
            <Field
              label="Initial password"
              hint="Optional, 10+ characters. Leave blank and issue one from the account page"
            >
              <Input
                name="ownerPassword"
                type="text"
                autoComplete="off"
                minLength={10}
                placeholder="optional"
              />
            </Field>
          </fieldset>

          <fieldset className="grid gap-4 border-t border-ink-200 pt-4 md:grid-cols-2">
            <legend className="mb-2 text-sm font-semibold text-ink-800">First branch</legend>
            <Field label="Branch name">
              <Input name="branchName" defaultValue="Main Clinic" />
            </Field>
            <Field label="Address" hint="Optional">
              <Input name="branchAddress" placeholder="102 MG Road, Shivajinagar, Pune" />
            </Field>
          </fieldset>

          <fieldset className="grid gap-4 border-t border-ink-200 pt-4 md:grid-cols-3">
            <legend className="mb-2 text-sm font-semibold text-ink-800">
              First doctor
              <span className="ml-2 font-normal text-ink-500">— optional</span>
            </legend>
            <Field label="Doctor name">
              <Input name="initialDoctorName" placeholder="Dr. Anjali Patil" />
            </Field>
            <Field label="Specialty">
              <Input name="initialDoctorSpecialty" placeholder="Paediatrics" />
            </Field>
            <Field label="Booking mode">
              <select name="initialDoctorMode" defaultValue="both" className={SELECT_CLASS}>
                <option value="both">Queue and slots</option>
                <option value="queue">Queue only</option>
                <option value="slot">Slots only</option>
              </select>
            </Field>
          </fieldset>

          <fieldset className="space-y-4 border-t border-ink-200 pt-4">
            <legend className="mb-1 text-sm font-semibold text-ink-800">
              WhatsApp Business Account
              <span className="ml-2 font-normal text-ink-500">
                — the hospital&rsquo;s own Meta App
              </span>
            </legend>
            <p className="text-xs leading-relaxed text-ink-500">
              All five fields together, or leave them all blank and bind it later from the
              account page. A number bound without its inbound secrets answers Meta&rsquo;s
              handshake and then rejects every message. Once saved, give Meta the callback
              URL shown on the account page — it is specific to this hospital.
            </p>

            <div className="grid gap-4 md:grid-cols-2">
              <Field label="Phone number ID" hint="WhatsApp → API Setup, the numeric sender id">
                <Input name="wabaPhoneNumberId" placeholder="123456789012345" />
              </Field>
              <Field label="WhatsApp Business Account ID" hint="The WABA the number belongs to">
                <Input name="wabaBusinessAccountId" placeholder="987654321098765" />
              </Field>
            </div>

            <Field
              label="Access token"
              hint="System User token from Business Settings → System Users. Sealed before storage and never shown again."
            >
              <Input name="wabaAccessToken" type="password" autoComplete="off" placeholder="EAA…" />
            </Field>

            <div className="grid gap-4 md:grid-cols-2">
              <Field label="Webhook verify token" hint="Whatever you set in the app's webhook config">
                <Input name="wabaVerifyToken" type="password" autoComplete="off" />
              </Field>
              <Field label="App secret" hint="App Settings → Basic. Signs every inbound payload.">
                <Input name="wabaAppSecret" type="password" autoComplete="off" />
              </Field>
            </div>

            <div className="grid gap-4 md:grid-cols-3">
              <Field label="Meta business ID" hint="Optional, informational">
                <Input name="wabaMetaBusinessId" />
              </Field>
              <Field label="Display number" hint="Optional, what patients see">
                <Input name="wabaDisplayNumber" placeholder="+91 98765 43210" />
              </Field>
              <Field label="Verified name" hint="Optional">
                <Input name="wabaVerifiedName" placeholder="Sanjeevani Care" />
              </Field>
            </div>

            {inventory.length > 0 ? (
              <Field
                label="Or assign from our shared inventory"
                hint="Platform-owned number under our Meta App. Use this instead of the fields above, not as well."
              >
                <select name="phoneNumberId" defaultValue="" className={SELECT_CLASS}>
                  <option value="">Not from inventory</option>
                  {inventory.map((number) => (
                    <option key={number.phoneNumberId} value={number.phoneNumberId}>
                      {number.displayPhoneNumber ?? number.phoneNumberId}
                      {number.verifiedName ? ` (${number.verifiedName})` : ''}
                    </option>
                  ))}
                </select>
              </Field>
            ) : null}
          </fieldset>

          <div className="flex items-center justify-between gap-4 border-t border-ink-200 pt-4">
            <p className="text-xs text-ink-500">
              Either way the owner must choose their own password at first sign-in. With the
              field blank, nobody can sign in until you issue a temporary password from the
              account page.
            </p>
            <Button type="submit" variant="primary" size="lg" className="shrink-0">
              Onboard hospital
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
