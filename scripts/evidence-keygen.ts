import { generateKeyPairSync } from 'node:crypto';
import { evidenceSigner } from '@/lib/security/evidence-key';

/**
 * Makes an evidence signing key pair (Ed25519) and prints both halves for the
 * environment. The private half belongs on the worker only (EVIDENCE_SIGNING_KEY);
 * the public half goes wherever seals are checked (EVIDENCE_PUBLIC_KEY), and a
 * copy should be kept off the server with the owner, so a check can be run
 * even if the server is not trusted.
 *
 *   npx tsx scripts/evidence-keygen.ts
 */
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const privateB64 = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
const publicB64 = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
const keyId = evidenceSigner({ EVIDENCE_SIGNING_KEY: privateB64 })!.keyId;

console.log(`# Evidence key ${keyId} — made ${new Date().toISOString()}`);
console.log(`EVIDENCE_SIGNING_KEY=${privateB64}`);
console.log(`EVIDENCE_PUBLIC_KEY=${publicB64}`);
