import { Button, Card, CardHeader, EmptyState, Field, Input, cn } from '@/components/ui';
import type { BindingView } from '@/lib/services/whatsapp-byo';
import { DefinitionRow } from '../../ui';
import { bindWabaAction } from './actions';

/**
 * The hospital's WhatsApp binding, and the form that establishes or rotates it.
 *
 * The callback URL is the part that matters operationally. Under hospital
 * ownership each WABA sits behind its own Meta App, so each needs its own
 * webhook endpoint — Meta's subscription handshake carries no tenant identity,
 * and a payload's signature can only be checked once you know whose app secret
 * to check it with. This is the URL to paste into that hospital's app.
 */
export function WhatsAppCard({
  hospitalId,
  binding,
  number,
}: {
  hospitalId: string;
  binding: BindingView | null;
  number: {
    phoneNumberId: string;
    displayPhoneNumber: string | null;
    verifiedName: string | null;
    status: string;
    qualityRating: string | null;
  } | null;
}) {
  /**
   * Read on the server so a missing PUBLIC_BASE_URL is visible here rather
   * than producing a plausible-looking localhost URL that silently never
   * receives anything in production.
   */
  const base = process.env.PUBLIC_BASE_URL?.replace(/\/$/, '');
  const callbackUrl = base
    ? `${base}/api/whatsapp/webhook/${hospitalId}`
    : null;

  const ownsWaba = binding?.ownership === 'hospital';
  const complete = Boolean(
    binding?.hasAccessToken && binding?.hasVerifyToken && binding?.hasAppSecret,
  );

  return (
    <Card>
      <CardHeader
        title="WhatsApp"
        hint={
          ownsWaba
            ? 'Hospital’s own Meta App'
            : binding
              ? 'Platform-owned number, shared Meta App'
              : 'Not configured'
        }
      />

      {number || binding ? (
        <dl className="divide-y divide-ink-200">
          <DefinitionRow term="Number">
            {number?.displayPhoneNumber ?? binding?.phoneNumberId ?? '—'}
          </DefinitionRow>
          <DefinitionRow term="Patients see">
            {number?.verifiedName ?? binding?.verifiedName ?? '—'}
          </DefinitionRow>
          <DefinitionRow term="WABA ID">
            <span className="numeric text-xs">{binding?.wabaId ?? '—'}</span>
          </DefinitionRow>
          <DefinitionRow term="Status">
            <span className="capitalize">{number?.status ?? binding?.status ?? '—'}</span>
          </DefinitionRow>
          {number?.qualityRating ? (
            <DefinitionRow term="Quality">{number.qualityRating}</DefinitionRow>
          ) : null}
          {ownsWaba ? (
            <DefinitionRow term="Secrets held">
              <span className="flex flex-wrap justify-end gap-1">
                {[
                  ['Token', binding?.hasAccessToken],
                  ['Verify', binding?.hasVerifyToken],
                  ['Secret', binding?.hasAppSecret],
                ].map(([label, held]) => (
                  <span
                    key={String(label)}
                    className={cn(
                      'rounded px-1.5 py-0.5 text-xs font-medium',
                      held
                        ? 'bg-emerald-50 text-emerald-800'
                        : 'bg-rose-50 text-rose-800',
                    )}
                  >
                    {String(label)}
                  </span>
                ))}
              </span>
            </DefinitionRow>
          ) : null}
        </dl>
      ) : (
        <EmptyState
          title="No WhatsApp yet"
          hint="Bind the hospital’s own account below, or assign a shared number from the WhatsApp tab."
        />
      )}

      {/* The callback URL — only meaningful under hospital ownership. */}
      {ownsWaba ? (
        <div className="border-t border-ink-200 bg-brand-50/40 px-5 py-3">
          <p className="text-xs font-medium uppercase tracking-wide text-ink-500">
            Callback URL for this hospital
          </p>
          {callbackUrl ? (
            <p className="numeric mt-1 select-all break-all text-xs text-ink-900">
              {callbackUrl}
            </p>
          ) : (
            <p className="mt-1 text-xs text-rose-700">
              PUBLIC_BASE_URL is not set on this server, so the callback URL cannot be
              shown. Set it and reload — guessing it is how a webhook ends up pointed at
              localhost in production.
            </p>
          )}
          <p className="mt-1.5 text-xs leading-relaxed text-ink-500">
            Paste this into their Meta App under WhatsApp → Configuration → Webhook, with
            the verify token below. It is specific to this hospital: the id in the path is
            how the webhook knows whose app secret to check the signature against.
          </p>
          {complete ? null : (
            <p className="mt-1.5 text-xs font-medium text-rose-700">
              One or more secrets are missing — inbound messages will be rejected until
              all three are stored.
            </p>
          )}
        </div>
      ) : null}

      <form action={bindWabaAction} className="space-y-3 border-t border-ink-200 p-4">
        <input type="hidden" name="hospitalId" value={hospitalId} />
        <p className="text-xs font-medium text-ink-700">
          {ownsWaba ? 'Rotate credentials' : 'Bind the hospital’s own WABA'}
        </p>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Phone number ID">
            <Input
              name="phoneNumberId"
              required
              defaultValue={binding?.phoneNumberId ?? ''}
              placeholder="123456789012345"
              className="py-2 text-sm"
            />
          </Field>
          <Field label="WABA ID">
            <Input
              name="wabaId"
              required
              defaultValue={binding?.wabaId ?? ''}
              placeholder="987654321098765"
              className="py-2 text-sm"
            />
          </Field>
        </div>

        <Field label="Access token" hint="System User token — sealed, never shown again">
          <Input
            name="accessToken"
            type="password"
            autoComplete="off"
            required
            placeholder="EAA…"
            className="py-2 text-sm"
          />
        </Field>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Verify token">
            <Input
              name="verifyToken"
              type="password"
              autoComplete="off"
              required
              className="py-2 text-sm"
            />
          </Field>
          <Field label="App secret">
            <Input
              name="appSecret"
              type="password"
              autoComplete="off"
              required
              className="py-2 text-sm"
            />
          </Field>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Display number" hint="Optional">
            <Input
              name="displayPhoneNumber"
              defaultValue={binding?.displayPhoneNumber ?? ''}
              className="py-2 text-sm"
            />
          </Field>
          <Field label="Verified name" hint="Optional">
            <Input
              name="verifiedName"
              defaultValue={binding?.verifiedName ?? ''}
              className="py-2 text-sm"
            />
          </Field>
        </div>

        <Button type="submit" variant="primary" size="sm">
          {ownsWaba ? 'Rotate and save' : 'Bind account'}
        </Button>
        <p className="text-xs leading-relaxed text-ink-500">
          The three secrets are sealed with AES-256-GCM before storage and are never
          returned to this page — which is why they must be re-entered in full to rotate
          any one of them.
        </p>
      </form>
    </Card>
  );
}
