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
import {
  HEALTH_LABELS,
  INTEGRATION_ERROR_CODES,
  integrationErrorMessage,
  type ConnectionHealth,
  type IntegrationErrorCode,
} from '@/lib/domain/whatsapp-integration';
import { LOCALES, LOCALE_NAMES } from '@/lib/i18n/patient';
import { TEMPLATES } from '@/lib/notify/templates';
import { canConfigureHospital } from '@/lib/services/auth';
import { getHospital } from '@/lib/services/hospital';
import { getIntegrationView } from '@/lib/services/whatsapp-integration';
import {
  disconnectWhatsApp,
  requestWhatsAppSetup,
  saveOwnerPhone,
  sendTestMessage,
  validateWhatsAppConnection,
} from './actions';

export const metadata = { title: 'WhatsApp · OPD Queue' };

const HEALTH_STYLES: Record<ConnectionHealth, string> = {
  healthy: 'bg-emerald-50 text-emerald-800 ring-emerald-200',
  degraded: 'bg-amber-50 text-amber-900 ring-amber-200',
  blocked: 'bg-rose-50 text-rose-800 ring-rose-200',
  setup: 'bg-sky-50 text-sky-800 ring-sky-200',
  off: 'bg-ink-100 text-ink-600 ring-ink-200',
};

const HEALTH_DOTS: Record<ConnectionHealth, string> = {
  healthy: 'bg-emerald-500',
  degraded: 'bg-amber-500',
  blocked: 'bg-rose-500',
  setup: 'bg-sky-500',
  off: 'bg-ink-400',
};

const DATE = new Intl.DateTimeFormat('en-IN', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

export default async function WhatsAppSettingsPage({
  searchParams,
}: PageProps<'/settings/whatsapp'>) {
  const session = await requireSession();
  const params = await searchParams;

  if (!canConfigureHospital(session.role) && !session.isPlatformAdmin) {
    return (
      <Card>
        <EmptyState title="Only the hospital owner can change WhatsApp settings" />
      </Card>
    );
  }

  const [hospital, integration] = await Promise.all([
    getHospital(session.hospitalId),
    getIntegrationView(session.hospitalId),
  ]);

  const templateCount = Object.keys(TEMPLATES).length * LOCALES.length;

  return (
    <div className="space-y-5 sm:space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-ink-900">WhatsApp Integration</h1>
          <p className="mt-0.5 text-xs sm:text-sm text-ink-500">
            Booking and notifications for {session.hospitalName}
          </p>
        </div>
        <Link href="/settings" className="w-full sm:w-auto">
          <Button className="w-full sm:w-auto justify-center">← Back to settings</Button>
        </Link>
      </div>

      <Notices params={params} />

      <Card>
        <CardHeader
          title="Connection"
          hint={
            integration.live
              ? 'Patients are receiving messages from your hospital’s number'
              : 'Messages are not reaching patients yet'
          }
          action={
            <span
              className={cn(
                'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset',
                HEALTH_STYLES[integration.health],
              )}
            >
              <span
                className={cn('size-2 rounded-full', HEALTH_DOTS[integration.health])}
              />
              {HEALTH_LABELS[integration.health]}
            </span>
          }
        />

        {integration.status === 'not_configured' ? (
          <NotConnected />
        ) : (
          <>
            <dl className="divide-y divide-ink-200 text-sm">
              <Row label="Sender name">
                {integration.verifiedName ?? (
                  <span className="text-ink-500">Awaiting approval from Meta</span>
                )}
              </Row>
              <Row label="Sender number">
                {integration.displayPhoneNumber ?? (
                  <span className="text-ink-500">Not assigned yet</span>
                )}
              </Row>
              <Row label="Number status">
                <NumberStatusText status={integration.numberStatus} />
              </Row>
              {integration.qualityRating ? (
                <Row label="Quality rating">
                  {integration.qualityRating}
                  {integration.messagingTier ? ` · ${integration.messagingTier}` : ''}
                </Row>
              ) : null}
              <Row label="Business account">
                <span className="font-mono text-xs text-ink-600">
                  {integration.wabaIdMasked ?? '—'}
                </span>
              </Row>
              <Row label="Number id">
                <span className="font-mono text-xs text-ink-600">
                  {integration.phoneNumberIdMasked ?? '—'}
                </span>
              </Row>
              {integration.connectedAt ? (
                <Row label="Connected">{DATE.format(integration.connectedAt)}</Row>
              ) : null}
              <Row label="Last checked">
                {integration.lastValidatedAt
                  ? DATE.format(integration.lastValidatedAt)
                  : 'Never'}
              </Row>
            </dl>

            {integration.lastError ? (
              <div className="border-t border-ink-200 bg-rose-50 p-4 sm:px-5 sm:py-3">
                <p className="text-xs sm:text-sm leading-relaxed text-rose-900">
                  {integration.lastError}
                </p>
                {integration.lastErrorAt ? (
                  <p className="mt-1 text-xs text-rose-700">
                    Last failure {DATE.format(integration.lastErrorAt)}
                  </p>
                ) : null}
              </div>
            ) : null}

            {integration.verifiedName && integration.displayPhoneNumber ? (
              <div className="border-t border-ink-200 bg-ink-50 p-4 sm:px-5 sm:py-3">
                <p className="text-xs sm:text-sm text-ink-600">
                  Patients see this sender as{' '}
                  <strong className="text-ink-900">{integration.verifiedName}</strong> (
                  {integration.displayPhoneNumber}).
                </p>
              </div>
            ) : null}

            <div className="flex flex-col sm:flex-row gap-2 border-t border-ink-200 p-4 sm:p-5">
              <form action={validateWhatsAppConnection} className="w-full sm:w-auto">
                <Button type="submit" className="w-full sm:w-auto justify-center">Check connection</Button>
              </form>
              {integration.status === 'disconnected' ? (
                <form action={requestWhatsAppSetup} className="w-full sm:w-auto">
                  <Button type="submit" variant="primary" className="w-full sm:w-auto justify-center">
                    Reconnect
                  </Button>
                </form>
              ) : null}
            </div>
          </>
        )}
      </Card>

      {integration.status !== 'not_configured' &&
      integration.status !== 'disconnected' ? (
        <Card>
          <CardHeader
            title="Disconnect WhatsApp"
            hint="Stops all patient notifications and WhatsApp booking"
          />
          <div className="space-y-3 p-4 sm:px-5 sm:pt-4 text-xs sm:text-sm leading-relaxed text-ink-600">
            <p>
              This removes the WhatsApp integration from QueueCare. It does not
              delete any WhatsApp Business account, and it does not delete your
              patients, appointments or message history.
            </p>
            <p>
              Patients will stop receiving booking confirmations and queue updates
              immediately, and messages they send will go unanswered.
            </p>
          </div>
          <form action={disconnectWhatsApp} className="space-y-4 p-4 sm:p-5">
            <Field label="Type DISCONNECT to confirm">
              <Input name="confirm" placeholder="DISCONNECT" autoComplete="off" />
            </Field>
            <Button type="submit" className="w-full sm:w-auto justify-center">Disconnect</Button>
          </form>
        </Card>
      ) : null}

      {integration.live ? (
        <Card>
          <CardHeader
            title="Send a test message"
            hint="Confirms the approved templates work end to end"
          />
          <form action={sendTestMessage} className="space-y-4 p-4 sm:p-5">
            <Field
              label="Your own mobile number"
              hint="Uses the queue link template. Send only to a number you control."
            >
              <Input name="testPhone" placeholder="98765 43210" required />
            </Field>
            <Button type="submit" className="w-full sm:w-auto justify-center">Send test</Button>
          </form>
        </Card>
      ) : null}

      <Card>
        <CardHeader title="Monthly summary" hint="One message a month, to you" />
        <form action={saveOwnerPhone} className="space-y-4 p-4 sm:p-5">
          <Field label="Owner’s mobile number" hint="Where the monthly summary goes.">
            <Input
              name="ownerPhone"
              defaultValue={
                hospital?.ownerPhoneE164 ? formatIndianPhone(hospital.ownerPhoneE164) : ''
              }
              placeholder="98765 43210"
            />
          </Field>
          <Button type="submit" variant="primary" className="w-full sm:w-auto justify-center">
            Save
          </Button>
        </form>
      </Card>

      <Card>
        <CardHeader
          title="Message templates"
          hint={`${templateCount} approved messages — ${Object.keys(TEMPLATES).length} kinds × ${LOCALES.length} languages`}
        />
        <div className="p-4 sm:px-5 sm:py-4">
          <p className="text-xs sm:text-sm leading-relaxed text-ink-600">
            These are the only messages QueueCare sends to your patients. Every one
            is triggered by something that happened — a booking, a token moving, a
            reminder — never by a promotion. Approval is handled for you.
          </p>
        </div>

        <div className="divide-y divide-ink-200 border-t border-ink-200">
          {Object.entries(TEMPLATES).map(([code, definition]) => (
            <div key={code} className="p-4 sm:px-5 sm:py-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="font-mono text-xs sm:text-sm font-bold text-ink-900">
                  {definition.name}
                </p>
                <p className="text-[11px] sm:text-xs text-ink-500">
                  {definition.variables.length} variable
                  {definition.variables.length === 1 ? '' : 's'}:{' '}
                  {definition.variables.join(', ')}
                </p>
              </div>
              <dl className="mt-3 space-y-2.5">
                {LOCALES.map((locale) => (
                  <div key={locale} className="flex flex-col sm:flex-row gap-1 sm:gap-3 bg-ink-50/50 p-2.5 rounded-lg">
                    <dt className="w-20 shrink-0 text-xs font-bold text-brand-700">
                      {LOCALE_NAMES[locale]}
                    </dt>
                    <dd
                      className={cn(
                        'min-w-0 flex-1 whitespace-pre-wrap text-xs sm:text-sm leading-relaxed text-ink-800',
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

/**
 * The not-connected state.
 */
function NotConnected() {
  return (
    <div className="space-y-4 p-4 sm:p-5">
      <p className="text-xs sm:text-sm leading-relaxed text-ink-600">
        Connect WhatsApp so patients can book appointments by message and receive
        their token, queue position and reminders automatically.
      </p>
      <ul className="space-y-2 text-xs sm:text-sm text-ink-600">
        <Step n={1}>You ask for setup here.</Step>
        <Step n={2}>
          We arrange the WhatsApp Business number, the verification and the message
          approvals. Nothing is needed from you.
        </Step>
        <Step n={3}>
          You approve the sender name your patients will see, and we switch it on.
        </Step>
      </ul>
      <p className="text-xs text-ink-500">
        Typically takes a few working days. We will call you when the sender name
        needs approving.
      </p>
      <form action={requestWhatsAppSetup}>
        <Button type="submit" variant="primary" className="w-full sm:w-auto justify-center">
          Connect WhatsApp
        </Button>
      </form>
    </div>
  );
}

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-ink-100 text-xs font-semibold text-ink-700">
        {n}
      </span>
      <span className="min-w-0 flex-1">{children}</span>
    </li>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-baseline gap-1 sm:gap-4 p-3.5 sm:px-5 sm:py-3">
      <dt className="text-xs sm:text-sm font-semibold text-ink-500 sm:w-40 shrink-0">{label}</dt>
      <dd className="min-w-0 flex-1 text-xs sm:text-sm text-ink-900 font-medium">{children}</dd>
    </div>
  );
}

/** Says what the status means for patients, not what the enum is called. */
function NumberStatusText({ status }: { status: string | null }) {
  switch (status) {
    case 'registered':
      return <span className="text-emerald-700">Live — sending and receiving</span>;
    case 'pending':
      return <span className="text-sky-700">Registration in progress with Meta</span>;
    case 'flagged':
      return (
        <span className="text-amber-800">
          Flagged by Meta for message quality — still sending
        </span>
      );
    case 'suspended':
      return <span className="text-rose-700">Suspended by Meta — not sending</span>;
    case 'released':
      return <span className="text-ink-600">Disconnected — not sending</span>;
    default:
      return <span className="text-ink-500">Not assigned yet</span>;
  }
}

/**
 * Renders an outcome. Error codes are matched against the known category list
 * rather than printed, so a crafted query string cannot put arbitrary text on
 * the page.
 */
function Notices({ params }: { params: Record<string, string | string[] | undefined> }) {
  const error = typeof params.error === 'string' ? params.error : null;

  const known = INTEGRATION_ERROR_CODES.find((code) => code === error);

  return (
    <>
      {params.requested ? (
        <Alert tone="warn">
          Setup requested. We will be in touch — nothing further is needed from you
          right now.
        </Alert>
      ) : null}
      {params.validated ? <Alert tone="warn">Connection checked.</Alert> : null}
      {params.saved ? <Alert tone="warn">Saved.</Alert> : null}
      {params.sent ? <Alert tone="warn">Test message sent.</Alert> : null}
      {params.disconnected ? (
        <Alert tone="warn">
          WhatsApp disconnected. Patients will no longer receive messages.
        </Alert>
      ) : null}

      {known ? (
        <Alert tone="error">{integrationErrorMessage(known as IntegrationErrorCode)}</Alert>
      ) : null}
      {error === 'PHONE' ? (
        <Alert tone="error">Enter a valid 10-digit Indian mobile number.</Alert>
      ) : null}
      {error === 'CONFIRM' ? (
        <Alert tone="error">
          Type DISCONNECT exactly to confirm. Nothing has been changed.
        </Alert>
      ) : null}
      {error === 'SEND' ? (
        <Alert tone="error">
          The test message could not be sent. Check the connection, then try again.
        </Alert>
      ) : null}
    </>
  );
}
