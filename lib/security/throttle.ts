import { and, eq, gt, inArray, sql } from 'drizzle-orm';
import { headers } from 'next/headers';
import { getDb } from '@/lib/db';
import { rateLimitEvents } from '@/lib/db/schema';
import { hashToken } from './tokens';

/**
 * Database-backed throttling, for the endpoints where the exact count matters:
 * password guessing on sign-in, and message-spending bookings on the public
 * booking form.
 *
 * `rate-limit.ts` is the in-process limiter, and says itself that it is not
 * fit for authentication — on N instances it allows N times the rate. This one
 * counts in Postgres, so the limit is the limit however many servers answer.
 *
 * Keys are hashed before storage, so the table never holds a readable email,
 * phone number or IP address.
 */

export type ThrottleRule = {
  /** Namespaced key, e.g. `login:email:a@b.com`. Hashed before it is stored. */
  key: string;
  /** Events allowed inside the window before further attempts are refused. */
  limit: number;
  windowMs: number;
};

const hashKey = (key: string) => hashToken(`throttle:${key}`);

/** True when any rule has already used up its allowance. Records nothing. */
export async function isThrottled(rules: ThrottleRule[], now: Date = new Date()): Promise<boolean> {
  for (const rule of rules) {
    const [row] = await getDb()
      .select({ count: sql<number>`count(*)::int` })
      .from(rateLimitEvents)
      .where(
        and(
          eq(rateLimitEvents.keyHash, hashKey(rule.key)),
          gt(rateLimitEvents.createdAt, new Date(now.getTime() - rule.windowMs)),
        ),
      );
    if ((row?.count ?? 0) >= rule.limit) return true;
  }
  return false;
}

/** Counts one event against every given key. */
export async function recordEvent(keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  await getDb()
    .insert(rateLimitEvents)
    .values(keys.map((key) => ({ keyHash: hashKey(key) })));
}

/** Forgets a key's events, e.g. an email's failed sign-ins once one succeeds. */
export async function clearEvents(keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  await getDb()
    .delete(rateLimitEvents)
    .where(inArray(rateLimitEvents.keyHash, keys.map(hashKey)));
}

/**
 * Checks the rules and, if none is exhausted, counts this event against all of
 * them. Returns false when the caller should refuse.
 *
 * Not atomic: two requests arriving together can both pass at limit - 1. That
 * lets a burst exceed the limit by the number of concurrent requests, which is
 * small, and is a fair price for not serialising every sign-in on one lock.
 */
export async function consumeThrottle(rules: ThrottleRule[], now: Date = new Date()): Promise<boolean> {
  if (await isThrottled(rules, now)) return false;
  await recordEvent(rules.map((rule) => rule.key));
  return true;
}

/**
 * The client's IP, as our own proxy reported it.
 *
 * Production sits behind nginx (or Vercel), which is the only thing that can
 * reach the app — the container binds to 127.0.0.1. `x-real-ip` is set by the
 * proxy from the socket address. Failing that, the LAST `x-forwarded-for`
 * entry is the one our proxy appended; earlier entries are whatever the client
 * chose to send, and trusting the first one would let an attacker pick a fresh
 * "IP" per request.
 */
export async function clientIp(): Promise<string> {
  const h = await headers();
  return ipFromHeaders((name) => h.get(name));
}

/**
 * Rules keyed on the client IP, or none when the IP is unknown.
 *
 * Without a proxy header every request would share the key "unknown", and a
 * per-IP limit would become a global one: thirty failed sign-ins from anyone
 * would lock every user out. Better to fall back to the per-account and
 * per-phone limits alone than to hand out a one-request denial of service.
 */
export function ipRules(ip: string, rule: Omit<ThrottleRule, 'key'> & { prefix: string }): ThrottleRule[] {
  if (ip === 'unknown') return [];
  return [{ key: `${rule.prefix}:${ip}`, limit: rule.limit, windowMs: rule.windowMs }];
}

/** The parsing behind clientIp, separate so it can be tested without a request. */
export function ipFromHeaders(get: (name: string) => string | null): string {
  const real = get('x-real-ip')?.trim();
  if (real) return real;
  const forwarded = get('x-forwarded-for');
  if (forwarded) {
    const parts = forwarded.split(',').map((p) => p.trim()).filter(Boolean);
    if (parts.length > 0) return parts[parts.length - 1];
  }
  return 'unknown';
}
