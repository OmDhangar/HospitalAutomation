import type { ChargeItemKind } from './ipd-config';

/**
 * Common IPD consumables, procedures, services, tests and room charges,
 * loaded into every new hospital so a nurse picks instead of typing on day
 * one (IPD plan §5.8, decision D-SC). The IPD twin of STARTER_MEDICINES.
 *
 * Names and units only, deliberately no prices: the price is the owner's
 * decision, entered on one "Set prices" screen. Everything here is loaded
 * unpriced, which means it can be recorded at the bedside immediately and is
 * billed once the owner prices it.
 *
 * Order matters: within each kind, most common first. The nurse's "Common in
 * this ward" and the doctor's Tests chips fall back to this order until a
 * ward or doctor has history of their own.
 *
 * Indicative, to be checked against the pilot's price list in Stage 0.
 */
export type StarterChargeItem = {
  kind: ChargeItemKind;
  name: string;
  unit: string;
  isTest: boolean;
};

const c = (name: string, unit: string): StarterChargeItem => ({
  kind: 'consumable',
  name,
  unit,
  isTest: false,
});
const p = (name: string): StarterChargeItem => ({ kind: 'procedure', name, unit: 'each', isTest: false });
const s = (name: string, unit: string): StarterChargeItem => ({
  kind: 'service',
  name,
  unit,
  isTest: false,
});
const t = (name: string): StarterChargeItem => ({ kind: 'service', name, unit: 'test', isTest: true });
const r = (name: string): StarterChargeItem => ({ kind: 'room', name, unit: 'day', isTest: false });

export const STARTER_CHARGE_ITEMS: readonly StarterChargeItem[] = [
  // Consumables
  c('Syringe 5 ml', 'syringe'),
  c('Syringe 2 ml', 'syringe'),
  c('Syringe 10 ml', 'syringe'),
  c('IV cannula 20G', 'cannula'),
  c('IV cannula 22G', 'cannula'),
  c('IV cannula 18G', 'cannula'),
  c('IV set', 'set'),
  c('Gloves', 'pair'),
  c('Gauze / cotton', 'pack'),
  c('Micropore tape', 'roll'),
  c('Dressing set', 'set'),
  c('Urine bag', 'bag'),
  c('Foley catheter', 'catheter'),
  c("Ryle's tube", 'tube'),
  c('Oxygen mask', 'mask'),
  c('Nebuliser mask', 'mask'),
  c('Blood transfusion set', 'set'),
  c('3-way stopcock', 'unit'),

  // Procedures
  p('Injection charge'),
  p('IV cannulation'),
  p('Nebulisation'),
  p('Dressing (small)'),
  p('Dressing (large)'),
  p('Catheterisation'),
  p("Ryle's tube insertion"),
  p('Suturing'),
  p('Enema'),

  // Services
  s('Doctor visit', 'visit'),
  s('Specialist visit', 'visit'),
  s('Nursing charge', 'day'),
  s('Oxygen', 'hour'),
  s('Cardiac monitor', 'day'),
  s('ECG', 'each'),
  s('GRBS (blood sugar, bedside)', 'each'),

  // Tests
  t('CBC'),
  t('Blood sugar (fasting)'),
  t('Blood sugar (PP)'),
  t('Urine routine'),
  t('KFT (RFT)'),
  t('LFT'),
  t('Serum electrolytes'),
  t('CRP'),
  t('HbA1c'),
  t('X-ray chest'),
  t('USG abdomen'),
  t('Dengue NS1'),
  t('Malaria antigen'),
  t('Widal'),

  // Room charges
  r('General ward bed'),
  r('Semi-private room'),
  r('Private room'),
  r('ICU bed'),
];
