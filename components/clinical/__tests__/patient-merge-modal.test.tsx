import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import { ToastProvider } from '@/components/toast';
import { PatientMergeModal } from '../patient-merge-modal';

describe('<PatientMergeModal /> Component', () => {
  it('renders nothing when isOpen is false', () => {
    const html = renderToString(
      <ToastProvider>
        <PatientMergeModal
          isOpen={false}
          onClose={vi.fn()}
        />
      </ToastProvider>,
    );
    expect(html).not.toContain('Merge Duplicate Patient Records');
  });

  it('renders dialog with source and target patient sections when isOpen is true', () => {
    const source = {
      id: 'p1',
      name: 'Ramesh Patil (Dup)',
      mrn: 'QR-2026-00042',
      phoneE164: '+919876543210',
      age: 42,
      gender: 'M',
      qid: null,
      address: null,
    };
    const target = {
      id: 'p2',
      name: 'Ramesh Patil (Master)',
      mrn: 'QR-2026-00001',
      phoneE164: '+919876543210',
      age: 42,
      gender: 'M',
      qid: null,
      address: null,
    };

    const html = renderToString(
      <ToastProvider>
        <PatientMergeModal
          isOpen={true}
          onClose={vi.fn()}
          sourcePatient={source}
          targetPatient={target}
        />
      </ToastProvider>,
    );

    expect(html).toContain('Merge Duplicate Patient Records');
    expect(html).toContain('Source (Duplicate)');
    expect(html).toContain('Ramesh Patil (Dup)');
    expect(html).toContain('Target (Survivor / Master)');
    expect(html).toContain('Ramesh Patil (Master)');
    expect(html).toContain('Confirm &amp; Execute Merge');
  });
});
