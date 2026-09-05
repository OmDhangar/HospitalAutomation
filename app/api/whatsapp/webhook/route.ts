import { eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { getAdminDb } from '@/lib/db/admin';
import { notificationOutbox } from '@/lib/db/schema';
import {
  parseWebhook,
  verifyChallenge,
  verifyWebhookSignature,
} from '@/lib/notify/webhook';
import { handleInboundMessage } from '@/lib/services/booking';

export const dynamic = 'force-dynamic';

/** Meta's subscription handshake: echo the challenge, but only if the token matches. */
export async function GET(request: Request) {
  const url = new URL(request.url);

  const ok = verifyChallenge({
    mode: url.searchParams.get('hub.mode'),
    token: url.searchParams.get('hub.verify_token'),
    expected: process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN,
  });

  if (!ok) return new NextResponse('forbidden', { status: 403 });
  return new NextResponse(url.searchParams.get('hub.challenge') ?? '', { status: 200 });
}

export async function POST(request: Request) {
  // Read as text, not json: the signature covers the raw bytes, and
  // re-serialising a parsed object produces a different string.
  const rawBody = await request.text();

  const signed = verifyWebhookSignature({
    rawBody,
    header: request.headers.get('x-hub-signature-256'),
    appSecret: process.env.WHATSAPP_APP_SECRET,
  });
  if (!signed) return new NextResponse('invalid signature', { status: 401 });

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new NextResponse('bad request', { status: 400 });
  }

  const { messages, statuses } = parseWebhook(payload);

  for (const message of messages) {
    try {
      await handleInboundMessage(message);
    } catch (error) {
      // One bad message must not abandon the rest of the batch, nor turn into a
      // non-2xx that makes Meta redeliver everything.
      console.error('whatsapp inbound failed', message.messageId, error);
    }
  }

  // Reconciling delivery receipts is what separates "we sent it" from "it
  // arrived" — the distinction a hospital asks about when a patient says they
  // never got their token.
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

  // Always 200 once the signature is valid. Meta retries non-2xx aggressively,
  // so a downstream error must not become a redelivery storm.
  return NextResponse.json({ received: true });
}
