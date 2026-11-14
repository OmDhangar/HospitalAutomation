export type IpdRoute =
  | 'oral'
  | 'iv_push'
  | 'iv_piggyback'
  | 'im'
  | 'sc'
  | 'nebulization'
  | 'topical'
  | 'inhalation'
  | 'sublingual'
  | 'rectal'
  | 'ophthalmic'
  | 'otic';

export type IpdScheduleType = 'scheduled' | 'prn' | 'stat';

export interface ParsedOpdDose {
  doseAmount: string;
  doseUnit: string;
}

export interface MappedFrequency {
  frequencyCode: string;
  scheduleTimes: string[];
  scheduleType: IpdScheduleType;
  isPrn: boolean;
}

/** Normalizes medicine dose units to standard inpatient forms. */
function normalizeUnit(unit: string): string {
  const lower = unit.trim().toLowerCase();
  switch (lower) {
    case 'tab':
    case 'tabs':
    case 'tablet':
    case 'tablets':
      return 'tab';
    case 'cap':
    case 'caps':
    case 'capsule':
    case 'capsules':
      return 'cap';
    case 'puff':
    case 'puffs':
      return 'puff';
    case 'drop':
    case 'drops':
      return 'drop';
    case 'sachet':
    case 'sachets':
      return 'sachet';
    case 'vial':
    case 'vials':
      return 'vial';
    case 'amp':
    case 'ampoule':
    case 'ampoules':
      return 'ampoule';
    case 'patch':
    case 'patches':
      return 'patch';
    default:
      return lower;
  }
}

/**
 * Parses free-form or semi-structured OPD prescription dose strings
 * (e.g. "500 mg", "650mg", "1 tab", "2.5 ml", "1") into structured numeric
 * doseAmount and doseUnit required by IPD medication orders.
 */
export function parseOpdDose(dose: string, fallbackUnit?: string | null): ParsedOpdDose {
  const trimmed = dose.trim();
  if (!trimmed) {
    return {
      doseAmount: '1',
      doseUnit: fallbackUnit ? normalizeUnit(fallbackUnit) : 'unit',
    };
  }

  // Matches numbers like "500", "650", "0.5", "2.5" with optional trailing unit
  const match = trimmed.match(/^(\d+(?:\.\d+)?)\s*([a-zA-Z]+.*)?$/);
  if (!match) {
    return {
      doseAmount: '1',
      doseUnit: fallbackUnit ? normalizeUnit(fallbackUnit) : 'unit',
    };
  }

  const doseAmount = match[1];
  const unitRaw = match[2]?.trim();

  let doseUnit = fallbackUnit ? normalizeUnit(fallbackUnit) : 'unit';
  if (unitRaw) {
    doseUnit = normalizeUnit(unitRaw);
  }

  return { doseAmount, doseUnit };
}

/**
 * Maps standard outpatient frequency codes and shorthand formats
 * (e.g. "OD", "1-0-1", "TDS", "SOS") into inpatient scheduled times.
 */
export function mapFrequencyToTimes(frequency: string): MappedFrequency {
  const norm = frequency.trim().toUpperCase();

  // PRN / SOS
  if (norm === 'SOS' || norm === 'PRN' || norm.includes('AS NEEDED') || norm.includes('WHEN REQUIRED')) {
    return {
      frequencyCode: norm === 'PRN' ? 'PRN' : 'SOS',
      scheduleTimes: [],
      scheduleType: 'prn',
      isPrn: true,
    };
  }

  // STAT / Immediately
  if (norm === 'STAT' || norm.includes('IMMEDIATE')) {
    return {
      frequencyCode: 'STAT',
      scheduleTimes: [],
      scheduleType: 'stat',
      isPrn: false,
    };
  }

  // Night / Bedtime (HS or 0-0-1)
  if (norm === 'HS' || norm === '0-0-1' || norm === '0-0-0-1' || norm.includes('NIGHT') || norm.includes('BEDTIME')) {
    return {
      frequencyCode: 'HS',
      scheduleTimes: ['21:00'],
      scheduleType: 'scheduled',
      isPrn: false,
    };
  }

  // Four times daily (QID or 1-1-1-1)
  if (norm === 'QID' || norm === '1-1-1-1' || norm.includes('FOUR TIMES') || norm.includes('4 TIMES')) {
    return {
      frequencyCode: 'QID',
      scheduleTimes: ['06:00', '12:00', '18:00', '22:00'],
      scheduleType: 'scheduled',
      isPrn: false,
    };
  }

  // Thrice daily (TDS / TID or 1-1-1)
  if (
    norm === 'TDS' ||
    norm === 'TID' ||
    norm === '1-1-1' ||
    norm.includes('THRICE') ||
    norm.includes('THREE TIMES') ||
    norm.includes('3 TIMES')
  ) {
    return {
      frequencyCode: 'TDS',
      scheduleTimes: ['08:00', '14:00', '20:00'],
      scheduleType: 'scheduled',
      isPrn: false,
    };
  }

  // Twice daily (BD / BID or 1-0-1)
  if (
    norm === 'BD' ||
    norm === 'BID' ||
    norm === '1-0-1' ||
    norm.includes('TWICE') ||
    norm.includes('TWO TIMES') ||
    norm.includes('2 TIMES')
  ) {
    return {
      frequencyCode: 'BD',
      scheduleTimes: ['09:00', '21:00'],
      scheduleType: 'scheduled',
      isPrn: false,
    };
  }

  // Once daily (OD or 1-0-0) — also default fallback
  return {
    frequencyCode: 'OD',
    scheduleTimes: ['09:00'],
    scheduleType: 'scheduled',
    isPrn: false,
  };
}

/**
 * Maps outpatient route text to strict inpatient route enum values.
 */
export function mapRoute(route?: string | null): IpdRoute {
  if (!route) return 'oral';
  const lower = route.trim().toLowerCase();

  switch (lower) {
    case 'oral':
    case 'po':
    case 'per oral':
    case 'by mouth':
      return 'oral';
    case 'iv':
    case 'iv_push':
    case 'iv push':
    case 'intravenous':
      return 'iv_push';
    case 'iv_piggyback':
    case 'ivpb':
    case 'infusion':
    case 'iv drip':
      return 'iv_piggyback';
    case 'im':
    case 'intramuscular':
      return 'im';
    case 'sc':
    case 'subcutaneous':
    case 'sub-q':
    case 'sq':
      return 'sc';
    case 'neb':
    case 'nebulization':
    case 'nebulizer':
    case 'inhalation':
      return 'nebulization';
    case 'topical':
    case 'local':
    case 'apply':
      return 'topical';
    case 'sublingual':
    case 'sl':
      return 'sublingual';
    case 'rectal':
    case 'pr':
      return 'rectal';
    case 'ophthalmic':
    case 'eye':
    case 'eye drop':
      return 'ophthalmic';
    case 'otic':
    case 'ear':
    case 'ear drop':
      return 'otic';
    default:
      return 'oral';
  }
}
