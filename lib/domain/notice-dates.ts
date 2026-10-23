import type { Locale } from '@/lib/i18n/patient';

/**
 * Safely adds days to a YYYY-MM-DD date string without UTC timezone drift.
 */
export function addDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(y, m - 1, d + days);
  const nextY = date.getFullYear();
  const nextM = String(date.getMonth() + 1).padStart(2, '0');
  const nextD = String(date.getDate()).padStart(2, '0');
  return `${nextY}-${nextM}-${nextD}`;
}

const MARATHI_MONTHS = [
  'जानेवारी',
  'फेब्रुवारी',
  'मार्च',
  'एप्रिल',
  'मे',
  'जून',
  'जुलै',
  'ऑगस्ट',
  'सप्टेंबर',
  'ऑक्टोबर',
  'नोव्हेंबर',
  'डिसेंबर',
];

const HINDI_MONTHS = [
  'जनवरी',
  'फरवरी',
  'मार्च',
  'अप्रैल',
  'मई',
  'जून',
  'जुलाई',
  'अगस्त',
  'सितंबर',
  'अक्टूबर',
  'नवंबर',
  'दिसंबर',
];

const MARATHI_WEEKDAYS = [
  'रविवार',
  'सोमवार',
  'मंगळवार',
  'बुधवार',
  'गुरुवार',
  'शुक्रवार',
  'शनिवार',
];

const HINDI_WEEKDAYS = [
  'रविवार',
  'सोमवार',
  'मंगलवार',
  'बुधवार',
  'गुरुवार',
  'शुक्रवार',
  'शनिवार',
];

const ENGLISH_WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

const ENGLISH_MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

export function toDevanagariDigits(num: number | string): string {
  const devanagari = ['०', '१', '२', '३', '४', '५', '६', '७', '८', '९'];
  return String(num).replace(/\d/g, (d) => devanagari[Number(d)]);
}

/**
 * Formats a date into localized text matching official notice standards.
 */
export function formatNoticeDate(dateStr: string, locale: Locale): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  if (isNaN(date.getTime())) return dateStr;

  const dayOfWeek = date.getDay();
  const monthIdx = date.getMonth();

  if (locale === 'mr') {
    const weekday = MARATHI_WEEKDAYS[dayOfWeek];
    const month = MARATHI_MONTHS[monthIdx];
    return `${weekday} दिनांक ${toDevanagariDigits(d)} ${month} ${toDevanagariDigits(y)}`;
  }

  if (locale === 'hi') {
    const weekday = HINDI_WEEKDAYS[dayOfWeek];
    const month = HINDI_MONTHS[monthIdx];
    return `${weekday}, दिनांक ${d} ${month} ${y}`;
  }

  const weekday = ENGLISH_WEEKDAYS[dayOfWeek];
  const month = ENGLISH_MONTHS[monthIdx];
  return `${weekday}, ${d} ${month} ${y}`;
}

/**
 * Builds the closure period and resumption date strings for WhatsApp notice templates.
 */
export function formatClosureNoticePeriod(
  startDateStr: string,
  endDateStr: string | null | undefined,
  locale: Locale,
  customReopenDateStr?: string | null,
): { closurePeriodText: string; reopenDateText: string } {
  const isRange = Boolean(endDateStr && endDateStr !== startDateStr);
  const startFormatted = formatNoticeDate(startDateStr, locale);
  const finalEndDateStr = isRange && endDateStr ? endDateStr : startDateStr;

  const reopenDateStr = customReopenDateStr || addDays(finalEndDateStr, 1);
  const reopenDateText = formatNoticeDate(reopenDateStr, locale);

  let closurePeriodText = '';
  if (locale === 'mr') {
    if (isRange) {
      const endFormatted = formatNoticeDate(finalEndDateStr, locale);
      closurePeriodText = `${startFormatted} पासून ${endFormatted} पर्यंत`;
    } else {
      closurePeriodText = `${startFormatted} रोजी`;
    }
  } else if (locale === 'hi') {
    if (isRange) {
      const endFormatted = formatNoticeDate(finalEndDateStr, locale);
      closurePeriodText = `${startFormatted} से ${endFormatted} तक`;
    } else {
      closurePeriodText = `${startFormatted} को`;
    }
  } else {
    if (isRange) {
      const endFormatted = formatNoticeDate(finalEndDateStr, locale);
      closurePeriodText = `from ${startFormatted} to ${endFormatted}`;
    } else {
      closurePeriodText = `on ${startFormatted}`;
    }
  }

  return { closurePeriodText, reopenDateText };
}
