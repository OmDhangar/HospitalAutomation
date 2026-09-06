import { z } from 'zod';
import { normalizeIndianPhone } from '@/lib/domain/phone';

export const PATIENTS_PER_DAY = ['under_50', '50_100', '100_200', 'over_200'] as const;
export type PatientsPerDay = (typeof PATIENTS_PER_DAY)[number];

export const PATIENTS_PER_DAY_LABELS: Record<PatientsPerDay, string> = {
  under_50: 'Under 50',
  '50_100': '50–100',
  '100_200': '100–200',
  over_200: 'Over 200',
};

export const MAX_DEMO_REQUESTS_PER_PHONE_PER_DAY = 3;

const fields = z.object({
  name: z.string().trim().min(1).max(80),
  organisation: z.string().trim().min(1).max(120),
  phone: z.string(),
  city: z.string().trim().min(1).max(80),
  patientsPerDay: z.enum(PATIENTS_PER_DAY),
});

export type DemoRequestInput = {
  name: string;
  organisation: string;
  phoneE164: string;
  city: string;
  patientsPerDay: PatientsPerDay;
};

export type DemoRequestParseResult =
  | { ok: true; value: DemoRequestInput }
  | { ok: false; error: string };

/**
 * Hidden field on the public form. Bots fill every input; humans never see it.
 * A filled value means write nothing and still report success.
 */
export function isHoneypotFilled(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

export function parseDemoRequest(raw: {
  name: unknown;
  organisation: unknown;
  phone: unknown;
  city: unknown;
  patientsPerDay: unknown;
}): DemoRequestParseResult {
  const parsed = fields.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: 'Please fill in every field.' };
  }

  const phoneE164 = normalizeIndianPhone(parsed.data.phone);
  if (!phoneE164) {
    return { ok: false, error: 'Enter a valid 10-digit Indian mobile number.' };
  }

  return {
    ok: true,
    value: {
      name: parsed.data.name,
      organisation: parsed.data.organisation,
      phoneE164,
      city: parsed.data.city,
      patientsPerDay: parsed.data.patientsPerDay,
    },
  };
}

/** Midnight of the current calendar day in the given IANA timezone. */
export function startOfDayIn(timezone: string, at: Date = new Date()): Date {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const parts = Object.fromEntries(dtf.formatToParts(at).map((part) => [part.type, part.value]));
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  const offsetMs = asUtc - at.getTime();
  const startAsUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day));
  return new Date(startAsUtc - offsetMs);
}
