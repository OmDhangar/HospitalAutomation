import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  eventName,
  isRazorpayConfigured,
  isTestMode,
  parsePaymentLinkEvent,
  razorpayConfig,
  verifyWebhookSignature,
} from '../razorpay';

const SECRET = 'whsec_test_abc123';
const sign = (body: string, secret = SECRET) =>
  createHmac('sha256', secret).update(body).digest('hex');

describe('verifyWebhookSignature', () => {
  const body = JSON.stringify({ event: 'payment_link.paid', payload: {} });

  it('accepts a correctly signed body', () => {
    expect(
      verifyWebhookSignature({ rawBody: body, signature: sign(body), secret: SECRET }),
    ).toBe(true);
  });

  it('rejects a body that was altered after signing', () => {
    const signature = sign(body);
    const tampered = body.replace('payment_link.paid', 'payment_link.expired');
    expect(
      verifyWebhookSignature({ rawBody: tampered, signature, secret: SECRET }),
    ).toBe(false);
  });

  it('rejects a signature made with a different secret', () => {
    expect(
      verifyWebhookSignature({
        rawBody: body,
        signature: sign(body, 'whsec_someone_elses'),
        secret: SECRET,
      }),
    ).toBe(false);
  });

  it('fails closed when the secret is not configured', () => {
    /**
     * The single most important case. A deployment that forgot the environment
     * variable must reject every webhook rather than accept every webhook —
     * for a payments endpoint, the alternative lets anyone mark any
     * subscription paid.
     */
    expect(
      verifyWebhookSignature({ rawBody: body, signature: sign(body), secret: undefined }),
    ).toBe(false);
    expect(
      verifyWebhookSignature({ rawBody: body, signature: sign(body), secret: '' }),
    ).toBe(false);
  });

  it('fails closed when no signature header was sent', () => {
    expect(verifyWebhookSignature({ rawBody: body, signature: null, secret: SECRET })).toBe(
      false,
    );
    expect(
      verifyWebhookSignature({ rawBody: body, signature: undefined, secret: SECRET }),
    ).toBe(false);
  });

  it('rejects a signature of the wrong length without throwing', () => {
    // timingSafeEqual throws on a length mismatch, so the length check has to
    // come first or a malformed header becomes a 500 instead of a 401.
    expect(() =>
      verifyWebhookSignature({ rawBody: body, signature: 'short', secret: SECRET }),
    ).not.toThrow();
    expect(
      verifyWebhookSignature({ rawBody: body, signature: 'short', secret: SECRET }),
    ).toBe(false);
  });

  it('is sensitive to key order, which is why the raw body must be used', () => {
    /**
     * Re-serialising parsed JSON reorders keys and drops whitespace, producing
     * a different string and a signature that never matches. This test exists
     * to make that failure loud if anyone "tidies" the route to use req.json().
     */
    const original = '{"event":"payment_link.paid","id":"evt_1"}';
    const reserialised = JSON.stringify(JSON.parse(original));
    const reordered = '{"id":"evt_1","event":"payment_link.paid"}';

    expect(
      verifyWebhookSignature({
        rawBody: reserialised,
        signature: sign(original),
        secret: SECRET,
      }),
    ).toBe(true); // identical here, by luck of key order

    expect(
      verifyWebhookSignature({
        rawBody: reordered,
        signature: sign(original),
        secret: SECRET,
      }),
    ).toBe(false); // and not here
  });
});

describe('parsePaymentLinkEvent', () => {
  const paidPayload = {
    event: 'payment_link.paid',
    payload: {
      payment_link: {
        entity: {
          id: 'plink_ExjpAUN3gVHrPJ',
          reference_id: '11111111-1111-4111-8111-111111111111',
          status: 'paid',
          amount: 235_882,
        },
      },
      payment: {
        entity: { id: 'pay_abc123', amount: 235_882, status: 'captured' },
      },
    },
  };

  it('pulls out the reference, link and payment ids', () => {
    const parsed = parsePaymentLinkEvent(paidPayload);
    expect(parsed.referenceId).toBe('11111111-1111-4111-8111-111111111111');
    expect(parsed.paymentLinkId).toBe('plink_ExjpAUN3gVHrPJ');
    expect(parsed.paymentId).toBe('pay_abc123');
    expect(parsed.amountPaise).toBe(235_882);
  });

  it('returns nulls rather than throwing on an unfamiliar shape', () => {
    // A parse error becomes a non-2xx, and a non-2xx becomes a redelivery
    // storm. Unknown payloads must degrade quietly.
    for (const payload of [{}, null, undefined, { payload: {} }, 'nonsense', 42]) {
      expect(() => parsePaymentLinkEvent(payload)).not.toThrow();
      expect(parsePaymentLinkEvent(payload).referenceId).toBeNull();
    }
  });

  it('falls back to the link amount when no payment entity is present', () => {
    const parsed = parsePaymentLinkEvent({
      payload: { payment_link: { entity: { id: 'plink_1', amount: 1000 } } },
    });
    expect(parsed.amountPaise).toBe(1000);
    expect(parsed.paymentId).toBeNull();
  });

  it('reads the event name', () => {
    expect(eventName(paidPayload)).toBe('payment_link.paid');
    expect(eventName({})).toBeNull();
    expect(eventName(null)).toBeNull();
  });
});

describe('configuration', () => {
  let savedId: string | undefined;
  let savedSecret: string | undefined;

  beforeEach(() => {
    savedId = process.env.RAZORPAY_KEY_ID;
    savedSecret = process.env.RAZORPAY_KEY_SECRET;
    delete process.env.RAZORPAY_KEY_ID;
    delete process.env.RAZORPAY_KEY_SECRET;
  });

  afterEach(() => {
    if (savedId === undefined) delete process.env.RAZORPAY_KEY_ID;
    else process.env.RAZORPAY_KEY_ID = savedId;
    if (savedSecret === undefined) delete process.env.RAZORPAY_KEY_SECRET;
    else process.env.RAZORPAY_KEY_SECRET = savedSecret;
  });

  it('reports unconfigured when either key is missing', () => {
    expect(isRazorpayConfigured()).toBe(false);

    process.env.RAZORPAY_KEY_ID = 'rzp_test_abc';
    expect(isRazorpayConfigured()).toBe(false);

    process.env.RAZORPAY_KEY_SECRET = 'secret';
    expect(isRazorpayConfigured()).toBe(true);
  });

  it('recognises test keys, so nobody demos a fake renewal', () => {
    process.env.RAZORPAY_KEY_ID = 'rzp_test_abc';
    process.env.RAZORPAY_KEY_SECRET = 'secret';
    expect(isTestMode()).toBe(true);

    process.env.RAZORPAY_KEY_ID = 'rzp_live_abc';
    expect(isTestMode()).toBe(false);
  });

  it('reads config at call time, not at import', () => {
    expect(razorpayConfig()).toBeNull();
    process.env.RAZORPAY_KEY_ID = 'rzp_test_abc';
    process.env.RAZORPAY_KEY_SECRET = 'secret';
    expect(razorpayConfig()).toEqual({ keyId: 'rzp_test_abc', keySecret: 'secret' });
  });
});
