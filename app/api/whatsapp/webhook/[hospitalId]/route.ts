import { eq } from 'drizzle-orm';
import { after, NextResponse } from 'next/server';
import { getAdminDb } from '@/lib/db/admin';
import { notificationOutbox } from '@/lib/db/schema';
import { getProvider } from '@/lib/notify/provider';
import { parseWebhook, verifyWebhookSignature } from '@/lib/notify/webhook';
import { handleInboundMessage } from '@/lib/services/booking';
import {
  resolveAppSecret,
  resolveVerifyToken,
  verifyTokenMatches,
} from '@/lib/services/whatsapp-byo';

/**
 * The callback URL for a hospital that runs its own Meta App.
 *
 * The hospital id is in the path because Meta gives us nothing else to route
 * on. The subscription handshake carries only `hub.verify_token`, and a
 * payload's signature can only be checked once you already know which app
 * secret to check it against — so a single shared URL cannot serve two Meta
 * Apps. Platform-owned numbers keep using the shared route at
 * /api/whatsapp/webhook, which reads the environment.
 *
 * The id in the URL is an identifier, not a credential. It grants nothing: the
 * handshake still has to echo a token only that hospital's app knows, and every
 * payload still has to carry a signature computed with their app secret.
 */
export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Meta's subscription handshake: echo the challenge, but only for this hospital's token. */
export async function GET(request: Request, ctx: RouteContext<'/api/whatsapp/webhook/[hospitalId]'>) {
  const { hospitalId } = await ctx.params;
  if (!UUID_RE.test(hospitalId)) return new NextResponse('forbidden', { status: 403 });

  const url = new URL(request.url);
  if (url.searchParams.get('hub.mode') !== 'subscribe') {
    return new NextResponse('forbidden', { status: 403 });
  }

  /**
   * One 403 for every failure — unknown hospital, platform-owned, no token
   * stored, wrong token. Distinguishing them would let anyone with the URL
   * enumerate which hospitals run their own app.
   */
  const expected = await resolveVerifyToken(hospitalId);
  if (!verifyTokenMatches(url.searchParams.get('hub.verify_token'), expected)) {
    return new NextResponse('forbidden', { status: 403 });
  }

  return new NextResponse(url.searchParams.get('hub.challenge') ?? '', { status: 200 });
}

export async function POST(request: Request, ctx: RouteContext<'/api/whatsapp/webhook/[hospitalId]'>) {
  const { hospitalId } = await ctx.params;
  if (!UUID_RE.test(hospitalId)) return new NextResponse('forbidden', { status: 403 });

  // Read as text, not json: the signature covers the raw bytes, and
  // re-serialising a parsed object produces a different string.
  const rawBody = await request.text();

  const appSecret = await resolveAppSecret(hospitalId);
  if (!appSecret) return new NextResponse('forbidden', { status: 403 });

  const signed = verifyWebhookSignature({
    rawBody,
    header: request.headers.get('x-hub-signature-256'),
    appSecret,
  });
  if (!signed) return new NextResponse('invalid signature', { status: 401 });

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new NextResponse('bad request', { status: 400 });
  }

  const { messages, statuses } = parseWebhook(payload);
  const provider = getProvider();

  // Answer Meta immediately; do the work after. A slow handler is retried,
  // and a retried booking conversation is a confused patient.
  after(async () => {
    for (const message of messages) {
      try {
        await provider.sendReadAndTypingIndicator({
          phoneNumberId: message.phoneNumberId,
          messageId: message.messageId,
          toPhoneE164: message.fromPhone,
        });
      } catch (error) {
        console.error('failed to send typing indicator', message.messageId, error);
      }
    }

    for (const message of messages) {
      try {
        /**
         * Routed by phone_number_id through `resolve_whatsapp_number`, exactly
         * as the shared route does — not by the hospital id in the URL. The
         * signature proves the payload came from this hospital's app; it does
         * not prove the sender number belongs to them, and trusting the path
         * over the number would let a misconfigured app write into the wrong
         * tenant's queue.
         */
        await handleInboundMessage(message);
      } catch (error) {
        // One bad message must not abandon the rest of the batch.
        console.error('whatsapp inbound failed', message.messageId, error);
      }
    }

    for (const status of statuses) {
      if (status.status !== 'delivered' && status.status !== 'read') continue;
      try {
        await getAdminDb()
          .update(notificationOutbox)
          .set({ deliveredAt: new Date() })
          .where(eq(notificationOutbox.providerMessageId, status.providerMessageId));
      } catch (error) {
        console.error('whatsapp status update failed', status.providerMessageId, error);
      }
    }
  });

  return NextResponse.json({ received: true });
}
