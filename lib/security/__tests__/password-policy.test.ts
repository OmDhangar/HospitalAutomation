import { describe, expect, it, vi } from 'vitest';

// throttle.ts imports next/headers, which only exists inside a request.
vi.mock('next/headers', () => ({ headers: async () => new Headers() }));

import {
  hashPassword,
  MIN_PASSWORD_LENGTH,
  passwordProblem,
  RETIRED_DEFAULT_PASSWORDS,
  unguessablePassword,
  verifyPassword,
} from '../password';
import { ipFromHeaders, ipRules } from '../throttle';

describe('password policy', () => {
  it('refuses the passwords that used to be handed out by default', () => {
    expect(passwordProblem('Staff@123')).not.toBeNull();
    expect(passwordProblem('Hospital@123')).not.toBeNull();
  });

  it('refuses anything shorter than the minimum', () => {
    expect(passwordProblem('a'.repeat(MIN_PASSWORD_LENGTH - 1))).toBe('too_short');
    expect(passwordProblem('a'.repeat(MIN_PASSWORD_LENGTH))).toBeNull();
  });

  /**
   * Both retired defaults are under ten characters, so the length rule alone
   * already refuses them. The explicit list is there so that raising the
   * minimum, or a future default, cannot quietly let one back in.
   */
  it('names a retired default as such even if it were long enough', () => {
    for (const retired of RETIRED_DEFAULT_PASSWORDS) {
      expect(passwordProblem(retired)).not.toBeNull();
    }
  });

  it('gives unrelated accounts unrelated unguessable passwords', async () => {
    const a = unguessablePassword();
    const b = unguessablePassword();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(32);
    expect(passwordProblem(a)).toBeNull();

    const hash = await hashPassword(a);
    expect(await verifyPassword(a, hash)).toBe(true);
    for (const retired of RETIRED_DEFAULT_PASSWORDS) {
      expect(await verifyPassword(retired, hash)).toBe(false);
    }
  });
});

describe('client IP for throttling', () => {
  const from = (headers: Record<string, string>) =>
    ipFromHeaders((name) => headers[name] ?? null);

  it('prefers the address the proxy saw on the socket', () => {
    expect(from({ 'x-real-ip': '203.0.113.7', 'x-forwarded-for': '1.1.1.1' })).toBe('203.0.113.7');
  });

  /**
   * The first x-forwarded-for entry is whatever the client sent. Trusting it
   * would let a script claim a new "IP" on every request and never be counted.
   */
  it('takes the entry our proxy appended, not one the client supplied', () => {
    expect(from({ 'x-forwarded-for': '6.6.6.6, 203.0.113.7' })).toBe('203.0.113.7');
  });

  it('reports an unknown IP when no proxy header is present', () => {
    expect(from({})).toBe('unknown');
  });

  /**
   * A per-IP rule keyed on "unknown" would be one bucket shared by every
   * visitor, so thirty failures from anyone would lock everyone out.
   */
  it('applies no per-IP rule when the IP is unknown', () => {
    const rule = { prefix: 'login:ip', limit: 30, windowMs: 60_000 };
    expect(ipRules('unknown', rule)).toEqual([]);
    expect(ipRules('203.0.113.7', rule)).toEqual([
      { key: 'login:ip:203.0.113.7', limit: 30, windowMs: 60_000 },
    ]);
  });
});
