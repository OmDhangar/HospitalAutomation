import { describe, it, expect, vi } from 'vitest';
import {
  saveDischargeSummary,
  finalizeDischargeSummary,
  reconcileHomeMedication,
  getLatestDischargeSummary,
  assertDischargeSummaryFinalized,
  PrescriberRegistrationRequiredError,
  DischargeSummaryRequiredError,
} from '@/lib/services/ipd-discharge-summary';

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}));

describe('IPD Discharge Summary, Home Meds & Prescriber Registration Gates', () => {
  it('saves home medication reconciliation entries', async () => {
    const insertedRows: any[] = [];
    const mockDb = {
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockImplementation((val) => {
          insertedRows.push(val);
          return {
            returning: vi.fn().mockResolvedValue([
              {
                id: 'home-med-1',
                ...val,
              },
            ]),
          };
        }),
      }),
    };

    const res = await reconcileHomeMedication(
      {
        hospitalId: 'hosp-1',
        admissionId: 'adm-1',
        medicineName: 'Metformin 500mg',
        dosage: '500mg',
        frequency: 'BD',
        lastTakenAt: 'Morning with breakfast',
        reconciliationStatus: 'continued',
        reconciliationNotes: 'Continue regular diabetic control during hospital stay',
        recordedByUserId: 'usr-1',
      },
      mockDb as any,
    );

    expect(res.id).toBe('home-med-1');
    expect(insertedRows.length).toBe(1);
    expect(insertedRows[0].reconciliationStatus).toBe('continued');
    expect(insertedRows[0].medicineName).toBe('Metformin 500mg');
  });

  it('saves draft discharge summary with structured take-home medications', async () => {
    const summaryRows: any[] = [];
    const takeHomeRows: any[] = [];

    const mockDb = {
      query: {
        ipdDischargeSummaries: {
          findFirst: vi.fn().mockResolvedValue(null),
        },
      },
      insert: vi.fn().mockImplementation((table) => ({
        values: vi.fn().mockImplementation((val) => {
          if (Array.isArray(val)) {
            takeHomeRows.push(...val);
          } else {
            summaryRows.push(val);
          }
          return {
            returning: vi.fn().mockResolvedValue([
              {
                id: 'summary-1',
                ...(Array.isArray(val) ? val[0] : val),
              },
            ]),
          };
        }),
      })),
    };

    const res = await saveDischargeSummary(
      {
        hospitalId: 'hosp-1',
        admissionId: 'adm-1',
        dischargeType: 'regular',
        primaryDiagnosis: 'Dengue Fever with Thrombocytopenia',
        hospitalCourse: 'Patient admitted with fever, platelets 45k. Managed with IV hydration. Platelets recovered to 1.2L.',
        conditionAtDischarge: 'Afebrile, clinically stable, vitals normal.',
        takeHomePrescriptions: [
          {
            medicineName: 'Paracetamol 650mg',
            dosage: '650mg',
            route: 'oral',
            frequency: 'PRN',
            duration: '3 days',
            instructions: 'Take SOS for body pain or fever > 100 F',
          },
        ],
        userId: 'usr-doc-1',
      },
      mockDb as any,
    );

    expect(res.summaryId).toBe('summary-1');
    expect(summaryRows.length).toBe(1);
    expect(summaryRows[0].dischargeType).toBe('regular');
    expect(summaryRows[0].status).toBe('draft');
  });

  it('rejects finalizing discharge summary if prescriber doctor has no registration number', async () => {
    const mockDb = {
      query: {
        ipdDischargeSummaries: {
          findFirst: vi.fn().mockResolvedValue({
            id: 'summary-1',
            hospitalId: 'hosp-1',
            admissionId: 'adm-1',
            status: 'draft',
            version: 1,
          }),
        },
        doctors: {
          findFirst: vi.fn().mockResolvedValue({
            id: 'doc-unregistered',
            name: 'Dr. No License',
            registrationNo: null, // Missing registration number!
          }),
        },
      },
    };

    await expect(
      finalizeDischargeSummary(
        {
          hospitalId: 'hosp-1',
          admissionId: 'adm-1',
          summaryId: 'summary-1',
          prescriberDoctorId: 'doc-unregistered',
          userId: 'usr-1',
        },
        mockDb as any,
      ),
    ).rejects.toThrow(PrescriberRegistrationRequiredError);
  });

  it('finalizes discharge summary when prescriber doctor registration number is present', async () => {
    let updatedPayload: any = null;
    const mockDb = {
      query: {
        ipdDischargeSummaries: {
          findFirst: vi.fn().mockResolvedValue({
            id: 'summary-1',
            hospitalId: 'hosp-1',
            admissionId: 'adm-1',
            status: 'draft',
            version: 1,
          }),
        },
        doctors: {
          findFirst: vi.fn().mockResolvedValue({
            id: 'doc-registered',
            name: 'Dr. Anand Sharma',
            registrationNo: 'MMC-2015-09876', // Valid Indian medical registration number
          }),
        },
      },
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockImplementation((val) => {
          updatedPayload = val;
          return {
            where: vi.fn().mockResolvedValue([]),
          };
        }),
      }),
    };

    const res = await finalizeDischargeSummary(
      {
        hospitalId: 'hosp-1',
        admissionId: 'adm-1',
        summaryId: 'summary-1',
        prescriberDoctorId: 'doc-registered',
        userId: 'usr-1',
      },
      mockDb as any,
    );

    expect(res.ok).toBe(true);
    expect(updatedPayload).toBeDefined();
    expect(updatedPayload.status).toBe('finalized');
    expect(updatedPayload.prescriberRegistrationNo).toBe('MMC-2015-09876');
    expect(updatedPayload.finalizedAt).toBeInstanceOf(Date);
  });

  it('blocks discharge billing finalization if discharge summary is not finalized', async () => {
    // Case A: No discharge summary exists
    const mockDbNoSummary = {
      query: {
        ipdDischargeSummaries: {
          findFirst: vi.fn().mockResolvedValue(null),
        },
      },
    };

    await expect(
      assertDischargeSummaryFinalized('hosp-1', 'adm-1', mockDbNoSummary as any),
    ).rejects.toThrow(DischargeSummaryRequiredError);

    // Case B: Summary exists but status is still draft
    const mockDbDraftSummary = {
      query: {
        ipdDischargeSummaries: {
          findFirst: vi.fn().mockResolvedValue({
            id: 'sum-draft',
            status: 'draft',
          }),
        },
      },
    };

    await expect(
      assertDischargeSummaryFinalized('hosp-1', 'adm-1', mockDbDraftSummary as any),
    ).rejects.toThrow(DischargeSummaryRequiredError);

    // Case C: Summary is finalized -> passes without throwing
    const mockDbFinalizedSummary = {
      query: {
        ipdDischargeSummaries: {
          findFirst: vi.fn().mockResolvedValue({
            id: 'sum-final',
            status: 'finalized',
            prescriberRegistrationNo: 'MMC-2015-09876',
          }),
        },
      },
    };

    await expect(
      assertDischargeSummaryFinalized('hosp-1', 'adm-1', mockDbFinalizedSummary as any),
    ).resolves.not.toThrow();
  });
});
