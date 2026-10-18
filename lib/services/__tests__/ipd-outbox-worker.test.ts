import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  calculateOutboxBackoffSeconds,
  processOutboxItem,
  listDeadLetterOutboxItems,
  retryDeadLetterItem,
  drainAllHospitalsIpdEmarOutbox,
} from '@/lib/services/ipd-emar-outbox';
import type { SelectIpdEmarIntegrationOutbox } from '@/lib/db/schema';

// Mock DB
const mockExecute = vi.fn();
const mockUpdate = vi.fn();
const mockSet = vi.fn();
const mockWhere = vi.fn();
const mockSelect = vi.fn();
const mockFrom = vi.fn();
const mockOrderBy = vi.fn();
const mockLimit = vi.fn();

vi.mock('@/lib/db', () => ({
  withTenant: vi.fn((_hospitalId: string, fn: (tx: any) => Promise<any>) => {
    const tx = {
      execute: mockExecute,
      update: () => ({
        set: (...args: any[]) => {
          mockSet(...args);
          return {
            where: (...wArgs: any[]) => {
              mockWhere(...wArgs);
              return Promise.resolve([{ id: 'outbox-1' }]);
            },
          };
        },
      }),
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: () => ({
              limit: () => Promise.resolve([]),
            }),
          }),
        }),
      }),
    };
    return fn(tx);
  }),
}));

vi.mock('@/lib/db/admin', () => ({
  getAdminDb: () => ({
    select: () => ({
      from: () => Promise.resolve([{ id: 'hosp-1' }]),
    }),
  }),
}));

describe('IPD eMAR Outbox Worker & Dead-Letter Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('calculateOutboxBackoffSeconds', () => {
    it('calculates exponential backoff capped at 300 seconds (5 mins)', () => {
      // attempts: min(300, 2^attempts * 5)
      expect(calculateOutboxBackoffSeconds(1)).toBe(10);
      expect(calculateOutboxBackoffSeconds(2)).toBe(20);
      expect(calculateOutboxBackoffSeconds(3)).toBe(40);
      expect(calculateOutboxBackoffSeconds(4)).toBe(80);
      expect(calculateOutboxBackoffSeconds(5)).toBe(160);
      expect(calculateOutboxBackoffSeconds(6)).toBe(300);
      expect(calculateOutboxBackoffSeconds(10)).toBe(300);
    });
  });

  describe('processOutboxItem Retry & Dead-Letter Threshold', () => {
    const baseItem: SelectIpdEmarIntegrationOutbox = {
      id: 'outbox-1',
      hospitalId: 'hosp-1',
      administrationId: 'admin-1',
      integrationType: 'billing',
      eventType: 'administer',
      payload: { medicineId: 'med-1', quantity: 1 },
      status: 'pending',
      attempts: 0,
      scheduledFor: new Date(),
      claimedAt: new Date(),
      lastError: null,
      processedAt: null,
      createdAt: new Date(),
    };

    it('transitions to retry with backoff on attempts < 5', async () => {
      // Mock failure inside processing by simulating missing administration or DB throw
      const item = { ...baseItem, attempts: 2 };
      
      const res = await processOutboxItem({ item });

      expect(res.outcome).toBe('retry');
      expect(res.error).toBeDefined();
      expect(mockSet).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'pending',
          attempts: 3,
          claimedAt: null,
        }),
      );
    });

    it('dead-letters to failed status when attempts reach 5', async () => {
      const item = { ...baseItem, attempts: 4 }; // 4th failed previously, this is 5th attempt
      
      const res = await processOutboxItem({ item });

      expect(res.outcome).toBe('failed');
      expect(mockSet).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'failed',
          attempts: 5,
          claimedAt: null,
        }),
      );
    });
  });

  describe('listDeadLetterOutboxItems & retryDeadLetterItem', () => {
    it('provides retry helper that resets status to pending and clears error', async () => {
      await retryDeadLetterItem({
        hospitalId: 'hosp-1',
        outboxId: 'outbox-1',
      });

      expect(mockSet).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'pending',
          attempts: 0,
          lastError: null,
          claimedAt: null,
        }),
      );
    });
  });

  describe('drainAllHospitalsIpdEmarOutbox', () => {
    it('iterates hospitals and returns aggregated metrics', async () => {
      const res = await drainAllHospitalsIpdEmarOutbox();
      expect(res).toHaveProperty('processed');
      expect(res).toHaveProperty('pendingPricing');
      expect(res).toHaveProperty('failed');
      expect(res).toHaveProperty('recoveredStuckClaims');
    });
  });
});
