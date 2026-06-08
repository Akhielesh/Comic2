import { describe, it, expect } from 'vitest';
import { decide, type DecideInput } from './decide.js';

const base: DecideInput = {
  gate: { enabled: true, killed: false },
  action: 'write_files',
  budget: { usdPerDay: 5, usdTotal: 50 },
  spend: { usdToday: 0, usdTotal: 0, tokensUsed: 0, containerMinutesUsed: 0 }
};

describe('decide gate', () => {
  it('proceeds when everything is clear', () => {
    expect(decide(base).proceed).toBe(true);
  });

  it('halts when Autopilot is disabled', () => {
    const o: any = decide({ ...base, gate: { enabled: false, killed: false } });
    expect(o.proceed).toBe(false);
    expect(o.reason).toBe('halted');
  });

  it('halts when the kill switch is engaged (even if enabled)', () => {
    const o: any = decide({ ...base, gate: { enabled: true, killed: true } });
    expect(o.reason).toBe('halted');
  });

  it('blocks out-of-scope work with a scope_change checkpoint', () => {
    const o: any = decide({ ...base, inScope: false });
    expect(o.proceed).toBe(false);
    expect(o.reason).toBe('scope');
    expect(o.checkpoint).toBe('scope_change');
  });

  it('allows out-of-scope work once scope_change is approved', () => {
    const o = decide({ ...base, inScope: false, isCheckpointApproved: (k) => k === 'scope_change' });
    expect(o.proceed).toBe(true);
  });

  it('blocks a production deploy until approved', () => {
    const o: any = decide({ ...base, action: 'deploy_production' });
    expect(o.reason).toBe('checkpoint');
    expect(o.checkpoint).toBe('prod_deploy');
  });

  it('allows a production deploy once prod_deploy is approved', () => {
    const o = decide({ ...base, action: 'deploy_production', isCheckpointApproved: (k) => k === 'prod_deploy' });
    expect(o.proceed).toBe(true);
  });

  it('lets a managed preview deploy proceed without a checkpoint', () => {
    expect(decide({ ...base, action: 'deploy_preview' }).proceed).toBe(true);
  });

  it('blocks when the proposed spend would breach the budget', () => {
    const o: any = decide({ ...base, proposed: { usd: 10 } });
    expect(o.proceed).toBe(false);
    expect(o.reason).toBe('budget');
    expect(o.code).toBe('BUDGET_DAILY_USD');
  });

  it('priority: halted beats scope, checkpoint, and budget', () => {
    const o: any = decide({
      ...base,
      gate: { enabled: false, killed: true },
      action: 'deploy_production',
      inScope: false,
      proposed: { usd: 999 }
    });
    expect(o.reason).toBe('halted');
  });

  it('priority: scope is checked before the action checkpoint', () => {
    const o: any = decide({ ...base, action: 'deploy_production', inScope: false });
    expect(o.reason).toBe('scope');
  });

  it('priority: checkpoint is checked before budget', () => {
    const o: any = decide({ ...base, action: 'deploy_production', proposed: { usd: 999 } });
    expect(o.reason).toBe('checkpoint');
  });
});
