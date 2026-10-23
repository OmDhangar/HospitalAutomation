import React from 'react';
import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { MyPatientsTable } from '@/app/(app)/ipd/my-patients/my-patients-table';
import type { MyPatient } from '@/lib/services/doctor-ipd';

describe('Doctor Surveillance Roster & Badges', () => {
  it('renders emergency, MLC, and new ward arrival badges on newly arrived patients', () => {
    const recentArrivedAt = new Date(Date.now() - 15 * 60 * 1000); // 15 mins ago
    const mockPatients: MyPatient[] = [
      {
        admissionId: 'adm-101',
        patientName: 'Ramesh Pawar',
        age: 45,
        gender: 'male',
        status: 'admitted',
        admittedAt: recentArrivedAt,
        arrivedAt: recentArrivedAt,
        urgency: 'emergency',
        isMlc: true,
        admissionNumber: 'ADM/26-27/00012',
        bed: { label: '4', wardName: 'ICU' },
        lastEntryAt: null,
      },
    ];

    const html = renderToString(
      <MyPatientsTable
        patients={mockPatients}
        chips={[]}
        writable={true}
        timezone="Asia/Kolkata"
      />,
    );

    expect(html).toContain('Ramesh Pawar');
    expect(html).toContain('Emergency');
    expect(html).toContain('MLC');
    expect(html).toContain('New Ward Arrival');
    expect(html).toContain('ADM/26-27/00012');
    expect(html).toContain('Bed 4');
    expect(html).toContain('ICU');
  });

  it('renders standard layout without emergency/MLC pills for routine admitted patients', () => {
    const olderAdmittedAt = new Date(Date.now() - 48 * 3600 * 1000); // 2 days ago
    const mockPatients: MyPatient[] = [
      {
        admissionId: 'adm-102',
        patientName: 'Sunita Patil',
        age: 32,
        gender: 'female',
        status: 'admitted',
        admittedAt: olderAdmittedAt,
        arrivedAt: olderAdmittedAt,
        urgency: 'planned',
        isMlc: false,
        admissionNumber: 'ADM/26-27/00008',
        bed: { label: '12', wardName: 'Female Ward' },
        lastEntryAt: new Date(),
      },
    ];

    const html = renderToString(
      <MyPatientsTable
        patients={mockPatients}
        chips={[]}
        writable={true}
        timezone="Asia/Kolkata"
      />,
    );

    expect(html).toContain('Sunita Patil');
    expect(html).not.toContain('New Ward Arrival');
    expect(html).not.toContain('Emergency');
    expect(html).not.toContain('MLC');
    expect(html).toContain('ADM/26-27/00008');
  });
});
