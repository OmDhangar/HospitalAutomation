import { describe, expect, it } from 'vitest';
import { allergyStatus, classOf, classOfAllergy, matchAllergies, parseAllergy, type PatientAllergy } from '@/lib/domain/allergy';
import { depositAlert, depositAlertSettingsFrom } from '@/lib/domain/discharge-bill';
import { goingHome, isDecisionFor, medRecProgress, parseMedRecItem } from '@/lib/domain/medrec';

const allergy = (substance: string, extra: Partial<PatientAllergy> = {}): PatientAllergy => ({
  id: substance,
  substance,
  category: 'drug',
  drugClass: classOfAllergy(substance),
  medicineId: null,
  severity: 'unknown',
  ...extra,
});

describe('allergy classes', () => {
  it('knows the classes the plan names, by generic and Indian brand names', () => {
    expect(classOf('Augmentin 625')).toBe('penicillins');
    expect(classOf('Amoxicillin + Clavulanic acid')).toBe('penicillins');
    expect(classOf('Ceftriaxone 1 g injection')).toBe('cephalosporins');
    expect(classOf('Septran DS')).toBe('sulfa');
    expect(classOf('Combiflam')).toBe('nsaids');
    expect(classOf('Ecosprin 75')).toBe('aspirin');
    expect(classOf('Paracetamol 500')).toBeNull();
    expect(classOf('Moxifloxacin')).toBeNull();
    expect(classOfAllergy('Sulpha drugs')).toBe('sulfa');
    expect(classOfAllergy('pain killers')).toBe('nsaids');
  });

  it('parses an allergy as typed, finding its class', () => {
    expect(parseAllergy({ substance: '  Penicillin ', severity: 'severe', reaction: 'face swelling' })).toEqual({
      substance: 'Penicillin', category: 'drug', reaction: 'face swelling', severity: 'severe', source: 'patient', drugClass: 'penicillins',
    });
    expect(parseAllergy({ substance: 'Peanuts', category: 'food' }).drugClass).toBeNull();
    expect(() => parseAllergy({ substance: 'x' })).toThrow(/allergic to/);
    expect(() => parseAllergy({ substance: 'Penicillin', severity: 'deadly' })).toThrow(/severe/);
  });
});

describe('matching a medicine line against allergies', () => {
  it('matches the same medicine, the same name, or the same class — never food', () => {
    const list = [allergy('Penicillin', { severity: 'severe' }), allergy('Brufen'), allergy('Peanuts', { category: 'food', drugClass: null }), allergy('Ceftriaxone', { medicineId: 'm-cef' })];
    expect(matchAllergies(list, { id: 'm1', name: 'Augmentin 625 Duo' }).map((m) => [m.substance, m.why])).toEqual([['Penicillin', 'same class: Penicillins']]);
    expect(matchAllergies(list, { id: 'm2', name: 'Ibuprofen 400', genericName: null }).map((m) => m.why)).toEqual(['same class: NSAIDs (pain killers)']);
    expect(matchAllergies(list, { id: 'm3', name: 'Tab Brufen 400' }).map((m) => m.why)).toEqual(['same name']);
    expect(matchAllergies(list, { id: 'm-cef', name: 'Monocef 1g' }).map((m) => m.why)).toEqual(['same medicine']);
    expect(matchAllergies(list, { id: 'm4', name: 'Peanut oil drops' })).toEqual([]);
    expect(matchAllergies(list, { id: 'm5', name: 'Paracetamol 650' })).toEqual([]);
  });

  it('says on the banner what is known', () => {
    const at = new Date('2026-10-11T05:00:00Z');
    expect(allergyStatus([], null)).toEqual({ kind: 'not_asked' });
    expect(allergyStatus([], { outcome: 'nkda', at })).toEqual({ kind: 'nkda', at });
    expect(allergyStatus([{ severity: 'severe' }, { severity: 'mild' }], { outcome: 'nkda', at })).toEqual({ kind: 'allergies', count: 2, severe: true });
  });
});

describe('medication reconciliation', () => {
  it('decisions per phase, progress, and what goes home', () => {
    expect(isDecisionFor('admission', 'hold')).toBe(true);
    expect(isDecisionFor('discharge', 'hold')).toBe(false);
    expect(isDecisionFor('discharge', 'new')).toBe(true);
    expect(medRecProgress([{ decision: 'continue' }, { decision: null }])).toEqual({ total: 2, decided: 1, complete: false });
    expect(medRecProgress([])).toEqual({ total: 0, decided: 0, complete: true });
    const list = [{ decision: 'continue' as const }, { decision: 'stop' as const }, { decision: 'new' as const }, { decision: 'change' as const }];
    expect(goingHome(list).map((i) => i.decision)).toEqual(['continue', 'new', 'change']);
    expect(parseMedRecItem({ name: ' Tab Metformin 500 ', dose: '1', frequency: '' })).toEqual({ name: 'Tab Metformin 500', dose: '1', frequency: null, route: null, duration: null });
    expect(() => parseMedRecItem({ name: '' })).toThrow(/medicine/);
  });
});

describe('deposit alert (D-DEP)', () => {
  const settings = depositAlertSettingsFrom(null);
  it('80% of the deposit used, or more than ₹5,000 owed', () => {
    expect(settings).toEqual({ usedPct: 80, balancePaise: 500_000 });
    expect(depositAlert({ totalPaise: 0, paidPaise: 1_000_000, settings })).toBeNull();
    expect(depositAlert({ totalPaise: 700_000, paidPaise: 1_000_000, settings })).toBeNull();
    expect(depositAlert({ totalPaise: 800_000, paidPaise: 1_000_000, settings })).toEqual({ reason: 'used', usedPct: 80, balancePaise: -200_000 });
    expect(depositAlert({ totalPaise: 1_600_000, paidPaise: 1_000_000, settings })).toEqual({ reason: 'owed', usedPct: 160, balancePaise: 600_000 });
    expect(depositAlert({ totalPaise: 300_000, paidPaise: 0, settings })).toBeNull();
    expect(depositAlert({ totalPaise: 600_000, paidPaise: 0, settings })).toEqual({ reason: 'owed', usedPct: null, balancePaise: 600_000 });
  });
  it('takes the hospital’s own limits, within bounds', () => {
    expect(depositAlertSettingsFrom({ usedPct: 90, balanceRupees: 2000 })).toEqual({ usedPct: 90, balancePaise: 200_000 });
    expect(depositAlertSettingsFrom({ usedPct: 10, balanceRupees: -5 })).toEqual({ usedPct: 80, balancePaise: 500_000 });
  });
});
