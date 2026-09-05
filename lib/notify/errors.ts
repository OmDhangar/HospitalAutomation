/**
 * Meta returns numeric error codes, and the difference between them matters:
 * some describe a transient condition worth retrying, and some describe a fact
 * about the world that will still be true on the fifth attempt.
 *
 * Retrying a permanent failure five times with exponential backoff keeps a dead
 * message in the queue for half an hour, buries the real cause under repeated
 * noise, and — once these become billable retries — costs money for nothing.
 */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly code?: number,
    readonly httpStatus?: number,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

/**
 * Permanent failures. Nothing we do differently on a retry changes these.
 *
 * Codes are from Meta's Cloud API error reference. Verify them against the
 * current documentation when the integration goes live — Meta adds codes.
 */
const PERMANENT_CODES = new Set([
  131026, // recipient is not a WhatsApp user, or cannot receive the message
  131047, // outside the 24-hour window and no template used
  131051, // unsupported message type
  132000, // template parameter count does not match the approved template
  132001, // template does not exist in this language
  132005, // template text exceeds the approved length
  132007, // template format mismatch
  132012, // template parameter format is invalid
  132015, // template is paused for quality reasons
  132016, // template is disabled
  133010, // phone number is not registered
  190, //    access token is invalid or expired — configuration, not weather
]);

/**
 * Transient failures. These are worth another attempt after a delay.
 */
const RETRYABLE_CODES = new Set([
  130429, // rate limit hit
  131048, // spam rate limit hit
  131056, // pair rate limit hit
  133016, // account temporarily unavailable
  368, //    temporarily blocked for policy violations
  1, //      an unknown internal error
  2, //      service temporarily unavailable
  4, //      application request limit reached
]);

export function isRetryableMetaError(args: {
  code?: number;
  httpStatus?: number;
}): boolean {
  if (args.code !== undefined) {
    if (PERMANENT_CODES.has(args.code)) return false;
    if (RETRYABLE_CODES.has(args.code)) return true;
  }

  // Fall back to the HTTP status. 5xx and 429 are the classic retryable shapes;
  // a 4xx we do not recognise is far more likely to be our mistake than Meta's.
  if (args.httpStatus !== undefined) {
    if (args.httpStatus === 429) return true;
    if (args.httpStatus >= 500) return true;
    if (args.httpStatus >= 400) return false;
  }

  // Network-level failure with no response at all: worth retrying.
  return true;
}
