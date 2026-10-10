import { describe, expect, it } from 'vitest';
import {
  LetterheadError,
  doctorDisplayName,
  doctorLetterheadLines,
  parseDoctorLetterhead,
  parseHospitalLetterhead,
} from '../letterhead';
import { IpdNumberError, formatIpdNumber, nextIpdNumber, parseNextIpdNumber } from '../ipd-number';

describe('letterhead', () => {
  it('tidies text and turns blanks into nothing', () => {
    expect(parseHospitalLetterhead({ registrationNo: '  GHD/BNH/ 136/2022 ', phones: '' })).toEqual({
      registrationNo: 'GHD/BNH/ 136/2022',
      phones: null,
    });
  });

  it('refuses text longer than the column allows, naming the field', () => {
    expect(() => parseHospitalLetterhead({ phones: '9'.repeat(121) })).toThrow(LetterheadError);
    expect(() => parseDoctorLetterhead({ qualification: 'M'.repeat(81) })).toThrow(/Degrees/);
  });

  it('reads the letterhead tick only when it is really ticked', () => {
    expect(parseDoctorLetterhead({ onLetterhead: true }).onLetterhead).toBe(true);
    expect(parseDoctorLetterhead({}).onLetterhead).toBe(false);
  });

  it('writes "Dr" once', () => {
    expect(doctorDisplayName('Dr. Vinod Rajesh Pawara')).toBe('Dr Vinod Rajesh Pawara');
    expect(doctorDisplayName('dr vinod')).toBe('Dr vinod');
    expect(doctorDisplayName('Vinod Pawara')).toBe('Dr Vinod Pawara');
  });

  it('prints degrees and registration on a second line only when known', () => {
    expect(
      doctorLetterheadLines({ name: 'Vinod Rajesh Pawara', qualification: 'MBBS, MD (Medicine)', registrationNo: '2015074070' }),
    ).toEqual(['Dr Vinod Rajesh Pawara', 'MBBS, MD (Medicine) · Reg. No. 2015074070']);
    expect(doctorLetterheadLines({ name: 'A Patil', qualification: null, registrationNo: null })).toEqual(['Dr A Patil']);
  });
});

describe('IPD numbers', () => {
  const fresh = { lastNumber: 0, highestGiven: 0 };

  it('continues from the paper register', () => {
    expect(parseNextIpdNumber('6159', fresh)).toEqual({ lastNumber: 6158 });
    expect(parseNextIpdNumber(' 6,159 ', fresh)).toEqual({ lastNumber: 6158 });
  });

  it('never goes back to a number already given', () => {
    expect(() => parseNextIpdNumber('6150', { lastNumber: 6158, highestGiven: 6158 })).toThrow(/6159 or more/);
    // A number given while the sequence was lower (e.g. an older import) still counts.
    expect(() => parseNextIpdNumber('100', { lastNumber: 50, highestGiven: 120 })).toThrow(IpdNumberError);
    expect(parseNextIpdNumber('121', { lastNumber: 50, highestGiven: 120 })).toEqual({ lastNumber: 120 });
  });

  it('refuses anything but a plain positive number', () => {
    for (const raw of ['', 'abc', '-5', '0', '12.5', '100000000']) {
      expect(() => parseNextIpdNumber(raw, fresh), raw).toThrow(IpdNumberError);
    }
  });

  it('says what the next admission will get', () => {
    expect(nextIpdNumber({ lastNumber: 6158, highestGiven: 6100 })).toBe(6159);
    expect(nextIpdNumber(fresh)).toBe(1);
  });

  it('shows a dash before a number is given', () => {
    expect(formatIpdNumber(null)).toBe('—');
    expect(formatIpdNumber(6158)).toBe('6158');
  });
});
