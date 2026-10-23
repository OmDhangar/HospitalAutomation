import { describe, expect, it } from 'vitest';
import {
  calculateAvailableAccountCapacity,
  resolveTierLimit,
  TIER_LIMITS,
} from '../whatsapp-capacity';

describe('whatsapp-capacity domain', () => {
  describe('resolveTierLimit', () => {
    it('returns 250 for null or undefined tier', () => {
      expect(resolveTierLimit(null)).toBe(250);
      expect(resolveTierLimit(undefined)).toBe(250);
      expect(resolveTierLimit('')).toBe(250);
    });

    it('resolves known Meta tiers accurately', () => {
      expect(resolveTierLimit('TIER_250')).toBe(250);
      expect(resolveTierLimit('tier_1k')).toBe(1000);
      expect(resolveTierLimit('TIER_10K')).toBe(10000);
      expect(resolveTierLimit('TIER_100K')).toBe(100000);
      expect(resolveTierLimit('TIER_UNLIMITED')).toBe(1000000);
    });

    it('falls back to 250 for unrecognized tier values', () => {
      expect(resolveTierLimit('TIER_UNKNOWN')).toBe(250);
    });
  });

  describe('calculateAvailableAccountCapacity', () => {
    it('calculates available capacity and caps at 250 with fresh account', () => {
      const result = calculateAvailableAccountCapacity({
        tierLimit: 1000,
        consumedLast24h: 0,
        activeReservations: 0,
        safetyBuffer: 10,
      });

      expect(result.tierLimit).toBe(1000);
      expect(result.safetyBuffer).toBe(10);
      expect(result.availableCapacity).toBe(990);
      // Application cap remains 250
      expect(result.effectiveCampaignCap).toBe(250);
    });

    it('deducts consumed capacity, active reservations and safety buffer', () => {
      const result = calculateAvailableAccountCapacity({
        tierLimit: 250,
        consumedLast24h: 150,
        activeReservations: 50,
        safetyBuffer: 10,
      });

      // 250 - (150 + 50 + 10) = 40
      expect(result.availableCapacity).toBe(40);
      expect(result.effectiveCampaignCap).toBe(40);
    });

    it('returns 0 available capacity when completely consumed', () => {
      const result = calculateAvailableAccountCapacity({
        tierLimit: 250,
        consumedLast24h: 245,
        activeReservations: 10,
        safetyBuffer: 10,
      });

      expect(result.availableCapacity).toBe(0);
      expect(result.effectiveCampaignCap).toBe(0);
    });

    it('supports custom application cap', () => {
      const result = calculateAvailableAccountCapacity({
        tierLimit: 1000,
        consumedLast24h: 0,
        activeReservations: 0,
        safetyBuffer: 10,
        applicationCap: 100,
      });

      expect(result.availableCapacity).toBe(990);
      expect(result.effectiveCampaignCap).toBe(100);
    });
  });
});
