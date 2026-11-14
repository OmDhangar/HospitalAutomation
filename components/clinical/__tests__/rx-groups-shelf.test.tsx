import { describe, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import React from 'react';
import { RxGroupsShelf } from '../rx-groups-shelf';
import type { RxGroupView } from '@/lib/services/rx-groups';

describe('RxGroupsShelf Component', () => {
  const mockGroups: RxGroupView[] = [
    {
      id: 'grp-uri',
      name: 'Upper Respiratory Infection (URI) Pack',
      description: '5-day bacterial URI regimen',
      category: 'respiratory',
      doctorId: null,
      isPersonal: false,
      defaultDiagnosis: 'Acute Upper Respiratory Tract Infection',
      defaultAdvice: 'Steam inhalation, warm fluids',
      defaultFollowUpDays: 5,
      sortOrder: 0,
      items: [
        {
          id: 'i-1',
          medicineId: 'med-amox',
          medicineName: 'Amoxicillin 500mg',
          dose: '1 tablet',
          frequency: '1-0-1',
          durationDays: 5,
          instructions: 'After food',
          sortOrder: 0,
        },
        {
          id: 'i-2',
          medicineId: 'med-pcm',
          medicineName: 'Paracetamol 650mg',
          dose: '1 tablet',
          frequency: 'SOS',
          durationDays: 5,
          instructions: 'After food',
          sortOrder: 1,
        },
      ],
    },
    {
      id: 'grp-dr-special',
      name: 'Dr. Special Fever Pack',
      description: null,
      category: 'general',
      doctorId: 'doc-123',
      isPersonal: true,
      defaultDiagnosis: 'Viral Pyrexia',
      defaultAdvice: 'Bed rest',
      defaultFollowUpDays: 3,
      sortOrder: 1,
      items: [
        {
          id: 'i-3',
          medicineId: 'med-pcm',
          medicineName: 'Paracetamol 650mg',
          dose: '1 tablet',
          frequency: '1-0-1',
          durationDays: 3,
          instructions: 'After food',
          sortOrder: 0,
        },
      ],
    },
  ];

  it('renders Rx-Groups title and group badges with medicine counts', () => {
    const html = renderToString(
      <RxGroupsShelf
        groups={mockGroups}
        onApplyGroup={vi.fn()}
      />,
    );

    expect(html).toContain('Rx-Groups (1-Click Protocols)');
    expect(html).toContain('Upper Respiratory Infection (URI) Pack');
    expect(html).toContain('Dr. Special Fever Pack');
    expect(html).toContain('My Group'); // For personal group
  });

  it('renders "Save current as Rx-Group" button when canSaveCurrentAsGroup is true', () => {
    const html = renderToString(
      <RxGroupsShelf
        groups={mockGroups}
        onApplyGroup={vi.fn()}
        canSaveCurrentAsGroup={true}
        onOpenSaveModal={vi.fn()}
      />,
    );

    expect(html).toContain('Save as Rx-Group');
  });

  it('renders empty state message when no groups are available', () => {
    const html = renderToString(
      <RxGroupsShelf
        groups={[]}
        onApplyGroup={vi.fn()}
      />,
    );

    expect(html).toContain('No Rx-Groups available');
  });
});
