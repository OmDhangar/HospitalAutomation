import { describe, it, expect } from 'vitest';
import { MODULES, moduleAllows, resolveModuleStates } from '../registry';

describe('Claims Tracker Module Registry Declaration', () => {
  it('registers claims_tracker module with defaultState off', () => {
    const claimsModule = MODULES.find((m) => m.id === 'claims_tracker');
    expect(claimsModule).toBeDefined();
    expect(claimsModule?.title).toBe('Claims & TPA Desk');
    expect(claimsModule?.tier).toBe('standard');
    expect(claimsModule?.core).toBe(false);
    expect(claimsModule?.defaultState).toBe('off');
    expect(claimsModule?.dependsOn).toContain('core_ipd');
    expect(claimsModule?.hasStages).toBe(true);
    expect(claimsModule?.routes).toContain('/ipd/claims');

    const tab = claimsModule?.fileTabs.find((t) => t.slug === 'claims');
    expect(tab).toBeDefined();
    expect(tab?.permission).toBe('claims.view');
  });

  it('evaluates module state correctly when off vs enabled', () => {
    // Default without features row: off
    const defaultStates = resolveModuleStates([]);
    expect(defaultStates.get('claims_tracker')?.state).toBe('off');

    // When toggled on with features row
    const enabledStates = resolveModuleStates([
      { moduleId: 'claims_tracker', state: 'on', stage: 'enforce', rolloutScope: { all: true }, settings: {} },
    ]);
    expect(enabledStates.get('claims_tracker')?.state).toBe('on');
    expect(enabledStates.get('claims_tracker')?.stage).toBe('enforce');
  });
});
