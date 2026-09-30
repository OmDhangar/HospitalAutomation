import { describe, expect, it } from 'vitest';
import { cleanProfileName, MAX_PROFILE_NAME_LENGTH } from '@/lib/domain/booking';
import { parseWebhook } from '../webhook';

/**
 * The bug these cover: `parseWebhook` never read `contacts[].profile.name`, so
 * the sender's WhatsApp name was discarded at the parse boundary and every
 * booking from a first-time patient landed on the "WhatsApp patient"
 * placeholder.
 */

const envelope = (value: Record<string, unknown>) => ({
  object: 'whatsapp_business_account',
  entry: [{ id: 'WABA', changes: [{ field: 'messages', value }] }],
});

const message = (from: string, id = 'wamid.TEST') => ({
  id,
  from,
  type: 'text',
  text: { body: 'hello' },
});

describe('parseWebhook — profile name', () => {
  it('captures the sender name Meta sends beside the message', () => {
    const { messages } = parseWebhook(
      envelope({
        metadata: { phone_number_id: '123' },
        contacts: [{ wa_id: '918767556966', profile: { name: 'Anita Deshmukh' } }],
        messages: [message('918767556966')],
      }),
    );

    expect(messages).toHaveLength(1);
    expect(messages[0].profileName).toBe('Anita Deshmukh');
  });

  /**
   * The correlation that matters. Nothing in Meta's contract says the two
   * arrays are ordered together, and attaching one patient's name to another
   * patient's booking is a bug that reaches a consulting room.
   */
  it('matches the contact by wa_id, not by position', () => {
    const { messages } = parseWebhook(
      envelope({
        metadata: { phone_number_id: '123' },
        contacts: [
          { wa_id: '910000000001', profile: { name: 'Wrong Person' } },
          { wa_id: '918767556966', profile: { name: 'Right Person' } },
        ],
        messages: [message('918767556966')],
      }),
    );

    expect(messages[0].profileName).toBe('Right Person');
  });

  it('falls back to the only contact when wa_id does not line up', () => {
    const { messages } = parseWebhook(
      envelope({
        metadata: { phone_number_id: '123' },
        contacts: [{ wa_id: '+91 87675 56966', profile: { name: 'Anita' } }],
        messages: [message('918767556966')],
      }),
    );

    expect(messages[0].profileName).toBe('Anita');
  });

  /** With several contacts and no match there is no safe guess. */
  it('reports no name rather than guessing among several contacts', () => {
    const { messages } = parseWebhook(
      envelope({
        metadata: { phone_number_id: '123' },
        contacts: [
          { wa_id: '910000000001', profile: { name: 'A' } },
          { wa_id: '910000000002', profile: { name: 'B' } },
        ],
        messages: [message('918767556966')],
      }),
    );

    expect(messages[0].profileName).toBeUndefined();
  });

  it('still parses a payload with no contacts at all', () => {
    const { messages } = parseWebhook(
      envelope({
        metadata: { phone_number_id: '123' },
        messages: [message('918767556966')],
      }),
    );

    expect(messages).toHaveLength(1);
    expect(messages[0].profileName).toBeUndefined();
  });

  it('carries the name through an interactive reply too', () => {
    const { messages } = parseWebhook(
      envelope({
        metadata: { phone_number_id: '123' },
        contacts: [{ wa_id: '918767556966', profile: { name: 'Anita' } }],
        messages: [
          {
            id: 'wamid.X',
            from: '918767556966',
            type: 'interactive',
            interactive: { list_reply: { id: 'doctor:abc' } },
          },
        ],
      }),
    );

    expect(messages[0].replyId).toBe('doctor:abc');
    expect(messages[0].profileName).toBe('Anita');
  });
});

describe('cleanProfileName', () => {
  it('keeps an ordinary name unchanged', () => {
    expect(cleanProfileName('Anita Deshmukh')).toBe('Anita Deshmukh');
  });

  it('keeps Devanagari names intact', () => {
    expect(cleanProfileName('अनिता देशमुख')).toBe('अनिता देशमुख');
  });

  it('collapses whitespace and trims', () => {
    expect(cleanProfileName('  Anita   Deshmukh \n')).toBe('Anita Deshmukh');
  });

  it('returns null for nothing at all', () => {
    expect(cleanProfileName(undefined)).toBeNull();
    expect(cleanProfileName(null)).toBeNull();
    expect(cleanProfileName('')).toBeNull();
    expect(cleanProfileName('   ')).toBeNull();
  });

  /**
   * Null, not a placeholder: the caller has a fallback chain, and returning
   * "WhatsApp patient" from here would make an absent name indistinguishable
   * from a patient who really is called that.
   */
  it('returns null for a name of pure symbols', () => {
    expect(cleanProfileName('★★★')).toBeNull();
    expect(cleanProfileName('...')).toBeNull();
  });

  it('keeps a name that merely contains an emoji', () => {
    const cleaned = cleanProfileName('Anita 🌸');
    expect(cleaned).toContain('Anita');
  });

  /**
   * Digits survive on purpose: "Anita 2" is what people write to tell apart
   * family members sharing one handset, and it is the only distinguishing mark
   * reception has.
   */
  it('keeps digits in a name', () => {
    expect(cleanProfileName('Anita 2')).toBe('Anita 2');
  });

  it('strips zero-width and bidi characters', () => {
    const sneaky = `Anita​‮Deshmukh`;
    const cleaned = cleanProfileName(sneaky)!;
    expect(cleaned).not.toMatch(/[\p{C}]/u);
    expect(cleaned).toBe('Anita Deshmukh');
  });

  it('caps a very long name', () => {
    const long = 'A'.repeat(200);
    expect(cleanProfileName(long)!.length).toBe(MAX_PROFILE_NAME_LENGTH);
  });
});
