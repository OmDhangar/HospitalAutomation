import { describe, expect, it } from 'vitest';
import { detectSearchType, formatTempName } from '../patient-search';

describe('patient-search helper utilities', () => {
  it('detects phone search type for 10-digit Indian numbers', () => {
    expect(detectSearchType('9876543210')).toBe('phone');
    expect(detectSearchType('+919876543210')).toBe('phone');
    expect(detectSearchType('98765 43210')).toBe('phone');
  });

  it('detects QID search type for canonical or user-entered QID', () => {
    expect(detectSearchType('QID-8K4M-2P7R')).toBe('qid');
    expect(detectSearchType('qid-8k4m-2p7r')).toBe('qid');
  });

  it('detects MRN / hospital-local ID search type', () => {
    expect(detectSearchType('H-1042')).toBe('mrn');
    expect(detectSearchType('TEMP-2627-0001')).toBe('mrn');
    expect(detectSearchType('ADM/26-27/00042')).toBe('mrn');
  });

  it('detects name search type for text queries', () => {
    expect(detectSearchType('Bhayaram Pawara')).toBe('name');
    expect(detectSearchType('Dilip')).toBe('name');
  });

  it('formats descriptive temporary names for unidentified patients', () => {
    const name = formatTempName({ gender: 'male', approxAge: 40, note: 'Found near bus stand' });
    expect(name).toContain('Unidentified Male (~40y)');
    expect(name).toContain('Found near bus stand');
  });
});
