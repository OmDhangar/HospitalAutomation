import { describe, expect, it } from 'vitest';
import { formatDoctor } from '../doctor';

describe('formatDoctor Formatter', () => {
  it('normalizes various consultant title inputs to Dr. exactly once', () => {
    expect(formatDoctor('Anand Sharma')).toBe('Dr. Anand Sharma');
    expect(formatDoctor('Dr. Anand Sharma')).toBe('Dr. Anand Sharma');
    expect(formatDoctor('Dr Anand Sharma')).toBe('Dr. Anand Sharma');
    expect(formatDoctor('Dr. Dr. Anand Sharma')).toBe('Dr. Anand Sharma');
    expect(formatDoctor('Doctor Anand Sharma')).toBe('Dr. Anand Sharma');
    expect(formatDoctor('dr. anand sharma')).toBe('Dr. Anand Sharma');
    expect(formatDoctor('  Dr.  Anand Sharma  ')).toBe('Dr. Anand Sharma');
  });

  it('handles null, undefined, or empty names safely', () => {
    expect(formatDoctor('')).toBe('—');
    expect(formatDoctor(null)).toBe('—');
    expect(formatDoctor(undefined)).toBe('—');
  });
});
