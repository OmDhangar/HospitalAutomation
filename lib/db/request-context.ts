import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Per-request facts that every tenant transaction needs, but that no service
 * signature carries.
 *
 * `withTenant` is called from thirty-odd places, most of them several layers
 * below the page or action that resolved the session. Threading "this request
 * may not write" down through all of them would mean changing every service
 * signature, and the first one anybody forgot would be a hole in the guard.
 *
 * `AsyncLocalStorage` rather than React's `cache`: a cache scope is
 * established for a render pass, and a server action executes outside one, so
 * the flag set while resolving the session was invisible to the transaction
 * that followed. Async context spans both.
 */
type RequestContext = { readOnly: boolean };

const storage = new AsyncLocalStorage<RequestContext>();

/**
 * Only ever called when an impersonated session resolves.
 *
 * `enterWith` rather than `run`, because there is no callback to wrap: the
 * session is resolved partway through a request that is already in flight.
 * It sets the store for the current async context and everything that
 * continues from it, which is precisely the transactions that follow.
 *
 * Nothing clears it. The context does not outlive the request, and the only
 * value ever written is the restrictive one — so the failure mode of a stray
 * context is a refused write, never an allowed one.
 */
export function markRequestReadOnly(): void {
  const existing = storage.getStore();
  if (existing) {
    existing.readOnly = true;
    return;
  }
  storage.enterWith({ readOnly: true });
}

/**
 * Defaults to writable, which is correct in every case this can be reached
 * without a session: the public booking page, the patient's queue link, the
 * WhatsApp webhook, the worker and migrations. None of those can be
 * impersonated.
 */
export function isRequestReadOnly(): boolean {
  return storage.getStore()?.readOnly ?? false;
}

/**
 * Runs `fn` with an explicit context. Used by tests, which need the flag to
 * begin and end somewhere definite rather than leaking between cases.
 */
export function withRequestContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}
