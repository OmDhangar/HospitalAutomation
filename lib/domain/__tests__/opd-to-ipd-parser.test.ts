import { describe, expect, it } from 'vitest';
import {
  parseOpdDose,
  mapFrequencyToTimes,
  mapRoute,
} from '@/lib/domain/opd-to-ipd-parser';

describe('OPD to IPD Dose Parser', () => {
  it('parses numeric dose and standard unit when space-separated', () => {
    expect(parseOpdDose('500 mg')).toEqual({
      doseAmount: '500',
      doseUnit: 'mg',
    });
    expect(parseOpdDose('10 ml')).toEqual({
      doseAmount: '10',
      doseUnit: 'ml',
    });
    expect(parseOpdDose('1 tab')).toEqual({
      doseAmount: '1',
      doseUnit: 'tab',
    });
    expect(parseOpdDose('2 capsules')).toEqual({
      doseAmount: '2',
      doseUnit: 'cap',
    });
    expect(parseOpdDose('2 puffs')).toEqual({
      doseAmount: '2',
      doseUnit: 'puff',
    });
  });

  it('parses numeric dose and unit when without spaces', () => {
    expect(parseOpdDose('650mg')).toEqual({
      doseAmount: '650',
      doseUnit: 'mg',
    });
    expect(parseOpdDose('1g')).toEqual({
      doseAmount: '1',
      doseUnit: 'g',
    });
    expect(parseOpdDose('0.5mg')).toEqual({
      doseAmount: '0.5',
      doseUnit: 'mg',
    });
    expect(parseOpdDose('2.5ml')).toEqual({
      doseAmount: '2.5',
      doseUnit: 'ml',
    });
  });

  it('handles bare numbers using fallbackUnit or default "unit"', () => {
    expect(parseOpdDose('1', 'tablet')).toEqual({
      doseAmount: '1',
      doseUnit: 'tab',
    });
    expect(parseOpdDose('2')).toEqual({
      doseAmount: '2',
      doseUnit: 'unit',
    });
  });

  it('handles non-numeric or empty input gracefully', () => {
    expect(parseOpdDose('')).toEqual({
      doseAmount: '1',
      doseUnit: 'unit',
    });
    expect(parseOpdDose('as needed')).toEqual({
      doseAmount: '1',
      doseUnit: 'unit',
    });
  });
});

describe('OPD to IPD Frequency Mapping', () => {
  it('maps Once Daily / OD to scheduled 09:00', () => {
    expect(mapFrequencyToTimes('OD')).toEqual({
      frequencyCode: 'OD',
      scheduleTimes: ['09:00'],
      scheduleType: 'scheduled',
      isPrn: false,
    });
    expect(mapFrequencyToTimes('1-0-0')).toEqual({
      frequencyCode: 'OD',
      scheduleTimes: ['09:00'],
      scheduleType: 'scheduled',
      isPrn: false,
    });
  });

  it('maps Twice Daily / BD to scheduled 09:00 and 21:00', () => {
    expect(mapFrequencyToTimes('BD')).toEqual({
      frequencyCode: 'BD',
      scheduleTimes: ['09:00', '21:00'],
      scheduleType: 'scheduled',
      isPrn: false,
    });
    expect(mapFrequencyToTimes('1-0-1')).toEqual({
      frequencyCode: 'BD',
      scheduleTimes: ['09:00', '21:00'],
      scheduleType: 'scheduled',
      isPrn: false,
    });
  });

  it('maps Thrice Daily / TDS to 08:00, 14:00, 20:00', () => {
    expect(mapFrequencyToTimes('TDS')).toEqual({
      frequencyCode: 'TDS',
      scheduleTimes: ['08:00', '14:00', '20:00'],
      scheduleType: 'scheduled',
      isPrn: false,
    });
    expect(mapFrequencyToTimes('1-1-1')).toEqual({
      frequencyCode: 'TDS',
      scheduleTimes: ['08:00', '14:00', '20:00'],
      scheduleType: 'scheduled',
      isPrn: false,
    });
  });

  it('maps Four times / QID to 06:00, 12:00, 18:00, 22:00', () => {
    expect(mapFrequencyToTimes('QID')).toEqual({
      frequencyCode: 'QID',
      scheduleTimes: ['06:00', '12:00', '18:00', '22:00'],
      scheduleType: 'scheduled',
      isPrn: false,
    });
  });

  it('maps Night / HS to 21:00', () => {
    expect(mapFrequencyToTimes('HS')).toEqual({
      frequencyCode: 'HS',
      scheduleTimes: ['21:00'],
      scheduleType: 'scheduled',
      isPrn: false,
    });
    expect(mapFrequencyToTimes('0-0-1')).toEqual({
      frequencyCode: 'HS',
      scheduleTimes: ['21:00'],
      scheduleType: 'scheduled',
      isPrn: false,
    });
  });

  it('maps SOS / PRN to scheduleType prn and isPrn true', () => {
    expect(mapFrequencyToTimes('SOS')).toEqual({
      frequencyCode: 'SOS',
      scheduleTimes: [],
      scheduleType: 'prn',
      isPrn: true,
    });
    expect(mapFrequencyToTimes('PRN')).toEqual({
      frequencyCode: 'PRN',
      scheduleTimes: [],
      scheduleType: 'prn',
      isPrn: true,
    });
  });

  it('maps STAT to scheduleType stat and isPrn false', () => {
    expect(mapFrequencyToTimes('STAT')).toEqual({
      frequencyCode: 'STAT',
      scheduleTimes: [],
      scheduleType: 'stat',
      isPrn: false,
    });
  });

  it('falls back safely for unknown frequencies', () => {
    expect(mapFrequencyToTimes('weekly')).toEqual({
      frequencyCode: 'OD',
      scheduleTimes: ['09:00'],
      scheduleType: 'scheduled',
      isPrn: false,
    });
  });
});

describe('OPD to IPD Route Mapping', () => {
  it('maps common routes cleanly', () => {
    expect(mapRoute('oral')).toBe('oral');
    expect(mapRoute('PO')).toBe('oral');
    expect(mapRoute('iv')).toBe('iv_push');
    expect(mapRoute('IV')).toBe('iv_push');
    expect(mapRoute('im')).toBe('im');
    expect(mapRoute('sc')).toBe('sc');
    expect(mapRoute('subcutaneous')).toBe('sc');
    expect(mapRoute('neb')).toBe('nebulization');
    expect(mapRoute('topical')).toBe('topical');
    expect(mapRoute(null)).toBe('oral');
    expect(mapRoute('unknown_route')).toBe('oral');
  });
});
