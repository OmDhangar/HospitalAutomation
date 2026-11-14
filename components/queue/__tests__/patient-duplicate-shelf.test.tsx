import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import { PatientDuplicateShelf } from '../patient-duplicate-shelf';
import type { PatientDuplicateMatch } from '@/lib/services/patient-merge';

describe('<PatientDuplicateShelf /> Component', () => {
  const mockMatches: PatientDuplicateMatch[] = [
    {
      patient: {
        id: 'patient-1',
        name: 'Ramesh Patil',
        phoneE164: '+919876543210',
        age: 42,
        gender: 'M',
        mrn: 'QR-2026-00042',
        qid: 'QID-8K4M-2P7R',
        address: 'Shivaji Nagar, Pune',
      },
      tier: 'exact',
      score: 100,
      reasons: ['same_phone_exact_name'],
      isFamilyPhone: false,
      isProbableDuplicate: true,
    },
    {
      patient: {
        id: 'patient-2',
        name: 'Sunita Patil',
        phoneE164: '+919876543210',
        age: 38,
        gender: 'F',
        mrn: 'QR-2026-00043',
        qid: 'QID-9L5N-3Q8S',
        address: 'Shivaji Nagar, Pune',
      },
      tier: 'medium',
      score: 70,
      reasons: ['family_phone_distinct_name'],
      isFamilyPhone: true,
      isProbableDuplicate: false,
    },
  ];

  it('renders nothing when matches array is empty and not loading', () => {
    const html = renderToString(
      <PatientDuplicateShelf
        matches={[]}
        onSelectPatient={vi.fn()}
        onForceNew={vi.fn()}
      />,
    );
    expect(html).toBe('');
  });

  it('renders candidate cards with UHID and badge', () => {
    const html = renderToString(
      <PatientDuplicateShelf
        matches={mockMatches}
        onSelectPatient={vi.fn()}
        onForceNew={vi.fn()}
      />,
    );

    expect(html).toContain('Ramesh Patil');
    expect(html).toContain('QR-2026-00042');
    expect(html).toContain('42y · M');
    expect(html).toContain('Exact Returning Patient');

    expect(html).toContain('Sunita Patil');
    expect(html).toContain('Family Member (Same Phone)');
    expect(html).toContain('Use This Patient');
    expect(html).toContain('Different Person (Family Member)');
  });
});
