/**
 * The text letterhead at the top of every printed IPD sheet (IPD sheets plan
 * §11.1 A4-min, decision D-LH): the hospital's name, the branch address, phones,
 * registration number, and the doctors the hospital chooses to show with their
 * degrees and registration numbers — what the pilot's paper forms carry.
 *
 * No logo yet: there is no file storage until phase A7.
 */

export const LETTERHEAD_LIMITS = {
  registrationNo: 60,
  phones: 120,
  qualification: 80,
  doctorRegistrationNo: 40,
} as const;

export class LetterheadError extends Error {}

/** Trims and collapses spaces; empty becomes null; too long is refused with the field's name. */
export function optionalText(value: string | null | undefined, max: number, label: string): string | null {
  const text = (value ?? '').trim().replace(/\s+/g, ' ');
  if (text === '') return null;
  if (text.length > max) throw new LetterheadError(`${label} is too long (at most ${max} characters)`);
  return text;
}

export type HospitalLetterheadInput = { registrationNo: string | null; phones: string | null };

export function parseHospitalLetterhead(input: { registrationNo?: string; phones?: string }): HospitalLetterheadInput {
  return {
    registrationNo: optionalText(input.registrationNo, LETTERHEAD_LIMITS.registrationNo, 'Registration number'),
    phones: optionalText(input.phones, LETTERHEAD_LIMITS.phones, 'Phone numbers'),
  };
}

export type DoctorLetterheadInput = {
  qualification: string | null;
  registrationNo: string | null;
  onLetterhead: boolean;
};

export function parseDoctorLetterhead(input: {
  qualification?: string;
  registrationNo?: string;
  onLetterhead?: boolean;
}): DoctorLetterheadInput {
  return {
    qualification: optionalText(input.qualification, LETTERHEAD_LIMITS.qualification, 'Degrees'),
    registrationNo: optionalText(input.registrationNo, LETTERHEAD_LIMITS.doctorRegistrationNo, 'Registration number'),
    onLetterhead: input.onLetterhead === true,
  };
}

/** "Dr Vinod R Pawara" whether or not the stored name already starts with "Dr". */
export function doctorDisplayName(name: string): string {
  return `Dr ${name.trim().replace(/^dr\.?\s+/i, '')}`;
}

/** The lines printed for one doctor: name, then "MBBS, MD (Medicine) · Reg. No. 2015074070" if known. */
export function doctorLetterheadLines(doctor: {
  name: string;
  qualification: string | null;
  registrationNo: string | null;
}): [string] | [string, string] {
  const detail = [doctor.qualification, doctor.registrationNo ? `Reg. No. ${doctor.registrationNo}` : null]
    .filter(Boolean)
    .join(' · ');
  return detail ? [doctorDisplayName(doctor.name), detail] : [doctorDisplayName(doctor.name)];
}

export type Letterhead = {
  hospitalName: string;
  branchName: string | null;
  address: string | null;
  phones: string | null;
  registrationNo: string | null;
  doctors: { name: string; qualification: string | null; registrationNo: string | null }[];
};
