import { describe, it, expect, vi } from 'vitest';
import {
  markBedCleaned,
  assertBedAvailableForAdmission,
  BedCleaningInProgressError,
} from '@/lib/services/ipd-census';

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}));

describe('Bed Cleaning State Machine Lifecycle', () => {
  it('blocks admission to a bed that is in cleaning status', async () => {
    const mockDb = {
      query: {
        beds: {
          findFirst: vi.fn().mockResolvedValue({
            id: 'bed-101',
            label: 'Bed 12',
            status: 'cleaning',
          }),
        },
      },
    };

    await expect(
      assertBedAvailableForAdmission('hosp-1', 'bed-101', mockDb as any),
    ).rejects.toThrow(BedCleaningInProgressError);
  });

  it('allows admission to a bed that is vacant', async () => {
    const mockDb = {
      query: {
        beds: {
          findFirst: vi.fn().mockResolvedValue({
            id: 'bed-102',
            label: 'Bed 14',
            status: 'vacant',
          }),
        },
      },
    };

    await expect(
      assertBedAvailableForAdmission('hosp-1', 'bed-102', mockDb as any),
    ).resolves.not.toThrow();
  });

  it('marks a cleaning bed as cleaned and resets status to vacant', async () => {
    let updatedValues: any = null;
    const mockDb = {
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockImplementation((val) => {
          updatedValues = val;
          return {
            where: vi.fn().mockResolvedValue([]),
          };
        }),
      }),
    };

    const res = await markBedCleaned('hosp-1', 'bed-101', 'usr-nurse-1', mockDb as any);
    expect(res.ok).toBe(true);
    expect(updatedValues.status).toBe('vacant');
    expect(updatedValues.cleanedByUserId).toBe('usr-nurse-1');
    expect(updatedValues.cleanedAt).toBeInstanceOf(Date);
  });
});
