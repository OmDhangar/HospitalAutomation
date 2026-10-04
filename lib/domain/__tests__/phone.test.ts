import { describe, expect, it } from 'vitest';
import {
  formatIndianPhone,
  isMockPhone,
  makeNoPhonePlaceholder,
  normalizeIndianPhone,
  normalizeStaffPhone,
} from '../phone';

describe('normalizeIndianPhone', () => {
  it('accepts the ways reception actually types a number', () => {
    for (const input of [
      '9876543210',
      '98765 43210',
      '98765-43210',
      '09876543210',
      '+91 98765 43210',
      '919876543210',
      '+919876543210',
    ]) {
      expect(normalizeIndianPhone(input)).toBe('+919876543210');
    }
  });

  it('rejects numbers that cannot be an Indian mobile', () => {
    for (const input of [
      '',
      '12345',
      '1234567890', // landline-style leading digit
      '5876543210',
      '98765432101234',
      'not a phone',
    ]) {
      expect(normalizeIndianPhone(input)).toBeNull();
    }
  });

  it('formats back to a readable local number', () => {
    expect(formatIndianPhone('+919876543210')).toBe('98765 43210');
  });
});

describe('no-phone patients', () => {
  it('turns 0000000000 into a placeholder no real mobile can match', () => {
    for (const input of ['0000000000', '00000 00000']) {
      const result = normalizeStaffPhone(input);
      expect(result?.noPhone).toBe(true);
      expect(result?.phoneE164).toMatch(/^\+910\d{9}$/);
      expect(isMockPhone(result!.phoneE164)).toBe(true);
    }
  });

  it('gives each no-phone patient their own placeholder', () => {
    const a = makeNoPhonePlaceholder(() => '123456789');
    const b = makeNoPhonePlaceholder(() => '987654321');
    expect(a).toBe('+910123456789');
    expect(a).not.toBe(b);
  });

  it('keeps a placeholder carried over from an earlier step of the form', () => {
    expect(normalizeStaffPhone('+910123456789')).toEqual({ phoneE164: '+910123456789', noPhone: true });
  });

  it('still reads a real number as real, and refuses a bad one', () => {
    expect(normalizeStaffPhone('98765 43210')).toEqual({ phoneE164: '+919876543210', noPhone: false });
    expect(normalizeStaffPhone('12345')).toBeNull();
    expect(isMockPhone('+919876543210')).toBe(false);
    expect(normalizeIndianPhone('0000000000')).toBeNull();
  });

  it('shows "No phone" instead of the placeholder', () => {
    expect(formatIndianPhone('+910123456789')).toBe('No phone');
  });
});
