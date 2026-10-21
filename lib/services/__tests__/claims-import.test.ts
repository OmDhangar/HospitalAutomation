import { describe, it, expect, vi } from 'vitest';
import {
  validateClaimsCsv,
  executeClaimsCsvImport,
  ClaimsCsvImportError,
} from '../claims-import';

describe('Claims Bootstrap CSV Import Engine', () => {
  const hospitalId = 'h-1';
  const actorUserId = 'u-1';

  it('rejects CSV exceeding row limit of 500 rows', async () => {
    const header = 'ipd_number,patient_name,payer_code,policy_number,claim_type,status\n';
    let rows = '';
    for (let i = 0; i < 505; i++) {
      rows += `10${i},Patient ${i},STAR_HEALTH,POL-${i},cashless,draft\n`;
    }
    const hugeCsv = header + rows;

    await expect(validateClaimsCsv(hugeCsv, hospitalId)).rejects.toThrow(ClaimsCsvImportError);
  });

  it('refuses phone-only matching without ipd_number or mrn', async () => {
    const csvWithoutId = `phone,patient_name,payer_code,policy_number,claim_type,status
+919876543210,Ramesh Kumar,STAR_HEALTH,POL-12345,cashless,draft`;

    const report = await validateClaimsCsv(csvWithoutId, hospitalId);
    expect(report.validCount).toBe(0);
    expect(report.errorCount).toBeGreaterThan(0);
    expect(report.errors[0].message).toContain('Missing required ipd_number or mrn');
  });

  it('validates and parses well-formed CSV rows', async () => {
    const validCsv = `ipd_number,patient_name,payer_code,policy_number,claim_type,status,preauth_amount
1001,Amit Sharma,STAR_HEALTH,STAR-998877,cashless,draft,25000`;

    const report = await validateClaimsCsv(validCsv, hospitalId);
    expect(report.totalRows).toBe(1);
    expect(report.validCount).toBe(1);
    expect(report.errorCount).toBe(0);
  });

  it('flags rows with invalid claim status or missing required payer_code', async () => {
    const invalidCsv = `ipd_number,patient_name,payer_code,policy_number,claim_type,status
1002,Sunita Patel,,POL-2233,cashless,unknown_status`;

    const report = await validateClaimsCsv(invalidCsv, hospitalId);
    expect(report.errorCount).toBeGreaterThan(0);
    expect(report.errors.some((e) => e.field === 'payer_code')).toBe(true);
    expect(report.errors.some((e) => e.field === 'status')).toBe(true);
  });
});
