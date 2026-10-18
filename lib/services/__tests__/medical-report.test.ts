import { describe, expect, it, vi } from 'vitest';
import { getMedicalReportForPrint } from '../medical-report';

vi.mock('@/lib/db', () => ({
  withTenant: vi.fn(async (_hospitalId, callback) => {
    const mockTx = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      leftJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockImplementation(() => {
        return Promise.resolve([]);
      }),
    };
    return callback(mockTx);
  }),
}));

vi.mock('../ipd-discharge-summary', () => ({
  getLatestDischargeSummary: vi.fn().mockResolvedValue(null),
}));

describe('medical-report service', () => {
  it('fetches investigations, clinical notes, and discharge summary', async () => {
    const report = await getMedicalReportForPrint('hosp-1', 'adm-1');
    expect(report).toBeDefined();
    expect(Array.isArray(report.investigations)).toBe(true);
    expect(Array.isArray(report.progressNotes)).toBe(true);
    expect(report.dischargeSummary).toBeNull();
  });
});
