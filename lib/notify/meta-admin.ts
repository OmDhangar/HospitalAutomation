import {
  categorizeProviderError,
  type IntegrationErrorCode,
} from '@/lib/domain/whatsapp-integration';

/**
 * Read-only Graph API calls used by onboarding, kept apart from the message
 * sending path in `provider.ts`.
 *
 * The separation is deliberate. Sending is hot, runs in the worker, and must
 * stay indifferent to how a hospital was onboarded. These calls are cold, run
 * once per configuration change, and exist to answer one question the sending
 * path is in no position to ask: is this number actually ours to use?
 *
 * Nothing here logs a token, echoes one into an error, or accepts one from
 * anywhere other than a caller that just read it from the environment or
 * unsealed it server-side.
 */

const GRAPH_VERSION = 'v23.0';
const GRAPH_ROOT = `https://graph.facebook.com/${GRAPH_VERSION}`;

/** How long to wait before treating Meta as unavailable. */
const TIMEOUT_MS = 10_000;

/**
 * A failure already reduced to a category.
 *
 * The provider's own message is deliberately absent: it routinely contains the
 * access token and always contains Graph API vocabulary that means nothing to
 * a hospital. Callers log the category and show the category's message.
 */
export class MetaAdminError extends Error {
  constructor(
    readonly errorCode: IntegrationErrorCode,
    /** For structured server logs only. Never rendered, never audited. */
    readonly diagnostic?: string,
  ) {
    super(errorCode);
    this.name = 'MetaAdminError';
  }
}

export type MetaPhoneNumber = {
  id: string;
  displayPhoneNumber: string | null;
  verifiedName: string | null;
  qualityRating: string | null;
  /** VERIFIED once SMS or voice verification has completed. */
  codeVerificationStatus: string | null;
  /** Meta's throughput tier, e.g. TIER_1K. */
  messagingTier: string | null;
};

type GraphPhoneNumber = {
  id?: string;
  display_phone_number?: string;
  verified_name?: string;
  quality_rating?: string;
  code_verification_status?: string;
  throughput?: { level?: string };
};

type GraphError = {
  error?: { message?: string; code?: number; error_subcode?: number; type?: string };
};

const PHONE_FIELDS =
  'id,display_phone_number,verified_name,quality_rating,code_verification_status,throughput';

function toPhoneNumber(row: GraphPhoneNumber): MetaPhoneNumber {
  return {
    id: String(row.id ?? ''),
    displayPhoneNumber: row.display_phone_number ?? null,
    verifiedName: row.verified_name ?? null,
    qualityRating: row.quality_rating ?? null,
    codeVerificationStatus: row.code_verification_status ?? null,
    messagingTier: row.throughput?.level ?? null,
  };
}

async function graphGet<T>(path: string, accessToken: string): Promise<T> {
  let response: Response;

  try {
    response = await fetch(`${GRAPH_ROOT}/${path}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: 'no-store',
    });
  } catch (error) {
    // A timeout or a DNS failure is Meta being unreachable, not the hospital's
    // configuration being wrong. Saying so avoids sending an owner to check
    // credentials that are perfectly fine.
    throw new MetaAdminError(
      'PROVIDER_UNAVAILABLE',
      error instanceof Error ? error.name : 'network error',
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new MetaAdminError('PROVIDER_UNAVAILABLE', 'unparseable response');
  }

  if (!response.ok) {
    const { error } = body as GraphError;
    const errorCode = categorizeProviderError({
      code: error?.code,
      subcode: error?.error_subcode,
      httpStatus: response.status,
    });
    // The diagnostic carries the numeric code and type only — never
    // error.message, which is where Meta quotes the token back.
    throw new MetaAdminError(
      errorCode,
      `http=${response.status} code=${error?.code ?? '?'} subcode=${
        error?.error_subcode ?? '?'
      } type=${error?.type ?? '?'}`,
    );
  }

  return body as T;
}

/** One number, looked up by its Meta id. */
export async function fetchPhoneNumber(args: {
  phoneNumberId: string;
  accessToken: string;
}): Promise<MetaPhoneNumber> {
  const row = await graphGet<GraphPhoneNumber>(
    `${encodeURIComponent(args.phoneNumberId)}?fields=${PHONE_FIELDS}`,
    args.accessToken,
  );

  if (!row.id) {
    throw new MetaAdminError('INVALID_PHONE_NUMBER', 'response carried no id');
  }

  return toPhoneNumber(row);
}

/**
 * Every number held in one WhatsApp Business Account.
 *
 * Paginated because a WABA holds up to 20 numbers and Meta pages at 25 by
 * default — close enough that relying on a single page would work in testing
 * and fail on the one account that matters.
 */
export async function listWabaPhoneNumbers(args: {
  wabaId: string;
  accessToken: string;
}): Promise<MetaPhoneNumber[]> {
  const collected: MetaPhoneNumber[] = [];
  let path: string | null =
    `${encodeURIComponent(args.wabaId)}/phone_numbers?fields=${PHONE_FIELDS}&limit=50`;

  // Bounded so a malformed paging cursor cannot spin here indefinitely.
  for (let page = 0; page < 10 && path; page += 1) {
    const body: { data?: GraphPhoneNumber[]; paging?: { next?: string } } =
      await graphGet(path, args.accessToken);

    for (const row of body.data ?? []) collected.push(toPhoneNumber(row));

    const next = body.paging?.next;
    // Meta returns an absolute URL; reduce it back to a path so every request
    // goes through the same base, version and timeout.
    path = next ? next.replace(`${GRAPH_ROOT}/`, '') : null;
    if (next && path === next) path = null;
  }

  return collected;
}

export type NumberVerification = {
  number: MetaPhoneNumber;
  /** False when Meta has not finished SMS/voice verification for the number. */
  registered: boolean;
};

/**
 * Confirms that a number is genuinely held in the expected WABA.
 *
 * This is the check that makes cross-hospital number theft impossible rather
 * than merely unlikely. The browser supplies a phone number id; until Meta
 * confirms that id sits inside the WhatsApp Business Account this integration
 * is entitled to, it is an unverified claim and is treated as one.
 *
 * Listing the WABA's numbers is used rather than reading the number's own
 * parent account, because the former proves membership of an account we chose
 * and the latter only reports an account the caller has not vouched for.
 */
export async function verifyNumberBelongsToWaba(args: {
  phoneNumberId: string;
  wabaId: string;
  accessToken: string;
}): Promise<NumberVerification> {
  const numbers = await listWabaPhoneNumbers({
    wabaId: args.wabaId,
    accessToken: args.accessToken,
  });

  const match = numbers.find((n) => n.id === args.phoneNumberId.trim());
  if (!match) {
    throw new MetaAdminError(
      'INVALID_WABA',
      `number not present in waba (${numbers.length} numbers checked)`,
    );
  }

  return {
    number: match,
    registered: match.codeVerificationStatus?.toUpperCase() === 'VERIFIED',
  };
}
