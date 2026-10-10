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
 * Two places hold them:
 *
 * - **Inside the web server**, a record per request, found through a key the
 *   framework gives each request (`registerRequestScope`, set by
 *   lib/auth/session.ts to Next's per-request `headers()` object). Marking
 *   the session used to call `AsyncLocalStorage.enterWith` deep inside
 *   session resolution; under Next.js that never reached the page, route or
 *   action that called it, so no browser request carried its read-only flag,
 *   staff user, session, channel or device (found in phase A6-min: the
 *   evidence log recorded none). A record keyed by the request does not
 *   depend on how async context flows back up the call stack.
 * - **Everywhere else** (tests, the worker, scripts), `AsyncLocalStorage`, set
 *   explicitly with `withRequestContext`. An explicit context always wins.
 *
 * React's `cache` was tried first and is not used: a server action executes
 * outside a render's cache scope, and a read-only support session wrote a row.
 */
type RequestContext = {
  readOnly: boolean;
  /**
   * The signed-in staff user, when this request has one. `withTenant` writes it
   * to `app.staff_user_id` so the identity definer functions can require a real
   * member of the hospital (0039). Public booking, the patient link, WhatsApp
   * and the worker never set it.
   */
  staffUserId?: string | null;
  /**
   * Where the request came from (0042, ADR-022): the session, its channel
   * (own device or ward tablet) and the device. Written onto bedside entries,
   * access-log rows and the evidence log; never used to decide what is allowed.
   */
  origin?: RequestOrigin | null;
};

export type RequestOrigin = {
  sessionId: string;
  channel: 'personal' | 'ward_device';
  deviceId: string | null;
};

const storage = new AsyncLocalStorage<RequestContext>();

/** Returns an object unique to the current web request, or null outside one. */
type RequestScope = () => Promise<object | null>;
let requestScope: RequestScope | null = null;
const scoped = new WeakMap<object, RequestContext>();

/** Called once by the web server's session module. Not called by tests, the worker or scripts. */
export function registerRequestScope(scope: RequestScope): void {
  requestScope = scope;
}

async function current(create: boolean): Promise<RequestContext | null> {
  const explicit = storage.getStore();
  if (explicit) return explicit;
  const key = requestScope ? await requestScope() : null;
  if (!key) return null;
  let context = scoped.get(key);
  if (!context && create) {
    context = { readOnly: false };
    scoped.set(key, context);
  }
  return context ?? null;
}

/**
 * Marks what was learnt about this request. With no explicit context and no
 * web request, falls back to `enterWith` (correct in plain Node, where it is
 * only ever reached from a test or a script).
 */
async function mark(change: (context: RequestContext) => void): Promise<void> {
  const context = await current(true);
  if (context) {
    change(context);
    return;
  }
  const fresh: RequestContext = { readOnly: false };
  change(fresh);
  storage.enterWith(fresh);
}

/**
 * Only ever called when an impersonated session resolves. Nothing clears it:
 * the only value ever written is the restrictive one, so the failure mode of
 * a stray context is a refused write, never an allowed one.
 */
export function markRequestReadOnly(): Promise<void> {
  return mark((context) => {
    context.readOnly = true;
  });
}

/**
 * Records the staff user behind this request. Called only when an ordinary
 * (non-impersonated) staff session resolves, so a support operator never
 * carries one. The database does not trust it alone: every identity function
 * also requires an active membership of that user in the transaction's own
 * hospital.
 */
export function markRequestStaffUser(userId: string): Promise<void> {
  return mark((context) => {
    context.staffUserId = userId;
  });
}

/** Records where this request came from. Called when a staff session resolves. */
export function markRequestOrigin(origin: RequestOrigin): Promise<void> {
  return mark((context) => {
    context.origin = origin;
  });
}

/** Everything `withTenant` writes into a transaction, in one lookup. */
export async function requestFacts(): Promise<{ readOnly: boolean; staffUserId: string | null; origin: RequestOrigin | null }> {
  const context = await current(false);
  return {
    // Writable by default: correct for every path without a session (public
    // booking, the queue link, WhatsApp, the worker, migrations), none of
    // which can be impersonated.
    readOnly: context?.readOnly ?? false,
    staffUserId: context?.staffUserId ?? null,
    origin: context?.origin ?? null,
  };
}

/** The staff user of this request, or null when there is none (public, WhatsApp, worker). */
export async function requestStaffUserId(): Promise<string | null> {
  return (await requestFacts()).staffUserId;
}

export async function isRequestReadOnly(): Promise<boolean> {
  return (await requestFacts()).readOnly;
}

/** The session, channel and device of this request, or null (public pages, worker, tests). */
export async function requestOrigin(): Promise<RequestOrigin | null> {
  return (await requestFacts()).origin;
}

/**
 * Runs `fn` with an explicit context. Used by tests, which need the facts to
 * begin and end somewhere definite rather than leaking between cases.
 */
export function withRequestContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}
