/**
 * Allergies and the check on a medicine line (IPD sheets plan B2, §8). Pure.
 *
 * An allergy belongs to the patient, not the stay. When a doctor writes a
 * medicine on the treatment card, it is matched against the patient's
 * allergies by name and by drug class (the class map below). A match is
 * decision support, not a block: the doctor may go ahead with a written
 * reason, which is kept on the line and in the evidence log.
 *
 * The class map is deliberately small and plain (the classes the plan names);
 * it is not a drug-interaction database and says so on screen.
 */

export class AllergyError extends Error {}

export const ALLERGY_CATEGORIES = { drug: 'Medicine', food: 'Food', other: 'Other' } as const;
export type AllergyCategory = keyof typeof ALLERGY_CATEGORIES;

export const ALLERGY_SEVERITIES = { severe: 'Severe (breathing, swelling, shock)', moderate: 'Moderate', mild: 'Mild (rash, itch)', unknown: 'Not known' } as const;
export type AllergySeverity = keyof typeof ALLERGY_SEVERITIES;

export const ALLERGY_SOURCES = { patient: 'Patient says', family: 'Family says', records: 'Old records', observed: 'Seen here' } as const;
export type AllergySource = keyof typeof ALLERGY_SOURCES;

/**
 * Drug classes and the names that belong to them (brand and generic, as
 * written on Indian prescriptions). Matching is on whole words, case-blind.
 */
export const DRUG_CLASSES = {
  penicillins: {
    label: 'Penicillins',
    pattern: /\b(penicillin|amoxicillin|amoxycillin|ampicillin|cloxacillin|dicloxacillin|flucloxacillin|piperacillin|benzathine|augmentin|amoxyclav|mox|novamox|moxikind|clavam)\b/i,
  },
  cephalosporins: {
    label: 'Cephalosporins',
    pattern: /\b(ceph\w*|cef\w*|monocef|taxim|zifi|oframax)\b/i,
  },
  sulfa: {
    label: 'Sulfa drugs',
    pattern: /\b(sulfa\w*|sulpha\w*|sulfonamides?|sulphonamides?|co-?trimoxazole|septran|bactrim|sulfamethoxazole|sulfasalazine|sulphasalazine)\b/i,
  },
  nsaids: {
    label: 'NSAIDs (pain killers)',
    pattern: /\b(nsaids?|ibuprofen|brufen|combiflam|diclofenac|voveran|dynapar|aceclofenac|zerodol|hifenac|naproxen|ketorolac|mefenamic|meftal|piroxicam|etoricoxib|nimesulide|nise|indomethacin|ketoprofen)\b/i,
  },
  aspirin: {
    label: 'Aspirin',
    pattern: /\b(aspirin|ecosprin|disprin|acetylsalicylic|loprin)\b/i,
  },
} as const;
export type DrugClass = keyof typeof DRUG_CLASSES;
export const isDrugClass = (value: string): value is DrugClass => value in DRUG_CLASSES;

/** The class a drug name belongs to, if the map knows it. */
export function classOf(name: string | null | undefined): DrugClass | null {
  if (!name) return null;
  for (const key of Object.keys(DRUG_CLASSES) as DrugClass[]) {
    if (DRUG_CLASSES[key].pattern.test(name)) return key;
  }
  return null;
}

/** Classes that are named by the class itself ("penicillin allergy" covers all penicillins). */
const CLASS_WORDS: Record<DrugClass, RegExp> = {
  penicillins: /\bpenicillins?\b/i,
  cephalosporins: /\bcephalosporins?\b/i,
  sulfa: /\b(sulfa|sulpha)( drugs?)?\b|\bsulfonamides?\b|\bsulphonamides?\b/i,
  nsaids: /\bnsaids?\b|\bpain ?killers?\b/i,
  aspirin: /\baspirin\b/i,
};

export type AllergyInput = {
  substance: string;
  category: AllergyCategory;
  reaction: string | null;
  severity: AllergySeverity;
  source: AllergySource;
  drugClass: DrugClass | null;
};

const tidy = (value: unknown) => String(value ?? '').replace(/\s+/g, ' ').trim();

/** Checks an allergy as typed; finds its drug class when it names one. Throws AllergyError. */
export function parseAllergy(raw: { substance?: unknown; category?: unknown; reaction?: unknown; severity?: unknown; source?: unknown }): AllergyInput {
  const substance = tidy(raw.substance);
  if (substance.length < 2 || substance.length > 80) throw new AllergyError('Write what the patient is allergic to');
  const category = tidy(raw.category) || 'drug';
  if (!(category in ALLERGY_CATEGORIES)) throw new AllergyError('Choose medicine, food or other');
  const severity = tidy(raw.severity) || 'unknown';
  if (!(severity in ALLERGY_SEVERITIES)) throw new AllergyError('Choose how severe');
  const source = tidy(raw.source) || 'patient';
  if (!(source in ALLERGY_SOURCES)) throw new AllergyError('Choose who said so');
  const reaction = tidy(raw.reaction) || null;
  if (reaction && reaction.length > 120) throw new AllergyError('Keep the reaction short');
  const drugClass = category === 'drug' ? (classOfAllergy(substance) ?? null) : null;
  return { substance, category: category as AllergyCategory, reaction, severity: severity as AllergySeverity, source: source as AllergySource, drugClass };
}

/** The class an allergy stands for: named as a class ("sulfa drugs") or as one of its drugs ("Augmentin"). */
export function classOfAllergy(substance: string): DrugClass | null {
  for (const key of Object.keys(CLASS_WORDS) as DrugClass[]) {
    if (CLASS_WORDS[key].test(substance)) return key;
  }
  return classOf(substance);
}

export type PatientAllergy = { id: string; substance: string; category: AllergyCategory; drugClass: DrugClass | null; medicineId: string | null; severity: AllergySeverity };

export type AllergyMatch = { allergyId: string; substance: string; severity: AllergySeverity; why: string };

const words = (text: string) => text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4);

/**
 * Does a medicine match any of the patient's allergies? Same medicine on the
 * list, the allergy's words in the medicine's name or generic name, or the
 * same drug class. Food and other allergies are not matched to medicines.
 */
export function matchAllergies(
  allergies: readonly PatientAllergy[],
  medicine: { id: string | null; name: string; genericName?: string | null },
): AllergyMatch[] {
  const names = [medicine.name, medicine.genericName ?? ''].join(' ');
  const nameWords = new Set(words(names));
  const medicineClass = classOf(names);
  const matches: AllergyMatch[] = [];
  for (const allergy of allergies) {
    if (allergy.category !== 'drug') continue;
    let why: string | null = null;
    if (allergy.medicineId && allergy.medicineId === medicine.id) why = 'same medicine';
    else if (words(allergy.substance).some((w) => nameWords.has(w))) why = 'same name';
    else if (allergy.drugClass && medicineClass === allergy.drugClass) why = `same class: ${DRUG_CLASSES[allergy.drugClass].label}`;
    if (why) matches.push({ allergyId: allergy.id, substance: allergy.substance, severity: allergy.severity, why });
  }
  return matches;
}

/** One line for the evidence log and the treatment card: "Penicillin (severe; same class: Penicillins)". */
export const matchText = (m: AllergyMatch) => `${m.substance} (${m.severity === 'unknown' ? '' : `${m.severity}; `}${m.why})`;

export type AllergyStatus =
  | { kind: 'not_asked' }
  | { kind: 'nkda'; at: Date }
  | { kind: 'unable'; at: Date }
  | { kind: 'allergies'; count: number; severe: boolean };

/** What the banner says: the allergies if any; else the last review; else "not asked yet". */
export function allergyStatus(
  allergies: readonly { severity: AllergySeverity }[],
  lastReview: { outcome: 'nkda' | 'recorded' | 'unable'; at: Date } | null,
): AllergyStatus {
  if (allergies.length > 0) return { kind: 'allergies', count: allergies.length, severe: allergies.some((a) => a.severity === 'severe') };
  if (lastReview?.outcome === 'nkda') return { kind: 'nkda', at: lastReview.at };
  if (lastReview?.outcome === 'unable') return { kind: 'unable', at: lastReview.at };
  return { kind: 'not_asked' };
}
