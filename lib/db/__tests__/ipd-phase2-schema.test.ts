import { describe, expect, it } from 'vitest';
import {
  clinicalAuditLogs,
  ipdClinicalTasks,
  draftRounds,
  vitalsReadings,
  intakeOutput,
} from '../schema';

describe('IPD Phase 2 Schemas', () => {
  it('exports clinical_audit_logs table with required columns', () => {
    expect(clinicalAuditLogs).toBeDefined();
    expect(clinicalAuditLogs.tableName).toBeDefined();
    expect(clinicalAuditLogs.recordId).toBeDefined();
    expect(clinicalAuditLogs.action).toBeDefined();
    expect(clinicalAuditLogs.reason).toBeDefined();
  });

  it('exports ipd_clinical_tasks table with status and scheduled_at', () => {
    expect(ipdClinicalTasks).toBeDefined();
    expect(ipdClinicalTasks.orderId).toBeDefined();
    expect(ipdClinicalTasks.admissionId).toBeDefined();
    expect(ipdClinicalTasks.scheduledAt).toBeDefined();
    expect(ipdClinicalTasks.status).toBeDefined();
  });

  it('exports draft_rounds table keyed by admission and author', () => {
    expect(draftRounds).toBeDefined();
    expect(draftRounds.admissionId).toBeDefined();
    expect(draftRounds.authorUserId).toBeDefined();
  });

  it('exports intake_output table with kind and ml', () => {
    expect(intakeOutput).toBeDefined();
    expect(intakeOutput.kind).toBeDefined();
    expect(intakeOutput.ml).toBeDefined();
  });

  it('exports vitals_readings with pain_score and news2_score', () => {
    expect(vitalsReadings).toBeDefined();
    expect(vitalsReadings.painScore).toBeDefined();
    expect(vitalsReadings.news2Score).toBeDefined();
  });
});
