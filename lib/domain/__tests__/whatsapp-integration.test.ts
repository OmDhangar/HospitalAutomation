import { describe, expect, it } from 'vitest';
import {
  categorizeProviderError,
  deriveHealth,
  INTEGRATION_ERROR_CODES,
  integrationErrorMessage,
  isPlausiblePhoneNumberId,
  isPlausibleWabaId,
  maskIdentifier,
} from '../whatsapp-integration';

describe('categorizeProviderError', () => {
  it('maps an expired token to invalid credentials', () => {
    expect(categorizeProviderError({ code: 190, httpStatus: 401 })).toBe(
      'INVALID_CREDENTIALS',
    );
  });

  it('maps a missing permission to permission denied', () => {
    expect(categorizeProviderError({ code: 200, httpStatus: 403 })).toBe(
      'PERMISSION_DENIED',
    );
  });

  it('distinguishes an unseeable object from a generic configuration error', () => {
    // Meta reuses code 100 heavily; the subcode is what separates "that number
    // is not yours" from "you asked for a field that does not exist".
    expect(categorizeProviderError({ code: 100, subcode: 33 })).toBe(
      'INVALID_PHONE_NUMBER',
    );
    expect(categorizeProviderError({ code: 100 })).toBe('CONFIGURATION_ERROR');
  });

  it('maps an unregistered number to its own category', () => {
    expect(categorizeProviderError({ code: 133010 })).toBe('NUMBER_NOT_REGISTERED');
  });

  it('maps rate limits', () => {
    expect(categorizeProviderError({ code: 4 })).toBe('RATE_LIMITED');
    expect(categorizeProviderError({ code: 130429 })).toBe('RATE_LIMITED');
    expect(categorizeProviderError({ httpStatus: 429 })).toBe('RATE_LIMITED');
  });

  it('treats 5xx as the provider being unavailable', () => {
    expect(categorizeProviderError({ httpStatus: 503 })).toBe('PROVIDER_UNAVAILABLE');
    expect(categorizeProviderError({ code: 2 })).toBe('PROVIDER_UNAVAILABLE');
  });

  it('falls back to unknown rather than guessing', () => {
    expect(categorizeProviderError({})).toBe('UNKNOWN_PROVIDER_ERROR');
    expect(categorizeProviderError({ code: 999999 })).toBe('UNKNOWN_PROVIDER_ERROR');
  });
});

describe('integrationErrorMessage', () => {
  it('has a message for every category', () => {
    for (const code of INTEGRATION_ERROR_CODES) {
      expect(integrationErrorMessage(code).length).toBeGreaterThan(20);
    }
  });

  it('never leaks provider jargon to the reader', () => {
    // The point of the taxonomy is that none of these reach a hospital owner.
    for (const code of INTEGRATION_ERROR_CODES) {
      const message = integrationErrorMessage(code).toLowerCase();
      expect(message).not.toContain('oauth');
      expect(message).not.toContain('graph');
      expect(message).not.toContain('token');
      expect(message).not.toContain('bearer');
    }
  });
});

describe('deriveHealth', () => {
  const base = {
    integrationStatus: 'connected' as const,
    numberStatus: 'registered' as const,
    qualityRating: 'GREEN' as string | null,
  };

  it('is healthy when credentials work and the number is registered', () => {
    expect(deriveHealth(base)).toBe('healthy');
  });

  it('is healthy when Meta has not reported a rating yet', () => {
    expect(deriveHealth({ ...base, qualityRating: null })).toBe('healthy');
  });

  it('separates a working credential from an unregistered number', () => {
    // The most common real onboarding state, and the one a single status column
    // would be unable to express.
    expect(deriveHealth({ ...base, numberStatus: 'pending' })).toBe('setup');
  });

  it('reports no number as setup, not as failure', () => {
    expect(deriveHealth({ ...base, numberStatus: null })).toBe('setup');
  });

  it('treats a suspended or released number as blocked', () => {
    expect(deriveHealth({ ...base, numberStatus: 'suspended' })).toBe('blocked');
    expect(deriveHealth({ ...base, numberStatus: 'released' })).toBe('blocked');
  });

  it('treats a flagged number as degraded', () => {
    expect(deriveHealth({ ...base, numberStatus: 'flagged' })).toBe('degraded');
  });

  it('surfaces quality ratings while they can still be acted on', () => {
    expect(deriveHealth({ ...base, qualityRating: 'YELLOW' })).toBe('degraded');
    expect(deriveHealth({ ...base, qualityRating: 'RED' })).toBe('blocked');
  });

  it('is case-insensitive about the rating Meta reports', () => {
    expect(deriveHealth({ ...base, qualityRating: 'red' })).toBe('blocked');
  });

  it('reports integration state ahead of number state', () => {
    expect(deriveHealth({ ...base, integrationStatus: 'error' })).toBe('blocked');
    expect(deriveHealth({ ...base, integrationStatus: 'disconnected' })).toBe('off');
    expect(deriveHealth({ ...base, integrationStatus: 'not_configured' })).toBe('setup');
    expect(deriveHealth({ ...base, integrationStatus: 'pending' })).toBe('setup');
  });
});

describe('maskIdentifier', () => {
  it('shows only the last four characters', () => {
    expect(maskIdentifier('123456789012345')).toBe('••••2345');
  });

  it('reveals nothing for a short value', () => {
    expect(maskIdentifier('12')).toBe('••');
  });

  it('passes null through', () => {
    expect(maskIdentifier(null)).toBeNull();
    expect(maskIdentifier(undefined)).toBeNull();
    expect(maskIdentifier('')).toBeNull();
  });
});

describe('identifier validation', () => {
  it('accepts a realistic Meta phone number id', () => {
    expect(isPlausiblePhoneNumberId('123456789012345')).toBe(true);
    expect(isPlausibleWabaId('109876543210987')).toBe(true);
  });

  it('rejects the number itself, which is the usual mistake', () => {
    expect(isPlausiblePhoneNumberId('+91 98765 43210')).toBe(false);
  });

  it('rejects empty, short and non-numeric input', () => {
    expect(isPlausiblePhoneNumberId('')).toBe(false);
    expect(isPlausiblePhoneNumberId('123')).toBe(false);
    expect(isPlausiblePhoneNumberId('abc1234567890')).toBe(false);
  });

  it('tolerates surrounding whitespace from a paste', () => {
    expect(isPlausiblePhoneNumberId('  123456789012345  ')).toBe(true);
  });
});
