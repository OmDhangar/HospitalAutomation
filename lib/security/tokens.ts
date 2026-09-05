import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * The patient's queue link is their only credential, so the token has to be
 * unguessable rather than merely unique. 16 random bytes is 128 bits; base64url
 * keeps it URL-safe and short enough to survive being forwarded on WhatsApp.
 *
 * Never derive this from an appointment id, a token number, or a phone number.
 */
export const generatePublicToken = (): string => randomBytes(16).toString('base64url');

/** Session cookies are opaque; only their hash is ever stored. */
export const generateSessionToken = (): string => randomBytes(32).toString('base64url');

export const hashToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

/** Constant-time comparison, so a lookup cannot be turned into an oracle. */
export function safeEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}
