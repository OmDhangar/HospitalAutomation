import { describe, it, expect, vi } from 'vitest';
import { calculateNews2, isNews2Escalated } from '@/lib/domain/vitals-news2';

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}));

describe('In-App NEWS2 Scoring & Clinical Escalation', () => {
  it('calculates score 0 for completely normal physiological vitals', () => {
    const score = calculateNews2({
      respiratoryRate: 16,
      spo2Percent: 98,
      o2Support: 'RA',
      bpSystolic: 120,
      pulseBpm: 72,
      avpu: 'A',
      temperatureF: 98.4,
    });

    expect(score.totalScore).toBe(0);
    expect(score.isEscalated).toBe(false);
  });

  it('triggers escalation when NEWS2 score >= 5', () => {
    // RR: 22 (+2), SpO2: 93 (+2), HR: 95 (+1) -> Total 5
    const score = calculateNews2({
      respiratoryRate: 22,
      spo2Percent: 93,
      o2Support: 'RA',
      bpSystolic: 125,
      pulseBpm: 95,
      avpu: 'A',
      temperatureF: 98.6,
    });

    expect(score.totalScore).toBe(5);
    expect(score.isEscalated).toBe(true);
    expect(isNews2Escalated(5)).toBe(true);
  });

  it('triggers escalation when any single parameter scores 3 (red flag parameter)', () => {
    // RR: 28 (scores 3), others normal -> Total 3, but has single score 3
    const score = calculateNews2({
      respiratoryRate: 28,
      spo2Percent: 97,
      o2Support: 'RA',
      bpSystolic: 120,
      pulseBpm: 80,
      avpu: 'A',
      temperatureF: 98.6,
    });

    expect(score.totalScore).toBe(3);
    expect(score.hasSingleParameterThree).toBe(true);
    expect(score.isEscalated).toBe(true);
  });
});
