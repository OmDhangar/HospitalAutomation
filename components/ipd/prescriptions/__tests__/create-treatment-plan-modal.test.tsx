import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import React from 'react';
import { CreateTreatmentPlanModal } from '../create-treatment-plan-modal';

describe('CreateTreatmentPlanModal Component', () => {
  it('renders modal with disease diagnosis, common presets, and save button when open', () => {
    const html = renderToString(
      <CreateTreatmentPlanModal
        admissionId="adm-101"
        isOpen={true}
        onClose={() => {}}
        patientName="Kavita Shinde"
        initialDiagnosis="Acute Gastroenteritis"
      />,
    );

    expect(html).toContain('Create IPD Treatment Plan &amp; Prescriptions');
    expect(html).toContain('Kavita Shinde');
    expect(html).toContain('Working Diagnosis / Disease Condition');
    expect(html).toContain('Acute Gastroenteritis');
    expect(html).toContain('1-Click Common IPD Presets');
    expect(html).toContain('RL 500ml IV');
    expect(html).toContain('Pantoprazole 40mg IV');
    expect(html).toContain('Ceftriaxone 1g IV');
    expect(html).toContain('Add to Plan');
    expect(html).toContain('Save &amp; Start Treatment Plan');
  });

  it('renders nothing when isOpen is false', () => {
    const html = renderToString(
      <CreateTreatmentPlanModal
        admissionId="adm-101"
        isOpen={false}
        onClose={() => {}}
      />,
    );

    expect(html).toBe('');
  });
});
