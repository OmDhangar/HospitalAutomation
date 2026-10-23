import { describe, expect, it } from 'vitest';
import { backoffWithJitter } from '../notice-worker';

describe('notice-worker', () => {
  describe('backoffWithJitter', () => {
    it('produces exponential backoff with upper cap and jitter', () => {
      const b0 = backoffWithJitter(0);
      expect(b0).toBeGreaterThanOrEqual(30);
      expect(b0).toBeLessThanOrEqual(36);

      const b1 = backoffWithJitter(1);
      expect(b1).toBeGreaterThanOrEqual(60);
      expect(b1).toBeLessThanOrEqual(66);

      const b2 = backoffWithJitter(2);
      expect(b2).toBeGreaterThanOrEqual(120);
      expect(b2).toBeLessThanOrEqual(126);

      const b10 = backoffWithJitter(10);
      // Math.min(3600, 30 * 2^10) = 3600 + jitter
      expect(b10).toBeGreaterThanOrEqual(3600);
      expect(b10).toBeLessThanOrEqual(3606);
    });
  });

  describe('inbound opt-out pattern detection', () => {
    const isOptOutWord = (text?: string): boolean => {
      const cleaned = text?.trim().toLowerCase();
      if (!cleaned) return false;
      return /^(stop|unsubscribe|cancel|optout|opt-out)(\s+.*)?$/i.test(cleaned);
    };

    it('identifies exact and variations of opt-out keywords', () => {
      expect(isOptOutWord('stop')).toBe(true);
      expect(isOptOutWord('STOP')).toBe(true);
      expect(isOptOutWord('Stop please')).toBe(true);
      expect(isOptOutWord('unsubscribe')).toBe(true);
      expect(isOptOutWord('cancel')).toBe(true);
      expect(isOptOutWord('optout')).toBe(true);
      expect(isOptOutWord('opt-out')).toBe(true);
    });

    it('rejects regular messages or conversations from being treated as opt-outs', () => {
      expect(isOptOutWord('hello')).toBe(false);
      expect(isOptOutWord('When will the hospital open?')).toBe(false);
      expect(isOptOutWord('I need to book an appointment')).toBe(false);
      expect(isOptOutWord('Please reschedule to tomorrow')).toBe(false);
      expect(isOptOutWord('')).toBe(false);
      expect(isOptOutWord(undefined)).toBe(false);
    });
  });
});
