import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/**
 * Authenticated encryption for provider credentials at rest.
 *
 * Server-only. Nothing here may be imported from a client component, and the
 * plaintext must never leave the function that needed it — not into a log line,
 * an audit row, an error message or a React prop.
 *
 * AES-256-GCM rather than CBC or a hand-rolled scheme: GCM authenticates the
 * ciphertext, so a token tampered with in the database fails to decrypt instead
 * of decrypting into something attacker-chosen. No custom cryptography appears
 * in this file, and none should be added to it.
 *
 * Under platform ownership nothing calls this: there is one Meta credential,
 * it lives in the environment, and no per-hospital secret exists to seal. It
 * is written and tested now because the alternative — reaching for it the week
 * a hospital-owned customer signs, under time pressure — is how key handling
 * gets done badly.
 */

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
/** 96 bits is the nonce size GCM is designed around. */
const IV_BYTES = 12;

export type SealedCredential = {
  ciphertext: string;
  iv: string;
  authTag: string;
  keyVersion: number;
};

/**
 * Keys come from the environment, never the database — a key stored beside the
 * thing it protects protects nothing.
 *
 * Version 1 reads `WHATSAPP_ENCRYPTION_KEY`; later versions read
 * `WHATSAPP_ENCRYPTION_KEY_V2`, `_V3` and so on. Sealing always uses the
 * highest version present, opening uses whichever version the row records. That
 * is the whole of key rotation: add a key, re-seal in the background, retire
 * the old variable once no row references it.
 */
function keyForVersion(version: number): Buffer {
  const raw =
    version === 1
      ? process.env.WHATSAPP_ENCRYPTION_KEY
      : process.env[`WHATSAPP_ENCRYPTION_KEY_V${version}`];

  if (!raw) {
    throw new CredentialKeyError(
      `No encryption key configured for version ${version}`,
    );
  }

  const key = Buffer.from(raw, 'base64');
  if (key.length !== KEY_BYTES) {
    // Checked rather than padded or hashed into shape. A short key is a
    // configuration mistake, and silently stretching it would hide the fact
    // that the data is protected by less entropy than it appears to be.
    throw new CredentialKeyError(
      `WHATSAPP_ENCRYPTION_KEY${version === 1 ? '' : `_V${version}`} must be ` +
        `${KEY_BYTES} bytes of base64 (got ${key.length})`,
    );
  }

  return key;
}

/** Highest configured key version. */
export function currentKeyVersion(): number {
  let version = process.env.WHATSAPP_ENCRYPTION_KEY ? 1 : 0;
  // Bounded rather than unbounded: a rotation past double digits means
  // something else has gone wrong.
  for (let candidate = 2; candidate <= 16; candidate += 1) {
    if (process.env[`WHATSAPP_ENCRYPTION_KEY_V${candidate}`]) version = candidate;
  }
  if (version === 0) {
    throw new CredentialKeyError('WHATSAPP_ENCRYPTION_KEY is not set');
  }
  return version;
}

export function hasEncryptionKey(): boolean {
  try {
    currentKeyVersion();
    return true;
  } catch {
    return false;
  }
}

/**
 * A configuration failure, distinct from a decryption failure.
 *
 * Worth separating: a missing key is an operator problem fixed by a deploy, a
 * failed authentication tag is a data problem that a deploy will not fix.
 */
export class CredentialKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CredentialKeyError';
  }
}

export class CredentialSealError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CredentialSealError';
  }
}

/**
 * Encrypts a credential for storage.
 *
 * A fresh random nonce per call, never derived and never reused: GCM's security
 * collapses entirely if one nonce is used twice under the same key, and that is
 * the single easiest way to get this wrong.
 */
export function sealCredential(plaintext: string): SealedCredential {
  if (!plaintext) throw new CredentialSealError('Refusing to seal an empty credential');

  const keyVersion = currentKeyVersion();
  const key = keyForVersion(keyVersion);
  const iv = randomBytes(IV_BYTES);

  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);

  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    keyVersion,
  };
}

/**
 * Decrypts a credential. Call this as late as possible and hold the result as
 * briefly as possible — ideally inside the function making the API request.
 *
 * Throws rather than returning null on a bad tag. A caller that forgets to
 * check a null gets a token-shaped empty string into an Authorization header;
 * a caller that ignores an exception does not exist.
 */
export function openCredential(sealed: SealedCredential): string {
  const key = keyForVersion(sealed.keyVersion);

  try {
    const decipher = createDecipheriv(
      ALGORITHM,
      key,
      Buffer.from(sealed.iv, 'base64'),
    );
    decipher.setAuthTag(Buffer.from(sealed.authTag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(sealed.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    // The underlying message is swallowed deliberately: it varies with the
    // failure mode and that variation is itself an oracle.
    throw new CredentialSealError('Credential could not be decrypted');
  }
}

/**
 * Whether a stored credential is still readable with the keys this process has.
 *
 * Used by health checks so a key retired too early shows up as a red status on
 * an operator's dashboard rather than as a failed patient notification.
 */
export function canOpenCredential(sealed: SealedCredential): boolean {
  try {
    openCredential(sealed);
    return true;
  } catch {
    return false;
  }
}

/**
 * Constant-time comparison, for the rare case where a credential must be
 * checked against a known value rather than used.
 */
export function credentialsMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Generates a key suitable for the variables above. For operators:
 *
 *   node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
 */
export function generateEncryptionKey(): string {
  return randomBytes(KEY_BYTES).toString('base64');
}
