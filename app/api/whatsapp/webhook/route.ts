import { eq, sql } from 'drizzle-orm';
import { after, NextResponse } from 'next/server';
import { getAdminDb } from '@/lib/db/admin';
import { notificationOutbox } from '@/lib/db/schema';
import {
  handleNoticeInboundOptOut,
  processNoticeDeliveryStatus,
} from '@/lib/notify/notice-worker';
import { getProvider } from '@/lib/notify/provider';
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
  const provider = getProvider();

  // Phase 1: Return 200 OK instantly.
  // Phase 2: Process typing indicators and inbound messages asynchronously via after()
  after(async () => {
    // 1. Immediately trigger read status & typing indicator for incoming messages
    for (const message of messages) {
      try {
        await provider.sendReadAndTypingIndicator({
          phoneNumberId: message.phoneNumberId,
          messageId: message.messageId,
          toPhoneE164: message.fromPhone,
        });
      } catch (err) {
        console.error('failed to send typing indicator', message.messageId, err);
      }
    }

    // 2. Process inbound conversation logic & notice opt-out checks
    for (const message of messages) {
      try {
        const [res] = await getAdminDb().execute<{ hospital_id: string | null }>(
          sql`select public.resolve_whatsapp_number(${message.phoneNumberId}) as hospital_id`,
        );
        if (res?.hospital_id) {
          await handleNoticeInboundOptOut({
            hospitalId: res.hospital_id,
            fromPhone: message.fromPhone,
            text: message.text,
          });
        }
      } catch (err) {
        console.error('failed notice opt-out check', message.messageId, err);
      }

      try {
        await handleInboundMessage(message);
      } catch (error) {
        // One bad message must not abandon the rest of the batch
        console.error('whatsapp inbound failed', message.messageId, error);
      }
    }

    // 3. Reconcile delivery receipts
    for (const status of statuses) {
      try {
        await processNoticeDeliveryStatus({
          providerMessageId: status.providerMessageId,
          status: status.status,
        });
      } catch (err) {
        console.error('notice delivery status update failed', status.providerMessageId, err);
      }

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
