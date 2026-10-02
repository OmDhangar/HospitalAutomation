import { describe, expect, it } from 'vitest';
import {
  MAX_PIN_FAILURES,
  PIN_LOCK_MS,
  WARD_SESSION_IDLE_MS,
  afterWrongPin,
  isLocked,
  isWardToken,
  parseDeviceCookie,
  pinProblem,
  shouldSlideWardSession,
  wardSessionMayVisit,
} from '../ward-pin';

describe('pinProblem', () => {
  it('accepts four digits that are not the obvious ones', () => {
    expect(pinProblem('4829')).toBeNull();
  });
  it('refuses the wrong length, letters, and the first PINs anyone tries', () => {
    expect(pinProblem('123')).toBe('not_four_digits');
    expect(pinProblem('12a4')).toBe('not_four_digits');
    expect(pinProblem('1234')).toBe('too_obvious');
    expect(pinProblem('0000')).toBe('too_obvious');
  });
});

describe('afterWrongPin', () => {
  const now = new Date('2026-10-20T10:00:00Z');
  it('counts up, then locks for fifteen minutes on the fifth miss', () => {
    let state = { failedCount: 0, lockedUntil: null as Date | null };
    for (let i = 1; i < MAX_PIN_FAILURES; i += 1) {
      state = afterWrongPin(state.failedCount, now);
      expect(state).toEqual({ failedCount: i, lockedUntil: null });
    }
    state = afterWrongPin(state.failedCount, now);
    expect(state.lockedUntil?.getTime()).toBe(now.getTime() + PIN_LOCK_MS);
    expect(isLocked(state.lockedUntil, now)).toBe(true);
    expect(isLocked(state.lockedUntil, new Date(now.getTime() + PIN_LOCK_MS + 1))).toBe(false);
  });
});

describe('shouldSlideWardSession', () => {
  const now = new Date('2026-10-20T10:00:00Z');
  it('renews a session that has been idle a while, not one just renewed', () => {
    expect(shouldSlideWardSession(new Date(now.getTime() + WARD_SESSION_IDLE_MS), now)).toBe(false);
    expect(shouldSlideWardSession(new Date(now.getTime() + 5 * 60_000), now)).toBe(true);
  });
});

describe('ward session containment', () => {
  it('recognises PIN session tokens by prefix', () => {
    expect(isWardToken('w_abc')).toBe(true);
    expect(isWardToken('abc')).toBe(false);
    expect(isWardToken(undefined)).toBe(false);
  });
  it('lets a PIN session reach the ward and nothing else', () => {
    for (const path of ['/ipd/ward', '/ipd/ward/x/bed/y', '/api/ipd/care-entries', '/api/ipd/care-entries/undo', '/api/ipd/items/search', '/ward-device']) {
      expect(wardSessionMayVisit(path)).toBe(true);
    }
    for (const path of ['/dashboard', '/ipd', '/ipd/admissions/x', '/settings', '/reports', '/api/medicines/search', '/ipd/wardrobe']) {
      expect(wardSessionMayVisit(path)).toBe(false);
    }
  });
});

describe('parseDeviceCookie', () => {
  const hospital = '6f1c9a3e-2b7d-4e8a-9c21-7d4e5f6a8b90';
  const token = 'A'.repeat(43);
  it('splits hospital and token', () => {
    expect(parseDeviceCookie(`${hospital}.${token}`)).toEqual({ hospitalId: hospital, token });
  });
  it('refuses anything else', () => {
    expect(parseDeviceCookie(undefined)).toBeNull();
    expect(parseDeviceCookie(token)).toBeNull();
    expect(parseDeviceCookie(`${hospital}.short`)).toBeNull();
  });
});
