import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verifies Meta's HMAC over the raw request body.
 *
 * Two things here are load-bearing:
 *
 * The signature is computed over the *raw bytes*. Re-serialising parsed JSON
 * produces a different string and a signature that never matches, so the route
 * must read the body as text and pass it through untouched.
 *
 * A missing app secret returns false rather than true. A deployment that forgot
 * the environment variable should reject every webhook, not accept every
 * webhook — the failure has to be loud and safe, not silent and open.
 */
export function verifyWebhookSignature(args: {
  rawBody: string;
  header: string | null | undefined;
  appSecret: string | undefined;
}): boolean {
  if (!args.appSecret || !args.header) return false;

  const expected = `sha256=${createHmac('sha256', args.appSecret)
    .update(args.rawBody)
    .digest('hex')}`;

  const received = Buffer.from(args.header);
  const computed = Buffer.from(expected);

  // Length check first: timingSafeEqual throws on a mismatch, and comparing
  // lengths leaks nothing an attacker cannot already see.
  if (received.length !== computed.length) return false;
  return timingSafeEqual(received, computed);
}

export type InboundEvent = {
  phoneNumberId: string;
  messageId: string;
  fromPhone: string;
  text?: string;
  replyId?: string;
};

export type StatusEvent = {
  providerMessageId: string;
  status: string;
};

export type ParsedWebhook = {
  messages: InboundEvent[];
  statuses: StatusEvent[];
};

type RawValue = {
  metadata?: { phone_number_id?: string };
  messages?: Array<{
    id?: string;
    from?: string;
    type?: string;
    text?: { body?: string };
    interactive?: {
      list_reply?: { id?: string };
      button_reply?: { id?: string };
    };
  }>;
  statuses?: Array<{ id?: string; status?: string }>;
};

/**
 * Flattens Meta's deeply nested envelope into the two things we act on.
 *
 * Tolerant by design: webhook payloads carry event types we do not handle and
 * will grow more over time. Anything unrecognised is skipped rather than
 * throwing, because a parse error here becomes an HTTP error, and an HTTP error
 * becomes a redelivery storm.
 */
export function parseWebhook(payload: unknown): ParsedWebhook {
  const result: ParsedWebhook = { messages: [], statuses: [] };

  const entries = (payload as { entry?: Array<{ changes?: Array<{ value?: RawValue }> }> })
    ?.entry;
  if (!Array.isArray(entries)) return result;

  for (const entry of entries) {
    for (const change of entry?.changes ?? []) {
      const value = change?.value;
      if (!value) continue;

      const phoneNumberId = value.metadata?.phone_number_id;

      for (const message of value.messages ?? []) {
        // Without an id we cannot de-duplicate, and without a sender we cannot
        // reply. Either missing makes the event unusable.
        if (!phoneNumberId || !message.id || !message.from) continue;

        result.messages.push({
          phoneNumberId,
          messageId: message.id,
          fromPhone: message.from,
          text: message.text?.body,
          replyId:
            message.interactive?.list_reply?.id ?? message.interactive?.button_reply?.id,
        });
      }

      for (const status of value.statuses ?? []) {
        if (!status.id || !status.status) continue;
        result.statuses.push({
          providerMessageId: status.id,
          status: status.status,
        });
      }
    }
  }

  return result;
}

/** Meta's subscription handshake. */
export function verifyChallenge(args: {
  mode: string | null;
  token: string | null;
  expected: string | undefined;
}): boolean {
  return Boolean(args.expected) && args.mode === 'subscribe' && args.token === args.expected;
}
