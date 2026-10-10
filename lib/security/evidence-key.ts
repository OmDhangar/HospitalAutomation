import { createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';
import { keyIdOf } from '@/lib/domain/evidence';

/**
 * The evidence key (IPD sheets plan §7.6): an Ed25519 key that signs each
 * hourly digest, so a digest cannot be rewritten by someone who can write to
 * the database but does not hold the key.
 *
 *   EVIDENCE_SIGNING_KEY   the private key, PKCS#8 (PEM, or base64 of the DER) — on the worker only
 *   EVIDENCE_PUBLIC_KEY    the public key, SPKI (PEM or base64 DER) — for checking; derived from the
 *                          private key when only that is set
 *
 * `npx tsx scripts/evidence-keygen.ts` makes a pair. Until a key is set,
 * digests are still chained and anchored, only unsigned, and the
 * Accountability page says so. Moving the key into AWS KMS is part of the S0
 * stage (plan §9.2); this module is the only place that would change.
 */

function parse(raw: string, kind: 'private' | 'public'): KeyObject {
  const text = raw.trim();
  const pem = text.startsWith('-----');
  const key =
    kind === 'private'
      ? createPrivateKey(pem ? text : { key: Buffer.from(text, 'base64'), format: 'der', type: 'pkcs8' })
      : createPublicKey(pem ? text : { key: Buffer.from(text, 'base64'), format: 'der', type: 'spki' });
  if (key.asymmetricKeyType !== 'ed25519') throw new Error(`EVIDENCE_${kind === 'private' ? 'SIGNING' : 'PUBLIC'}_KEY must be an Ed25519 key`);
  return key;
}

const rawPublic = (key: KeyObject): Buffer => {
  const jwk = key.export({ format: 'jwk' }) as { x?: string };
  return Buffer.from(jwk.x ?? '', 'base64url');
};

export type EvidenceSigner = { keyId: string; sign: (digestHash: Buffer) => Buffer };

/** The signer, or null when no key is configured. A malformed key is an error, not a silent "unsigned". */
export function evidenceSigner(env: Record<string, string | undefined> = process.env): EvidenceSigner | null {
  const raw = env.EVIDENCE_SIGNING_KEY;
  if (!raw?.trim()) return null;
  const privateKey = parse(raw, 'private');
  const keyId = keyIdOf(rawPublic(createPublicKey(privateKey)));
  return { keyId, sign: (digestHash) => sign(null, digestHash, privateKey) };
}

export type EvidenceVerifier = { keyId: string; verify: (digestHash: Buffer, signature: Buffer) => boolean };

/** The checker, from the public key (or the private key's public half), or null when neither is set. */
export function evidenceVerifier(env: Record<string, string | undefined> = process.env): EvidenceVerifier | null {
  const publicRaw = env.EVIDENCE_PUBLIC_KEY?.trim();
  const privateRaw = env.EVIDENCE_SIGNING_KEY?.trim();
  if (!publicRaw && !privateRaw) return null;
  const publicKey = publicRaw ? parse(publicRaw, 'public') : createPublicKey(parse(privateRaw!, 'private'));
  return {
    keyId: keyIdOf(rawPublic(publicKey)),
    verify: (digestHash, signature) => {
      try {
        return verify(null, digestHash, publicKey, signature);
      } catch {
        return false;
      }
    },
  };
}
