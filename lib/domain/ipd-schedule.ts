/**
 * Inpatient medication scheduling domain engine.
 * Governs clinical frequencies, authoritative clock schedules, and eMAR task windows.
 */

export const FREQUENCY_DEFAULTS: Record<string, string[]> = {
  OD: ['08:00'],
  BD: ['08:00', '20:00'],
  TDS: ['08:00', '14:00', '20:00'],
  QID: ['06:00', '12:00', '18:00', '00:00'],
  Stat: [],
  PRN: [],
  SOS: [],
};

const CLOCK_TIME_REGEX = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

/**
 * Validates whether a time string is a valid 24-hour clock time ("HH:MM" between 00:00 and 23:59).
 */
export function isValidClockTime(time: string): boolean {
  if (typeof time !== 'string') return false;
  return CLOCK_TIME_REGEX.test(time);
}

/**
 * Returns default hospital schedule clock times for a frequency code preset.
 */
export function getScheduleTimesForFrequency(frequencyCode: string): string[] {
  const normalized = frequencyCode?.trim();
  return FREQUENCY_DEFAULTS[normalized] ? [...FREQUENCY_DEFAULTS[normalized]] : [];
}

/**
 * Parses a date and time string in a timezone or standard ISO format.
 */
function parseOccurrence(year: number, month: number, day: number, timeStr: string, timezone: string): Date {
  const [hh, mm] = timeStr.split(':').map(Number);
  
  // Format as ISO string and parse
  const mStr = String(month).padStart(2, '0');
  const dStr = String(day).padStart(2, '0');
  const hStr = String(hh).padStart(2, '0');
  const minStr = String(mm).padStart(2, '0');

  // We construct the date string in the target timezone
  // For standard Indian hospital operations (Asia/Kolkata), UTC offset is +05:30
  if (timezone === 'Asia/Kolkata' || !timezone) {
    return new Date(`${year}-${mStr}-${dStr}T${hStr}:${minStr}:00+05:30`);
  }

  // Fallback using Intl for arbitrary timezones
  const dateObj = new Date(Date.UTC(year, month - 1, day, hh, mm));
  return dateObj;
}

export interface CalculateOccurrencesArgs {
  scheduleTimes: string[];
  startsAt: Date;
  endsAt?: Date | null;
  from: Date;
  to: Date;
  timezone?: string;
}

/**
 * Calculates scheduled dose occurrences between two timestamps.
 */
export function calculateScheduledOccurrences(args: CalculateOccurrencesArgs): Date[] {
  const { scheduleTimes, startsAt, endsAt, from, to, timezone = 'Asia/Kolkata' } = args;

  if (!scheduleTimes || scheduleTimes.length === 0) {
    return [];
  }

  const occurrences: Date[] = [];
  
  // Iterate calendar days within the [from, to] range with padding for timezone boundaries
  const cursor = new Date(from);
  cursor.setDate(cursor.getDate() - 1);
  const endLimit = new Date(to);
  endLimit.setDate(endLimit.getDate() + 1);

  while (cursor <= endLimit) {
    const year = cursor.getFullYear();
    const month = cursor.getMonth() + 1;
    const day = cursor.getDate();

    for (const timeStr of scheduleTimes) {
      if (!isValidClockTime(timeStr)) continue;
      const occurrence = parseOccurrence(year, month, day, timeStr, timezone);

      if (
        occurrence >= startsAt &&
        (!endsAt || occurrence < endsAt) &&
        occurrence >= from &&
        occurrence < to
      ) {
        // Prevent duplicate timestamps
        if (!occurrences.some((d) => d.getTime() === occurrence.getTime())) {
          occurrences.push(occurrence);
        }
      }
    }

    cursor.setDate(cursor.getDate() + 1);
  }

  occurrences.sort((a, b) => a.getTime() - b.getTime());
  return occurrences;
}

export type TaskTimeCategory = 'due_now' | 'overdue' | 'upcoming';

/**
 * Classifies a scheduled dose occurrence relative to target observation time:
 * - 'due_now': within [targetTime - 60 min, targetTime + 60 min]
 * - 'overdue': scheduledTime < targetTime - 60 min
 * - 'upcoming': scheduledTime > targetTime + 60 min
 */
export function getTaskTimeCategory(scheduledTime: Date, targetTime: Date): TaskTimeCategory {
  const diffMs = scheduledTime.getTime() - targetTime.getTime();
  const diffMinutes = diffMs / (60 * 1000);

  if (diffMinutes < -60) {
    return 'overdue';
  }
  if (diffMinutes > 60) {
    return 'upcoming';
  }
  return 'due_now';
}
