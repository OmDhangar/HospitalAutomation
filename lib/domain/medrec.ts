/**
 * Medication reconciliation (IPD sheets plan B2, §8: NABH). Pure.
 *
 * At admission: every medicine the patient was taking at home, and the
 * doctor's decision for each — continue (it goes on the treatment card),
 * hold, stop, or change. At discharge: what the patient is to take at home —
 * each medicine still on the card and each home medicine, continued, stopped
 * or changed, plus anything new. The discharge list is what the discharge
 * summary prints under "Medicines to continue".
 *
 * A doctor completes each reconciliation; a medicine without a decision keeps
 * it open.
 */

export class MedRecError extends Error {}

export const MED_REC_PHASES = { admission: 'At admission', discharge: 'At discharge' } as const;
export type MedRecPhase = keyof typeof MED_REC_PHASES;

export const MED_REC_SOURCES = {
  patient: 'Patient said',
  family: 'Family said',
  prescription: 'Old prescription',
  records: 'Records / OPD',
  treatment_card: 'On the treatment card',
  home: 'Home medicine',
  new: 'New at discharge',
} as const;
export type MedRecSource = keyof typeof MED_REC_SOURCES;

export const ADMISSION_DECISIONS = {
  continue: 'Continue',
  hold: 'Hold for now',
  stop: 'Stop',
  change: 'Change',
} as const;

export const DISCHARGE_DECISIONS = {
  continue: 'Continue at home',
  change: 'Continue, changed',
  stop: 'Stop',
  new: 'New',
} as const;

export type MedRecDecision = 'continue' | 'hold' | 'stop' | 'change' | 'new';

export const decisionsFor = (phase: MedRecPhase): Record<string, string> => (phase === 'admission' ? ADMISSION_DECISIONS : DISCHARGE_DECISIONS);

export function isDecisionFor(phase: MedRecPhase, value: string): value is MedRecDecision {
  return value in decisionsFor(phase);
}

/** A change, a hold or a stop says why; "continue" needs no words. */
export function decisionNeedsNote(decision: MedRecDecision): boolean {
  return decision === 'change' || decision === 'hold' || decision === 'stop';
}

export type MedRecItemInput = { name: string; dose: string | null; frequency: string | null; route: string | null; duration: string | null };

const tidy = (value: unknown, max: number, label: string, required = false): string | null => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!text) {
    if (required) throw new MedRecError(`Write the ${label}`);
    return null;
  }
  if (text.length > max) throw new MedRecError(`The ${label} is too long (at most ${max} letters)`);
  return text;
};

export function parseMedRecItem(raw: { name?: unknown; dose?: unknown; frequency?: unknown; route?: unknown; duration?: unknown }): MedRecItemInput {
  const name = tidy(raw.name, 120, 'medicine', true)!;
  if (name.length < 2) throw new MedRecError('Write the medicine');
  return {
    name,
    dose: tidy(raw.dose, 40, 'dose'),
    frequency: tidy(raw.frequency, 40, 'frequency'),
    route: tidy(raw.route, 20, 'route'),
    duration: tidy(raw.duration, 40, 'duration'),
  };
}

export type MedRecProgress = { total: number; decided: number; complete: boolean };

/** How far a reconciliation is: every live medicine decided. An empty admission list is complete only when "none at home" is said. */
export function medRecProgress(items: readonly { decision: MedRecDecision | null }[]): MedRecProgress {
  const decided = items.filter((i) => i.decision !== null).length;
  return { total: items.length, decided, complete: decided === items.length };
}

/** The lines that go home: continued, changed and new medicines, in that order of the list. */
export function goingHome<T extends { decision: MedRecDecision | null }>(items: readonly T[]): T[] {
  return items.filter((i) => i.decision === 'continue' || i.decision === 'change' || i.decision === 'new');
}
