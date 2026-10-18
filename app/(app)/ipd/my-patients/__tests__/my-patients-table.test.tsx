import { describe, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import React from 'react';
import { MyPatientsTable } from '../my-patients-table';
import type { MyPatient, TestChip } from '@/lib/services/doctor-ipd';

describe('MyPatientsTable Component', () => {
  const dummyPatients: MyPatient[] = [
    {
      admissionId: 'adm-101',
      patientName: 'KAVITA SHINDE',
      age: 33,
      gender: 'Female',
      status: 'discharge_ready',
      admittedAt: new Date('2026-10-02T10:00:00Z'),
      bed: { label: '12', wardName: 'General Ward A' },
      lastEntryAt: new Date('2026-10-10T08:00:00Z'),
    },
    {
      admissionId: 'adm-102',
      patientName: 'RAJ PATIL',
      age: 25,
      gender: 'Male',
      status: 'admitted',
      admittedAt: new Date('2026-10-05T10:00:00Z'),
      bed: { label: '13', wardName: 'General Ward A' },
      lastEntryAt: null,
    },
  ];

  it('renders spreadsheet-dense table with proper headers and row metrics', () => {
    const html = renderToString(
      <MyPatientsTable
        patients={dummyPatients}
        chips={[]}
        writable={true}
        timezone="Asia/Kolkata"
      />,
    );

    // Expect table structure
    expect(html).toContain('<table');
    expect(html).toContain('Bed / Ward');
    expect(html).toContain('Patient');
    expect(html).toContain('Day');
    expect(html).toContain('Status');

    // Expect patient data formatted properly
    expect(html).toContain('Kavita Shinde');
    expect(html).toContain('Bed 12');
    expect(html).toContain('Ready for discharge');
    expect(html).toContain('Raj Patil');
    expect(html).toContain('Bed 13');
    expect(html).toContain('/ipd/patients/adm-101/summary');
  });
});
