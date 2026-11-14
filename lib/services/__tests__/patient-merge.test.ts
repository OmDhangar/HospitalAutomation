import { describe, expect, it, vi } from 'vitest';
import {
  checkPatientMergeCriticality,
  executePatientMerge,
  findPatientDuplicates,
} from '../patient-merge';
import * as dbModule from '@/lib/db';

describe('Patient Merge & Duplicate Service (patient-merge.ts)', () => {
  it('detects duplicate candidates using phone and phonetic matching', async () => {
    const mockPatients = [
      {
        id: 'patient-1',
        name: 'Ramesh Patil',
        phoneE164: '+919876543210',
        age: 40,
        birthYear: 1986,
        gender: 'M',
        mrn: 'QR-2026-00001',
        mergedIntoId: null,
      },
      {
        id: 'patient-2',
        name: 'Sunita Patil',
        phoneE164: '+919876543210',
        age: 38,
        birthYear: 1988,
        gender: 'F',
        mrn: 'QR-2026-00002',
        mergedIntoId: null,
      },
    ];

    vi.spyOn(dbModule, 'withTenant').mockImplementation(async (_hId, cb: any) => {
      const mockTx = {
        select: () => ({
          from: () => ({
            where: () => ({
              orderBy: () => ({
                limit: () => mockPatients,
              }),
            }),
          }),
        }),
      };
      return cb(mockTx);
    });

    const matches = await findPatientDuplicates('hospital-1', {
      phone: '9876543210',
      name: 'Ramesh Patel', // Phonetic match
      age: 40,
      gender: 'M',
    });

    expect(matches).toHaveLength(2);
    // Ramesh Patel should be highest match (high tier)
    expect(matches[0].patient.id).toBe('patient-1');
    expect(matches[0].tier).toBe('high');
    expect(matches[0].isProbableDuplicate).toBe(true);

    // Sunita Patil on same phone should be family member (medium tier)
    expect(matches[1].patient.id).toBe('patient-2');
    expect(matches[1].tier).toBe('medium');
    expect(matches[1].isFamilyPhone).toBe(true);
  });

  it('identifies critical merge when active admission or demographic conflict exists', async () => {
    const fromP = {
      id: 'p-from',
      hospitalId: 'h-1',
      name: 'Ramesh Patil',
      gender: 'M',
      birthYear: 1970,
      mrn: 'QR-2026-00001',
      mergedIntoId: null,
    };
    const toP = {
      id: 'p-to',
      hospitalId: 'h-1',
      name: 'Ramesh Patil',
      gender: 'F', // Gender conflict!
      birthYear: 1985, // 15 years gap!
      mrn: 'QR-2026-00002',
      mergedIntoId: null,
    };

    vi.spyOn(dbModule, 'withTenant').mockImplementation(async (_hId, cb: any) => {
      const mockTx = {
        select: () => ({
          from: () => ({
            where: () => [fromP, toP],
          }),
        }),
        execute: async () => [{ has_active_admission: false, has_unpaid_bills: false }],
      };
      return cb(mockTx);
    });

    const result = await checkPatientMergeCriticality('h-1', 'p-from', 'p-to');
    expect(result.isCritical).toBe(true);
    expect(result.reasons).toContain('gender_conflict');
    expect(result.reasons).toContain('age_disparity_gt_5_years');
  });

  it('rejects critical merge if justification is missing or too short', async () => {
    vi.spyOn(dbModule, 'withTenant').mockImplementation(async (_hId, cb: any) => {
      const mockTx = {
        select: () => ({
          from: () => ({
            where: () => [
              { id: 'p1', name: 'A', gender: 'M', birthYear: 1980, mrn: 'H1', mergedIntoId: null },
              { id: 'p2', name: 'B', gender: 'F', birthYear: 1980, mrn: 'H2', mergedIntoId: null },
            ],
          }),
        }),
        execute: async () => [{ has_active_admission: true, has_unpaid_bills: false }],
      };
      return cb(mockTx);
    });

    await expect(
      executePatientMerge('h-1', 'user-1', 'receptionist', {
        fromPatientId: 'p1',
        toPatientId: 'p2',
        justification: 'too short', // < 10 chars
      }),
    ).rejects.toThrow(/justification/i);
  });
});
