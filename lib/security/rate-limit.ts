/**
 * A small in-process rate limiter, for operations that cost money or provider
 * goodwill rather than merely CPU.
 *
 * Deliberately not Redis. The one thing being protected here is the Graph API
 * validation call: an authenticated owner holding down "Validate" should not be
 * able to generate unbounded traffic against Meta, because Meta's rate limits
 * apply across the whole business portfolio and one impatient hospital would
 * slow sending for every other one. Introducing a second datastore to stop that
 * would cost far more than the problem.
 *
 * The honest limitation: this counts per process, so N server instances allow
 * roughly N times the configured rate. That is acceptable for its purpose — it
 * converts "unbounded" into "small multiple of a small number" — and it is not
 * acceptable for anything where the exact count matters, such as billing or
 * authentication throttling. Use the database for those.
 */

type Bucket = { tokens: number; lastRefill: number };

const buckets = new Map<string, Bucket>();

/** Stops a long-lived process accumulating a bucket per hospital forever. */
const MAX_BUCKETS = 10_000;

export type RateLimitResult = {
  allowed: boolean;
  /** Seconds until at least one more attempt is permitted. */
  retryAfterSeconds: number;
};

/**
 * Token bucket: `capacity` attempts available, refilling over `windowMs`.
 *
 * A bucket rather than a fixed window so that normal use — connect, look at the
 * result, validate once more — never trips the limit, while a held-down button
 * stops after the burst is spent.
 */
export function consumeToken(args: {
  key: string;
  capacity: number;
  windowMs: number;
}): RateLimitResult {
  const now = Date.now();
  const refillPerMs = args.capacity / args.windowMs;

  if (buckets.size > MAX_BUCKETS) sweep(now, args.windowMs);

  const existing = buckets.get(args.key);
  const bucket: Bucket = existing ?? { tokens: args.capacity, lastRefill: now };

  if (existing) {
    const elapsed = now - existing.lastRefill;
    bucket.tokens = Math.min(args.capacity, existing.tokens + elapsed * refillPerMs);
    bucket.lastRefill = now;
  }

  if (bucket.tokens < 1) {
    buckets.set(args.key, bucket);
    const msUntilOne = (1 - bucket.tokens) / refillPerMs;
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil(msUntilOne / 1000)),
    };
  }

  bucket.tokens -= 1;
  buckets.set(args.key, bucket);
  return { allowed: true, retryAfterSeconds: 0 };
}

/** Drops buckets that have sat full long enough to be indistinguishable from new. */
function sweep(now: number, windowMs: number) {
  for (const [key, bucket] of buckets) {
    if (now - bucket.lastRefill > windowMs * 2) buckets.delete(key);
  }
}

/** Test seam. */
export function resetRateLimits() {
  buckets.clear();
}

/**
 * Validation against Meta: six attempts, refilling over ten minutes.
 *
 * Enough that an owner working through a genuine setup problem never notices
 * it, and few enough that a script does.
 */
export const VALIDATION_LIMIT = { capacity: 6, windowMs: 10 * 60 * 1000 };
