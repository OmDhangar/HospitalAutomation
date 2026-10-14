import { describe, it, expect, vi, beforeEach } from 'vitest';
import { calculateBmi, recordPatientMeasurement, getLatestMeasurementForAdmission } from '@/lib/services/patient-measurements';

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}));

describe('Patient Measurements Service & BMI Calculations', () => {
  it('calculates BMI correctly rounded to 1 decimal place', () => {
    // 70 kg, 175 cm -> 70 / (1.75 * 1.75) = 22.857... -> 22.9
    expect(calculateBmi(70, 175)).toBe(22.9);

    // 85.5 kg, 168 cm -> 85.5 / (1.68 * 1.68) = 30.29... -> 30.3
    expect(calculateBmi(85.5, 168)).toBe(30.3);

    // 50 kg, 160 cm -> 50 / (1.6 * 1.6) = 19.53... -> 19.5
    expect(calculateBmi(50, 160)).toBe(19.5);
  });

  it('returns null if either weight or height is invalid or zero', () => {
    expect(calculateBmi(0, 175)).toBeNull();
    expect(calculateBmi(70, 0)).toBeNull();
    expect(calculateBmi(-10, 175)).toBeNull();
    expect(calculateBmi(70, -160)).toBeNull();
    expect(calculateBmi(undefined as any, 175)).toBeNull();
    expect(calculateBmi(70, undefined as any)).toBeNull();
  });

  it('rejects recording if neither weight nor height is provided', async () => {
    const mockDb = {
      insert: vi.fn(),
    };

    await expect(
      recordPatientMeasurement(
        {
          hospitalId: 'hosp-1',
          patientId: 'pat-1',
          admissionId: 'adm-1',
          notes: 'No numbers given',
        },
        mockDb as any,
      ),
    ).rejects.toThrow(/At least weight or height must be provided/i);
  });

  it('inserts measurement with calculated BMI when both weight and height provided', async () => {
    const insertedRows: any[] = [];
    const mockDb = {
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockImplementation((val) => {
          insertedRows.push(val);
          return {
            returning: vi.fn().mockResolvedValue([
              {
                id: 'meas-123',
                ...val,
                createdAt: new Date(),
                updatedAt: new Date(),
              },
            ]),
          };
        }),
      }),
    };

    const result = await recordPatientMeasurement(
      {
        hospitalId: 'hosp-1',
        patientId: 'pat-1',
        admissionId: 'adm-1',
        weightKg: 68.5,
        heightCm: 172,
        notes: 'Recorded on admission triage',
        measuredByUserId: 'usr-nurse-1',
      },
      mockDb as any,
    );

    expect(result.id).toBe('meas-123');
    expect(insertedRows.length).toBe(1);
    expect(insertedRows[0].weightKg).toBe('68.50');
    expect(insertedRows[0].heightCm).toBe('172.00');
    // 68.5 / (1.72^2) = 68.5 / 2.9584 = 23.15 -> 23.2
    expect(insertedRows[0].bmi).toBe('23.2');
    expect(insertedRows[0].notes).toBe('Recorded on admission triage');
  });

  it('retrieves latest measurement for an admission', async () => {
    const mockDb = {
      query: {
        patientMeasurements: {
          findFirst: vi.fn().mockResolvedValue({
            id: 'meas-999',
            hospitalId: 'hosp-1',
            admissionId: 'adm-1',
            weightKg: '72.00',
            heightCm: '170.00',
            bmi: '24.9',
            recordedAt: new Date('2026-10-14T10:00:00Z'),
          }),
        },
      },
    };

    const latest = await getLatestMeasurementForAdmission('hosp-1', 'adm-1', mockDb as any);
    expect(latest).toBeDefined();
    expect(latest?.id).toBe('meas-999');
    expect(latest?.weightKg).toBe(72);
    expect(latest?.heightCm).toBe(170);
    expect(latest?.bmi).toBe(24.9);
  });
});
