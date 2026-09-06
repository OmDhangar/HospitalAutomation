import { describe, expect, it } from 'vitest';
import {
  isHoneypotFilled,
  parseDemoRequest,
  startOfDayIn,
} from '../demo-request';

describe('parseDemoRequest', () => {
  const valid = {
    name: 'Dr. Patil',
    organisation: 'Patil Hospital',
    phone: '98765 43210',
    city: 'Sangli',
    patientsPerDay: '100_200',
  };

  it('accepts a complete request and normalises the phone', () => {
    expect(parseDemoRequest(valid)).toEqual({
      ok: true,
      value: {
        name: 'Dr. Patil',
        organisation: 'Patil Hospital',
        phoneE164: '+919876543210',
        city: 'Sangli',
        patientsPerDay: '100_200',
      },
    });
  });

  it('trims whitespace on text fields', () => {
    const result = parseDemoRequest({
      ...valid,
      name: '  Dr. Patil  ',
      city: ' Sangli ',
    });
    expect(result.ok && result.value.name).toBe('Dr. Patil');
    expect(result.ok && result.value.city).toBe('Sangli');
  });

  it('rejects a missing field', () => {
    expect(parseDemoRequest({ ...valid, name: '' }).ok).toBe(false);
    expect(parseDemoRequest({ ...valid, patientsPerDay: 'plenty' }).ok).toBe(false);
  });

  it('rejects a number that is not an Indian mobile', () => {
    const result = parseDemoRequest({ ...valid, phone: '12345' });
    expect(result).toEqual({
      ok: false,
      error: 'Enter a valid 10-digit Indian mobile number.',
    });
  });
});

describe('isHoneypotFilled', () => {
  it('treats empty and missing as human', () => {
    expect(isHoneypotFilled('')).toBe(false);
    expect(isHoneypotFilled('   ')).toBe(false);
    expect(isHoneypotFilled(undefined)).toBe(false);
  });

  it('treats any real value as a bot', () => {
    expect(isHoneypotFilled('https://spam.example')).toBe(true);
  });
});

describe('startOfDayIn', () => {
  it('returns midnight of that calendar day in the timezone', () => {
    // 06:00 UTC is 11:30 IST on 5 Sep, so the IST day started at 18:30 UTC on the 4th.
    const lateMorningIst = new Date('2026-09-05T06:00:00Z');
    const start = startOfDayIn('Asia/Kolkata', lateMorningIst);
    expect(start.toISOString()).toBe('2026-09-04T18:30:00.000Z');
  });
});
