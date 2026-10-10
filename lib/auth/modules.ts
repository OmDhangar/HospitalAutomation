import { notFound } from 'next/navigation';
import { cache } from 'react';
import { moduleAllows, type ModuleId, type ModuleStates } from '@/lib/modules/registry';
import { getModuleStates } from '@/lib/services/modules';

/**
 * Module checks for pages and server actions (ADR-021). Every route a non-core
 * module owns calls one of these on the server; hiding a button is never the
 * check. The coverage test (lib/modules/__tests__/coverage.test.ts) fails if a
 * module route does not.
 *
 * Route handlers use `ipdCaller(permission, { module })` instead, which answers
 * with JSON rather than a 404 page.
 */

/** One read of the hospital's module states per request, shared by layout and page. */
export const getModuleStatesForRequest = cache((hospitalId: string): Promise<ModuleStates> => getModuleStates(hospitalId));

/** For pages: a module that is off (or read-only, for a write) is a 404, as if the page did not exist. */
export async function requireModule(
  session: { hospitalId: string },
  id: ModuleId,
  mode: 'read' | 'write' = 'read',
  wardId: string | null = null,
): Promise<ModuleStates> {
  const states = await getModuleStatesForRequest(session.hospitalId);
  if (!moduleAllows(states, id, mode, wardId)) notFound();
  return states;
}

export class ModuleUnavailableError extends Error {
  constructor(readonly moduleId: ModuleId) {
    super('This part of QuriioHQ is not switched on for your hospital');
  }
}

/** For server actions: throws, so the action stops before it writes anything. */
export async function assertModule(
  session: { hospitalId: string },
  id: ModuleId,
  mode: 'read' | 'write' = 'write',
  wardId: string | null = null,
): Promise<void> {
  const states = await getModuleStatesForRequest(session.hospitalId);
  if (!moduleAllows(states, id, mode, wardId)) throw new ModuleUnavailableError(id);
}
