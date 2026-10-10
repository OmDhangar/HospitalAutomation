import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ACCESS_SETTINGS,
  ENROL_CODE_ALPHABET,
  MAX_DEVICE_FAILURES_PER_HOUR,
  afterDeviceFailure,
  afterWrongPin,
  channelAllowed,
  deviceUnusedTooLong,
  enrolCodeFrom,
  formatEnrolCode,
  isLocked,
  normalizeEnrolCode,
  parseAccessSettings,
  parseDeviceCookie,
  pinProblem,
  sessionRule,
  sessionVerdict,
  shouldWriteLastSeen,
  wardRoleFor,
  wardSessionMayVisit,
} from '../staff-access';

const MIN = 60_000;
const at = (minutes: number) => new Date(Date.UTC(2026, 9, 10, 8, 0) + minutes * MIN);

describe('access settings', () => {
  it('fills defaults', () => {
    expect(parseAccessSettings(undefined)).toEqual(DEFAULT_ACCESS_SETTINGS);
    expect(parseAccessSettings({ nonsense: true })).toEqual(DEFAULT_ACCESS_SETTINGS);
  });

  it('keeps the lock between 5 and 30 minutes', () => {
    expect(parseAccessSettings({ clinicalLockMinutes: 1 }).clinicalLockMinutes).toBe(5);
    expect(parseAccessSettings({ clinicalLockMinutes: 240 }).clinicalLockMinutes).toBe(30);
    expect(parseAccessSettings({ clinicalLockMinutes: 10 }).clinicalLockMinutes).toBe(10);
  });

  it('never lets the owner be locked out of their own device', () => {
    const settings = parseAccessSettings({ personalRoles: ['nurse'] });
    expect(channelAllowed(settings, 'owner', 'personal')).toBe(true);
    expect(channelAllowed(settings, 'doctor', 'personal')).toBe(false);
  });

  it('allows ward devices to the roles chosen', () => {
    const settings = parseAccessSettings({ wardDeviceRoles: ['nurse', 'nurse'] });
    expect(settings.wardDeviceRoles).toEqual(['nurse']);
    expect(channelAllowed(settings, 'nurse', 'ward_device')).toBe(true);
    expect(channelAllowed(settings, 'receptionist', 'ward_device')).toBe(false);
  });

  it('caps what a role can do on a shared tablet', () => {
    expect(wardRoleFor('owner')).toBe('doctor');
    expect(wardRoleFor('receptionist')).toBe('nurse');
    expect(wardRoleFor('nurse')).toBe('nurse');
    expect(wardRoleFor('doctor')).toBe('doctor');
  });
});

describe('session lifetime', () => {
  const settings = DEFAULT_ACCESS_SETTINGS;

  it('locks a nurse’s or doctor’s phone after 15 idle minutes, and asks again after 5 in the background', () => {
    const rule = sessionRule('nurse', 'personal', settings);
    expect(rule.idle).toEqual({ ms: 15 * MIN, action: 'lock' });
    expect(rule.backgroundLockMs).toBe(5 * MIN);
    expect(sessionVerdict({ createdAt: at(0), lastSeenAt: at(10), lockedAt: null, now: at(24), rule })).toBe('active');
    expect(sessionVerdict({ createdAt: at(0), lastSeenAt: at(10), lockedAt: null, now: at(26), rule })).toBe('lock');
  });

  it('uses the owner’s chosen lock minutes', () => {
    const rule = sessionRule('doctor', 'personal', parseAccessSettings({ clinicalLockMinutes: 5 }));
    expect(sessionVerdict({ createdAt: at(0), lastSeenAt: at(0), lockedAt: null, now: at(6), rule })).toBe('lock');
  });

  it('keeps a locked session locked, whatever the activity', () => {
    const rule = sessionRule('nurse', 'personal', settings);
    expect(sessionVerdict({ createdAt: at(0), lastSeenAt: at(1), lockedAt: at(1), now: at(2), rule })).toBe('lock');
  });

  it('ends a ward-device person session after 10 idle minutes and after 24 hours', () => {
    const rule = sessionRule('nurse', 'ward_device', settings);
    expect(rule.idle.action).toBe('end');
    expect(sessionVerdict({ createdAt: at(0), lastSeenAt: at(0), lockedAt: null, now: at(11), rule })).toBe('end');
    expect(sessionVerdict({ createdAt: at(0), lastSeenAt: at(24 * 60), lockedAt: null, now: at(24 * 60 + 1), rule })).toBe('end');
  });

  it('signs the owner out after 8 idle hours and a week at most, and reception after 12 hours', () => {
    const owner = sessionRule('owner', 'personal', settings);
    expect(sessionVerdict({ createdAt: at(0), lastSeenAt: at(0), lockedAt: null, now: at(8 * 60 + 1), rule: owner })).toBe('end');
    expect(sessionVerdict({ createdAt: at(0), lastSeenAt: at(7 * 24 * 60), lockedAt: null, now: at(7 * 24 * 60 + 1), rule: owner })).toBe('end');
    const desk = sessionRule('receptionist', 'personal', settings);
    expect(desk.backgroundLockMs).toBeNull();
    expect(sessionVerdict({ createdAt: at(0), lastSeenAt: at(0), lockedAt: null, now: at(11 * 60), rule: desk })).toBe('active');
  });

  it('measures idle from sign-in when the session was never seen', () => {
    const rule = sessionRule('nurse', 'personal', settings);
    expect(sessionVerdict({ createdAt: at(0), lastSeenAt: null, lockedAt: null, now: at(16), rule })).toBe('lock');
  });

  it('writes last seen once a minute for clinical sessions, not on every request', () => {
    const rule = sessionRule('nurse', 'personal', settings);
    expect(shouldWriteLastSeen(null, at(0), rule)).toBe(true);
    expect(shouldWriteLastSeen(at(0), new Date(at(0).getTime() + 30_000), rule)).toBe(false);
    expect(shouldWriteLastSeen(at(0), at(1), rule)).toBe(true);
  });
});

describe('PINs', () => {
  it('refuses PINs that are not four digits or easy to guess', () => {
    expect(pinProblem('123')).toBe('not_four_digits');
    expect(pinProblem('12a4')).toBe('not_four_digits');
    expect(pinProblem('1234')).toBe('too_obvious');
    expect(pinProblem('0000')).toBe('too_obvious');
    expect(pinProblem('1987')).toBe('looks_like_a_year');
    expect(pinProblem('7391')).toBeNull();
  });

  it('locks a person for 15 minutes on the fifth wrong PIN', () => {
    let count = 0;
    for (let i = 0; i < 4; i++) {
      const next = afterWrongPin(count, at(0));
      expect(next.lockedUntil).toBeNull();
      count = next.failedCount;
    }
    const fifth = afterWrongPin(count, at(0));
    expect(fifth.lockedUntil).toEqual(at(15));
    expect(isLocked(fifth.lockedUntil, at(14))).toBe(true);
    expect(isLocked(fifth.lockedUntil, at(15))).toBe(false);
  });

  it('locks a device for an hour after twenty wrong PINs in an hour, and forgets older ones', () => {
    let state = { failedPins: 0, windowStartedAt: null as Date | null };
    for (let i = 1; i < MAX_DEVICE_FAILURES_PER_HOUR; i++) {
      const next = afterDeviceFailure(state, at(i));
      expect(next.lockedUntil).toBeNull();
      state = next;
    }
    expect(afterDeviceFailure(state, at(30)).lockedUntil).toEqual(at(90));
    // The same count spread beyond an hour starts again.
    expect(afterDeviceFailure(state, at(70))).toMatchObject({ failedPins: 1, lockedUntil: null });
  });
});

describe('device enrolment', () => {
  it('makes 8-character codes from the unambiguous alphabet', () => {
    const code = enrolCodeFrom(new Uint8Array([0, 1, 2, 3, 250, 251, 252, 255]));
    expect(code).toHaveLength(8);
    for (const ch of code) expect(ENROL_CODE_ALPHABET).toContain(ch);
    expect(formatEnrolCode('ABCDEFGH')).toBe('ABCD-EFGH');
  });

  it('accepts the code however it is typed', () => {
    expect(normalizeEnrolCode(' abcd-efgh ')).toBe('ABCDEFGH');
    expect(normalizeEnrolCode('ABCD EFG')).toBeNull();
    expect(normalizeEnrolCode('ABCD-EFG0')).toBeNull();
  });

  it('reads the device cookie and refuses anything else', () => {
    const id = '6f9619ff-8b86-4d01-b42d-00cf4fc964ff';
    expect(parseDeviceCookie(`${id}.${'a'.repeat(43)}`)).toEqual({ hospitalId: id, token: 'a'.repeat(43) });
    expect(parseDeviceCookie(`${id}.short`)).toBeNull();
    expect(parseDeviceCookie('garbage')).toBeNull();
    expect(parseDeviceCookie(undefined)).toBeNull();
  });

  it('retires a device unused for 90 days, but not one used last week', () => {
    const day = 24 * 60;
    expect(deviceUnusedTooLong(at(0), at(0), at(91 * day))).toBe(true);
    expect(deviceUnusedTooLong(at(84 * day), at(0), at(91 * day))).toBe(false);
  });
});

describe('ward session scope', () => {
  it('keeps a ward session on the IPD', () => {
    for (const path of ['/ipd', '/ipd/ward/x', '/api/ipd/care-entries', '/print/ipd-file/x', '/ward-device', '/_next/static/a.js']) {
      expect(wardSessionMayVisit(path), path).toBe(true);
    }
    for (const path of ['/dashboard', '/settings', '/settings/ipd', '/reports', '/ipdx', '/api/medicines/search', '/print/ipd-bill/x']) {
      expect(wardSessionMayVisit(path), path).toBe(false);
    }
  });
});
