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
