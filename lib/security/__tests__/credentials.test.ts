import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  canOpenCredential,
  credentialsMatch,
  CredentialKeyError,
  CredentialSealError,
  currentKeyVersion,
  generateEncryptionKey,
  hasEncryptionKey,
  openCredential,
  sealCredential,
} from '../credentials';

const KEY_V1 = generateEncryptionKey();
const KEY_V2 = generateEncryptionKey();

/**
 * Keys are read from the environment on every call rather than cached, so the
 * tests can rotate them mid-suite. That is also what makes rotation possible
 * without a restart in production.
 */
const ENV_KEYS = [
  'WHATSAPP_ENCRYPTION_KEY',
  'WHATSAPP_ENCRYPTION_KEY_V2',
  'WHATSAPP_ENCRYPTION_KEY_V3',
];

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.WHATSAPP_ENCRYPTION_KEY = KEY_V1;
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('sealCredential / openCredential', () => {
  it('round-trips a token', () => {
    const token = 'EAAG' + 'x'.repeat(180);
    const sealed = sealCredential(token);
    expect(openCredential(sealed)).toBe(token);
  });

  it('never stores the plaintext in any part of the sealed value', () => {
    const token = 'EAAGsecrettoken12345';
    const sealed = sealCredential(token);

    const serialized = JSON.stringify(sealed);
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain('secrettoken');
    // Base64 of the plaintext would also be a leak.
    expect(serialized).not.toContain(Buffer.from(token).toString('base64'));
  });

  it('uses a fresh nonce every time, so the same token seals differently', () => {
    const token = 'EAAGrepeated';
    const a = sealCredential(token);
    const b = sealCredential(token);

    // A reused nonce under one key is the failure that breaks GCM outright.
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(openCredential(a)).toBe(token);
    expect(openCredential(b)).toBe(token);
  });

  it('refuses to seal an empty credential', () => {
    expect(() => sealCredential('')).toThrow(CredentialSealError);
  });

  it('rejects a key that is not 32 bytes', () => {
    process.env.WHATSAPP_ENCRYPTION_KEY = Buffer.from('too short').toString('base64');
    expect(() => sealCredential('token')).toThrow(CredentialKeyError);
  });

  it('reports a missing key rather than sealing with a default', () => {
    delete process.env.WHATSAPP_ENCRYPTION_KEY;
    expect(hasEncryptionKey()).toBe(false);
    expect(() => currentKeyVersion()).toThrow(CredentialKeyError);
  });
});

describe('tamper detection', () => {
  it('fails to open when the ciphertext is altered', () => {
    const sealed = sealCredential('EAAGoriginal');
    const bytes = Buffer.from(sealed.ciphertext, 'base64');
    bytes[0] ^= 0xff;

    expect(() =>
      openCredential({ ...sealed, ciphertext: bytes.toString('base64') }),
    ).toThrow(CredentialSealError);
  });

  it('fails to open when the auth tag is altered', () => {
    const sealed = sealCredential('EAAGoriginal');
    const tag = Buffer.from(sealed.authTag, 'base64');
    tag[0] ^= 0xff;

    expect(() => openCredential({ ...sealed, authTag: tag.toString('base64') })).toThrow(
      CredentialSealError,
    );
  });

  it('fails to open under a different key', () => {
    const sealed = sealCredential('EAAGoriginal');
    process.env.WHATSAPP_ENCRYPTION_KEY = KEY_V2;

    expect(canOpenCredential(sealed)).toBe(false);
  });
});

describe('key rotation', () => {
  it('seals with the highest configured version', () => {
    expect(sealCredential('a').keyVersion).toBe(1);

    process.env.WHATSAPP_ENCRYPTION_KEY_V2 = KEY_V2;
    expect(currentKeyVersion()).toBe(2);
    expect(sealCredential('a').keyVersion).toBe(2);
  });

  it('opens an old row with the old key after a new key is added', () => {
    const token = 'EAAGsealed-under-v1';
    const old = sealCredential(token);
    expect(old.keyVersion).toBe(1);

    // Operator adds v2. v1 rows must keep working until they are re-sealed.
    process.env.WHATSAPP_ENCRYPTION_KEY_V2 = KEY_V2;

    expect(openCredential(old)).toBe(token);
    expect(sealCredential(token).keyVersion).toBe(2);
  });

  it('reports a retired key as unreadable instead of failing silently', () => {
    process.env.WHATSAPP_ENCRYPTION_KEY_V2 = KEY_V2;
    const sealed = sealCredential('token');
    expect(sealed.keyVersion).toBe(2);

    delete process.env.WHATSAPP_ENCRYPTION_KEY_V2;
    expect(canOpenCredential(sealed)).toBe(false);
  });
});

describe('credentialsMatch', () => {
  it('matches equal values and rejects different ones', () => {
    expect(credentialsMatch('abc123', 'abc123')).toBe(true);
    expect(credentialsMatch('abc123', 'abc124')).toBe(false);
  });

  it('rejects values of different length without throwing', () => {
    expect(credentialsMatch('short', 'much longer value')).toBe(false);
  });
});
