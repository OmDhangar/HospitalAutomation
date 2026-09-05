import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseWebhook, verifyChallenge, verifyWebhookSignature } from '../webhook';

const SECRET = 'test-app-secret';
const sign = (body: string, secret = SECRET) =>
  `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

describe('webhook signature', () => {
  const body = JSON.stringify({ entry: [{ changes: [] }] });

  it('accepts a correctly signed body', () => {
    expect(
      verifyWebhookSignature({ rawBody: body, header: sign(body), appSecret: SECRET }),
    ).toBe(true);
  });

  it('rejects a body signed with a different secret', () => {
    expect(
      verifyWebhookSignature({
        rawBody: body,
        header: sign(body, 'wrong-secret'),
        appSecret: SECRET,
      }),
    ).toBe(false);
  });

  it('rejects a tampered body', () => {
    const header = sign(body);
    const tampered = JSON.stringify({ entry: [{ changes: [{ injected: true }] }] });
    expect(
      verifyWebhookSignature({ rawBody: tampered, header, appSecret: SECRET }),
    ).toBe(false);
  });

  /**
   * The important one. A deployment missing WHATSAPP_APP_SECRET must reject
   * everything, not accept everything — otherwise a forgotten environment
   * variable turns this into an open endpoint that anyone can post bookings to.
   */
  it('rejects everything when no app secret is configured', () => {
    expect(
      verifyWebhookSignature({ rawBody: body, header: sign(body), appSecret: undefined }),
    ).toBe(false);
  });

  it('rejects a missing or malformed signature header', () => {
    for (const header of [null, undefined, '', 'sha256=', 'garbage']) {
      expect(verifyWebhookSignature({ rawBody: body, header, appSecret: SECRET })).toBe(
        false,
      );
    }
  });

  it('is not confused by a signature of the wrong length', () => {
    // timingSafeEqual throws on length mismatch; we must handle it, not crash.
    expect(
      verifyWebhookSignature({ rawBody: body, header: 'sha256=ab', appSecret: SECRET }),
    ).toBe(false);
  });
});

describe('challenge handshake', () => {
  it('accepts a subscribe with the right token', () => {
    expect(verifyChallenge({ mode: 'subscribe', token: 'tok', expected: 'tok' })).toBe(true);
  });

  it('rejects a wrong token, wrong mode, or unset expectation', () => {
    expect(verifyChallenge({ mode: 'subscribe', token: 'no', expected: 'tok' })).toBe(false);
    expect(verifyChallenge({ mode: 'unsubscribe', token: 'tok', expected: 'tok' })).toBe(
      false,
    );
    expect(verifyChallenge({ mode: 'subscribe', token: 'tok', expected: undefined })).toBe(
      false,
    );
  });
});

describe('webhook parsing', () => {
  const envelope = (value: unknown) => ({ entry: [{ changes: [{ value }] }] });

  it('extracts a plain text message', () => {
    const parsed = parseWebhook(
      envelope({
        metadata: { phone_number_id: 'pn-1' },
        messages: [{ id: 'wamid.1', from: '919876543210', type: 'text', text: { body: 'Hi' } }],
      }),
    );

    expect(parsed.messages).toEqual([
      {
        phoneNumberId: 'pn-1',
        messageId: 'wamid.1',
        fromPhone: '919876543210',
        text: 'Hi',
        replyId: undefined,
      },
    ]);
  });

  it('extracts a list reply, which is how every booking choice arrives', () => {
    const parsed = parseWebhook(
      envelope({
        metadata: { phone_number_id: 'pn-1' },
        messages: [
          {
            id: 'wamid.2',
            from: '919876543210',
            type: 'interactive',
            interactive: { list_reply: { id: 'doc:abc' } },
          },
        ],
      }),
    );

    expect(parsed.messages[0].replyId).toBe('doc:abc');
  });

  it('extracts button replies too', () => {
    const parsed = parseWebhook(
      envelope({
        metadata: { phone_number_id: 'pn-1' },
        messages: [
          {
            id: 'wamid.3',
            from: '919876543210',
            interactive: { button_reply: { id: 'slot:now' } },
          },
        ],
      }),
    );

    expect(parsed.messages[0].replyId).toBe('slot:now');
  });

  it('extracts delivery statuses', () => {
    const parsed = parseWebhook(
      envelope({ statuses: [{ id: 'wamid.out', status: 'delivered' }] }),
    );
    expect(parsed.statuses).toEqual([
      { providerMessageId: 'wamid.out', status: 'delivered' },
    ]);
  });

  it('skips messages missing an id or a sender rather than throwing', () => {
    const parsed = parseWebhook(
      envelope({
        metadata: { phone_number_id: 'pn-1' },
        messages: [
          { from: '919876543210', text: { body: 'no id' } },
          { id: 'wamid.4', text: { body: 'no sender' } },
        ],
      }),
    );
    expect(parsed.messages).toHaveLength(0);
  });

  it('skips a message with no phone number id to attribute it to', () => {
    const parsed = parseWebhook(
      envelope({ messages: [{ id: 'wamid.5', from: '919876543210' }] }),
    );
    expect(parsed.messages).toHaveLength(0);
  });

  /**
   * Meta adds event types over time. An unexpected shape must not throw: a
   * thrown parse error becomes an HTTP error, and Meta answers HTTP errors with
   * redelivery.
   */
  it('survives junk without throwing', () => {
    for (const junk of [null, undefined, {}, { entry: null }, { entry: [{}] }, 'nonsense', 42]) {
      expect(() => parseWebhook(junk)).not.toThrow();
      expect(parseWebhook(junk)).toEqual({ messages: [], statuses: [] });
    }
  });

  it('handles several changes in one delivery', () => {
    const parsed = parseWebhook({
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: 'pn-1' },
                messages: [{ id: 'a', from: '919876543210' }],
              },
            },
            { value: { statuses: [{ id: 'b', status: 'read' }] } },
          ],
        },
      ],
    });

    expect(parsed.messages).toHaveLength(1);
    expect(parsed.statuses).toHaveLength(1);
  });
});
