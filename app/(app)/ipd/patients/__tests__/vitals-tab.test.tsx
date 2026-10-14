import { describe, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import React from 'react';
import { VitalsAndIoTab } from '@/components/ipd/vitals/vitals-and-io-tab';
import type { VitalsReadingRow, IntakeOutputRow } from '@/lib/db/schema';

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
  }),
}));

describe('VitalsAndIoTab Component', () => {
  const dummyVitals: Partial<VitalsReadingRow>[] = [
    {
      id: 'vit-1',
      admissionId: 'adm-101',
      recordedAt: new Date('2026-10-13T08:00:00Z'),
      temperatureF: '98.6',
      pulseBpm: 72,
      bpSystolic: 120,
      bpDiastolic: 80,
      respiratoryRate: 16,
      spo2Percent: 99,
      painScore: 2,
      avpu: 'A',
      news2Score: 0,
      scheduledSlot: '08:00',
    },
    {
      id: 'vit-2',
      admissionId: 'adm-101',
      recordedAt: new Date('2026-10-13T14:00:00Z'),
      temperatureF: '101.2',
      pulseBpm: 104,
      bpSystolic: 110,
      bpDiastolic: 70,
      respiratoryRate: 20,
      spo2Percent: 94,
      painScore: 4,
      avpu: 'A',
      news2Score: 4,
      scheduledSlot: '14:00',
    },
  ];

  const nowMs = Date.now();
  const dummyFluids: Partial<IntakeOutputRow>[] = [
    {
      id: 'io-1',
      admissionId: 'adm-101',
      recordedAt: new Date(nowMs - 2 * 60 * 60 * 1000),
      kind: 'ORAL',
      ml: 350,
      notes: 'Water and soup',
    },
    {
      id: 'io-2',
      admissionId: 'adm-101',
      recordedAt: new Date(nowMs - 4 * 60 * 60 * 1000),
      kind: 'IV',
      ml: 500,
      notes: 'Normal Saline 0.9%',
    },
    {
      id: 'io-3',
      admissionId: 'adm-101',
      recordedAt: new Date(nowMs - 6 * 60 * 60 * 1000),
      kind: 'URINE',
      ml: 400,
      notes: 'Clear urine',
    },
  ];

  it('renders TPR flowsheet, fluid balance totals, and entry modal triggers', () => {
    const html = renderToString(
      <VitalsAndIoTab
        admissionId="adm-101"
        vitals={dummyVitals as any}
        fluids={dummyFluids as any}
        canRecord={true}
      />,
    );

    // Expect flowsheets
    expect(html).toContain('Temperature, Pulse &amp; Respiration');
    expect(html).toContain('98.6');
    expect(html).toContain('101.2');
    expect(html).toContain('120/80');

    // Expect fluid totals
    expect(html).toContain('24-Hour Fluid Balance');
    expect(html).toContain('850 ml'); // 350 + 500
    expect(html).toContain('400 ml'); // 400 out
    expect(html).toContain('+450 ml'); // Net: 850 - 400

    // Expect action triggers
    expect(html).toContain('+ Record Vitals');
    expect(html).toContain('+ Record Fluid Balance');

    // Expect doctor vitals order bar
    expect(html).toContain('Doctor Vitals Order:');
    expect(html).toContain('q4h');
  });

  it('renders critical clinical escalation banner when latest vital has news2Score >= 5', () => {
    const highRiskVitals: Partial<VitalsReadingRow>[] = [
      {
        id: 'vit-crit',
        admissionId: 'adm-101',
        recordedAt: new Date(),
        temperatureF: '103.5',
        pulseBpm: 135,
        bpSystolic: 85,
        bpDiastolic: 55,
        respiratoryRate: 28,
        spo2Percent: 88,
        painScore: 7,
        avpu: 'V',
        news2Score: 8,
        scheduledSlot: 'Stat',
      },
      ...dummyVitals,
    ];

    const html = renderToString(
      <VitalsAndIoTab
        admissionId="adm-101"
        vitals={highRiskVitals as any}
        fluids={dummyFluids as any}
        vitalsFrequency="q1h"
        canRecord={true}
      />,
    );

    expect(html).toContain('CRITICAL CLINICAL ESCALATION: NEWS2 Score 8');
    expect(html).toContain('Patient meets inpatient clinical escalation threshold (NEWS2 ≥ 5)');
    expect(html).toContain('Immediate doctor bedside evaluation');
    expect(html).toContain('q1h');
    expect(html).toContain('Every 1 hour (Critical)');
  });
});
