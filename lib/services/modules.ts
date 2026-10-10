import { and, eq } from 'drizzle-orm';
import { withTenant } from '@/lib/db';
import { auditLogs, hospitalFeatures } from '@/lib/db/schema';
import {
  MODULE_STAGES,
  MODULE_STATES,
  isModuleId,
  moduleById,
  resolveModuleStates,
  type ModuleStage,
  type ModuleState,
  type ModuleStates,
  type RolloutScope,
} from '@/lib/modules/registry';

/**
 * Per-hospital module states (ADR-021). One indexed read of
 * `hospital_features` per request; the app layer caches it for the request.
 */

export class ModuleConfigError extends Error {}

export async function getModuleStates(hospitalId: string): Promise<ModuleStates> {
  const rows = await withTenant(hospitalId, (tx) =>
    tx
      .select({
        moduleId: hospitalFeatures.moduleId,
        state: hospitalFeatures.state,
        rolloutScope: hospitalFeatures.rolloutScope,
        stage: hospitalFeatures.stage,
        settings: hospitalFeatures.settings,
      })
      .from(hospitalFeatures)
      .where(eq(hospitalFeatures.hospitalId, hospitalId)),
  );
  return resolveModuleStates(rows);
}

/**
 * The owner changes one module. Core modules cannot be changed; the change is
 * audited with what it was before. Nothing is deleted when a module goes off.
 */
export async function setModuleState(args: {
  hospitalId: string;
  moduleId: string;
  state: string;
  stage?: string;
  rolloutScope?: RolloutScope;
  actorUserId: string;
}): Promise<void> {
  if (!isModuleId(args.moduleId)) throw new ModuleConfigError('Unknown module');
  const def = moduleById(args.moduleId);
  if (def.core) throw new ModuleConfigError(`${def.title} is part of the core and is always on`);
  if (!(MODULE_STATES as readonly string[]).includes(args.state)) throw new ModuleConfigError('Choose on, read-only or off');
  const state = args.state as ModuleState;
  const stage = (args.stage ?? 'observe') as ModuleStage;
  if (!(MODULE_STAGES as readonly string[]).includes(stage)) throw new ModuleConfigError('Choose observe, warn or enforce');
  const rolloutScope = args.rolloutScope ?? { all: true };
  if (!rolloutScope.all && rolloutScope.wardIds.length === 0) {
    throw new ModuleConfigError('Choose at least one ward, or all wards');
  }

  await withTenant(args.hospitalId, async (tx) => {
    const [before] = await tx
      .select({ state: hospitalFeatures.state, stage: hospitalFeatures.stage, rolloutScope: hospitalFeatures.rolloutScope })
      .from(hospitalFeatures)
      .where(and(eq(hospitalFeatures.hospitalId, args.hospitalId), eq(hospitalFeatures.moduleId, args.moduleId)))
      .for('update');
    await tx
      .insert(hospitalFeatures)
      .values({
        hospitalId: args.hospitalId,
        moduleId: args.moduleId,
        state,
        stage,
        rolloutScope,
        updatedByUserId: args.actorUserId,
      })
      .onConflictDoUpdate({
        target: [hospitalFeatures.hospitalId, hospitalFeatures.moduleId],
        set: { state, stage, rolloutScope, updatedByUserId: args.actorUserId, updatedAt: new Date() },
      });
    await tx.insert(auditLogs).values({
      hospitalId: args.hospitalId,
      actorUserId: args.actorUserId,
      action: 'module.changed',
      objectType: 'module',
      objectId: args.moduleId,
      metadata: {
        from: before ?? { state: def.defaultState, stage: 'observe', rolloutScope: { all: true } },
        to: { state, stage, rolloutScope },
      },
    });
  });
}
