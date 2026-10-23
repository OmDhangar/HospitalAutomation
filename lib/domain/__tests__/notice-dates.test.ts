import { describe, expect, it } from 'vitest';
import { addDays, formatClosureNoticePeriod, formatNoticeDate } from '../notice-dates';

describe('notice-dates', () => {
  describe('addDays', () => {
    it('adds days across months without UTC timezone drift', () => {
      expect(addDays('2026-10-23', 1)).toBe('2026-10-24');
      expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
      expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    });
  });

  describe('formatNoticeDate', () => {
    it('formats Marathi date according to hospital notice standard', () => {
      const mr = formatNoticeDate('2026-10-23', 'mr');
      expect(mr).toContain('शुक्रवार');
      expect(mr).toContain('२३');
      expect(mr).toContain('ऑक्टोबर');
      expect(mr).toContain('२०२६');
    });

    it('formats Hindi date', () => {
      const hi = formatNoticeDate('2026-10-23', 'hi');
      expect(hi).toContain('शुक्रवार');
      expect(hi).toContain('अक्टूबर');
    });

    it('formats English date', () => {
      const en = formatNoticeDate('2026-10-23', 'en');
      expect(en).toBe('Friday, 23 October 2026');
    });
  });

  describe('formatClosureNoticePeriod', () => {
    it('formats multi-day closure period and automatic reopen date in Marathi', () => {
      const { closurePeriodText, reopenDateText } = formatClosureNoticePeriod(
        '2026-10-23',
        '2026-10-25',
        'mr',
      );

      // Matches user's exact notice: "शुक्रवार दिनांक २३ ऑक्टोबर २०२६ पासून रविवार दिनांक २५ ऑक्टोबर २०२६ पर्यंत"
      expect(closurePeriodText).toContain('शुक्रवार');
      expect(closurePeriodText).toContain('ऑक्टोबर');
      expect(closurePeriodText).toContain('पासून');
      expect(closurePeriodText).toContain('रविवार');
      expect(closurePeriodText).toContain('पर्यंत');

      // Reopening on Monday, 26 Oct
      expect(reopenDateText).toContain('सोमवार');
      expect(reopenDateText).toContain('२६');
      expect(reopenDateText).toContain('ऑक्टोबर');
    });

    it('formats single-day closure in Marathi', () => {
      const { closurePeriodText, reopenDateText } = formatClosureNoticePeriod(
        '2026-10-24',
        '2026-10-24',
        'mr',
      );
      expect(closurePeriodText).toContain('शनिवार');
      expect(closurePeriodText).toContain('रोजी');
      expect(reopenDateText).toContain('रविवार');
    });

    it('allows explicit custom reopen date override', () => {
      const { reopenDateText } = formatClosureNoticePeriod(
        '2026-10-23',
        '2026-10-25',
        'mr',
        '2026-10-27',
      );
      expect(reopenDateText).toContain('मंगळवार');
      expect(reopenDateText).toContain('२७');
    });

    it('formats multi-day closure in English', () => {
      const { closurePeriodText, reopenDateText } = formatClosureNoticePeriod(
        '2026-10-23',
        '2026-10-25',
        'en',
      );
      expect(closurePeriodText).toBe(
        'from Friday, 23 October 2026 to Sunday, 25 October 2026',
      );
      expect(reopenDateText).toBe('Monday, 26 October 2026');
    });
  });
});
