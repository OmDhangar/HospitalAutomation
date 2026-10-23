import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { computeConsentHash, formatConsentText } from '@/lib/services/consents';
import { shouldRequireBackdateReason } from '@/lib/services/admissions';

describe('Inpatient Intake Service & Consent Engine', () => {
  it('computes exact SHA-256 hash of normalized consent text', () => {
    const template = 'I, {{signatory_name}}, consent to admission of {{patient_name}} into {{hospital_name}}.';
    const text = formatConsentText(template, {
      signatory_name: 'Rajesh Pawara',
      patient_name: 'Amit Pawara',
      hospital_name: 'Guruved Hospital',
    });

    const expectedHash = createHash('sha256').update(text.trim()).digest('hex');
    const hash = computeConsentHash(text);

    expect(hash).toBe(expectedHash);
  });

  it('requires backdate reason when arrival is more than 15 minutes in the past', () => {
    const now = new Date('2026-10-19T14:30:00Z');
    
    // 5 minutes in past: not considered backdated
    const fiveMinsAgo = new Date('2026-10-19T14:25:00Z');
    expect(shouldRequireBackdateReason(fiveMinsAgo, now)).toBe(false);

    // 14 minutes in past: within 15m grace window
    const fourteenMinsAgo = new Date('2026-10-19T14:16:00Z');
    expect(shouldRequireBackdateReason(fourteenMinsAgo, now)).toBe(false);

    // 16 minutes in past: requires reason
    const sixteenMinsAgo = new Date('2026-10-19T14:14:00Z');
    expect(shouldRequireBackdateReason(sixteenMinsAgo, now)).toBe(true);

    // 2 hours in past: requires reason
    const twoHoursAgo = new Date('2026-10-19T12:30:00Z');
    expect(shouldRequireBackdateReason(twoHoursAgo, now)).toBe(true);
  });

  it('determines Indian financial year correctly across April 1 boundary', async () => {
    const { currentFiscalYear } = await import('@/lib/services/document-numbers');
    
    // October 2026 -> FY 2026-27
    const octDate = new Date('2026-10-19T10:00:00Z');
    expect(currentFiscalYear(octDate)).toBe('2026-27');

    // March 2027 -> FY 2026-27 (before April)
    const marDate = new Date('2027-03-31T10:00:00Z');
    expect(currentFiscalYear(marDate)).toBe('2026-27');

    // April 1, 2027 -> FY 2027-28
    const aprDate = new Date('2027-04-01T10:00:00Z');
    expect(currentFiscalYear(aprDate)).toBe('2027-28');
  });

  it('safely handles missing variables in formatConsentText', () => {
    const template = 'Patient {{patient_name}} admitted under Dr. {{doctor_name}}. Note: {{optional_note}}';
    const text = formatConsentText(template, {
      patient_name: 'Suresh Patil',
      doctor_name: 'Vinod Pawara',
    });

    expect(text).toBe('Patient Suresh Patil admitted under Dr. Vinod Pawara. Note:');
  });
});
