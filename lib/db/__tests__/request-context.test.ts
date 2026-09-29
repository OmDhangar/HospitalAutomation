import { describe, expect, it } from 'vitest';
import {
  isRequestReadOnly,
  markRequestReadOnly,
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
  it('defaults to writable outside any request', () => {
    expect(isRequestReadOnly()).toBe(false);
  });

  it('is visible to everything that continues from where it was set', async () => {
    await withRequestContext({ readOnly: false }, async () => {
      expect(isRequestReadOnly()).toBe(false);
      markRequestReadOnly();

      // The await is the point: this is the shape of resolving a session and
      // then opening a transaction, which is where the cache-based version
      // lost the flag.
      await Promise.resolve();
      expect(isRequestReadOnly()).toBe(true);

      await (async () => {
        await Promise.resolve();
        expect(isRequestReadOnly()).toBe(true);
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
      markRequestReadOnly();
      await new Promise((resolve) => setTimeout(resolve, 5));
      return isRequestReadOnly();
    });

    const writableSide = withRequestContext({ readOnly: false }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return isRequestReadOnly();
    });

    expect(await Promise.all([readOnlySide, writableSide])).toEqual([true, false]);
  });

  it('does not escape the context that set it', async () => {
    await withRequestContext({ readOnly: false }, async () => {
      markRequestReadOnly();
      expect(isRequestReadOnly()).toBe(true);
    });

    expect(isRequestReadOnly()).toBe(false);
  });
});
