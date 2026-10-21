import { describe, it, expect } from 'vitest';
import * as schema from '../../schema';
import * as fs from 'node:fs';
import * as path from 'node:path';

describe('Claims Migration 0066 & Schema Definitions', () => {
  it('exports all 7 claims tables from schema', () => {
    expect(schema.payerProfiles).toBeDefined();
    expect(schema.hospitalPayerConfigs).toBeDefined();
    expect(schema.claimCases).toBeDefined();
    expect(schema.claimEvents).toBeDefined();
    expect(schema.claimDocumentRecords).toBeDefined();
    expect(schema.claimQueries).toBeDefined();
    expect(schema.claimRejections).toBeDefined();
  });

  it('declares essential optimistic locking and encrypted columns on claimCases', () => {
    const cols = schema.claimCases;
    expect(cols.version).toBeDefined();
    expect(cols.clientId).toBeDefined();
    expect(cols.policyNumberCiphertext).toBeDefined();
    expect(cols.policyNumberBidx).toBeDefined();
    expect(cols.policyNumberMasked).toBeDefined();
    expect(cols.memberIdCiphertext).toBeDefined();
    expect(cols.memberIdBidx).toBeDefined();
    expect(cols.status).toBeDefined();
    expect(cols.preauthAmountPaise).toBeDefined();
    expect(cols.settledAmountPaise).toBeDefined();
  });

  it('verifies migration 0066 file exists and contains idempotent SQL with check constraints', () => {
    const migrationPath = path.resolve(process.cwd(), 'drizzle/0066_claims_tracker_and_tpa_desk.sql');
    expect(fs.existsSync(migrationPath)).toBe(true);
    const sql = fs.readFileSync(migrationPath, 'utf8');

    expect(sql).toContain('CREATE TABLE IF NOT EXISTS payer_profiles');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS hospital_payer_configs');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS claim_cases');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS claim_events');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS claim_document_records');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS claim_queries');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS claim_rejections');

    // Asserts text CHECK constraints rather than pgEnum
    expect(sql).toContain("category TEXT NOT NULL CHECK (category IN ('tpa'");
    expect(sql).toContain("status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN");
    expect(sql).toContain('ENABLE ROW LEVEL SECURITY');
  });
});
