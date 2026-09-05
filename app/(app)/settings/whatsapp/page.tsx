import Link from 'next/link';
import {
  Alert,
  Button,
  Card,
  CardHeader,
  EmptyState,
  Field,
  Input,
  cn,
} from '@/components/ui';
import { requireSession } from '@/lib/auth/session';
import { formatIndianPhone } from '@/lib/domain/phone';
import { LOCALES, LOCALE_NAMES } from '@/lib/i18n/patient';
import { TEMPLATES } from '@/lib/notify/templates';
import { canConfigureHospital } from '@/lib/services/auth';
import { getHospital } from '@/lib/services/hospital';
import { saveWhatsAppSettings, sendTestMessage } from './actions';

export const metadata = { title: 'WhatsApp · OPD Queue' };

export default async function WhatsAppSettingsPage({
  searchParams,
}: PageProps<'/settings/whatsapp'>) {
  const session = await requireSession();
  const params = await searchParams;

  if (!canConfigureHospital(session.role)) {
    return (
      <Card>
        <EmptyState title="Only the hospital owner can change WhatsApp settings" />
      </Card>
    );
  }

  const hospital = await getHospital(session.hospitalId);
  const hasToken = Boolean(process.env.WHATSAPP_ACCESS_TOKEN);
  const hasAppSecret = Boolean(process.env.WHATSAPP_APP_SECRET);
  const hasVerifyToken = Boolean(process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN);
  const hasNumber = Boolean(hospital?.whatsappPhoneNumberId);
  const live = hasToken && hasNumber;

  const templateCount = Object.keys(TEMPLATES).length * LOCALES.length;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-ink-900">WhatsApp</h1>
          <p className="mt-0.5 text-sm text-ink-500">
            Booking and notifications for {session.hospitalName}
          </p>
        </div>
        <Link href="/settings">
          <Button>Back to settings</Button>
        </Link>
      </div>

      {params.saved ? <Alert tone="warn">Settings saved.</Alert> : null}
      {params.sent ? <Alert tone="warn">Test message sent.</Alert> : null}
      {params.error === 'phone' ? (
        <Alert tone="error">Enter a valid 10-digit Indian mobile number.</Alert>
      ) : null}
      {params.error === 'nonumber' ? (
        <Alert tone="error">
          Set the WhatsApp phone number id below before sending a test.
        </Alert>
      ) : null}
      {params.error === 'send' ? (
        <Alert tone="error">
          Send failed: {typeof params.detail === 'string' ? params.detail : 'unknown error'}
        </Alert>
      ) : null}

      <Card>
        <CardHeader
          title="Connection"
          hint={
            live
              ? 'Live — messages go to Meta'
              : 'Not live — messages are printed to the server log instead'
          }
          action={
            <span
              className={cn(
                'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset',
                live
                  ? 'bg-emerald-50 text-emerald-800 ring-emerald-200'
                  : 'bg-amber-50 text-amber-900 ring-amber-200',
              )}
            >
              <span
                className={cn(
                  'size-1.5 rounded-full',
                  live ? 'bg-emerald-500' : 'bg-amber-500',
                )}
              />
              {live ? 'Connected' : 'Development mode'}
            </span>
          }
        />

        <ul className="divide-y divide-ink-200 text-sm">
          <Check
            label="Access token"
            ok={hasToken}
            detail="WHATSAPP_ACCESS_TOKEN — a permanent System User token, not a 24-hour test token"
          />
          <Check
            label="App secret"
            ok={hasAppSecret}
            detail="WHATSAPP_APP_SECRET — without it the webhook rejects every request"
          />
          <Check
            label="Webhook verify token"
            ok={hasVerifyToken}
            detail="WHATSAPP_WEBHOOK_VERIFY_TOKEN — any string you choose, entered on both sides"
          />
          <Check
            label="Phone number id"
            ok={hasNumber}
            detail={
              hospital?.whatsappPhoneNumberId ??
              'From the Meta dashboard, under WhatsApp → API Setup'
            }
          />
        </ul>

        <form action={saveWhatsAppSettings} className="space-y-4 border-t border-ink-200 p-5">
          <Field
            label="WhatsApp phone number id"
            hint="Meta's numeric id for the number, not the number itself."
          >
            <Input
              name="phoneNumberId"
              defaultValue={hospital?.whatsappPhoneNumberId ?? ''}
              placeholder="123456789012345"
            />
          </Field>
          <Field
            label="Owner's mobile number"
            hint="Where the monthly summary goes. Optional."
          >
            <Input
              name="ownerPhone"
              defaultValue={
                hospital?.ownerPhoneE164 ? formatIndianPhone(hospital.ownerPhoneE164) : ''
              }
              placeholder="98765 43210"
            />
          </Field>
          <Button type="submit" variant="primary">
            Save
          </Button>
        </form>
      </Card>

      <Card>
        <CardHeader
          title="Send a test message"
          hint="The only way to confirm credentials, number and templates line up"
        />
        <form action={sendTestMessage} className="space-y-4 p-5">
          <Field
            label="Your own mobile number"
            hint="Uses the queue link template. Send only to a number you control."
          >
            <Input name="testPhone" placeholder="98765 43210" required />
          </Field>
          <Button type="submit">Send test</Button>
        </form>
      </Card>

      <Card>
        <CardHeader
          title="Templates"
          hint={`${templateCount} approvals needed — ${Object.keys(TEMPLATES).length} templates × ${LOCALES.length} languages`}
        />
        <div className="px-5 py-4">
          <p className="text-sm leading-relaxed text-ink-600">
            Submit every one of these in the Meta dashboard under{' '}
            <strong>WhatsApp → Message Templates</strong>, or run{' '}
            <code className="rounded bg-ink-100 px-1.5 py-0.5 text-xs">
              npm run whatsapp:templates
            </code>{' '}
            to print the exact payloads. The text must match what is submitted, or
            sends fail with a template mismatch.
          </p>
        </div>

        <div className="divide-y divide-ink-200 border-t border-ink-200">
          {Object.entries(TEMPLATES).map(([code, definition]) => (
            <div key={code} className="px-5 py-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="font-mono text-sm font-medium text-ink-900">
                  {definition.name}
                </p>
                <p className="text-xs text-ink-500">
                  {definition.variables.length} variable
                  {definition.variables.length === 1 ? '' : 's'}:{' '}
                  {definition.variables.join(', ')}
                </p>
              </div>
              <dl className="mt-3 space-y-2">
                {LOCALES.map((locale) => (
                  <div key={locale} className="flex gap-3">
                    <dt className="w-16 shrink-0 text-xs font-medium text-ink-500">
                      {LOCALE_NAMES[locale]}
                    </dt>
                    <dd
                      className={cn(
                        'min-w-0 flex-1 whitespace-pre-wrap text-sm leading-relaxed text-ink-700',
                        locale !== 'en' && 'font-deva',
                      )}
                    >
                      {definition.body[locale]}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

function Check({
  label,
  ok,
  detail,
}: {
  label: string;
  ok: boolean;
  detail: string;
}) {
  return (
    <li className="flex items-start gap-3 px-5 py-3">
      <span
        className={cn(
          'mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white',
          ok ? 'bg-emerald-500' : 'bg-ink-300',
        )}
      >
        {ok ? '✓' : '!'}
      </span>
      <div className="min-w-0">
        <p className="font-medium text-ink-900">{label}</p>
        <p className="break-words text-xs text-ink-500">{detail}</p>
      </div>
    </li>
  );
}
