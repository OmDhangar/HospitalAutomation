import { describe, it, expect, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import React from 'react';
import { RxGroupsShelf } from '@/components/clinical/rx-groups-shelf';
import type { RxGroupView } from '@/lib/services/rx-groups';

describe('Rx-Groups Consultation UI Integration', () => {
  const mockGroups: RxGroupView[] = [
    {
      id: 'grp-uri',
      name: 'Upper Respiratory Infection (URI) Pack',
      description: '5-day bacterial URI regimen',
      category: 'respiratory',
      doctorId: null,
      isPersonal: false,
      defaultDiagnosis: 'Acute Upper Respiratory Tract Infection',
      defaultAdvice: 'Steam inhalation twice daily, warm fluids',
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
  ];

  it('renders Rx-Groups shelf on consultation screen and shows protocol badges', () => {
    const html = renderToString(
      <RxGroupsShelf
        groups={mockGroups}
        onApplyGroup={vi.fn()}
        canSaveCurrentAsGroup={true}
        onOpenSaveModal={vi.fn()}
      />,
    );

    expect(html).toContain('Rx-Groups (1-Click Protocols)');
    expect(html).toContain('Upper Respiratory Infection (URI) Pack');
    expect(html).toContain('Save as Rx-Group');
  });
});
