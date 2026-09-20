import { describe, expect, it } from 'vitest';
import { isRetryableMetaError, ProviderError } from '../errors';

describe('Meta error classification', () => {
  it('does not retry a number that cannot receive WhatsApp', () => {
    // The patient does not have WhatsApp. Five attempts will not give them it.
    expect(isRetryableMetaError({ code: 131026, httpStatus: 400 })).toBe(false);
  });

  it('does not retry template problems that are our mistake to fix', () => {
    // A wrong parameter count, a format mismatch or a disabled template are
    // facts about what we submitted. The fifth attempt sends the same thing.
    for (const code of [132000, 132007, 132012, 132016]) {
      expect(isRetryableMetaError({ code, httpStatus: 400 })).toBe(false);
    }
  });

  it('DOES retry a template Meta is still reviewing', () => {
    /**
     * 132001 was previously classified as permanent alongside the others, and
     * that was wrong in one specific and expensive case: editing an approved
     * template returns it to review, and every send fails with this code until
     * the review finishes — minutes usually, occasionally an hour or more.
     *
     * Treating it as permanent meant a routine wording change silently killed
     * every reminder queued during the review window. The message is still
     * valid and still wanted; it just has to wait.
     *
     * 132015 is the same shape: a quality pause lifts on its own.
     */
    expect(isRetryableMetaError({ code: 132001, httpStatus: 400 })).toBe(true);
    expect(isRetryableMetaError({ code: 132015, httpStatus: 400 })).toBe(true);
  });

  it('does not retry an invalid access token', () => {
    // Configuration, not weather. Retrying hides the real problem.
    expect(isRetryableMetaError({ code: 190, httpStatus: 401 })).toBe(false);
  });

  it('retries rate limits', () => {
    for (const code of [130429, 131048, 131056]) {
      expect(isRetryableMetaError({ code, httpStatus: 400 })).toBe(true);
    }
  });

  it('retries a bare 429 or 5xx even with no error code', () => {
    expect(isRetryableMetaError({ httpStatus: 429 })).toBe(true);
    expect(isRetryableMetaError({ httpStatus: 500 })).toBe(true);
    expect(isRetryableMetaError({ httpStatus: 503 })).toBe(true);
  });

  it('treats an unrecognised 4xx as our fault and gives up', () => {
    expect(isRetryableMetaError({ httpStatus: 400 })).toBe(false);
    expect(isRetryableMetaError({ httpStatus: 403 })).toBe(false);
  });

  it('retries when there was no response at all', () => {
    // A socket that never connected says nothing about whether it would later.
    expect(isRetryableMetaError({})).toBe(true);
  });

  it('lets a known code override the HTTP status', () => {
    // Meta returns 400 for rate limits, which would otherwise look permanent.
    expect(isRetryableMetaError({ code: 130429, httpStatus: 400 })).toBe(true);
  });

  it('carries the classification on the error itself', () => {
    const error = new ProviderError('nope', false, 131026, 400);
    expect(error.retryable).toBe(false);
    expect(error.code).toBe(131026);
    expect(error.name).toBe('ProviderError');
  });
});
