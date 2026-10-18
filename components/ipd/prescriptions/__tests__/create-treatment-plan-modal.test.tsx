import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import React from 'react';
import { CreateTreatmentPlanModal } from '../create-treatment-plan-modal';

describe('CreateTreatmentPlanModal Component', () => {
  it('renders modal with disease diagnosis, common presets, and save button when open without active orders', () => {
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
    expect(html).toContain('New Prescriptions to Add (0)');
  });

  it('renders active prescriptions section and dynamic title when activeOrders are provided', () => {
    const mockActiveOrders = [
      {
        id: 'ord-1',
        medicineName: 'Ceftriaxone 1g IV',
        strength: '1 g',
        form: 'Injection',
        route: 'iv_push',
        frequency: 'BD',
      },
      {
        id: 'ord-2',
        medicineName: 'Hydrocortisone 100mg IV',
        strength: '100 mg',
        form: 'Injection',
        route: 'iv_push',
        frequency: 'TDS',
      },
      {
        id: 'ord-3',
        medicineName: 'Pantoprazole 40mg IV',
        strength: '40 mg',
        form: 'Injection',
        route: 'iv_push',
        frequency: 'OD',
      },
    ];

    const html = renderToString(
      <CreateTreatmentPlanModal
        admissionId="adm-101"
        isOpen={true}
        onClose={() => {}}
        patientName="Kavita Shinde"
        activeOrders={mockActiveOrders}
      />,
    );

    // Dynamic title indicating addition to existing plan
    expect(html).toContain('Add Prescriptions to Treatment Plan');
    expect(html).toContain('3 continuing medications');

    // Shows currently active prescriptions
    expect(html).toContain('Currently Active Prescriptions (3)');
    expect(html).toContain('Ceftriaxone 1g IV');
    expect(html).toContain('Hydrocortisone 100mg IV');
    expect(html).toContain('Pantoprazole 40mg IV');
    expect(html).toContain('These active medications will continue running at bedside');

    // New prescriptions staging area is clearly differentiated
    expect(html).toContain('New Prescriptions to Add (0)');
    expect(html).toContain('Add Prescriptions to Active Plan');
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
