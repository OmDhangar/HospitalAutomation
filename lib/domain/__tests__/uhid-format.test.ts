import { describe, expect, it } from 'vitest';
import { formatUhid, isValidUhid, parseUhid } from '../uhid';

describe('Standardized UHID Formatting & Validation', () => {
  it('formats standard UHID as <PREFIX>-<YYYY>-<SEQUENCE>', () => {
    expect(formatUhid('QR', 2026, 42)).toBe('QR-2026-00042');
    expect(formatUhid('KAV', 2026, 1)).toBe('KAV-2026-00001');
    expect(formatUhid('hosp', 2026, 99999)).toBe('HOSP-2026-99999');
  });

  it('validates canonical UHID strings', () => {
    expect(isValidUhid('QR-2026-00042')).toBe(true);
    expect(isValidUhid('KAV-2026-00001')).toBe(true);
    expect(isValidUhid('HOSP-2025-12345')).toBe(true);

    // Invalid cases
    expect(isValidUhid('QR-26-00042')).toBe(false); // 2-digit year
    expect(isValidUhid('QR-2026-42')).toBe(false); // unpadded sequence
    expect(isValidUhid('2026-00042')).toBe(false); // missing prefix
    expect(isValidUhid('QR_2026_00042')).toBe(false); // wrong delimiter
    expect(isValidUhid('')).toBe(false);
  });

  it('parses valid UHID components', () => {
    const parsed = parseUhid('QR-2026-00042');
    expect(parsed).toEqual({
      prefix: 'QR',
      year: 2026,
      seq: 42,
    });
  });

  it('returns null when parsing invalid UHID', () => {
    expect(parseUhid('INVALID-UHID')).toBeNull();
    expect(parseUhid('QR-2026')).toBeNull();
  });
});
