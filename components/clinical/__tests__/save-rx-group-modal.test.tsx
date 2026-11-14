import { describe, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import React from 'react';
import { SaveRxGroupModal } from '../save-rx-group-modal';
import type { DraftLine } from '@/lib/domain/consultation';

describe('SaveRxGroupModal Component', () => {
  const mockLines: DraftLine[] = [
    {
      medicineId: 'med-amox',
      medicineLabel: 'Amoxicillin 500mg',
      dose: '1 tablet',
      frequency: '1-0-1',
      durationDays: 5,
      instructions: 'After food',
    },
    {
      medicineId: 'med-pcm',
      medicineLabel: 'Paracetamol 650mg',
      dose: '1 tablet',
      frequency: 'SOS',
      durationDays: 5,
      instructions: 'After food',
    },
  ];

  it('renders modal with group name input, pre-populated diagnosis, and medication summary when open', () => {
    const html = renderToString(
      <SaveRxGroupModal
        isOpen={true}
        onClose={vi.fn()}
        items={mockLines}
        currentDiagnosis="Acute Pharyngitis"
        currentAdvice="Warm saline gargles"
        onSave={vi.fn()}
      />,
    );

    expect(html).toContain('Save as Reusable Rx-Group');
    expect(html).toContain('Template Name');
    expect(html).toContain('Acute Pharyngitis');
    expect(html).toContain('Warm saline gargles');
    expect(html).toContain('Amoxicillin 500mg');
    expect(html).toContain('Paracetamol 650mg');
    expect(html).toContain('Save Rx-Group');
  });

  it('does not render when isOpen is false', () => {
    const html = renderToString(
      <SaveRxGroupModal
        isOpen={false}
        onClose={vi.fn()}
        items={mockLines}
        onSave={vi.fn()}
      />,
    );

    expect(html).toBe('');
  });
});
