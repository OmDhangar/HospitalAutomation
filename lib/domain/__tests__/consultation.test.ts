import { describe, expect, it } from 'vitest';
import {
  LIMITS,
  isEmptyConsultation,
  parseConsultation,
  parseDraft,
  samePrescription,
  type ConsultationInput,
} from '../consultation';

const MED_A = '5f0c6a8e-3b1d-4c8e-9a2f-1d2e3f4a5b6c';
const MED_B = '7a1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d';

const line = (overrides: Partial<ConsultationInput['items'][number]> = {}) => ({
  medicineId: MED_A,
  dose: '1 tab',
  frequency: '1-0-1',
  durationDays: 5,
  instructions: 'After food',
  ...overrides,
});

const consultation = (overrides: Partial<ConsultationInput> = {}): ConsultationInput => ({
  diagnosis: 'Viral fever',
  notes: '',
  items: [line()],
  advice: '',
  followUpOn: null,
  ...overrides,
});

describe('parseConsultation', () => {
  it('accepts a complete consultation and tidies its text', () => {
    const result = parseConsultation(
      consultation({ diagnosis: '  Viral   fever ', items: [line({ dose: ' 1  tab ' })] }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.diagnosis).toBe('Viral fever');
    expect(result.value.items[0].dose).toBe('1 tab');
  });

  it('keeps line breaks in notes and advice', () => {
    const result = parseConsultation(consultation({ notes: 'Fever 3 days\nCough', advice: 'Rest\nFluids' }));
    expect(result.ok && result.value.notes).toBe('Fever 3 days\nCough');
  });

  it('accepts a diagnosis with no prescription, and a prescription with no diagnosis', () => {
    expect(parseConsultation(consultation({ items: [] })).ok).toBe(true);
    expect(parseConsultation(consultation({ diagnosis: '' })).ok).toBe(true);
  });

  it('refuses an empty consultation', () => {
    const result = parseConsultation(consultation({ diagnosis: '  ', items: [] }));
    expect(result).toEqual({ ok: false, error: 'Nothing to save yet' });
  });

  it('names the line and the field that is missing', () => {
    const result = parseConsultation(consultation({ items: [line(), line({ medicineId: MED_B, dose: '' })] }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('Medicine 2');
    expect(result.error).toContain('dose');
  });

  it('refuses a medicine that was typed rather than picked', () => {
    const result = parseConsultation(consultation({ items: [line({ medicineId: 'Paracetamol' })] }));
    expect(result.ok).toBe(false);
  });

  it('refuses the same medicine twice', () => {
    const result = parseConsultation(consultation({ items: [line(), line({ dose: '2 tab' })] }));
    expect(result.ok).toBe(false);
  });

  it('enforces the limits the database also enforces', () => {
    expect(parseConsultation(consultation({ diagnosis: 'x'.repeat(LIMITS.diagnosis + 1) })).ok).toBe(false);
    expect(parseConsultation(consultation({ items: [line({ durationDays: 0 })] })).ok).toBe(false);
    expect(parseConsultation(consultation({ items: [line({ durationDays: 366 })] })).ok).toBe(false);
    expect(parseConsultation(consultation({ followUpOn: 'next week' })).ok).toBe(false);
    expect(parseConsultation(consultation({ followUpOn: '2026-10-07' })).ok).toBe(true);
  });
});

describe('parseDraft', () => {
  it('accepts half-written work, which is what a draft is for', () => {
    const result = parseDraft({
      diagnosis: '',
      notes: '',
      items: [{ ...line({ dose: '', frequency: '' }), medicineLabel: 'Paracetamol 500 mg tablet' }],
      advice: '',
      followUpOn: null,
    });
    expect(result.ok).toBe(true);
  });

  it('refuses something that is not a draft at all', () => {
    expect(parseDraft({ items: 'lots' }).ok).toBe(false);
    expect(parseDraft({ diagnosis: 'x'.repeat(10_000), notes: '', items: [], advice: '', followUpOn: null }).ok).toBe(false);
  });
});

describe('isEmptyConsultation', () => {
  it('treats whitespace as nothing', () => {
    expect(isEmptyConsultation({ diagnosis: ' ', notes: '\n', items: [], advice: '', followUpOn: null })).toBe(true);
    expect(isEmptyConsultation({ diagnosis: '', notes: '', items: [], advice: '', followUpOn: '2026-10-07' })).toBe(false);
  });
});

describe('samePrescription', () => {
  const base = { items: [line()], advice: 'Rest', followUpOn: null };

  it('is true for an unchanged prescription, so Save twice is not a revision', () => {
    expect(samePrescription(base, { ...base, items: [line()] })).toBe(true);
  });

  it('notices any change a patient would read', () => {
    expect(samePrescription(base, { ...base, items: [line({ dose: '2 tab' })] })).toBe(false);
    expect(samePrescription(base, { ...base, advice: 'Rest well' })).toBe(false);
    expect(samePrescription(base, { ...base, followUpOn: '2026-10-07' })).toBe(false);
    expect(samePrescription(base, { ...base, items: [] })).toBe(false);
  });

  it('treats a new order of lines as a change, because the printout changes', () => {
    const two = { ...base, items: [line(), line({ medicineId: MED_B })] };
    expect(samePrescription(two, { ...two, items: [...two.items].reverse() })).toBe(false);
  });
});
