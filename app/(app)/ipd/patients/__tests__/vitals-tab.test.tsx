import { describe, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import React from 'react';
import { VitalsAndIoTab } from '@/components/ipd/vitals/vitals-and-io-tab';
import { TprCalendarGrid } from '@/components/ipd/vitals/tpr-calendar-grid';
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
    expect(html).toContain('Vitals &amp; Fluid Balance (TPR &amp; I/O)');
    expect(html).toContain('98.6');
    expect(html).toContain('101.2');
    expect(html).toContain('120/80');

    // Expect fluid totals
    expect(html).toContain('24-Hour Fluid Balance');
    expect(html).toContain('850 ml'); // 350 + 500
    expect(html).toContain('400 ml'); // 400 out
    expect(html).toContain('+450 ml'); // Net: 850 - 400

    // Expect single primary action trigger
    expect(html).toContain('+ Record Vitals');
    expect(html).not.toContain('+ Record Fluid Balance');

    // Doctor vitals order bar removed to keep page uncluttered
    expect(html).not.toContain('Doctor Vitals Order:');
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
        canRecord={true}
      />,
    );

    expect(html).toContain('CRITICAL CLINICAL ESCALATION: NEWS2 Score 8');
    expect(html).toContain('Patient meets inpatient clinical escalation threshold (NEWS2 ≥ 5)');
    expect(html).toContain('Immediate doctor bedside evaluation');
  });

  it('renders authentic paper-chart nursing TPR sheet with 24 hourly rows and paper columns', () => {
    const html = renderToString(
      <TprCalendarGrid
        admissionId="adm-101"
        patient={{
          name: 'Bhagwan Paude',
          age: 48,
          gender: 'Male',
          ipdNumber: '6159',
          wardName: 'Female Medical Ward',
          bedLabel: '12',
          admittedAt: new Date('2026-10-13T08:00:00Z'),
        }}
        vitals={dummyVitals as any}
        fluids={dummyFluids as any}
        treatments={[
          {
            id: 'trt-1',
            actualTime: new Date('2026-10-13T08:30:00Z'),
            medicineName: 'Inj. Monocef',
            doseGiven: '2g',
          },
        ]}
      />,
    );

    expect(html).toContain('NURSING T.P.R. CHART');
    expect(html).toContain('Bhagwan Paude');
    expect(html).toContain('48 Y');
    expect(html).toContain('Male');
    expect(html).toContain('6159');
    expect(html).toContain('TIME');
    expect(html).toContain('PULSE');
    expect(html).toContain('B.P.');
    expect(html).toContain('SPO2');
    expect(html).toContain('TEMP');
    expect(html).toContain('BSL');
    expect(html).toContain('R.R.');
    expect(html).toContain('ABD GIRTH');
    expect(html).toContain('OUT PUT');
    expect(html).toContain('DRAIN');
    expect(html).toContain('URIN');
    expect(html).toContain('RT.ASPI');
    expect(html).toContain('INTEX');
    expect(html).toContain('ORAL');
    expect(html).toContain('I/V FLUID');
    expect(html).toContain('TREATMENT');
    expect(html).toContain('8 am');
    expect(html).toContain('7 am');
    expect(html).toContain('Inj. Monocef (2g)');
  });

  it('renders dynamic hospital name and letterhead configured from settings without hardcoded fallback', () => {
    const customLetterhead = {
      hospitalName: 'Apex Multispeciality Hospital & Trauma Center',
      branchName: 'City Center Branch',
      address: 'Plot 42, Ring Road, Pune',
      phones: '+91 98765 43210',
      registrationNo: 'REG/MH/2026/8941',
      doctors: [],
    };

    const html = renderToString(
      <TprCalendarGrid
        admissionId="adm-101"
        hospitalName={customLetterhead.hospitalName}
        letterhead={customLetterhead}
        vitals={dummyVitals as any}
        fluids={dummyFluids as any}
      />,
    );

    expect(html).toContain('Apex Multispeciality Hospital &amp; Trauma Center');
    expect(html).toContain('City Center Branch');
    expect(html).toContain('Plot 42, Ring Road, Pune');
    expect(html).toContain('Tel: +91 98765 43210');
    expect(html).toContain('Reg. No: REG/MH/2026/8941');
    expect(html).not.toContain('GURUVED');
  });
});
