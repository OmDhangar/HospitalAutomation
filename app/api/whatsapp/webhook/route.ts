import { createHmac, timingSafeEqual } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { getAdminDb } from '@/lib/db/admin';
import { notificationOutbox } from '@/lib/db/schema';
import { handleInboundMessage } from '@/lib/services/booking';

export const dynamic = 'force-dynamic';

/**
 * Meta's subscription handshake. It echoes a challenge back, but only when the
 * verify token matches the one configured for this app.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const mode = url.searchParams.get('hub.mode');
  const token = url.searchParams.get('hub.verify_token');
  const challenge = url.searchParams.get('hub.challenge');

  const expected = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;
  if (mode === 'subscribe' && expected && token === expected) {
    return new NextResponse(challenge ?? '', { status: 200 });
  }
  return new NextResponse('forbidden', { status: 403 });
}

/**
 * Verifies Meta's HMAC over the *raw* body.
 *
 * The raw bytes matter: re-serialising the parsed JSON would produce a
 * different string and a signature that never matches. Comparison is
 * constant-time so the check cannot be probed byte by byte.
 */
function verifySignature(rawBody: string, header: string | null): boolean {
  const appSecret = process.env.WHATSAPP_APP_SECRET;

  // Without a configured secret there is nothing to verify against. Refuse
  // rather than accept, so a missing environment variable cannot silently turn
  // this into an open endpoint.
  if (!appSecret || !header) return false;

  const expected = `sha256=${createHmac('sha256', appSecret).update(rawBody).digest('hex')}`;
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

type WebhookValue = {
  metadata?: { phone_number_id?: string };
  messages?: Array<{
    id: string;
    from: string;
    type: string;
    text?: { body?: string };
    interactive?: {
      list_reply?: { id?: string };
      button_reply?: { id?: string };
    };
  }>;
  statuses?: Array<{ id: string; status: string; timestamp?: string }>;
};

export async function POST(request: Request) {
  const rawBody = await request.text();

  if (!verifySignature(rawBody, request.headers.get('x-hub-signature-256'))) {
    return new NextResponse('invalid signature', { status: 401 });
  }

  let parsed: { entry?: Array<{ changes?: Array<{ value?: WebhookValue }> }> };
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return new NextResponse('bad request', { status: 400 });
  }

  for (const entry of parsed.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value;
      if (!value) continue;

      const phoneNumberId = value.metadata?.phone_number_id;

      for (const message of value.messages ?? []) {
        if (!phoneNumberId) continue;
        await handleInboundMessage({
          phoneNumberId,
          messageId: message.id,
          fromPhone: message.from,
          text: message.text?.body,
          replyId:
            message.interactive?.list_reply?.id ?? message.interactive?.button_reply?.id,
        });
      }

      // Delivery receipts. Reconciling these is what lets us tell "we sent it"
      // apart from "it arrived", which matters when a hospital asks why a
      // patient never saw their token.
      for (const status of value.statuses ?? []) {
        if (status.status !== 'delivered' && status.status !== 'read') continue;
        await getAdminDb()
          .update(notificationOutbox)
          .set({ deliveredAt: new Date() })
          .where(eq(notificationOutbox.providerMessageId, status.id));
      }
    }
  }

  // Always 200 once the signature is valid: Meta retries non-2xx aggressively,
  // and a downstream error should not become a redelivery storm.
  return NextResponse.json({ received: true });
}
