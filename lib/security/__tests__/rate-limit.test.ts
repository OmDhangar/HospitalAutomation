import { beforeEach, describe, expect, it } from 'vitest';
import { consumeToken, resetRateLimits, VALIDATION_LIMIT } from '../rate-limit';

beforeEach(resetRateLimits);

describe('consumeToken', () => {
  it('allows a burst up to capacity, then refuses', () => {
    const args = { key: 'h1', capacity: 3, windowMs: 60_000 };

    expect(consumeToken(args).allowed).toBe(true);
    expect(consumeToken(args).allowed).toBe(true);
    expect(consumeToken(args).allowed).toBe(true);

    const refused = consumeToken(args);
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('keys are independent, so one hospital cannot throttle another', () => {
    const shared = { capacity: 1, windowMs: 60_000 };
    expect(consumeToken({ key: 'hospital-a', ...shared }).allowed).toBe(true);
    expect(consumeToken({ key: 'hospital-a', ...shared }).allowed).toBe(false);
    expect(consumeToken({ key: 'hospital-b', ...shared }).allowed).toBe(true);
  });

  it('refills over time rather than resetting on a window boundary', async () => {
    // A 40ms window refills a 2-capacity bucket at one token per 20ms, so a
    // short wait buys exactly one more attempt.
    const args = { key: 'refill', capacity: 2, windowMs: 40 };
    expect(consumeToken(args).allowed).toBe(true);
    expect(consumeToken(args).allowed).toBe(true);
    expect(consumeToken(args).allowed).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 45));
    expect(consumeToken(args).allowed).toBe(true);
  });

  it('never reports a retry hint below one second', () => {
    const args = { key: 'hint', capacity: 1, windowMs: 1000 };
    consumeToken(args);
    expect(consumeToken(args).retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });
});

describe('the validation limit', () => {
  it('lets a real setup session through without ever being noticed', () => {
    // Connect, look, check again, fix something, check again: the shape of a
    // genuine onboarding call. It must not hit the limit.
    for (let i = 0; i < VALIDATION_LIMIT.capacity; i += 1) {
      expect(consumeToken({ key: 'real', ...VALIDATION_LIMIT }).allowed).toBe(true);
    }
  });

  it('stops a held-down button', () => {
    for (let i = 0; i < VALIDATION_LIMIT.capacity; i += 1) {
      consumeToken({ key: 'script', ...VALIDATION_LIMIT });
    }
    expect(consumeToken({ key: 'script', ...VALIDATION_LIMIT }).allowed).toBe(false);
  });
});
