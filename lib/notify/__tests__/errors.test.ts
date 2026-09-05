import { describe, expect, it } from 'vitest';
import { isRetryableMetaError, ProviderError } from '../errors';

describe('Meta error classification', () => {
  it('does not retry a number that cannot receive WhatsApp', () => {
    // The patient does not have WhatsApp. Five attempts will not give them it.
    expect(isRetryableMetaError({ code: 131026, httpStatus: 400 })).toBe(false);
  });

  it('does not retry template problems, which are our mistake to fix', () => {
    for (const code of [132000, 132001, 132007, 132016]) {
      expect(isRetryableMetaError({ code, httpStatus: 400 })).toBe(false);
    }
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
