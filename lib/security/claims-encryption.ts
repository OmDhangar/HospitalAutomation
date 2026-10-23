import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from 'node:crypto';

/**
 * Dedicated field-level encryption and blind indexing for insurance identifiers
 * (policy numbers, member IDs).
 *
 * Compliance: DPDP Act 2023, HIPAA, IRDAI Guidelines.
 *
 * Algorithm: AES-256-GCM with 96-bit (12-byte) random IV and 128-bit (16-byte) auth tag.
 * Security Binding: Binds ciphertext cryptographically to claim_cases.id via
 * Authenticated Additional Data (AAD). A ciphertext copied from one patient or claim
 * to another fails authentication immediately.
 *
 * Keying: Uses CLAIMS_ENCRYPTION_KEY exclusively. Fails closed if missing.
 */

export class ClaimsKeyConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClaimsKeyConfigurationError';
  }
}

export class ClaimsDecryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClaimsDecryptionError';
  }
}

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;

export type EncryptedIdentifier = {
  ciphertext: string;
  iv: string;
  tag: string;
  keyVersion: number;
  masked: string;
  blindIndex: string;
};

/**
 * Resolves the 32-byte key buffer for the given version.
 * Fails closed if the key is missing or not 32 bytes (64 hex characters or 32 raw bytes).
 */
function getKeyForVersion(version: number = 1): Buffer {
  const envVarName = version === 1 ? 'CLAIMS_ENCRYPTION_KEY' : `CLAIMS_ENCRYPTION_KEY_V${version}`;
  const rawKey = process.env[envVarName];

  if (!rawKey) {
    throw new ClaimsKeyConfigurationError(
      `No claims encryption key configured in environment for version ${version} (${envVarName})`
    );
  }

  // Support 64-char hex string or 32-char raw string
  if (rawKey.length === 64 && /^[0-9a-fA-F]+$/.test(rawKey)) {
    return Buffer.from(rawKey, 'hex');
  }

  const buf = Buffer.from(rawKey, 'utf8');
  if (buf.length === 32) {
    return buf;
  }

  throw new ClaimsKeyConfigurationError(
    `Claims encryption key ${envVarName} must be exactly 32 bytes (or 64 hex characters), received ${buf.length} bytes`
  );
}

/**
 * Derives a deterministic keyed HMAC-SHA256 blind index for exact search matching.
 * Normalizes input (uppercase, trimmed) so case differences match reliably.
 */
export function computeClaimBlindIndex(raw: string): string {
  const salt = process.env.CLAIMS_BLIND_INDEX_SALT || 'claims_default_blind_index_salt_fixed';
  const normalized = (raw ?? '').trim().toUpperCase();
  return createHmac('sha256', salt).update(normalized).digest('hex');
}

/**
 * Generates a safe masked representation (last 4 characters only).
 */
export function maskClaimIdentifier(raw: string): string {
  const cleaned = (raw ?? '').trim();
  if (!cleaned) return '••••';
  const suffix = cleaned.slice(-4);
  return `•••• ${suffix}`;
}

/**
 * Encrypts a sensitive insurance identifier with AES-256-GCM and binds it to claimId via AAD.
 */
export function encryptClaimIdentifier(raw: string, claimId: string): EncryptedIdentifier {
  if (!claimId) {
    throw new Error('claimId is required as Authenticated Additional Data (AAD) for claims encryption');
  }

  const keyVersion = 1;
  const key = getKeyForVersion(keyVersion);
  const iv = randomBytes(IV_BYTES);

  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(Buffer.from(claimId, 'utf8'));

  let ciphertext = cipher.update(raw, 'utf8', 'hex');
  ciphertext += cipher.final('hex');

  const tag = cipher.getAuthTag().toString('hex');

  return {
    ciphertext,
    iv: iv.toString('hex'),
    tag,
    keyVersion,
    masked: maskClaimIdentifier(raw),
    blindIndex: computeClaimBlindIndex(raw),
  };
}

/**
 * Decrypts an encrypted insurance identifier, verifying the AAD claimId and auth tag.
 * Throws ClaimsDecryptionError on tamper, transplant, or invalid key.
 */
export function decryptClaimIdentifier(
  encrypted: { ciphertext: string; iv: string; tag: string; keyVersion: number },
  claimId: string
): string {
  if (!claimId) {
    throw new Error('claimId is required as Authenticated Additional Data (AAD) for claims decryption');
  }

  try {
    const key = getKeyForVersion(encrypted.keyVersion);
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(encrypted.iv, 'hex'));

    decipher.setAAD(Buffer.from(claimId, 'utf8'));
    decipher.setAuthTag(Buffer.from(encrypted.tag, 'hex'));

    let decrypted = decipher.update(encrypted.ciphertext, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
  } catch (err: any) {
    if (err instanceof ClaimsKeyConfigurationError) {
      throw err;
    }
    throw new ClaimsDecryptionError(
      `Failed to decrypt claim identifier: authentication failed or data corrupted (${err.message})`
    );
  }
}
