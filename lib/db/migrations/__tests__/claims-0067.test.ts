import { describe, it, expect } from 'vitest';
import * as schema from '../../schema';
import * as fs from 'node:fs';
import * as path from 'node:path';

describe('Claims Migration 0067 & Schema Lifecycle Corrections', () => {
  it('exports all 3 new claims lifecycle tables from schema', () => {
    expect(schema.claimAuthorizations).toBeDefined();
    expect(schema.claimSubmissions).toBeDefined();
    expect(schema.claimRemittances).toBeDefined();
  });

  it('declares decoupled settlement and lifecycle columns on claimCases', () => {
    const cols = schema.claimCases;
    expect(cols.interruptedStage).toBeDefined();
    expect(cols.settlementStatus).toBeDefined();
    expect(cols.currentAuthorizedLimitPaise).toBeDefined();
    expect(cols.adjudicatedPayablePaise).toBeDefined();
    expect(cols.totalRemittedPaise).toBeDefined();
    expect(cols.totalTdsWithheldPaise).toBeDefined();
    expect(cols.totalDeductionsPaise).toBeDefined();
    expect(cols.totalDisputedPaise).toBeDefined();
    expect(cols.hospitalInternalDeadline).toBeDefined();
    expect(cols.legacyReconciliationRequired).toBeDefined();
  });

  it('declares insurer resolution and deadline type columns on claimQueries', () => {
    const cols = schema.claimQueries;
    expect(cols.insurerResolvedAt).toBeDefined();
    expect(cols.insurerResolutionReference).toBeDefined();
    expect(cols.insurerResolutionNotes).toBeDefined();
    expect(cols.deadlineType).toBeDefined();
  });

  it('verifies migration 0067 file exists and contains idempotent SQL, safe backfill, and RLS policies', () => {
    const migrationPath = path.resolve(process.cwd(), 'drizzle/0067_claims_lifecycle_corrections.sql');
    expect(fs.existsSync(migrationPath)).toBe(true);
    const sql = fs.readFileSync(migrationPath, 'utf8');

    expect(sql).toContain('ALTER TABLE claim_cases ADD COLUMN IF NOT EXISTS interrupted_stage');
    expect(sql).toContain('ALTER TABLE claim_cases ADD COLUMN IF NOT EXISTS settlement_status');
    expect(sql).toContain('ALTER TABLE claim_cases ADD COLUMN IF NOT EXISTS legacy_reconciliation_required');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS claim_authorizations');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS claim_submissions');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS claim_remittances');

    // Asserts safe legacy backfill flags for reconciliation without inventing fake remittance rows
    expect(sql).toContain("'legacy_reconciliation_required'");
    expect(sql).toContain('ENABLE ROW LEVEL SECURITY');
  });
});
