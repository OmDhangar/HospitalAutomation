import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  encryptClaimIdentifier,
  decryptClaimIdentifier,
  computeClaimBlindIndex,
  maskClaimIdentifier,
  ClaimsKeyConfigurationError,
  ClaimsDecryptionError,
} from '../claims-encryption';

describe('Claims Cryptography & Masking Subsystem', () => {
  const TEST_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'; // 32 bytes hex
  const TEST_SALT = 'fedcba9876543210fedcba9876543210';
  const CLAIM_ID_1 = '11111111-1111-1111-1111-111111111111';
  const CLAIM_ID_2 = '22222222-2222-2222-2222-222222222222';
  const RAW_POLICY = 'STAR-POL-987654321';
  const RAW_MEMBER = 'MEMB-123456';

  const originalKey = process.env.CLAIMS_ENCRYPTION_KEY;
  const originalSalt = process.env.CLAIMS_BLIND_INDEX_SALT;

  beforeEach(() => {
    process.env.CLAIMS_ENCRYPTION_KEY = TEST_KEY;
    process.env.CLAIMS_BLIND_INDEX_SALT = TEST_SALT;
  });

  afterEach(() => {
    process.env.CLAIMS_ENCRYPTION_KEY = originalKey;
    process.env.CLAIMS_BLIND_INDEX_SALT = originalSalt;
  });

  it('fails closed when CLAIMS_ENCRYPTION_KEY is missing', () => {
    delete process.env.CLAIMS_ENCRYPTION_KEY;
    expect(() => encryptClaimIdentifier(RAW_POLICY, CLAIM_ID_1)).toThrow(ClaimsKeyConfigurationError);
  });

  it('encrypts and decrypts round-trip with correct AAD claimId', () => {
    const encrypted = encryptClaimIdentifier(RAW_POLICY, CLAIM_ID_1);
    expect(encrypted.ciphertext).toBeDefined();
    expect(encrypted.iv).toHaveLength(24); // 12 bytes hex
    expect(encrypted.tag).toHaveLength(32); // 16 bytes hex
    expect(encrypted.keyVersion).toBe(1);
    expect(encrypted.masked).toBe('•••• 4321');
    expect(encrypted.blindIndex).toHaveLength(64); // SHA-256 hex

    const decrypted = decryptClaimIdentifier(encrypted, CLAIM_ID_1);
    expect(decrypted).toBe(RAW_POLICY);
  });

  it('fails decryption cleanly when AAD claimId does not match (tampering / transplant)', () => {
    const encrypted = encryptClaimIdentifier(RAW_POLICY, CLAIM_ID_1);
    expect(() => decryptClaimIdentifier(encrypted, CLAIM_ID_2)).toThrow(ClaimsDecryptionError);
  });

  it('fails decryption cleanly when ciphertext or auth tag is corrupted', () => {
    const encrypted = encryptClaimIdentifier(RAW_POLICY, CLAIM_ID_1);
    const corrupted = {
      ...encrypted,
      ciphertext: encrypted.ciphertext.slice(0, -2) + 'aa',
    };
    expect(() => decryptClaimIdentifier(corrupted, CLAIM_ID_1)).toThrow(ClaimsDecryptionError);
  });

  it('computes deterministic HMAC-SHA256 blind index using salt', () => {
    const bidx1 = computeClaimBlindIndex(RAW_POLICY);
    const bidx2 = computeClaimBlindIndex(RAW_POLICY);
    const bidx3 = computeClaimBlindIndex('DIFFERENT-POLICY');

    expect(bidx1).toBe(bidx2);
    expect(bidx1).not.toBe(bidx3);
    expect(bidx1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('generates correct 4-character masked strings', () => {
    expect(maskClaimIdentifier('123456789')).toBe('•••• 6789');
    expect(maskClaimIdentifier('123')).toBe('•••• 123');
    expect(maskClaimIdentifier('')).toBe('••••');
    expect(maskClaimIdentifier('STAR-HLTH-99')).toBe('•••• H-99');
  });
});
