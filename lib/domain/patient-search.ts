import { normalizeQid } from './uhid';

export type SearchMatchType = 'phone' | 'qid' | 'mrn' | 'name';

export function detectSearchType(raw: string): SearchMatchType {
  const query = raw.trim();
  const digits = query.replace(/\D/g, '');
  if (digits.length === 10 || (digits.length === 12 && digits.startsWith('91'))) {
    return 'phone';
  }
  const upper = query.toUpperCase();
  if (upper.startsWith('QID') || normalizeQid(query) !== null) {
    return 'qid';
  }
  if (/^[A-Za-z0-9]+[/-][A-Za-z0-9/-]+$/.test(query) || (digits.length > 0 && /[A-Za-z]/.test(query))) {
    return 'mrn';
  }
  return 'name';
}

export function formatTempName(args: {
  gender?: string | null;
  approxAge?: number | null;
  note?: string | null;
}): string {
  const g = args.gender === 'male' ? 'Male' : args.gender === 'female' ? 'Female' : 'Person';
  const age = args.approxAge ? ` (~${args.approxAge}y)` : '';
  const note = args.note ? `, ${args.note.trim()}` : '';
  return `Unidentified ${g}${age}${note}`;
}

export type ActiveStayInfo = {
  admissionId: string;
  admissionNumber: string | null;
  ipdNumber: number | null;
  status: 'awaiting_bed' | 'admitted' | 'discharge_ready';
  wardName: string | null;
  bedLabel: string | null;
  doctorName: string;
  admittedAt: Date | null;
};

export type SmartSearchResult = {
  id: string;
  name: string;
  age: number | null;
  gender: string | null;
  phoneE164: string;
  address: string | null;
  mrn: string | null;
  qid: string | null;
  matchType: SearchMatchType;
  activeStay: ActiveStayInfo | null;
};
