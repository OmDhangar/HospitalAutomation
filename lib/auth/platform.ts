import { notFound } from 'next/navigation';
import { requireSession } from './session';
import type { Session } from '@/lib/services/auth';

/**
 * The gate on every operator page and action.
 *
 * `notFound()` rather than a redirect or an "access denied" page: to anyone
 * who is not an operator, this part of the product does not exist, and saying
 * "forbidden" tells them it does. The operator console is not a feature they
 * are one upgrade away from.
 *
 * Called in each page and each action rather than once in the layout. A layout
 * is not a security boundary in the app router — a page renders on its own, and
 * a server action is reachable by POST whether any layout ran or not.
 */
export async function requirePlatformAdmin(): Promise<Session> {
  const session = await requireSession();
  if (!session.isPlatformAdmin) notFound();

  /**
   * An impersonated session is a platform admin's session, and it must not be
   * able to reach back out into the console to administer other tenants. That
   * would be a read-only support window with full cross-tenant write authority
   * hanging off it, since the operator actions run on the admin connection and
   * the read-only policies do not apply there.
   */
  if (session.impersonatedByUserId !== null) notFound();

  return session;
}
