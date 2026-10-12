/**
 * The discharge summary (IPD sheets plan B5). Pure.
 *
 * A summary is a set of plain sections. The draft is built from the record,
 * deterministically (no AI): the reason for admission and the case sheet,
 * the complaints and findings, the tests ordered, the treatment card, and
 * the medicines going home from the reconciliation (or, if it was not done,
 * the active card lines, marked so). Follow-up, diet and warning signs start
 * from plain defaults the doctor edits. Every section stays editable until
 * the doctor finalises; a finalised version is the record.
 */

export class SummaryError extends Error {}

export const DISCHARGE_TYPES = {
  routine: 'Discharged (improved)',
  on_request: 'Discharged on request',
  dama: 'Discharged against medical advice (DAMA)',
  referred: 'Referred to another hospital',
  death: 'Death',
} as const;
export type DischargeType = keyof typeof DISCHARGE_TYPES;

export type SummaryMedicine = { name: string; dose: string; frequency: string; duration: string; note: string };

export type SummaryContent = {
  diagnosis: string;
  dischargeType: DischargeType;
  complaints: string;
  history: string;
  findings: string;
  investigations: string;
  course: string;
  treatmentGiven: string;
  procedures: string;
  conditionAtDischarge: string;
  medicines: SummaryMedicine[];
  /** True when the medicines came from the card, not a completed discharge reconciliation. */
  medicinesUnreconciled: boolean;
  followUp: string;
  diet: string;
  warningSigns: string;
};

/** The text sections, in print order, with their headings. */
export const SECTIONS: readonly { key: Exclude<keyof SummaryContent, 'medicines' | 'medicinesUnreconciled' | 'dischargeType'>; label: string; rows: number; max: number }[] = [
  { key: 'diagnosis', label: 'Diagnosis', rows: 2, max: 400 },
  { key: 'complaints', label: 'Presenting complaints', rows: 3, max: 1000 },
  { key: 'history', label: 'History', rows: 3, max: 2000 },
  { key: 'findings', label: 'Findings on admission', rows: 3, max: 2000 },
  { key: 'investigations', label: 'Investigations', rows: 3, max: 2000 },
  { key: 'course', label: 'Course in hospital', rows: 4, max: 3000 },
  { key: 'treatmentGiven', label: 'Treatment given', rows: 4, max: 3000 },
  { key: 'procedures', label: 'Procedures', rows: 2, max: 1000 },
  { key: 'conditionAtDischarge', label: 'Condition at discharge', rows: 2, max: 500 },
  { key: 'followUp', label: 'Follow-up', rows: 2, max: 500 },
  { key: 'diet', label: 'Diet', rows: 2, max: 500 },
  { key: 'warningSigns', label: 'Come back at once if', rows: 3, max: 1000 },
];

export const DEFAULT_FOLLOW_UP = 'Review in OPD after 7 days with this summary and reports.';
export const DEFAULT_DIET = 'Normal home diet.';
export const DEFAULT_WARNING_SIGNS =
  'Fever above 101 °F, breathlessness, chest pain, bleeding, fainting, severe pain, not passing urine, or any new worry.';

/** What the record holds about the stay, gathered by the service. */
export type SummarySources = {
  reason: string | null;
  caseNote: {
    caseOf: string | null;
    complaints: { text: string; duration: string | null }[];
    history: string | null;
    pastHistory: string | null;
    examination: string;
  } | null;
  tests: { name: string; status: string; at: Date }[];
  treatment: { description: string; dose: string | null; route: string | null; frequency: string | null; startedAt: Date; stoppedAt: Date | null }[];
  progress: { at: Date; text: string }[];
  goingHome: { name: string; dose: string | null; frequency: string | null; duration: string | null; note: string | null }[] | null;
  activeCardMedicines: { description: string; dose: string | null; frequency: string | null }[];
};

const day = (at: Date, timezone: string) => new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', timeZone: timezone }).format(at);

/** The first draft, from the record. Same record → same draft. */
export function buildDraft(src: SummarySources, timezone: string): SummaryContent {
  const note = src.caseNote;
  const complaints = note?.complaints.map((c) => `${c.text}${c.duration ? ` × ${c.duration}` : ''}`).join('\n') ?? '';
  const history = [note?.history, note?.pastHistory ? `Past history: ${note.pastHistory}` : null].filter(Boolean).join('\n');
  const tests = src.tests.map((t) => `${t.name} (${day(t.at, timezone)})${t.status === 'cancelled' || t.status === 'not_coming' ? ' — not done' : t.status === 'ordered' || t.status === 'arrived' ? ' — pending' : ''}`).join('\n');
  const treatment = src.treatment
    .map((t) => {
      const how = [t.dose, t.route, t.frequency].filter(Boolean).join(' ');
      const when = `${day(t.startedAt, timezone)}${t.stoppedAt ? ` to ${day(t.stoppedAt, timezone)}` : ' onwards'}`;
      return `${t.description}${how ? ` ${how}` : ''} (${when})`;
    })
    .join('\n');
  const course = src.progress.map((p) => `${day(p.at, timezone)}: ${p.text}`).join('\n');
  const medicines: SummaryMedicine[] = src.goingHome
    ? src.goingHome.map((m) => ({ name: m.name, dose: m.dose ?? '', frequency: m.frequency ?? '', duration: m.duration ?? '', note: m.note ?? '' }))
    : src.activeCardMedicines.map((m) => ({ name: m.description, dose: m.dose ?? '', frequency: m.frequency ?? '', duration: '', note: '' }));
  return {
    diagnosis: note?.caseOf ?? src.reason ?? '',
    dischargeType: 'routine',
    complaints,
    history,
    findings: note?.examination ?? '',
    investigations: tests,
    course,
    treatmentGiven: treatment,
    procedures: '',
    conditionAtDischarge: 'Stable.',
    medicines,
    medicinesUnreconciled: src.goingHome === null,
    followUp: DEFAULT_FOLLOW_UP,
    diet: DEFAULT_DIET,
    warningSigns: DEFAULT_WARNING_SIGNS,
  };
}

const tidy = (value: unknown, max: number, label: string): string => {
  const text = String(value ?? '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (text.length > max) throw new SummaryError(`${label} is too long (at most ${max} letters)`);
  return text;
};

/** Checks a summary as edited. Throws SummaryError. `final`: what finalising needs on top. */
export function parseSummary(raw: Record<string, unknown>, options: { final?: boolean } = {}): SummaryContent {
  const dischargeType = String(raw.dischargeType ?? 'routine');
  if (!(dischargeType in DISCHARGE_TYPES)) throw new SummaryError('Choose how the patient left');
  const content = { dischargeType } as SummaryContent;
  for (const section of SECTIONS) content[section.key] = tidy(raw[section.key], section.max, section.label);
  const medicines = Array.isArray(raw.medicines) ? raw.medicines : [];
  if (medicines.length > 40) throw new SummaryError('At most 40 medicines');
  content.medicines = medicines
    .map((m: Record<string, unknown>) => ({
      name: tidy(m?.name, 120, 'A medicine'),
      dose: tidy(m?.dose, 40, 'A dose'),
      frequency: tidy(m?.frequency, 40, 'How often'),
      duration: tidy(m?.duration, 40, 'How long'),
      note: tidy(m?.note, 120, 'A note'),
    }))
    .filter((m) => m.name);
  content.medicinesUnreconciled = Boolean(raw.medicinesUnreconciled);
  if (options.final) {
    if (!content.diagnosis) throw new SummaryError('Write the diagnosis');
    if (dischargeType !== 'death' && !content.followUp) throw new SummaryError('Write the follow-up');
    if (dischargeType !== 'death' && !content.warningSigns) throw new SummaryError('Write when to come back at once');
  }
  return content;
}

/** Refreshes the sections that come from the record, keeping what the doctor wrote in the others. */
export function refreshFromRecord(current: SummaryContent, fresh: SummaryContent): SummaryContent {
  return {
    ...current,
    complaints: fresh.complaints,
    findings: fresh.findings,
    investigations: fresh.investigations,
    treatmentGiven: fresh.treatmentGiven,
    medicines: fresh.medicines,
    medicinesUnreconciled: fresh.medicinesUnreconciled,
    course: current.course || fresh.course,
    diagnosis: current.diagnosis || fresh.diagnosis,
    history: current.history || fresh.history,
  };
}
