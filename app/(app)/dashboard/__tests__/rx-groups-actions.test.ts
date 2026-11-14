import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/auth/session', () => ({
  requireSession: vi.fn(),
  requireWritableSession: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  withTenant: vi.fn((_hospitalId: string, fn: (tx: any) => Promise<any>) => {
    const tx = {
      select: () => ({
        from: () => ({
          where: () => Promise.resolve([{ id: 'doc-123' }]),
        }),
      }),
    };
    return fn(tx);
  }),
}));

vi.mock('@/lib/services/rx-groups', () => ({
  listRxGroups: vi.fn(),
  createRxGroup: vi.fn(),
  seedDefaultRxGroups: vi.fn(),
  RxGroupValidationError: class RxGroupValidationError extends Error {
    constructor(msg: string) {
      super(msg);
      this.name = 'RxGroupValidationError';
    }
  },
}));

import { requireSession, requireWritableSession } from '@/lib/auth/session';
import {
  listRxGroups,
  createRxGroup,
  seedDefaultRxGroups,
} from '@/lib/services/rx-groups';
import {
  listRxGroupsDynamic,
  saveAsRxGroupDynamic,
} from '../consultation-actions';

describe('rx-groups consultation actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('listRxGroupsDynamic', () => {
    it('returns list of Rx-Groups for authorized doctor', async () => {
      vi.mocked(requireSession).mockResolvedValueOnce({
        hospitalId: 'hosp-1',
        userId: 'user-doc',
        role: 'doctor',
      } as any);

      vi.mocked(listRxGroups).mockResolvedValueOnce([
        {
          id: 'grp-1',
          name: 'URI Pack',
          category: 'respiratory',
          doctorId: null,
          isPersonal: false,
          defaultDiagnosis: 'Acute URI',
          defaultAdvice: 'Warm fluids',
          defaultFollowUpDays: 5,
          sortOrder: 0,
          description: null,
          items: [],
        },
      ]);

      const res = await listRxGroupsDynamic();
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.groups).toHaveLength(1);
        expect(res.groups[0].name).toBe('URI Pack');
      }
    });

    it('seeds default groups if hospital has none and returns them', async () => {
      vi.mocked(requireSession).mockResolvedValueOnce({
        hospitalId: 'hosp-1',
        userId: 'user-doc',
        role: 'doctor',
      } as any);

      // First call empty, second call returns seeded
      vi.mocked(listRxGroups)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          {
            id: 'grp-seeded',
            name: 'Upper Respiratory Infection (URI) Pack',
            category: 'respiratory',
            doctorId: null,
            isPersonal: false,
            defaultDiagnosis: 'Acute URI',
            defaultAdvice: 'Warm fluids',
            defaultFollowUpDays: 5,
            sortOrder: 0,
            description: null,
            items: [],
          },
        ]);

      vi.mocked(seedDefaultRxGroups).mockResolvedValueOnce(5);

      const res = await listRxGroupsDynamic();
      expect(seedDefaultRxGroups).toHaveBeenCalledWith({ hospitalId: 'hosp-1' });
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.groups).toHaveLength(1);
      }
    });
  });

  describe('saveAsRxGroupDynamic', () => {
    it('saves custom Rx-Group when called by doctor', async () => {
      vi.mocked(requireWritableSession).mockResolvedValueOnce({
        hospitalId: 'hosp-1',
        userId: 'user-doc',
        role: 'doctor',
        readOnly: false,
      } as any);

      vi.mocked(createRxGroup).mockResolvedValueOnce({
        id: 'grp-custom',
        name: 'My Special Fever Pack',
        description: null,
        category: 'general',
        doctorId: 'doc-123',
        isPersonal: true,
        defaultDiagnosis: 'Viral Pyrexia',
        defaultAdvice: 'Hydration',
        defaultFollowUpDays: 3,
        sortOrder: 0,
        items: [
          {
            id: 'item-1',
            medicineId: 'med-pcm',
            medicineName: 'Paracetamol 650mg',
            dose: '1 tablet',
            frequency: '1-0-1',
            durationDays: 3,
            instructions: 'After food',
            sortOrder: 0,
          },
        ],
      });

      const res = await saveAsRxGroupDynamic({
        name: 'My Special Fever Pack',
        defaultDiagnosis: 'Viral Pyrexia',
        defaultAdvice: 'Hydration',
        defaultFollowUpDays: 3,
        items: [
          {
            medicineId: 'med-pcm',
            medicineName: 'Paracetamol 650mg',
            dose: '1 tablet',
            frequency: '1-0-1',
            durationDays: 3,
            instructions: 'After food',
          },
        ],
      });

      expect(res.ok).toBe(true);
      expect(createRxGroup).toHaveBeenCalledWith(
        expect.objectContaining({
          hospitalId: 'hosp-1',
          name: 'My Special Fever Pack',
          doctorId: 'doc-123',
        }),
      );
    });

    it('rejects unauthorized role (receptionist)', async () => {
      vi.mocked(requireWritableSession).mockResolvedValueOnce({
        hospitalId: 'hosp-1',
        userId: 'user-recep',
        role: 'receptionist',
        readOnly: false,
      } as any);

      const res = await saveAsRxGroupDynamic({
        name: 'Pack',
        items: [],
      });

      expect(res.ok).toBe(false);
      expect(createRxGroup).not.toHaveBeenCalled();
    });
  });
});
