import { describe, expect, it } from 'vitest';
import {
  IntegrationAuthError,
  IntegrationError,
  disconnectIntegration,
  startOnboarding,
  validateConnection,
  type Actor,
} from '../whatsapp-integration';
import { refreshNumberHealth, returnNumberToInventory } from '../whatsapp-numbers';

/**
 * Authorization is asserted before anything else happens, so these need no
 * database: a rejected caller must be rejected before a connection is opened,
 * and that is exactly what makes it testable without one.
 *
 * If one of these ever starts needing a live Postgres, the check has moved too
 * late and the test failure is the point.
 */

const owner: Actor = { userId: 'u-owner', role: 'owner', isPlatformAdmin: false };
const receptionist: Actor = {
  userId: 'u-recep',
  role: 'receptionist',
  isPlatformAdmin: false,
};
const doctor: Actor = { userId: 'u-doc', role: 'doctor', isPlatformAdmin: false };
const platformAdmin: Actor = {
  userId: 'u-admin',
  role: 'receptionist',
  isPlatformAdmin: true,
};

const HOSPITAL = '11111111-1111-4111-8111-111111111111';

describe('who may manage the integration', () => {
  it('refuses a receptionist', async () => {
    await expect(
      startOnboarding({ hospitalId: HOSPITAL, actor: receptionist }),
    ).rejects.toThrow(IntegrationAuthError);

    await expect(
      validateConnection({ hospitalId: HOSPITAL, actor: receptionist }),
    ).rejects.toThrow(IntegrationAuthError);

    await expect(
      disconnectIntegration({ hospitalId: HOSPITAL, actor: receptionist }),
    ).rejects.toThrow(IntegrationAuthError);
  });

  it('refuses a doctor', async () => {
    await expect(
      startOnboarding({ hospitalId: HOSPITAL, actor: doctor }),
    ).rejects.toThrow(IntegrationAuthError);

    await expect(
      disconnectIntegration({ hospitalId: HOSPITAL, actor: doctor }),
    ).rejects.toThrow(IntegrationAuthError);
  });

  it('refuses a non-admin for platform-only operations', async () => {
    await expect(
      refreshNumberHealth({ phoneNumberId: '123456789012345', actor: owner }),
    ).rejects.toThrow(IntegrationAuthError);

    await expect(
      returnNumberToInventory({ phoneNumberId: '123456789012345', actor: owner }),
    ).rejects.toThrow(IntegrationAuthError);
  });

  it('rejects before doing any work, not after', async () => {
    // A receptionist must not even consume a rate-limit token or reach a
    // connection — the assertion is the first statement in the function.
    const before = Date.now();
    await expect(
      validateConnection({ hospitalId: HOSPITAL, actor: doctor }),
    ).rejects.toThrow(IntegrationAuthError);
    expect(Date.now() - before).toBeLessThan(500);
  });
});

describe('error surfaces', () => {
  it('carries a category and a safe message, never provider wording', () => {
    const error = new IntegrationError('INVALID_CREDENTIALS');
    expect(error.errorCode).toBe('INVALID_CREDENTIALS');
    expect(error.message).not.toMatch(/oauth|graph|bearer/i);
    expect(error.message.length).toBeGreaterThan(20);
  });

  it('carries a retry hint when rate limited', () => {
    const error = new IntegrationError('RATE_LIMITED', 42);
    expect(error.retryAfterSeconds).toBe(42);
  });
});

describe('rejecting implausible identifiers', () => {
  it('refuses a phone number id that is obviously the number itself', async () => {
    // Caught before any Graph API call, so a typo costs a form error rather
    // than a rate-limit slot against a limit shared by every hospital.
    await expect(
      refreshNumberHealth({ phoneNumberId: '+91 98765 43210', actor: platformAdmin }),
    ).rejects.toThrow(IntegrationError);
  });
});
