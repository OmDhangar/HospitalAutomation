import { NextResponse } from 'next/server';
import {
  eventName,
  parsePaymentLinkEvent,
  verifyWebhookSignature,
} from '@/lib/payments/razorpay';
import { settlePayment } from '@/lib/services/payments';

export const dynamic = 'force-dynamic';

/**
 * Razorpay's confirmation that money actually moved.
 *
 * This is the only path that extends a subscription. The redirect the customer
 * follows after paying is just a URL anyone can visit, so it grants nothing —
 * it only prompts a reconciliation check. Everything that has consequences
 * happens here, behind a verified signature.
 */

/** Events that mean a renewal has been paid for. */
const PAID_EVENTS = new Set(['payment_link.paid', 'payment_link.partially_paid']);

export async function POST(request: Request) {
  // Read as text, not json: the signature covers the raw bytes, and
  // re-serialising a parsed object produces a different string.
  const rawBody = await request.text();

  const signed = verifyWebhookSignature({
    rawBody,
    signature: request.headers.get('x-razorpay-signature'),
    secret: process.env.RAZORPAY_WEBHOOK_SECRET,
  });

  if (!signed) {
    // Deliberately terse. Telling an unverified caller whether the secret is
    // missing or merely wrong is free reconnaissance.
    console.warn('[payments:webhook] rejected an unsigned or mis-signed request');
    return new NextResponse('invalid signature', { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new NextResponse('bad request', { status: 400 });
  }

  const event = eventName(payload);

  /**
   * Anything not about a paid link is acknowledged and ignored.
   *
   * A 2xx is the correct answer to an event we do not act on: Razorpay retries
   * non-2xx responses, so returning an error for an event type we simply do
   * not handle would create an endless redelivery loop over nothing.
   */
  if (!event || !PAID_EVENTS.has(event)) {
    return NextResponse.json({ received: true, handled: false });
  }

  const parsed = parsePaymentLinkEvent(payload);

  try {
    const result = await settlePayment({
      referenceId: parsed.referenceId,
      providerPaymentId: parsed.paymentId,
      providerLinkId: parsed.paymentLinkId,
      amountPaise: parsed.amountPaise,
    });

    if (result.outcome === 'unknown_reference') {
      // Still a 2xx. A reference we cannot place will not become placeable on
      // the fourth retry, and a payment landing here at all is worth a human
      // looking at rather than a retry storm burying it.
      console.error(
        '[payments:webhook] unplaceable payment',
        JSON.stringify({
          event,
          reference_id: parsed.referenceId,
          provider_link_id: parsed.paymentLinkId,
        }),
      );
      return NextResponse.json({ received: true, handled: false });
    }

    return NextResponse.json({ received: true, outcome: result.outcome });
  } catch (error) {
    /**
     * A 500 here is deliberate and is the one case worth retrying: the
     * signature was valid and the money is real, so the alternative to
     * Razorpay trying again is a hospital that paid and never got its plan
     * extended. settlePayment is idempotent, so a retry is safe.
     */
    console.error('[payments:webhook] settlement failed', {
      event,
      reference_id: parsed.referenceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return new NextResponse('settlement failed', { status: 500 });
  }
}
