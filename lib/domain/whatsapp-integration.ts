/**
 * The vocabulary of WhatsApp onboarding: what can go wrong, what the hospital
 * is told about it, and how integration state plus number state combine into
 * the one word an owner actually reads.
 *
 * Pure on purpose. Everything here is decided without a database, a session or
 * a network call, which is what makes the failure taxonomy testable — and a
 * failure taxonomy nobody tests is a list of strings.
 */

/**
 * Why a connection attempt failed, in terms the product understands.
 *
 * Meta's own errors are not usable here for two reasons. They quote the access
 * token back inside the message, so they can never be shown or logged verbatim;
 * and they describe Graph API mechanics rather than the thing the hospital has
 * to do next. These categories exist to answer "what now", which is the only
 * question being asked.
 */
export const INTEGRATION_ERROR_CODES = [
  'INVALID_CREDENTIALS',
  'INVALID_WABA',
  'INVALID_PHONE_NUMBER',
  'NUMBER_NOT_REGISTERED',
  'NUMBER_ALREADY_ASSIGNED',
  'PERMISSION_DENIED',
  'PROVIDER_UNAVAILABLE',
  'RATE_LIMITED',
  'CONFIGURATION_ERROR',
  'UNKNOWN_PROVIDER_ERROR',
] as const;

export type IntegrationErrorCode = (typeof INTEGRATION_ERROR_CODES)[number];

export type IntegrationStatus =
  | 'not_configured'
  | 'pending'
  | 'validating'
  | 'connected'
  | 'error'
  | 'disconnected';

export type NumberStatus =
  | 'pending'
  | 'registered'
  | 'flagged'
  | 'suspended'
  | 'released';

/**
 * Maps a Meta Graph API failure onto a category.
 *
 * Codes come from Meta's error reference. The HTTP status is the fallback
 * rather than the primary signal, because Meta returns 400 for both "your token
 * is dead" and "that number is not yours" — and those need different sentences
 * in front of a hospital owner.
 */
export function categorizeProviderError(args: {
  code?: number;
  subcode?: number;
  httpStatus?: number;
}): IntegrationErrorCode {
  switch (args.code) {
    case 190: // token invalid, expired, or revoked
      return 'INVALID_CREDENTIALS';
    case 200: // permission missing on the token
    case 10:
      return 'PERMISSION_DENIED';
    case 100:
      // 100 is Meta's catch-all for "that identifier is not one you can see",
      // which in this flow almost always means the number belongs elsewhere.
      return args.subcode === 33 ? 'INVALID_PHONE_NUMBER' : 'CONFIGURATION_ERROR';
    case 133010:
      return 'NUMBER_NOT_REGISTERED';
    case 4: // application request limit reached
    case 80007:
    case 130429:
      return 'RATE_LIMITED';
    case 1:
    case 2:
      return 'PROVIDER_UNAVAILABLE';
    default:
      break;
  }

  if (args.httpStatus === 401 || args.httpStatus === 403) return 'PERMISSION_DENIED';
  if (args.httpStatus === 429) return 'RATE_LIMITED';
  if (args.httpStatus !== undefined && args.httpStatus >= 500) {
    return 'PROVIDER_UNAVAILABLE';
  }

  return 'UNKNOWN_PROVIDER_ERROR';
}

/**
 * What the hospital is shown. Never the provider's own words.
 *
 * Each one names something the reader can act on. "Invalid OAuth access token"
 * tells a receptionist nothing; "we could not authenticate — the platform team
 * has been notified" tells them it is not their problem and not their fix,
 * which under platform ownership is the truth.
 */
const ERROR_MESSAGES: Record<IntegrationErrorCode, string> = {
  INVALID_CREDENTIALS:
    'WhatsApp could not be reached with the current credentials. The platform team has been notified — no action is needed from your side.',
  INVALID_WABA:
    'This number is not held in the WhatsApp Business Account configured for your hospital. Contact support so it can be moved.',
  INVALID_PHONE_NUMBER:
    'That WhatsApp number id was not recognised. Check it against the Meta dashboard, or contact support.',
  NUMBER_NOT_REGISTERED:
    'The number exists but has not finished registration with Meta. Registration usually completes within a few minutes of SMS or voice verification.',
  NUMBER_ALREADY_ASSIGNED:
    'That WhatsApp number is already connected to another hospital. A number can only serve one hospital at a time.',
  PERMISSION_DENIED:
    'The WhatsApp connection is missing a required permission. The platform team has been notified.',
  PROVIDER_UNAVAILABLE:
    'WhatsApp is not responding right now. This is usually brief — try again in a few minutes.',
  RATE_LIMITED:
    'Too many checks in a short period. Wait a minute and try again.',
  CONFIGURATION_ERROR:
    'The WhatsApp configuration is incomplete. Contact support to finish setting it up.',
  UNKNOWN_PROVIDER_ERROR:
    'Unable to validate the WhatsApp connection. The credentials may have expired, or the number may not belong to the configured business account.',
};

export function integrationErrorMessage(code: IntegrationErrorCode): string {
  return ERROR_MESSAGES[code];
}

/**
 * The single word an owner reads on the settings page.
 *
 * Derived from both statuses rather than stored, because a stored copy is a
 * third thing to keep in step with the two facts it is computed from — and the
 * one that goes stale silently.
 */
export type ConnectionHealth = 'healthy' | 'degraded' | 'blocked' | 'setup' | 'off';

export function deriveHealth(args: {
  integrationStatus: IntegrationStatus;
  numberStatus: NumberStatus | null;
  qualityRating: string | null;
}): ConnectionHealth {
  if (args.integrationStatus === 'disconnected') return 'off';
  if (args.integrationStatus === 'not_configured') return 'setup';
  if (args.integrationStatus === 'error') return 'blocked';

  // Connected credentials still send nothing without a registered sender. That
  // gap is the most common real state during onboarding, so it gets its own
  // answer rather than being rounded up to healthy or down to blocked.
  if (args.numberStatus === null) return 'setup';
  if (args.numberStatus === 'suspended' || args.numberStatus === 'released') {
    return 'blocked';
  }
  if (args.numberStatus === 'flagged') return 'degraded';
  if (args.numberStatus !== 'registered') return 'setup';

  if (args.integrationStatus !== 'connected') return 'setup';

  // Meta scores quality per number. RED precedes a suspension rather than
  // following one, so it is worth surfacing while it can still be acted on.
  const rating = args.qualityRating?.toUpperCase();
  if (rating === 'RED') return 'blocked';
  if (rating === 'YELLOW') return 'degraded';

  return 'healthy';
}

export const HEALTH_LABELS: Record<ConnectionHealth, string> = {
  healthy: 'Healthy',
  degraded: 'Needs attention',
  blocked: 'Not sending',
  setup: 'Setup in progress',
  off: 'Disconnected',
};

/**
 * Shows enough of an identifier to recognise it, never enough to use it.
 *
 * Applied to WABA and phone number ids, which are not secrets but are also not
 * the hospital's business to hold under platform ownership. Four trailing
 * characters is enough to match against a support ticket.
 */
export function maskIdentifier(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed.length <= 4) return '•'.repeat(trimmed.length);
  return `••••${trimmed.slice(-4)}`;
}

/**
 * Meta's phone number ids are numeric strings of 15-ish digits. Validated
 * before it reaches the provider so an obvious typo costs a form error rather
 * than an API round trip and a rate-limit slot.
 */
export function isPlausiblePhoneNumberId(value: string): boolean {
  return /^\d{10,20}$/.test(value.trim());
}

export function isPlausibleWabaId(value: string): boolean {
  return /^\d{10,20}$/.test(value.trim());
}
