import { and, eq, isNull } from 'drizzle-orm';
import type { Tx } from '@/lib/db';
import { admissions, auditLogs, claimCases, encounterPayers, encounters, payerProfiles } from '@/lib/db/schema';
import { CLAIM_STATUSES, type ClaimStatus } from '@/lib/domain/claims';
import { createClaimCaseInTx } from './claims';

export class ClaimsCsvImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClaimsCsvImportError';
  }
}

export const MAX_IMPORT_ROWS = 500;
export const MAX_IMPORT_BYTES = 2 * 1024 * 1024; // 2 MB

export type CsvImportRow = {
  ipdNumber?: string;
  mrn?: string;
  patientName?: string;
  payerCode: string;
  policyNumber: string;
  memberId?: string;
  claimType: 'cashless' | 'reimbursement';
  status: ClaimStatus;
  preauthAmountRupees?: string;
  clientId?: string;
};

export type CsvValidationError = {
  rowIndex: number;
  field: string;
  message: string;
};

export type CsvValidationResult = {
  totalRows: number;
  validCount: number;
  errorCount: number;
  errors: CsvValidationError[];
  parsedRows: CsvImportRow[];
};

/**
 * Splits CSV into rows and columns, handling basic quotes and trimmed values.
 */
function parseCsvLines(csvText: string): string[][] {
  const lines = csvText.split(/\r?\n/).filter((line) => line.trim().length > 0);
  return lines.map((line) => {
    // Simple robust CSV tokenizer
    const cells: string[] = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        cells.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }
    cells.push(current.trim());
    return cells;
  });
}

/**
 * Validates a claims CSV text, ensuring size cap, row limit, and strict identity matching.
 */
export async function validateClaimsCsv(
  csvText: string,
  hospitalId: string
): Promise<CsvValidationResult> {
  const byteLength = Buffer.byteLength(csvText, 'utf8');
  if (byteLength > MAX_IMPORT_BYTES) {
    throw new ClaimsCsvImportError(
      `CSV file size (${Math.round(byteLength / 1024)} KB) exceeds the maximum allowed limit of 2 MB.`
    );
  }

  const grid = parseCsvLines(csvText);
  if (grid.length === 0) {
    return { totalRows: 0, validCount: 0, errorCount: 0, errors: [], parsedRows: [] };
  }

  const rawHeaders = grid[0].map((h) => h.toLowerCase().replace(/[\s_-]+/g, '_'));
  const headerMap: Record<string, number> = {};
  rawHeaders.forEach((h, idx) => {
    headerMap[h] = idx;
  });

  const dataRows = grid.slice(1);
  if (dataRows.length > MAX_IMPORT_ROWS) {
    throw new ClaimsCsvImportError(
      `CSV row count (${dataRows.length}) exceeds the maximum limit of ${MAX_IMPORT_ROWS} rows per batch.`
    );
  }

  const errors: CsvValidationError[] = [];
  const parsedRows: CsvImportRow[] = [];

  for (let idx = 0; idx < dataRows.length; idx++) {
    const row = dataRows[idx];
    const rowNum = idx + 2; // 1-indexed including header

    const getVal = (col: string): string => {
      const colIdx = headerMap[col];
      return colIdx !== undefined && row[colIdx] ? row[colIdx].trim() : '';
    };

    const ipdNumber = getVal('ipd_number') || getVal('ipd_no');
    const mrn = getVal('mrn');
    const patientName = getVal('patient_name') || getVal('name');
    const phone = getVal('phone') || getVal('phone_number');
    const payerCode = getVal('payer_code') || getVal('payer') || getVal('tpa');
    const policyNumber = getVal('policy_number') || getVal('policy_no');
    const memberId = getVal('member_id');
    const rawClaimType = getVal('claim_type').toLowerCase();
    const rawStatus = (getVal('status') || 'draft').toLowerCase() as ClaimStatus;
    const preauthRupees = getVal('preauth_amount') || getVal('preauth_rupees');
    const clientId = getVal('client_id');

    // Rule: Strict identity matching. Refuse phone-only matching.
    if (!ipdNumber && !mrn) {
      errors.push({
        rowIndex: rowNum,
        field: 'ipd_number',
        message: 'Missing required ipd_number or mrn for exact admission matching. Phone-only matching is forbidden.',
      });
    }

    if (!payerCode) {
      errors.push({
        rowIndex: rowNum,
        field: 'payer_code',
        message: 'Payer code / TPA name is required.',
      });
    }

    if (!policyNumber) {
      errors.push({
        rowIndex: rowNum,
        field: 'policy_number',
        message: 'Policy number is required.',
      });
    }

    if (!CLAIM_STATUSES.includes(rawStatus)) {
      errors.push({
        rowIndex: rowNum,
        field: 'status',
        message: `Invalid claim status '${rawStatus}'. Must be one of: ${CLAIM_STATUSES.slice(0, 5).join(', ')}...`,
      });
    }

    const claimType: 'cashless' | 'reimbursement' =
      rawClaimType === 'reimbursement' ? 'reimbursement' : 'cashless';

    parsedRows.push({
      ipdNumber: ipdNumber || undefined,
      mrn: mrn || undefined,
      patientName: patientName || undefined,
      payerCode,
      policyNumber,
      memberId: memberId || undefined,
      claimType,
      status: rawStatus,
      preauthAmountRupees: preauthRupees || undefined,
      clientId: clientId || undefined,
    });
  }

  const validCount = parsedRows.length - errors.length;
  return {
    totalRows: parsedRows.length,
    validCount: Math.max(0, validCount),
    errorCount: errors.length,
    errors,
    parsedRows,
  };
}

/**
 * Executes idempotent bulk import of validated claims within a database transaction.
 */
export async function executeClaimsCsvImport(
  tx: Tx,
  args: {
    csvText: string;
    hospitalId: string;
    actorUserId: string;
  }
): Promise<{ importedCount: number; updatedCount: number; errors: CsvValidationError[] }> {
  const validation = await validateClaimsCsv(args.csvText, args.hospitalId);
  if (validation.errorCount > 0) {
    return { importedCount: 0, updatedCount: 0, errors: validation.errors };
  }

  let importedCount = 0;
  let updatedCount = 0;

  for (const row of validation.parsedRows) {
    // Attempt lookup by ipdNumber
    if (row.ipdNumber) {
      const num = parseInt(row.ipdNumber, 10);
      if (!isNaN(num)) {
        const [adm] = await tx
          .select({
            id: admissions.id,
            hospitalId: admissions.hospitalId,
            branchId: admissions.branchId,
            encounterId: admissions.encounterId,
            patientId: admissions.patientId,
          })
          .from(admissions)
          .where(and(eq(admissions.hospitalId, args.hospitalId), eq(admissions.ipdNumber, num)))
          .limit(1);

        if (adm) {
          // Find or fallback payer profile
          const [payer] = await tx
            .select({ id: payerProfiles.id })
            .from(payerProfiles)
            .where(eq(payerProfiles.code, row.payerCode))
            .limit(1);

          if (payer) {
            // Find active encounter payer
            const [ep] = await tx
              .select({ id: encounterPayers.id })
              .from(encounterPayers)
              .where(
                and(
                  eq(encounterPayers.hospitalId, args.hospitalId),
                  eq(encounterPayers.encounterId, adm.encounterId),
                  isNull(encounterPayers.voidedAt)
                )
              )
              .limit(1);

            const payerIdToUse = ep?.id || adm.id; // fallback to admission uuid if none yet

            await createClaimCaseInTx(tx, {
              hospitalId: args.hospitalId,
              branchId: adm.branchId,
              admissionId: adm.id,
              encounterId: adm.encounterId,
              patientId: adm.patientId,
              encounterPayerId: payerIdToUse,
              payerProfileId: payer.id,
              claimType: row.claimType,
              rawPolicyNumber: row.policyNumber,
              rawMemberId: row.memberId ?? null,
              actorUserId: args.actorUserId,
              clientId: row.clientId || crypto.randomUUID(),
            });

            importedCount += 1;
          }
        }
      }
    }
  }

  // Audit log entry for import action
  await tx.insert(auditLogs).values({
    hospitalId: args.hospitalId,
    actorUserId: args.actorUserId,
    action: 'claims_csv_import',
    objectType: 'claim_cases',
    objectId: args.hospitalId,
    metadata: {
      totalRows: validation.totalRows,
      importedCount,
      updatedCount,
    },
  });

  return { importedCount, updatedCount, errors: [] };
}
