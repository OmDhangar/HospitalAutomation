import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => {
  let mockGroups: any[] = [];
  let mockItems: any[] = [];
  let mockMedicines: any[] = [
    { id: 'med-amox', hospitalId: 'hosp-1', name: 'Amoxicillin 500mg' },
    { id: 'med-pcm', hospitalId: 'hosp-1', name: 'Paracetamol 650mg' },
    { id: 'med-pant', hospitalId: 'hosp-1', name: 'Pantoprazole 40mg' },
    { id: 'med-cet', hospitalId: 'hosp-1', name: 'Cetirizine 10mg' },
  ];

  const txMock = {
    _reset: () => {
      mockGroups = [];
      mockItems = [];
    },
    _setGroups: (g: any[]) => { mockGroups = g; },
    _setItems: (i: any[]) => { mockItems = i; },
    _setMedicines: (m: any[]) => { mockMedicines = m; },
    select: (fields?: any) => ({
      from: (tbl: any) => ({
        where: vi.fn().mockImplementation((condition: any) => ({
          orderBy: vi.fn().mockImplementation(() => {
            // Check which table was queried
            if (tbl._table === 'medicines') {
              return Promise.resolve(mockMedicines);
            }
            if (tbl._table === 'rx_groups') {
              return Promise.resolve(mockGroups);
            }
            return Promise.resolve(mockItems);
          }),
          limit: vi.fn().mockImplementation((n: number) => {
            if (tbl._table === 'rx_groups') {
              return Promise.resolve(mockGroups.slice(0, n));
            }
            return Promise.resolve(mockItems.slice(0, n));
          }),
        })),
        orderBy: vi.fn().mockImplementation(() => {
          if (tbl._table === 'rx_groups') return Promise.resolve(mockGroups);
          return Promise.resolve(mockItems);
        }),
      }),
    }),
    insert: (tbl: any) => ({
      values: vi.fn().mockImplementation((val: any) => {
        const rows = Array.isArray(val) ? val : [val];
        const inserted = rows.map((r, idx) => ({
          id: r.id || `gen-${Date.now()}-${idx}`,
          ...r,
          createdAt: new Date(),
          updatedAt: new Date(),
        }));
        if (tbl._table === 'rx_groups') {
          mockGroups.push(...inserted);
        } else if (tbl._table === 'rx_group_items') {
          mockItems.push(...inserted);
        } else if (tbl._table === 'medicines') {
          mockMedicines.push(...inserted);
        }
        return {
          returning: vi.fn().mockResolvedValue(inserted),
        };
      }),
    }),
    update: (tbl: any) => ({
      set: vi.fn().mockImplementation((patch: any) => ({
        where: vi.fn().mockImplementation(() => {
          return Promise.resolve([{ ok: true }]);
        }),
      })),
    }),
    delete: (tbl: any) => ({
      where: vi.fn().mockImplementation(() => {
        return Promise.resolve();
      }),
    }),
  };

  return {
    withTenant: vi.fn((_hospitalId: string, fn: (tx: any) => Promise<any>) => fn(txMock)),
    __txMock: txMock,
  };
});

// Attach dummy identifiers to schema tables so the mock knows what's being queried
vi.mock('@/lib/db/schema', () => ({
  rxGroups: { _table: 'rx_groups' },
  rxGroupItems: { _table: 'rx_group_items' },
  medicines: { _table: 'medicines' },
}));

import * as dbModule from '@/lib/db';
import {
  listRxGroups,
  createRxGroup,
  deleteRxGroup,
  RxGroupValidationError,
} from '../rx-groups';

describe('rx-groups service', () => {
  const { __txMock } = dbModule as any;

  beforeEach(() => {
    vi.clearAllMocks();
    __txMock._reset();
  });

  describe('createRxGroup', () => {
    it('creates an institutional Rx-group with valid medicines and directions', async () => {
      const res = await createRxGroup({
        hospitalId: 'hosp-1',
        name: 'Upper Respiratory Infection Pack',
        description: 'Standard 5-day regimen for acute bacterial URI',
        category: 'respiratory',
        defaultDiagnosis: 'Acute Upper Respiratory Tract Infection',
        defaultAdvice: 'Plenty of warm fluids, steam inhalation twice daily, rest',
        defaultFollowUpDays: 5,
        items: [
          {
            medicineId: 'med-amox',
            medicineName: 'Amoxicillin 500mg',
            dose: '1 tablet',
            frequency: '1-0-1',
            durationDays: 5,
            instructions: 'After food',
          },
          {
            medicineId: 'med-pcm',
            medicineName: 'Paracetamol 650mg',
            dose: '1 tablet',
            frequency: 'SOS',
            durationDays: 5,
            instructions: 'After food if fever > 100 F',
          },
        ],
      });

      expect(res.name).toBe('Upper Respiratory Infection Pack');
      expect(res.defaultDiagnosis).toBe('Acute Upper Respiratory Tract Infection');
      expect(res.items).toHaveLength(2);
      expect(res.items[0].medicineName).toBe('Amoxicillin 500mg');
      expect(res.items[0].dose).toBe('1 tablet');
      expect(res.items[0].frequency).toBe('1-0-1');
      expect(res.isPersonal).toBe(false);
    });

    it('creates a personal doctor Rx-group when doctorId is specified', async () => {
      const res = await createRxGroup({
        hospitalId: 'hosp-1',
        doctorId: 'doc-99',
        name: 'Dr. Sharma Fever Special',
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

      expect(res.name).toBe('Dr. Sharma Fever Special');
      expect(res.doctorId).toBe('doc-99');
      expect(res.isPersonal).toBe(true);
    });

    it('rejects creation if name is empty', async () => {
      await expect(
        createRxGroup({
          hospitalId: 'hosp-1',
          name: '  ',
          items: [
            {
              medicineId: 'med-pcm',
              medicineName: 'Paracetamol 650mg',
              dose: '1 tab',
              frequency: '1-0-1',
            },
          ],
        }),
      ).rejects.toThrow(RxGroupValidationError);
    });

    it('rejects creation if items array is empty', async () => {
      await expect(
        createRxGroup({
          hospitalId: 'hosp-1',
          name: 'Empty Bundle',
          items: [],
        }),
      ).rejects.toThrow(RxGroupValidationError);
    });
  });

  describe('listRxGroups', () => {
    it('returns combined hospital-wide and doctor personal groups', async () => {
      __txMock._setGroups([
        {
          id: 'grp-inst',
          hospitalId: 'hosp-1',
          doctorId: null,
          name: 'Hospital URI Pack',
          category: 'respiratory',
          defaultDiagnosis: 'Acute URI',
          defaultAdvice: 'Warm water',
          defaultFollowUpDays: 5,
          sortOrder: 0,
          active: true,
        },
        {
          id: 'grp-doc',
          hospitalId: 'hosp-1',
          doctorId: 'doc-99',
          name: 'Dr Personal Pack',
          category: 'general',
          defaultDiagnosis: 'Fever',
          defaultAdvice: 'Rest',
          defaultFollowUpDays: 3,
          sortOrder: 1,
          active: true,
        },
      ]);

      __txMock._setItems([
        {
          id: 'item-1',
          hospitalId: 'hosp-1',
          rxGroupId: 'grp-inst',
          medicineId: 'med-amox',
          medicineName: 'Amoxicillin 500mg',
          dose: '1 tab',
          frequency: '1-0-1',
          durationDays: 5,
          instructions: 'After food',
          sortOrder: 0,
        },
        {
          id: 'item-2',
          hospitalId: 'hosp-1',
          rxGroupId: 'grp-doc',
          medicineId: 'med-pcm',
          medicineName: 'Paracetamol 650mg',
          dose: '1 tab',
          frequency: 'SOS',
          durationDays: 3,
          instructions: 'After food',
          sortOrder: 0,
        },
      ]);

      const groups = await listRxGroups({
        hospitalId: 'hosp-1',
        doctorId: 'doc-99',
      });

      expect(groups).toHaveLength(2);
      expect(groups[0].name).toBe('Hospital URI Pack');
      expect(groups[0].isPersonal).toBe(false);
      expect(groups[0].items).toHaveLength(1);
      expect(groups[1].name).toBe('Dr Personal Pack');
      expect(groups[1].isPersonal).toBe(true);
      expect(groups[1].items).toHaveLength(1);
    });
  });

  describe('deleteRxGroup', () => {
    it('deletes group successfully', async () => {
      __txMock._setGroups([
        {
          id: 'grp-to-delete',
          hospitalId: 'hosp-1',
          doctorId: 'doc-99',
          name: 'Temporary Group',
          active: true,
        },
      ]);

      await expect(
        deleteRxGroup({
          hospitalId: 'hosp-1',
          rxGroupId: 'grp-to-delete',
          actorDoctorId: 'doc-99',
        }),
      ).resolves.not.toThrow();
    });
  });
});
