import { describe, expect, it } from 'vitest';
import { sortAwaitingBedByUrgency } from '@/lib/services/ipd-census';
import type { CensusPatient } from '@/lib/services/ipd-census';

describe('OPD Admission Advice & Urgency Ranking', () => {
  it('ranks awaiting bed patients strictly by urgency: emergency > same_day > planned', () => {
    const now = new Date('2026-10-19T10:00:00Z');
    const patients: Partial<CensusPatient>[] = [
      {
        admissionId: 'adm-planned',
        patientName: 'Planned Patient',
        urgency: 'planned',
        requestedAt: new Date('2026-10-19T07:00:00Z'), // waiting 3h
        status: 'awaiting_bed',
      },
      {
        admissionId: 'adm-same-day',
        patientName: 'Same Day Patient',
        urgency: 'same_day',
        requestedAt: new Date('2026-10-19T08:00:00Z'), // waiting 2h
        status: 'awaiting_bed',
      },
      {
        admissionId: 'adm-emergency',
        patientName: 'Emergency Patient',
        urgency: 'emergency',
        requestedAt: new Date('2026-10-19T09:30:00Z'), // waiting 30m
        status: 'awaiting_bed',
      },
      {
        admissionId: 'adm-emergency-older',
        patientName: 'Older Emergency Patient',
        urgency: 'emergency',
        requestedAt: new Date('2026-10-19T09:00:00Z'), // waiting 1h
        status: 'awaiting_bed',
      },
    ];

    const sorted = sortAwaitingBedByUrgency(patients as CensusPatient[]);

    expect(sorted.map((p) => p.admissionId)).toEqual([
      'adm-emergency-older', // Emergency first, FIFO within tier
      'adm-emergency',
      'adm-same-day',
      'adm-planned',
    ]);
  });

  it('defaults missing or null urgency to same_day ranking', () => {
    const patients: Partial<CensusPatient>[] = [
      {
        admissionId: 'adm-planned',
        patientName: 'Planned',
        urgency: 'planned',
        requestedAt: new Date('2026-10-19T08:00:00Z'),
        status: 'awaiting_bed',
      },
      {
        admissionId: 'adm-null',
        patientName: 'Unspecified Urgency',
        urgency: null,
        requestedAt: new Date('2026-10-19T08:30:00Z'),
        status: 'awaiting_bed',
      },
      {
        admissionId: 'adm-emergency',
        patientName: 'Emergency',
        urgency: 'emergency',
        requestedAt: new Date('2026-10-19T09:00:00Z'),
        status: 'awaiting_bed',
      },
    ];

    const sorted = sortAwaitingBedByUrgency(patients as CensusPatient[]);

    expect(sorted.map((p) => p.admissionId)).toEqual([
      'adm-emergency',
      'adm-null', // treated as same_day
      'adm-planned',
    ]);
  });
});
