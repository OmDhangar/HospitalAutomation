import { describe, expect, it } from 'vitest';
import {
  isRequestReadOnly,
  markRequestOrigin,
  markRequestReadOnly,
  markRequestStaffUser,
  registerRequestScope,
  requestFacts,
  requestStaffUserId,
  withRequestContext,
} from '../request-context';

/**
 * The flag that decides whether a transaction may write.
 *
 * These exist because the first implementation used React's `cache`, which
 * establishes a scope for a render pass. A server action executes outside one,
 * so the flag set while resolving the session was invisible to the transaction
 * that followed, and a read-only support session wrote a row to a customer's
 * queue. The cases below are the properties that failure violated.
 */
describe('request read-only context', () => {
  it('defaults to writable outside any request', async () => {
    expect(await isRequestReadOnly()).toBe(false);
  });

  it('is visible to everything that continues from where it was set', async () => {
    await withRequestContext({ readOnly: false }, async () => {
      expect(await isRequestReadOnly()).toBe(false);
      await markRequestReadOnly();

      // The await is the point: this is the shape of resolving a session and
      // then opening a transaction, which is where the cache-based version
      // lost the flag.
      await Promise.resolve();
      expect(await isRequestReadOnly()).toBe(true);

      await (async () => {
        await Promise.resolve();
        expect(await isRequestReadOnly()).toBe(true);
      })();
    });
  });

  /**
   * Two requests in flight at once must not see each other's flag. A support
   * session marking itself read-only cannot be allowed to freeze a hospital's
   * own reception desk, and — the dangerous direction — a writable request
   * must never clear the flag on a read-only one.
   */
  it('does not leak between concurrent contexts', async () => {
    const readOnlySide = withRequestContext({ readOnly: false }, async () => {
      await markRequestReadOnly();
      await new Promise((resolve) => setTimeout(resolve, 5));
      return await isRequestReadOnly();
    });

    const writableSide = withRequestContext({ readOnly: false }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return await isRequestReadOnly();
    });

    expect(await Promise.all([readOnlySide, writableSide])).toEqual([true, false]);
  });

  it('does not escape the context that set it', async () => {
    await withRequestContext({ readOnly: false }, async () => {
      await markRequestReadOnly();
      expect(await isRequestReadOnly()).toBe(true);
    });

    expect(await isRequestReadOnly()).toBe(false);
  });
});

describe('request staff user', () => {
  it('is absent by default: public, WhatsApp and worker paths carry no staff user', async () => {
    await withRequestContext({ readOnly: false }, async () => {
      expect(await requestStaffUserId()).toBeNull();
    });
  });

  it('is visible after an await once marked, and does not leak into another request', async () => {
    await withRequestContext({ readOnly: false }, async () => {
      await markRequestStaffUser('user-1');
      await Promise.resolve();
      expect(await requestStaffUserId()).toBe('user-1');
    });
    await withRequestContext({ readOnly: false }, async () => {
      expect(await requestStaffUserId()).toBeNull();
    });
  });
});

/**
 * Inside the web server the facts are kept per request, keyed by an object the
 * framework gives each request (Next's headers). This is the shape that
 * failed before: the session is resolved in one async branch (the layout, or
 * a helper that returns), and the transaction runs in another (the page, the
 * route's own code) — `enterWith` in the first never reached the second.
 */
describe('per-request facts in the web server', () => {
  it('reach every branch of the same request, and no other request', async () => {
    const requestA = {};
    const requestB = {};
    let current: object | null = null;
    registerRequestScope(async () => current);
    try {
      current = requestA;
      // Marked inside a helper that returns, as session resolution does.
      await (async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        await markRequestStaffUser('user-a');
        await markRequestOrigin({ sessionId: 's-a', channel: 'ward_device', deviceId: 'tab-1' });
      })();
      // Read from a separate branch of the same request.
      const fromOtherBranch = await (async () => requestFacts())();
      expect(fromOtherBranch).toEqual({
        readOnly: false,
        staffUserId: 'user-a',
        origin: { sessionId: 's-a', channel: 'ward_device', deviceId: 'tab-1' },
      });

      current = requestB;
      expect(await requestFacts()).toEqual({ readOnly: false, staffUserId: null, origin: null });
      await markRequestReadOnly();
      current = requestA;
      expect(await isRequestReadOnly()).toBe(false);
      current = requestB;
      expect(await isRequestReadOnly()).toBe(true);
    } finally {
      registerRequestScope(async () => null);
    }
  });

  it('gives way to an explicit context (tests, the worker)', async () => {
    const request = {};
    registerRequestScope(async () => request);
    try {
      await markRequestReadOnly();
      await withRequestContext({ readOnly: false, staffUserId: 'worker' }, async () => {
        expect(await requestFacts()).toMatchObject({ readOnly: false, staffUserId: 'worker' });
      });
    } finally {
      registerRequestScope(async () => null);
    }
  });
});
