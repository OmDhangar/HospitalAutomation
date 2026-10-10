import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { leafHash } from '@/lib/domain/evidence';
import { evidenceSigner, evidenceVerifier } from '../evidence-key';

const pair = () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateB64: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
    publicPem: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
  };
};

describe('the evidence key', () => {
  it('is optional: no key, no signer', () => {
    expect(evidenceSigner({})).toBeNull();
    expect(evidenceVerifier({})).toBeNull();
  });

  it('signs a digest that the public key alone can check, under the same key id', () => {
    const keys = pair();
    const signer = evidenceSigner({ EVIDENCE_SIGNING_KEY: keys.privateB64 })!;
    const verifier = evidenceVerifier({ EVIDENCE_PUBLIC_KEY: keys.publicPem })!;
    const digest = leafHash('digest');
    const signature = signer.sign(digest);
    expect(signature).toHaveLength(64);
    expect(verifier.keyId).toBe(signer.keyId);
    expect(signer.keyId).toMatch(/^[0-9a-f]{16}$/);
    expect(verifier.verify(digest, signature)).toBe(true);
    expect(verifier.verify(leafHash('other'), signature)).toBe(false);
  });

  it('refuses another key’s signature and a key that is not Ed25519', () => {
    const signer = evidenceSigner({ EVIDENCE_SIGNING_KEY: pair().privateB64 })!;
    const stranger = evidenceVerifier({ EVIDENCE_PUBLIC_KEY: pair().publicPem })!;
    const digest = leafHash('digest');
    expect(stranger.verify(digest, signer.sign(digest))).toBe(false);

    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const ec = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
    expect(() => evidenceSigner({ EVIDENCE_SIGNING_KEY: ec })).toThrow(/Ed25519/);
  });
});
