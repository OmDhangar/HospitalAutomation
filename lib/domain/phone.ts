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
  const local = e164.replace(/^\+91/, '');
  return local.length === 10 ? `${local.slice(0, 5)} ${local.slice(5)}` : e164;
}
