import { describe, expect, it } from 'vitest';
import {
  GLOBAL_MEDICINES_DATA,
  type GlobalMedicine,
  searchGlobalMedicinesData,
} from '@/lib/domain/global-medicines-data';

describe('global-medicines domain dataset', () => {
  it('contains more than 80 essential clinical medicines', () => {
    expect(GLOBAL_MEDICINES_DATA.length).toBeGreaterThan(80);
  });

  it('contains medicines from critical hospital therapeutic classes', () => {
    const categories = new Set(GLOBAL_MEDICINES_DATA.map((m) => m.category));
    expect(categories.has('Antibiotics')).toBe(true);
    expect(categories.has('Analgesics & Pain Relief')).toBe(true);
    expect(categories.has('IV Fluids')).toBe(true);
    expect(categories.has('Gastrointestinal & Antacids')).toBe(true);
    expect(categories.has('Emergency & Steroids')).toBe(true);
    expect(categories.has('Cardiovascular')).toBe(true);
    expect(categories.has('Respiratory')).toBe(true);
  });

  it('includes standard high-frequency hospital medicines with default units and routes', () => {
    const augmentin = GLOBAL_MEDICINES_DATA.find((m) => m.name.toLowerCase().includes('augmentin'));
    expect(augmentin).toBeDefined();
    expect(augmentin?.form).toBeDefined();

    const ceftriaxone = GLOBAL_MEDICINES_DATA.find((m) => m.name.toLowerCase().includes('ceftriaxone'));
    expect(ceftriaxone).toBeDefined();
    expect(ceftriaxone?.defaultRoute).toBe('iv_push');

    const rl = GLOBAL_MEDICINES_DATA.find((m) => m.name.toLowerCase().includes('ringer lactate'));
    expect(rl).toBeDefined();
    expect(rl?.category).toBe('IV Fluids');

    const hydrocortisone = GLOBAL_MEDICINES_DATA.find((m) => m.name.toLowerCase().includes('hydrocortisone'));
    expect(hydrocortisone).toBeDefined();
    expect(hydrocortisone?.defaultRoute).toBe('iv_push');
  });

  it('searches global medicine dataset by prefix or generic name', () => {
    const results = searchGlobalMedicinesData('ceftr', 5);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].name.toLowerCase()).toContain('ceftriaxone');

    const pcm = searchGlobalMedicinesData('paracetamol', 5);
    expect(pcm.length).toBeGreaterThanOrEqual(1);
    expect(pcm[0].genericName?.toLowerCase()).toContain('paracetamol');
  });
});
