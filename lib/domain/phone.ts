/**
 * Reception types a phone number a dozen different ways: with spaces, with a
 * leading zero, with +91, with the country code and no plus. WhatsApp needs one
 * canonical E.164 string, and a mismatch means a patient silently never gets
 * their queue link.
 *
 * Indian mobile numbers are ten digits starting 6-9.
 */
export function normalizeIndianPhone(input: string): string | null {
  const digits = input.replace(/\D/g, '');

  const local =
    digits.length === 10
      ? digits
      : digits.length === 11 && digits.startsWith('0')
        ? digits.slice(1)
        : digits.length === 12 && digits.startsWith('91')
          ? digits.slice(2)
          : digits.length === 13 && digits.startsWith('091')
            ? digits.slice(3)
            : null;

  if (!local || !/^[6-9]\d{9}$/.test(local)) return null;
  return `+91${local}`;
}

/** "+919876543210" -> "98765 43210", for display back to staff. */
export function formatIndianPhone(e164: string): string {
  if (isMockPhone(e164)) return 'No phone';
  const local = e164.replace(/^\+91/, '');
  return local.length === 10 ? `${local.slice(0, 5)} ${local.slice(5)}` : e164;
}

/**
 * What reception types for a patient with no phone. Ten zeros can never be a
 * real number, and it is easy to remember at a busy desk.
 */
export const NO_PHONE_INPUT = '0000000000';

/**
 * A patient with no phone is stored under a placeholder: +91 then a 0 then
 * nine random digits. No Indian mobile starts with 0, so it can never reach a
 * real person, and normalizeIndianPhone never produces one.
 *
 * Each patient gets their own placeholder rather than one shared number:
 * patients are matched by phone and name, and two different people both called
 * "Ramesh" with no phone must not become one medical record.
 */
const NO_PHONE_PATTERN = /^\+910\d{9}$/;

export function isNoPhoneInput(input: string): boolean {
  return input.replace(/\D/g, '') === NO_PHONE_INPUT;
}

/** True for a no-phone placeholder. Nothing is ever sent to one. */
export function isMockPhone(e164: string | null | undefined): boolean {
  return typeof e164 === 'string' && NO_PHONE_PATTERN.test(e164);
}

export function makeNoPhonePlaceholder(
  randomDigits: (count: number) => string = secureRandomDigits,
): string {
  return `+910${randomDigits(9)}`;
}

function secureRandomDigits(count: number): string {
  const bytes = crypto.getRandomValues(new Uint32Array(count));
  return Array.from(bytes, (n) => String(n % 10)).join('');
}

/**
 * The phone box on staff screens: a real mobile number, "0000000000" for a
 * patient with no phone (a fresh placeholder), or a placeholder carried over
 * from an earlier step of the same form.
 */
export function normalizeStaffPhone(input: string): { phoneE164: string; noPhone: boolean } | null {
  const trimmed = input.trim();
  if (isNoPhoneInput(trimmed)) return { phoneE164: makeNoPhonePlaceholder(), noPhone: true };
  if (isMockPhone(trimmed)) return { phoneE164: trimmed, noPhone: true };
  const phoneE164 = normalizeIndianPhone(trimmed);
  return phoneE164 ? { phoneE164, noPhone: false } : null;
}
