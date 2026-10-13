import { describe, expect, it, vi, beforeEach } from 'vitest';
import { resolveLookupRedirect } from '../lookup-service';

let mockPatients: any[] = [];
let mockAdmissions: any[] = [];

vi.mock('@/lib/db', () => ({
  withTenant: vi.fn((_hospitalId: string, fn: (tx: any) => Promise<any>) => {
    const tx = {
      select: () => ({
        from: (_table: any) => ({
          where: () => ({
            limit: () => Promise.resolve(mockPatients),
            orderBy: () => ({
              limit: () => Promise.resolve(mockAdmissions),
            }),
          }),
        }),
      }),
    };
    return fn(tx);
  }),
}));

describe('IPD Lookup Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPatients = [{ id: 'pat-101' }];
    mockAdmissions = [{ id: 'adm-555' }];
  });

  it('resolves active admission for a given UHID and returns canonical redirect path', async () => {
    const path = await resolveLookupRedirect({
      uhid: 'UHID-2024-0012',
      hospitalId: 'hosp-1',
    });
    expect(path).toMatch(/^\/ipd\/patients\/[a-zA-Z0-9-]+\/summary$/);
    expect(path).toBe('/ipd/patients/adm-555/summary');
  });

  it('handles missing patient by returning safe error path', async () => {
    mockPatients = [];
    mockAdmissions = [];
    const path = await resolveLookupRedirect({
      uhid: 'NON-EXISTENT',
      hospitalId: 'hosp-1',
    });
    expect(path).toContain('error=Patient+not+found');
  });
});
