import { describe, expect, it } from 'vitest';
import { chartAction, generalExamText, parseNote, parseNoteVitals, sameVitals, vitalsText } from '@/lib/domain/notes';

const now = new Date('2026-10-11T06:00:00Z');

describe('doctor’s notes', () => {
  it('parses a case sheet in the paper’s sections', () => {
    const note = parseNote(
      {
        kind: 'admission',
        seenAt: '2026-10-11T05:30:00Z',
        caseOf: ' Acute gastroenteritis ',
        complaints: [{ text: 'Loose motions', duration: '2 days' }, { text: '', duration: '' }, { text: 'Vomiting', duration: '' }],
        history: 'Started after a wedding meal.\n\n\n\nNo blood.',
        generalExam: { pallor: 'absent', icterus: 'present', cyanosis: 'maybe', other: 'Dry tongue' },
        vitals: { pulse: '104', bp: '100/60', temp: '37.8', spo2: '', rr: '' },
        systemicExam: { cns: 'Conscious, oriented', rs: 'NAD', pa: '', cvs: 'S1S2 heard' },
        advice: 'IV fluids, ORS',
      },
      now,
    );
    expect(note).toMatchObject({
      kind: 'admission',
      caseOf: 'Acute gastroenteritis',
      complaints: [{ text: 'Loose motions', duration: '2 days' }, { text: 'Vomiting', duration: null }],
      history: 'Started after a wedding meal.\n\nNo blood.',
      generalExam: { pallor: 'absent', icterus: 'present', other: 'Dry tongue' },
      vitals: { pulse: 104, bpSystolic: 100, bpDiastolic: 60, tempFTenths: 1000 },
      systemicExam: { cns: 'Conscious, oriented', rs: 'NAD', cvs: 'S1S2 heard' },
    });
    expect(generalExamText(note.generalExam)).toBe('Pallor −, Icterus +, Dry tongue');
    expect(vitalsText(note.vitals)).toBe('P 104 · BP 100/60 · T 100.0 °F');
  });

  it('refuses a note with nothing in it, a future time, or a wrong vital', () => {
    expect(() => parseNote({ kind: 'admission', complaints: [] }, now)).toThrow(/what the patient came with/);
    expect(() => parseNote({ kind: 'progress' }, now)).toThrow(/progress or the advice/);
    expect(() => parseNote({ kind: 'progress', progress: 'Better', seenAt: '2026-10-11T07:00:00Z' }, now)).toThrow(/future/);
    expect(() => parseNoteVitals({ bp: '80/120' })).toThrow(/B.P./);
    expect(() => parseNoteVitals({ pulse: '400' })).toThrow(/Pulse/);
  });

  it('confirms a recent chart reading kept as is, writes one when changed or missing', () => {
    const recent = { id: 'r1', vitals: { pulse: 88, bpSystolic: 120, bpDiastolic: 80 } };
    expect(chartAction({}, recent)).toEqual({ kind: 'none' });
    expect(chartAction({ pulse: 88, bpSystolic: 120, bpDiastolic: 80 }, recent)).toEqual({ kind: 'confirm', entryId: 'r1' });
    expect(chartAction({ pulse: 92, bpSystolic: 120, bpDiastolic: 80 }, recent)).toEqual({ kind: 'write' });
    expect(chartAction({ pulse: 88 }, null)).toEqual({ kind: 'write' });
    expect(sameVitals({ pulse: 88 }, { pulse: 88, spo2: 97 })).toBe(false);
  });
});
