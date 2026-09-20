import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Razorpay, reduced to the three things this product needs: create a link,
 * check it, and prove a webhook really came from them.
 *
 * No SDK. The official Node package pulls in a dependency tree to wrap what is
 * two `fetch` calls and an HMAC, and its `validateWebhookSignature` takes a
 * stringified body — which is exactly the mistake this module exists to avoid
 * (see verifyWebhookSignature below).
 *
 * Nothing here logs a key, a secret or a signature.
 */

const API_ROOT = 'https://api.razorpay.com/v1';
const TIMEOUT_MS = 15_000;

export class RazorpayError extends Error {
  constructor(
    message: string,
    readonly httpStatus?: number,
    /** Razorpay's own code, for logs. Never shown to a hospital. */
    readonly providerCode?: string,
  ) {
    super(message);
    this.name = 'RazorpayError';
  }
}

export type RazorpayConfig = { keyId: string; keySecret: string };

/**
 * Reads credentials at call time rather than module load, so importing this
 * file does not require a configured gateway — the same reason `getDb()` is
 * lazy. Tests and unrelated code paths can import it freely.
 */
export function razorpayConfig(): RazorpayConfig | null {
  const keyId = process.env.RAZORPAY_KEY_ID?.trim();
  const keySecret = process.env.RAZORPAY_KEY_SECRET?.trim();
  if (!keyId || !keySecret) return null;
  return { keyId, keySecret };
}

export function isRazorpayConfigured(): boolean {
  return razorpayConfig() !== null;
}

/**
 * True when the keys are Razorpay's test keys.
 *
 * Surfaced in the UI so nobody demonstrates a "successful" renewal to a
 * customer using a card that never moved money.
 */
export function isTestMode(): boolean {
  return razorpayConfig()?.keyId.startsWith('rzp_test') ?? false;
}

async function call<T>(
  path: string,
  init: { method: 'GET' | 'POST'; body?: unknown },
): Promise<T> {
  const config = razorpayConfig();
  if (!config) throw new RazorpayError('Razorpay is not configured');

  const auth = Buffer.from(`${config.keyId}:${config.keySecret}`).toString('base64');

  let response: Response;
  try {
    response = await fetch(`${API_ROOT}${path}`, {
      method: init.method,
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/json',
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: 'no-store',
    });
  } catch (error) {
    throw new RazorpayError(
      `Razorpay unreachable: ${error instanceof Error ? error.name : 'network error'}`,
    );
  }

  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new RazorpayError(`Razorpay returned an unparseable response`, response.status);
  }

  if (!response.ok) {
    const err = (body as { error?: { description?: string; code?: string } }).error;
    throw new RazorpayError(
      `Razorpay ${init.method} ${path} failed (${response.status}): ${
        err?.description ?? 'unknown error'
      }`,
      response.status,
      err?.code,
    );
  }

  return body as T;
}

/* ------------------------------------------------------------ payment links */

export type PaymentLink = {
  id: string;
  shortUrl: string;
  status: string;
  amount: number;
  referenceId: string | null;
};

type RawPaymentLink = {
  id?: string;
  short_url?: string;
  status?: string;
  amount?: number;
  reference_id?: string | null;
};

function toPaymentLink(raw: RawPaymentLink): PaymentLink {
  if (!raw.id || !raw.short_url) {
    throw new RazorpayError('Razorpay returned a payment link with no id or url');
  }
  return {
    id: raw.id,
    shortUrl: raw.short_url,
    status: raw.status ?? 'created',
    amount: raw.amount ?? 0,
    referenceId: raw.reference_id ?? null,
  };
}

/**
 * Creates a hosted payment page.
 *
 * Chosen over Checkout deliberately. Checkout needs a script tag and a client
 * component, which would pull a server-rendered settings page into the client
 * bundle for one button. A link is a redirect: it works on any phone, can be
 * forwarded to whoever actually holds the company card, and survives the owner
 * closing the tab — which is the realistic path for a hospital purchase.
 */
export async function createPaymentLink(args: {
  amountPaise: number;
  referenceId: string;
  description: string;
  callbackUrl: string;
  expireBy: number;
  customer?: { name?: string; contact?: string; email?: string };
  notes?: Record<string, string>;
}): Promise<PaymentLink> {
  const raw = await call<RawPaymentLink>('/payment_links', {
    method: 'POST',
    body: {
      amount: args.amountPaise,
      currency: 'INR',
      // Partial payment would leave a subscription half-bought, with no
      // sensible answer for how much term that entitles them to.
      accept_partial: false,
      reference_id: args.referenceId,
      description: args.description,
      expire_by: args.expireBy,
      ...(args.customer ? { customer: args.customer } : {}),
      // Razorpay notifies the payer directly, so a lapsed plan reaches the
      // owner's phone rather than waiting for them to open the dashboard.
      notify: { sms: Boolean(args.customer?.contact), email: Boolean(args.customer?.email) },
      reminder_enable: true,
      callback_url: args.callbackUrl,
      callback_method: 'get',
      notes: args.notes ?? {},
    },
  });

  return toPaymentLink(raw);
}

/**
 * Re-reads a link's current state.
 *
 * The webhook is the primary path, but webhooks are lost, misconfigured and
 * delayed. This is what lets a hospital that has already paid recover by
 * reloading the page instead of waiting for us to notice.
 */
export async function fetchPaymentLink(linkId: string): Promise<PaymentLink> {
  return toPaymentLink(
    await call<RawPaymentLink>(`/payment_links/${encodeURIComponent(linkId)}`, {
      method: 'GET',
    }),
  );
}

/* --------------------------------------------------------------- webhooks */

/**
 * Verifies that a webhook really came from Razorpay.
 *
 * Two things are load-bearing, and both are the same trap the WhatsApp webhook
 * documents:
 *
 * The HMAC is over the *raw bytes* of the request. Parsing the JSON and
 * re-serialising it produces a different string — key order and whitespace both
 * change — and a signature that never matches. The route must read the body as
 * text and pass it through untouched.
 *
 * A missing secret returns false rather than true. A deployment that forgot the
 * environment variable must reject every webhook, not accept every webhook —
 * and for a payments endpoint, accepting unsigned requests would let anyone
 * mark any subscription paid.
 */
export function verifyWebhookSignature(args: {
  rawBody: string;
  signature: string | null | undefined;
  secret: string | undefined;
}): boolean {
  if (!args.secret || !args.signature) return false;

  const expected = createHmac('sha256', args.secret).update(args.rawBody).digest('hex');

  const received = Buffer.from(args.signature);
  const computed = Buffer.from(expected);

  // Length first: timingSafeEqual throws on a mismatch, and comparing lengths
  // leaks nothing an attacker cannot already measure.
  if (received.length !== computed.length) return false;
  return timingSafeEqual(received, computed);
}

export type PaymentLinkPaidEvent = {
  /** Our payments.id, round-tripped through reference_id. */
  referenceId: string | null;
  paymentLinkId: string | null;
  paymentId: string | null;
  amountPaise: number | null;
  status: string | null;
};

/**
 * Pulls the few fields that matter out of Razorpay's envelope.
 *
 * Tolerant by design: the payload carries entities this product does not act
 * on and will grow more over time. Anything unrecognised yields nulls rather
 * than throwing, because a parse error becomes a non-2xx, and a non-2xx
 * becomes a redelivery storm.
 */
export function parsePaymentLinkEvent(payload: unknown): PaymentLinkPaidEvent {
  const root = payload as {
    payload?: {
      payment_link?: { entity?: RawPaymentLink };
      payment?: { entity?: { id?: string; amount?: number; status?: string } };
    };
  };

  const link = root?.payload?.payment_link?.entity;
  const payment = root?.payload?.payment?.entity;

  return {
    referenceId: link?.reference_id ?? null,
    paymentLinkId: link?.id ?? null,
    paymentId: payment?.id ?? null,
    amountPaise: payment?.amount ?? link?.amount ?? null,
    status: link?.status ?? payment?.status ?? null,
  };
}

export function eventName(payload: unknown): string | null {
  return (payload as { event?: string })?.event ?? null;
}
