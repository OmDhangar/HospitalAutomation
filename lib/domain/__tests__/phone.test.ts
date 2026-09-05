import { describe, expect, it } from 'vitest';
import { formatIndianPhone, normalizeIndianPhone } from '../phone';

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
