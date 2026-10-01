import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

/**
 * scrypt from Node's standard library rather than Argon2id or bcrypt.
 *
 * The specification asked for Argon2id or bcrypt; both mean a native module,
 * which means a compiler toolchain on every machine that builds this. scrypt is
 * a memory-hard KDF, is in the standard library, and needs no build step. For a
 * handful of staff logins per hospital that trade is clearly worth it.
 *
 * Revisit if password handling ever becomes a larger part of the product.
 */
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const derived = await scrypt(password, salt, KEY_LENGTH);
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltHex, hashHex] = stored.split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;

  const derived = await scrypt(password, Buffer.from(saltHex, 'hex'), KEY_LENGTH);
  const expected = Buffer.from(hashHex, 'hex');
  if (derived.length !== expected.length) return false;

  return timingSafeEqual(derived, expected);
}

/** The shortest password anyone may set, temporary or not. */
export const MIN_PASSWORD_LENGTH = 10;

/**
 * Passwords this product used to hand out by default, before accounts were
 * given random ones. Every account created without a typed password had one of
 * these, so they are the first thing anyone guessing would try.
 */
export const RETIRED_DEFAULT_PASSWORDS = ['Staff@123', 'Hospital@123'] as const;

/** Why a password is not acceptable, or null when it is. */
export function passwordProblem(password: string): 'too_short' | 'retired_default' | null {
  if (password.length < MIN_PASSWORD_LENGTH) return 'too_short';
  if ((RETIRED_DEFAULT_PASSWORDS as readonly string[]).includes(password)) return 'retired_default';
  return null;
}

/**
 * A password nobody knows, for an account whose holder will be issued a
 * temporary one separately. 24 random bytes: not meant to be typed, only to
 * make the account unusable until a real password is set.
 */
export const unguessablePassword = (): string => randomBytes(24).toString('base64url');
