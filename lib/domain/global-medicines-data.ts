/**
 * Comprehensive global catalogue of medicines commonly prescribed across general,
 * inpatient, emergency, and surgical medical practice.
 *
 * Provides a universal master index so doctors receive rich autocomplete suggestions
 * regardless of the hospital tenant, with pre-configured forms, routes, and billing units.
 */

export interface GlobalMedicine {
  name: string;
  genericName: string | null;
  strength: string | null;
  form: string;
  category: string;
  unit: string;
  defaultRoute: 'oral' | 'iv_push' | 'iv_piggyback' | 'im' | 'sc' | 'nebulization' | 'inhalation' | 'sublingual' | 'topical';
  defaultFrequency: string;
}

const g = (
  name: string,
  genericName: string | null,
  strength: string | null,
  form: string,
  category: string,
  unit: string,
  defaultRoute: GlobalMedicine['defaultRoute'] = 'oral',
  defaultFrequency = 'OD',
): GlobalMedicine => ({
  name,
  genericName,
  strength,
  form,
  category,
  unit,
  defaultRoute,
  defaultFrequency,
});

export const GLOBAL_MEDICINES_DATA: readonly GlobalMedicine[] = [
  // -------------------------------------------------------------------------
  // 1. Antibiotics & Anti-infectives
  // -------------------------------------------------------------------------
  g('Augmentin 625mg Tab', 'Amoxicillin + Clavulanic Acid', '625mg', 'Tablet', 'Antibiotics', 'tablet', 'oral', 'BD'),
  g('Augmentin 1.2g Inj', 'Amoxicillin + Clavulanic Acid', '1.2g', 'Injection', 'Antibiotics', 'vial', 'iv_push', 'BD'),
  g('Ceftriaxone 1g Inj', 'Ceftriaxone', '1g', 'Injection', 'Antibiotics', 'vial', 'iv_push', 'OD'),
  g('Ceftriaxone 2g Inj', 'Ceftriaxone', '2g', 'Injection', 'Antibiotics', 'vial', 'iv_push', 'OD'),
  g('Meropenem 1g Inj', 'Meropenem', '1g', 'Injection', 'Antibiotics', 'vial', 'iv_push', 'TDS'),
  g('Piperacillin + Tazobactam 4.5g Inj', 'Piperacillin + Tazobactam', '4.5g', 'Injection', 'Antibiotics', 'vial', 'iv_piggyback', 'TDS'),
  g('Cefoperazone + Sulbactam 1.5g Inj', 'Cefoperazone + Sulbactam', '1.5g', 'Injection', 'Antibiotics', 'vial', 'iv_push', 'BD'),
  g('Metronidazole 500mg IV Infusion', 'Metronidazole', '500mg', 'IV Infusion', 'Antibiotics', 'bottle', 'iv_piggyback', 'TDS'),
  g('Metronidazole 400mg Tab', 'Metronidazole', '400mg', 'Tablet', 'Antibiotics', 'tablet', 'oral', 'TDS'),
  g('Amikacin 500mg Inj', 'Amikacin', '500mg', 'Injection', 'Antibiotics', 'vial', 'iv_push', 'OD'),
  g('Gentamicin 80mg Inj', 'Gentamicin', '80mg', 'Injection', 'Antibiotics', 'ampoule', 'im', 'OD'),
  g('Levofloxacin 500mg IV Infusion', 'Levofloxacin', '500mg', 'IV Infusion', 'Antibiotics', 'bottle', 'iv_piggyback', 'OD'),
  g('Levofloxacin 500mg Tab', 'Levofloxacin', '500mg', 'Tablet', 'Antibiotics', 'tablet', 'oral', 'OD'),
  g('Ciprofloxacin 500mg Tab', 'Ciprofloxacin', '500mg', 'Tablet', 'Antibiotics', 'tablet', 'oral', 'BD'),
  g('Ciprofloxacin 200mg IV Infusion', 'Ciprofloxacin', '200mg', 'IV Infusion', 'Antibiotics', 'bottle', 'iv_piggyback', 'BD'),
  g('Azithromycin 500mg Tab', 'Azithromycin', '500mg', 'Tablet', 'Antibiotics', 'tablet', 'oral', 'OD'),
  g('Azithromycin 500mg IV Inj', 'Azithromycin', '500mg', 'Injection', 'Antibiotics', 'vial', 'iv_piggyback', 'OD'),
  g('Cefixime 200mg Tab', 'Cefixime', '200mg', 'Tablet', 'Antibiotics', 'tablet', 'oral', 'BD'),
  g('Cefuroxime 500mg Tab', 'Cefuroxime Axetil', '500mg', 'Tablet', 'Antibiotics', 'tablet', 'oral', 'BD'),
  g('Cefuroxime 750mg Inj', 'Cefuroxime Sodium', '750mg', 'Injection', 'Antibiotics', 'vial', 'iv_push', 'TDS'),
  g('Doxycycline 100mg Cap', 'Doxycycline', '100mg', 'Capsule', 'Antibiotics', 'capsule', 'oral', 'BD'),
  g('Vancomycin 1g Inj', 'Vancomycin', '1g', 'Injection', 'Antibiotics', 'vial', 'iv_piggyback', 'BD'),
  g('Linezolid 600mg IV Infusion', 'Linezolid', '600mg', 'IV Infusion', 'Antibiotics', 'bottle', 'iv_piggyback', 'BD'),
  g('Linezolid 600mg Tab', 'Linezolid', '600mg', 'Tablet', 'Antibiotics', 'tablet', 'oral', 'BD'),
  g('Fluconazole 150mg Tab', 'Fluconazole', '150mg', 'Tablet', 'Antibiotics', 'tablet', 'oral', 'OD'),
  g('Fluconazole 200mg IV Infusion', 'Fluconazole', '200mg', 'IV Infusion', 'Antibiotics', 'bottle', 'iv_piggyback', 'OD'),
  g('Albendazole 400mg Tab', 'Albendazole', '400mg', 'Tablet', 'Antibiotics', 'tablet', 'oral', 'STAT'),

  // -------------------------------------------------------------------------
  // 2. Analgesics, Antipyretics & Pain Relief
  // -------------------------------------------------------------------------
  g('Paracetamol 650mg Tab', 'Paracetamol', '650mg', 'Tablet', 'Analgesics & Pain Relief', 'tablet', 'oral', 'TDS'),
  g('Paracetamol 500mg Tab', 'Paracetamol', '500mg', 'Tablet', 'Analgesics & Pain Relief', 'tablet', 'oral', 'TDS'),
  g('Paracetamol 1g IV Infusion', 'Paracetamol', '1g / 100ml', 'IV Infusion', 'Analgesics & Pain Relief', 'bottle', 'iv_piggyback', 'TDS'),
  g('Tramadol 50mg Inj', 'Tramadol', '50mg/ml', 'Injection', 'Analgesics & Pain Relief', 'ampoule', 'iv_push', 'PRN'),
  g('Tramadol 50mg Cap', 'Tramadol', '50mg', 'Capsule', 'Analgesics & Pain Relief', 'capsule', 'oral', 'BD'),
  g('Diclofenac 75mg Inj', 'Diclofenac Sodium', '75mg/3ml', 'Injection', 'Analgesics & Pain Relief', 'ampoule', 'im', 'PRN'),
  g('Diclofenac 50mg Tab', 'Diclofenac Sodium', '50mg', 'Tablet', 'Analgesics & Pain Relief', 'tablet', 'oral', 'BD'),
  g('Aceclofenac 100mg Tab', 'Aceclofenac', '100mg', 'Tablet', 'Analgesics & Pain Relief', 'tablet', 'oral', 'BD'),
  g('Aceclofenac + Paracetamol Tab', 'Aceclofenac + Paracetamol', '100mg + 325mg', 'Tablet', 'Analgesics & Pain Relief', 'tablet', 'oral', 'BD'),
  g('Ibuprofen 400mg Tab', 'Ibuprofen', '400mg', 'Tablet', 'Analgesics & Pain Relief', 'tablet', 'oral', 'TDS'),
  g('Ketorolac 30mg Inj', 'Ketorolac Tromethamine', '30mg/ml', 'Injection', 'Analgesics & Pain Relief', 'ampoule', 'iv_push', 'PRN'),
  g('Piroxicam 20mg Cap', 'Piroxicam', '20mg', 'Capsule', 'Analgesics & Pain Relief', 'capsule', 'oral', 'OD'),

  // -------------------------------------------------------------------------
  // 3. Gastrointestinal, PPIs, Antacids & Antiemetics
  // -------------------------------------------------------------------------
  g('Pantoprazole 40mg IV Inj', 'Pantoprazole', '40mg', 'Injection', 'Gastrointestinal & Antacids', 'vial', 'iv_push', 'OD'),
  g('Pantoprazole 40mg Tab', 'Pantoprazole', '40mg', 'Tablet', 'Gastrointestinal & Antacids', 'tablet', 'oral', 'OD'),
  g('Rabeprazole 20mg Tab', 'Rabeprazole', '20mg', 'Tablet', 'Gastrointestinal & Antacids', 'tablet', 'oral', 'OD'),
  g('Rabeprazole 20mg Inj', 'Rabeprazole', '20mg', 'Injection', 'Gastrointestinal & Antacids', 'vial', 'iv_push', 'OD'),
  g('Omeprazole 20mg Cap', 'Omeprazole', '20mg', 'Capsule', 'Gastrointestinal & Antacids', 'capsule', 'oral', 'OD'),
  g('Omeprazole 40mg IV Inj', 'Omeprazole', '40mg', 'Injection', 'Gastrointestinal & Antacids', 'vial', 'iv_push', 'OD'),
  g('Ondansetron 4mg IV Inj', 'Ondansetron', '4mg/2ml', 'Injection', 'Gastrointestinal & Antacids', 'ampoule', 'iv_push', 'TDS'),
  g('Ondansetron 4mg Tab', 'Ondansetron', '4mg', 'Tablet', 'Gastrointestinal & Antacids', 'tablet', 'oral', 'TDS'),
  g('Domperidone 10mg Tab', 'Domperidone', '10mg', 'Tablet', 'Gastrointestinal & Antacids', 'tablet', 'oral', 'TDS'),
  g('Metoclopramide 10mg Inj', 'Metoclopramide', '10mg/2ml', 'Injection', 'Gastrointestinal & Antacids', 'ampoule', 'iv_push', 'TDS'),
  g('Dicyclomine 20mg Inj', 'Dicyclomine', '20mg/2ml', 'Injection', 'Gastrointestinal & Antacids', 'ampoule', 'im', 'PRN'),
  g('Hyoscine Butylbromide 20mg Inj', 'Hyoscine Butylbromide (Buscopan)', '20mg/ml', 'Injection', 'Gastrointestinal & Antacids', 'ampoule', 'iv_push', 'PRN'),
  g('Sucralfate 1g / 10ml Suspension', 'Sucralfate', '1g/10ml', 'Syrup', 'Gastrointestinal & Antacids', 'bottle', 'oral', 'TDS'),
  g('Lactulose 10g / 15ml Syrup', 'Lactulose', '10g/15ml', 'Syrup', 'Gastrointestinal & Antacids', 'bottle', 'oral', 'BD'),
  g('Loperamide 2mg Cap', 'Loperamide', '2mg', 'Capsule', 'Gastrointestinal & Antacids', 'capsule', 'oral', 'PRN'),

  // -------------------------------------------------------------------------
  // 4. IV Fluids & Electrolyte Infusions
  // -------------------------------------------------------------------------
  g('Ringer Lactate 500ml IV Infusion', 'Ringer Lactate', '500ml', 'IV Fluid', 'IV Fluids', 'bottle', 'iv_piggyback', 'OD'),
  g('Normal Saline 0.9% 500ml IV', 'Sodium Chloride 0.9%', '500ml', 'IV Fluid', 'IV Fluids', 'bottle', 'iv_piggyback', 'OD'),
  g('Normal Saline 0.9% 100ml IV', 'Sodium Chloride 0.9%', '100ml', 'IV Fluid', 'IV Fluids', 'bottle', 'iv_piggyback', 'OD'),
  g('Dextrose 5% 500ml IV', 'Dextrose 5%', '500ml', 'IV Fluid', 'IV Fluids', 'bottle', 'iv_piggyback', 'OD'),
  g('Dextrose Normal Saline (DNS) 500ml IV', 'Dextrose 5% + NaCl 0.9%', '500ml', 'IV Fluid', 'IV Fluids', 'bottle', 'iv_piggyback', 'OD'),
  g('Dextrose 25% 100ml IV', 'Dextrose 25%', '100ml', 'IV Fluid', 'IV Fluids', 'bottle', 'iv_push', 'STAT'),
  g('Isolyte-P 500ml IV Infusion', 'Maintenance Electrolyte Solution', '500ml', 'IV Fluid', 'IV Fluids', 'bottle', 'iv_piggyback', 'OD'),
  g('Isolyte-M 500ml IV Infusion', 'Maintenance Electrolyte Solution', '500ml', 'IV Fluid', 'IV Fluids', 'bottle', 'iv_piggyback', 'OD'),
  g('Potassium Chloride (KCl) 15% Inj', 'Potassium Chloride', '150mg/ml (20mEq/10ml)', 'Injection', 'IV Fluids', 'ampoule', 'iv_piggyback', 'OD'),
  g('Sodium Bicarbonate 7.5% Inj', 'Sodium Bicarbonate', '7.5% (8.9mEq/10ml)', 'Injection', 'IV Fluids', 'ampoule', 'iv_piggyback', 'STAT'),
  g('Oral Rehydration Salts (ORS) Sachet', 'Oral Rehydration Salts', '21.8g', 'Powder', 'IV Fluids', 'sachet', 'oral', 'PRN'),

  // -------------------------------------------------------------------------
  // 5. Emergency, Steroids & Critical Care
  // -------------------------------------------------------------------------
  g('Hydrocortisone 100mg Inj', 'Hydrocortisone Sodium Succinate', '100mg', 'Injection', 'Emergency & Steroids', 'vial', 'iv_push', 'OD'),
  g('Hydrocortisone 200mg Inj', 'Hydrocortisone Sodium Succinate', '200mg', 'Injection', 'Emergency & Steroids', 'vial', 'iv_push', 'BD'),
  g('Dexamethasone 4mg/ml Inj', 'Dexamethasone', '4mg/ml (2ml)', 'Injection', 'Emergency & Steroids', 'ampoule', 'iv_push', 'BD'),
  g('Methylprednisolone 40mg Inj', 'Methylprednisolone Sodium Succinate', '40mg', 'Injection', 'Emergency & Steroids', 'vial', 'iv_push', 'OD'),
  g('Methylprednisolone 125mg Inj', 'Methylprednisolone Sodium Succinate', '125mg', 'Injection', 'Emergency & Steroids', 'vial', 'iv_push', 'OD'),
  g('Prednisolone 10mg Tab', 'Prednisolone', '10mg', 'Tablet', 'Emergency & Steroids', 'tablet', 'oral', 'OD'),
  g('Prednisolone 20mg Tab', 'Prednisolone', '20mg', 'Tablet', 'Emergency & Steroids', 'tablet', 'oral', 'OD'),
  g('Adrenaline 1:1000 Inj', 'Epinephrine (Adrenaline)', '1mg/ml', 'Injection', 'Emergency & Steroids', 'ampoule', 'im', 'STAT'),
  g('Noradrenaline 4mg Inj', 'Norepinephrine', '4mg/2ml', 'Injection', 'Emergency & Steroids', 'ampoule', 'iv_piggyback', 'STAT'),
  g('Atropine Sulfate 0.6mg Inj', 'Atropine Sulfate', '0.6mg/ml', 'Injection', 'Emergency & Steroids', 'ampoule', 'iv_push', 'STAT'),
  g('Calcium Gluconate 10% Inj', 'Calcium Gluconate', '10% (10ml)', 'Injection', 'Emergency & Steroids', 'ampoule', 'iv_push', 'STAT'),
  g('Furosemide (Lasix) 20mg Inj', 'Furosemide', '20mg/2ml', 'Injection', 'Emergency & Steroids', 'ampoule', 'iv_push', 'OD'),
  g('Furosemide (Lasix) 40mg Tab', 'Furosemide', '40mg', 'Tablet', 'Emergency & Steroids', 'tablet', 'oral', 'OD'),
  g('Tranexamic Acid 500mg Inj', 'Tranexamic Acid', '500mg/5ml', 'Injection', 'Emergency & Steroids', 'ampoule', 'iv_push', 'TDS'),
  g('Tranexamic Acid 500mg Tab', 'Tranexamic Acid', '500mg', 'Tablet', 'Emergency & Steroids', 'tablet', 'oral', 'TDS'),

  // -------------------------------------------------------------------------
  // 6. Respiratory, Inhalation & Antiallergic
  // -------------------------------------------------------------------------
  g('Salbutamol 2.5mg Respules', 'Salbutamol', '2.5mg/2.5ml', 'Respule', 'Respiratory', 'respule', 'nebulization', 'TDS'),
  g('Ipratropium 500mcg Respules', 'Ipratropium Bromide', '500mcg/2ml', 'Respule', 'Respiratory', 'respule', 'nebulization', 'BD'),
  g('Budecort 0.5mg Respules', 'Budesonide', '0.5mg/2ml', 'Respule', 'Respiratory', 'respule', 'nebulization', 'BD'),
  g('Budecort 1mg Respules', 'Budesonide', '1mg/2ml', 'Respule', 'Respiratory', 'respule', 'nebulization', 'BD'),
  g('Duolin Respules', 'Levosalbutamol + Ipratropium', '1.25mg + 500mcg', 'Respule', 'Respiratory', 'respule', 'nebulization', 'TDS'),
  g('Deriphyllin Inj', 'Theophylline + Etofylline', '2ml (169.4mg)', 'Injection', 'Respiratory', 'ampoule', 'iv_push', 'BD'),
  g('Deriphyllin Retard 150mg Tab', 'Theophylline + Etofylline', '150mg', 'Tablet', 'Respiratory', 'tablet', 'oral', 'BD'),
  g('Montelukast 10mg Tab', 'Montelukast', '10mg', 'Tablet', 'Respiratory', 'tablet', 'oral', 'OD'),
  g('Montelukast + Levocetirizine Tab', 'Montelukast + Levocetirizine', '10mg + 5mg', 'Tablet', 'Respiratory', 'tablet', 'oral', 'OD'),
  g('Cetirizine 10mg Tab', 'Cetirizine', '10mg', 'Tablet', 'Respiratory', 'tablet', 'oral', 'OD'),
  g('Levocetirizine 5mg Tab', 'Levocetirizine', '5mg', 'Tablet', 'Respiratory', 'tablet', 'oral', 'OD'),
  g('Chlorpheniramine 4mg Tab', 'Chlorpheniramine Maleate', '4mg', 'Tablet', 'Respiratory', 'tablet', 'oral', 'TDS'),
  g('Avil 2ml Inj', 'Pheniramine Maleate', '22.75mg/ml', 'Injection', 'Emergency & Steroids', 'ampoule', 'iv_push', 'PRN'),
  g('Ambroxol 30mg/5ml Syrup', 'Ambroxol', '30mg/5ml', 'Syrup', 'Respiratory', 'bottle', 'oral', 'TDS'),

  // -------------------------------------------------------------------------
  // 7. Cardiovascular, Antihypertensives & Antiplatelets
  // -------------------------------------------------------------------------
  g('Amlodipine 5mg Tab', 'Amlodipine', '5mg', 'Tablet', 'Cardiovascular', 'tablet', 'oral', 'OD'),
  g('Amlodipine 10mg Tab', 'Amlodipine', '10mg', 'Tablet', 'Cardiovascular', 'tablet', 'oral', 'OD'),
  g('Telmisartan 40mg Tab', 'Telmisartan', '40mg', 'Tablet', 'Cardiovascular', 'tablet', 'oral', 'OD'),
  g('Telmisartan 80mg Tab', 'Telmisartan', '80mg', 'Tablet', 'Cardiovascular', 'tablet', 'oral', 'OD'),
  g('Telmisartan + Amlodipine Tab', 'Telmisartan + Amlodipine', '40mg + 5mg', 'Tablet', 'Cardiovascular', 'tablet', 'oral', 'OD'),
  g('Losartan 50mg Tab', 'Losartan Potassium', '50mg', 'Tablet', 'Cardiovascular', 'tablet', 'oral', 'OD'),
  g('Enalapril 5mg Tab', 'Enalapril', '5mg', 'Tablet', 'Cardiovascular', 'tablet', 'oral', 'OD'),
  g('Ramipril 5mg Tab', 'Ramipril', '5mg', 'Tablet', 'Cardiovascular', 'tablet', 'oral', 'OD'),
  g('Atenolol 50mg Tab', 'Atenolol', '50mg', 'Tablet', 'Cardiovascular', 'tablet', 'oral', 'OD'),
  g('Metoprolol 25mg Tab', 'Metoprolol Succinate', '25mg', 'Tablet', 'Cardiovascular', 'tablet', 'oral', 'OD'),
  g('Metoprolol 50mg Tab', 'Metoprolol Succinate', '50mg', 'Tablet', 'Cardiovascular', 'tablet', 'oral', 'OD'),
  g('Labetalol 20mg Inj', 'Labetalol', '20mg/4ml', 'Injection', 'Cardiovascular', 'ampoule', 'iv_push', 'PRN'),
  g('Labetalol 100mg Tab', 'Labetalol', '100mg', 'Tablet', 'Cardiovascular', 'tablet', 'oral', 'BD'),
  g('Nitroglycerin 25mg / 50ml IV Infusion', 'Nitroglycerin', '25mg/50ml', 'IV Infusion', 'Cardiovascular', 'vial', 'iv_piggyback', 'STAT'),
  g('Sorbitrate 5mg Sublingual Tab', 'Isosorbide Dinitrate', '5mg', 'Tablet', 'Cardiovascular', 'tablet', 'sublingual', 'PRN'),
  g('Aspirin 75mg Tab', 'Aspirin', '75mg', 'Tablet', 'Cardiovascular', 'tablet', 'oral', 'OD'),
  g('Aspirin 150mg Tab', 'Aspirin', '150mg', 'Tablet', 'Cardiovascular', 'tablet', 'oral', 'OD'),
  g('Clopidogrel 75mg Tab', 'Clopidogrel', '75mg', 'Tablet', 'Cardiovascular', 'tablet', 'oral', 'OD'),
  g('Atorvastatin 10mg Tab', 'Atorvastatin', '10mg', 'Tablet', 'Cardiovascular', 'tablet', 'oral', 'OD'),
  g('Atorvastatin 20mg Tab', 'Atorvastatin', '20mg', 'Tablet', 'Cardiovascular', 'tablet', 'oral', 'OD'),
  g('Atorvastatin 40mg Tab', 'Atorvastatin', '40mg', 'Tablet', 'Cardiovascular', 'tablet', 'oral', 'OD'),
  g('Rosuvastatin 10mg Tab', 'Rosuvastatin', '10mg', 'Tablet', 'Cardiovascular', 'tablet', 'oral', 'OD'),

  // -------------------------------------------------------------------------
  // 8. Endocrine, Diabetes & Metabolism
  // -------------------------------------------------------------------------
  g('Human Actrapid (Regular) Insulin 40IU/ml', 'Regular Soluble Insulin', '40IU/ml (10ml)', 'Injection', 'Endocrine & Diabetes', 'vial', 'sc', 'TDS'),
  g('Human Mixtard 30/70 Insulin 40IU/ml', 'Biphasic Isophane Insulin', '40IU/ml (10ml)', 'Injection', 'Endocrine & Diabetes', 'vial', 'sc', 'BD'),
  g('Insulin Glargine (Lantus) 100IU/ml', 'Insulin Glargine', '100IU/ml (3ml)', 'Cartridge', 'Endocrine & Diabetes', 'cartridge', 'sc', 'OD'),
  g('Metformin 500mg Tab', 'Metformin Hydrochloride', '500mg', 'Tablet', 'Endocrine & Diabetes', 'tablet', 'oral', 'BD'),
  g('Metformin 1000mg SR Tab', 'Metformin Hydrochloride', '1000mg', 'Tablet', 'Endocrine & Diabetes', 'tablet', 'oral', 'OD'),
  g('Glimepiride 1mg Tab', 'Glimepiride', '1mg', 'Tablet', 'Endocrine & Diabetes', 'tablet', 'oral', 'OD'),
  g('Glimepiride 2mg Tab', 'Glimepiride', '2mg', 'Tablet', 'Endocrine & Diabetes', 'tablet', 'oral', 'OD'),
  g('Vildagliptin 50mg Tab', 'Vildagliptin', '50mg', 'Tablet', 'Endocrine & Diabetes', 'tablet', 'oral', 'BD'),
  g('Levothyroxine 25mcg Tab', 'Levothyroxine Sodium', '25mcg', 'Tablet', 'Endocrine & Diabetes', 'tablet', 'oral', 'OD'),
  g('Levothyroxine 50mcg Tab', 'Levothyroxine Sodium', '50mcg', 'Tablet', 'Endocrine & Diabetes', 'tablet', 'oral', 'OD'),
  g('Levothyroxine 100mcg Tab', 'Levothyroxine Sodium', '100mcg', 'Tablet', 'Endocrine & Diabetes', 'tablet', 'oral', 'OD'),

  // -------------------------------------------------------------------------
  // 9. Supplements, Electrolytes & Vitamins
  // -------------------------------------------------------------------------
  g('Vitamin B Complex with B12 Tab', 'Vitamin B Complex + B12', 'Multivitamin', 'Tablet', 'Supplements & Vitamins', 'tablet', 'oral', 'OD'),
  g('Vitamin C 500mg Chewable Tab', 'Ascorbic Acid (Vitamin C)', '500mg', 'Tablet', 'Supplements & Vitamins', 'tablet', 'oral', 'OD'),
  g('Calcium 500mg + Vitamin D3 Tab', 'Calcium Carbonate + Cholecalciferol', '500mg + 250IU', 'Tablet', 'Supplements & Vitamins', 'tablet', 'oral', 'BD'),
  g('Vitamin D3 60,000 IU Cap', 'Cholecalciferol', '60000 IU', 'Capsule', 'Supplements & Vitamins', 'capsule', 'oral', 'STAT'),
  g('Folic Acid 5mg Tab', 'Folic Acid', '5mg', 'Tablet', 'Supplements & Vitamins', 'tablet', 'oral', 'OD'),
  g('Ferrous Ascorbate + Folic Acid Tab', 'Iron + Folic Acid', '100mg + 1.5mg', 'Tablet', 'Supplements & Vitamins', 'tablet', 'oral', 'OD'),
  g('Zinc Sulfate 20mg Tab', 'Zinc Sulfate', '20mg', 'Tablet', 'Supplements & Vitamins', 'tablet', 'oral', 'OD'),

  // -------------------------------------------------------------------------
  // 10. Topical, Wound & Local Preparations
  // -------------------------------------------------------------------------
  g('Povidone Iodine 5% Ointment', 'Povidone Iodine', '5% (20g)', 'Ointment', 'Topical & Wound Care', 'tube', 'topical', 'BD'),
  g('Povidone Iodine 10% Solution', 'Povidone Iodine', '10% (100ml)', 'Solution', 'Topical & Wound Care', 'bottle', 'topical', 'BD'),
  g('Silver Sulfadiazine 1% Cream', 'Silver Sulfadiazine', '1% (50g)', 'Cream', 'Topical & Wound Care', 'tube', 'topical', 'BD'),
  g('Mupirocin 2% Ointment', 'Mupirocin', '2% (5g)', 'Ointment', 'Topical & Wound Care', 'tube', 'topical', 'TDS'),
  g('Clotrimazole 1% Cream', 'Clotrimazole', '1% (15g)', 'Cream', 'Topical & Wound Care', 'tube', 'topical', 'BD'),
  g('Ciprofloxacin 0.3% Eye Drops', 'Ciprofloxacin', '0.3% (5ml)', 'Eye Drops', 'Topical & Wound Care', 'bottle', 'topical', 'TDS'),
];

/**
 * In-memory fast prefix search on the global catalogue.
 */
export function searchGlobalMedicinesData(query: string, limit = 10): GlobalMedicine[] {
  const term = query.trim().toLowerCase();
  if (term.length === 0) return [];

  const matches: GlobalMedicine[] = [];
  for (const item of GLOBAL_MEDICINES_DATA) {
    const nameMatch = item.name.toLowerCase().includes(term);
    const genericMatch = item.genericName ? item.genericName.toLowerCase().includes(term) : false;
    if (nameMatch || genericMatch) {
      matches.push(item);
      if (matches.length >= limit) break;
    }
  }
  return matches;
}
