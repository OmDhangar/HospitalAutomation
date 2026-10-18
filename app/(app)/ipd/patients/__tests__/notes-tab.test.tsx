import { describe, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import React from 'react';
import { NotesTab, type ClinicalNoteItem } from '@/components/ipd/notes/notes-tab';

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
  }),
}));

describe('NotesTab Component', () => {
  const dummyNotes: ClinicalNoteItem[] = [
    {
      id: 'note-1',
      admissionId: 'adm-101',
      noteType: 'SOAP',
      authorName: 'Dr. Amit Mehra',
      authorRole: 'doctor',
      createdAt: new Date('2026-10-13T10:30:00Z'),
      soapS: 'Patient reports improved appetite, no vomiting since morning.',
      soapO: 'Afebrile, pulse 76 regular, chest clear, abdomen soft non-tender.',
      soapA: 'Acute gastroenteritis resolving.',
      soapP: 'Step down IV fluids to 500ml maintenance, switch to oral fluids, plan discharge tomorrow.',
    },
    {
      id: 'note-2',
      admissionId: 'adm-101',
      noteType: 'NURSING',
      authorName: 'Staff Nurse Pooja',
      authorRole: 'nurse',
      createdAt: new Date('2026-10-13T14:00:00Z'),
      body: 'Patient tolerated light khichdi meal. Vital signs stable. IV cannula site clean and patent.',
    },
  ];

  it('renders progress notes list, SOAP breakdown, author badges, and add note trigger', () => {
    const html = renderToString(
      <NotesTab
        admissionId="adm-101"
        notes={dummyNotes}
        canAddNote={true}
      />,
    );

    // Expect note headers and authors
    expect(html).toContain('Dr. Amit Mehra');
    expect(html).toContain('Staff Nurse Pooja');
    expect(html).toContain('Doctor Rounds (SOAP)');
    expect(html).toContain('Nursing Note');

    // Expect SOAP contents
    expect(html).toContain('Patient reports improved appetite');
    expect(html).toContain('Acute gastroenteritis resolving');
    expect(html).toContain('Step down IV fluids');

    // Expect trigger
    expect(html).toContain('+ Add Clinical Note');
  });
});
