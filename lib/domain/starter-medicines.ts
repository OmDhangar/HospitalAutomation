/**
 * Common OPD and ward medicines, offered to a hospital as a one-click starting
 * catalogue so the doctor's search is useful on day one (decision D19).
 *
 * Generic names, strengths and forms only. Deliberately no prices and no
 * dosing: the price is the owner's decision, and the dose is the doctor's.
 * Everything here is added unpriced, which means prescribable immediately and
 * billable only once the owner sets a price.
 *
 * `unit` is what one unit of quantity means on an IPD bill.
 */
export type StarterMedicine = {
  name: string;
  strength: string | null;
  form: string;
  unit: string;
};

const m = (name: string, strength: string | null, form: string, unit: string): StarterMedicine => ({
  name,
  strength,
  form,
  unit,
});

export const STARTER_MEDICINES: readonly StarterMedicine[] = [
  // Fever and pain
  m('Paracetamol', '500 mg', 'tablet', 'tablet'),
  m('Paracetamol', '650 mg', 'tablet', 'tablet'),
  m('Paracetamol', '125 mg/5 ml', 'syrup', 'bottle'),
  m('Ibuprofen', '400 mg', 'tablet', 'tablet'),
  m('Diclofenac', '50 mg', 'tablet', 'tablet'),
  m('Aceclofenac', '100 mg', 'tablet', 'tablet'),

  // Antibiotics and anti-infectives
  m('Amoxicillin', '500 mg', 'capsule', 'capsule'),
  m('Amoxicillin + Clavulanic acid', '625 mg', 'tablet', 'tablet'),
  m('Azithromycin', '500 mg', 'tablet', 'tablet'),
  m('Azithromycin', '250 mg', 'tablet', 'tablet'),
  m('Cefixime', '200 mg', 'tablet', 'tablet'),
  m('Ciprofloxacin', '500 mg', 'tablet', 'tablet'),
  m('Ofloxacin', '200 mg', 'tablet', 'tablet'),
  m('Metronidazole', '400 mg', 'tablet', 'tablet'),
  m('Doxycycline', '100 mg', 'capsule', 'capsule'),
  m('Fluconazole', '150 mg', 'tablet', 'tablet'),
  m('Albendazole', '400 mg', 'tablet', 'tablet'),

  // Allergy and respiratory
  m('Cetirizine', '10 mg', 'tablet', 'tablet'),
  m('Levocetirizine', '5 mg', 'tablet', 'tablet'),
  m('Montelukast', '10 mg', 'tablet', 'tablet'),
  m('Chlorpheniramine', '4 mg', 'tablet', 'tablet'),
  m('Salbutamol', '4 mg', 'tablet', 'tablet'),
  m('Salbutamol', '100 mcg', 'inhaler', 'inhaler'),
  m('Ambroxol', '30 mg/5 ml', 'syrup', 'bottle'),
  m('Dextromethorphan', '10 mg/5 ml', 'syrup', 'bottle'),

  // Stomach
  m('Pantoprazole', '40 mg', 'tablet', 'tablet'),
  m('Omeprazole', '20 mg', 'capsule', 'capsule'),
  m('Rabeprazole', '20 mg', 'tablet', 'tablet'),
  m('Domperidone', '10 mg', 'tablet', 'tablet'),
  m('Ondansetron', '4 mg', 'tablet', 'tablet'),
  m('Dicyclomine', '10 mg', 'tablet', 'tablet'),
  m('Loperamide', '2 mg', 'capsule', 'capsule'),
  m('Oral rehydration salts', null, 'sachet', 'sachet'),

  // Chronic conditions
  m('Metformin', '500 mg', 'tablet', 'tablet'),
  m('Glimepiride', '1 mg', 'tablet', 'tablet'),
  m('Amlodipine', '5 mg', 'tablet', 'tablet'),
  m('Telmisartan', '40 mg', 'tablet', 'tablet'),
  m('Losartan', '50 mg', 'tablet', 'tablet'),
  m('Atenolol', '50 mg', 'tablet', 'tablet'),
  m('Atorvastatin', '10 mg', 'tablet', 'tablet'),
  m('Aspirin', '75 mg', 'tablet', 'tablet'),
  m('Clopidogrel', '75 mg', 'tablet', 'tablet'),
  m('Levothyroxine', '50 mcg', 'tablet', 'tablet'),
  m('Prednisolone', '10 mg', 'tablet', 'tablet'),

  // Supplements
  m('Folic acid', '5 mg', 'tablet', 'tablet'),
  m('Ferrous sulphate + Folic acid', null, 'tablet', 'tablet'),
  m('Calcium + Vitamin D3', null, 'tablet', 'tablet'),
  m('Vitamin D3', '60000 IU', 'capsule', 'capsule'),
  m('Vitamin B complex', null, 'tablet', 'tablet'),
  m('Multivitamin', null, 'tablet', 'tablet'),
  m('Zinc', '20 mg', 'tablet', 'tablet'),

  // Topical and eye
  m('Clotrimazole', '1%', 'cream', 'tube'),
  m('Mupirocin', '2%', 'ointment', 'tube'),
  m('Silver sulfadiazine', '1%', 'cream', 'tube'),
  m('Povidone iodine', '5%', 'ointment', 'tube'),
  m('Ciprofloxacin', '0.3%', 'eye drops', 'bottle'),

  // Injections and fluids, for the ward
  m('Diclofenac', '75 mg/3 ml', 'injection', 'ampoule'),
  m('Ondansetron', '2 mg/ml', 'injection', 'ampoule'),
  m('Pantoprazole', '40 mg', 'injection', 'vial'),
  m('Ceftriaxone', '1 g', 'injection', 'vial'),
  m('Dexamethasone', '4 mg/ml', 'injection', 'ampoule'),
  m('Normal saline', '0.9% 500 ml', 'IV fluid', 'bottle'),
  m('Ringer lactate', '500 ml', 'IV fluid', 'bottle'),
  m('Dextrose', '5% 500 ml', 'IV fluid', 'bottle'),
];
