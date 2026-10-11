import { describe, expect, it } from 'vitest';
import { DEFAULT_WARNING_SIGNS, buildDraft, parseSummary, refreshFromRecord, type SummarySources } from '@/lib/domain/discharge-summary';

const TZ = 'Asia/Kolkata';
const at = (iso: string) => new Date(iso);

const sources: SummarySources = {
  reason: 'Fever and cough',
  caseNote: {
    caseOf: 'Community acquired pneumonia',
    complaints: [{ text: 'Fever', duration: '5 days' }, { text: 'Cough', duration: null }],
    history: 'High grade fever with chills.',
    pastHistory: 'Diabetic on metformin',
    examination: 'P 104 · BP 110/70\nRS: Right basal crepts',
  },
  tests: [
    { name: 'CBC', status: 'reported', at: at('2026-10-09T05:00:00Z') },
    { name: 'Chest X-ray', status: 'ordered', at: at('2026-10-09T06:00:00Z') },
    { name: 'Sputum culture', status: 'not_coming', at: at('2026-10-10T06:00:00Z') },
  ],
  treatment: [
    { description: 'Ceftriaxone 1 g injection', dose: '1 g', route: 'iv', frequency: 'BD', startedAt: at('2026-10-09T06:00:00Z'), stoppedAt: at('2026-10-11T04:00:00Z') },
    { description: 'Paracetamol 500 mg tablet', dose: '1 tab', route: 'oral', frequency: 'SOS', startedAt: at('2026-10-09T06:00:00Z'), stoppedAt: null },
  ],
  progress: [{ at: at('2026-10-10T04:00:00Z'), text: 'Afebrile since morning' }],
  goingHome: null,
  activeCardMedicines: [{ description: 'Paracetamol 500 mg tablet', dose: '1 tab', frequency: 'SOS' }],
};

describe('discharge summary draft', () => {
  it('is built from the record, the same way every time', () => {
    const draft = buildDraft(sources, TZ);
    expect(draft).toMatchObject({
      diagnosis: 'Community acquired pneumonia',
      complaints: 'Fever × 5 days\nCough',
      history: 'High grade fever with chills.\nPast history: Diabetic on metformin',
      findings: 'P 104 · BP 110/70\nRS: Right basal crepts',
      investigations: 'CBC (9 Oct)\nChest X-ray (9 Oct) — pending\nSputum culture (10 Oct) — not done',
      treatmentGiven: 'Ceftriaxone 1 g injection 1 g iv BD (9 Oct to 11 Oct)\nParacetamol 500 mg tablet 1 tab oral SOS (9 Oct onwards)',
      course: '10 Oct: Afebrile since morning',
      medicines: [{ name: 'Paracetamol 500 mg tablet', dose: '1 tab', frequency: 'SOS', duration: '', note: '' }],
      medicinesUnreconciled: true,
      warningSigns: DEFAULT_WARNING_SIGNS,
    });
    expect(buildDraft(sources, TZ)).toEqual(draft);
    const reconciled = buildDraft({ ...sources, goingHome: [{ name: 'Tab Augmentin 625', dose: '1', frequency: 'BD', duration: '5 days', note: null }] }, TZ);
    expect(reconciled.medicinesUnreconciled).toBe(false);
    expect(reconciled.medicines.map((m) => m.name)).toEqual(['Tab Augmentin 625']);
    expect(buildDraft({ ...sources, caseNote: null }, TZ).diagnosis).toBe('Fever and cough');
  });

  it('checks what finalising needs, and refreshes only the record’s sections', () => {
    const draft = buildDraft(sources, TZ);
    expect(() => parseSummary({ ...draft, diagnosis: '' }, { final: true })).toThrow(/diagnosis/);
    expect(() => parseSummary({ ...draft, followUp: '' }, { final: true })).toThrow(/follow-up/);
    expect(parseSummary({ ...draft, dischargeType: 'death', followUp: '', warningSigns: '' }, { final: true }).dischargeType).toBe('death');
    expect(() => parseSummary({ ...draft, dischargeType: 'escaped' })).toThrow(/how the patient left/);
    const parsed = parseSummary({ ...draft, medicines: [...draft.medicines, { name: '  ' }] });
    expect(parsed.medicines).toHaveLength(1);
    const edited = { ...parsed, diagnosis: 'Right lower lobe pneumonia', course: 'Improved on IV antibiotics.' };
    const refreshed = refreshFromRecord(edited, buildDraft({ ...sources, tests: [] }, TZ));
    expect(refreshed).toMatchObject({ diagnosis: 'Right lower lobe pneumonia', course: 'Improved on IV antibiotics.', investigations: '' });
  });
});
