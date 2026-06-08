import { describe, it, expect } from 'vitest';
import {
  CHECKPOINT_KINDS,
  checkpointForAction,
  requiresCheckpoint,
  canTransition,
  isTerminal,
  isCleared,
  resolveCheckpoint
} from './checkpoints.js';

describe('checkpointForAction', () => {
  it('requires no checkpoint for in-sandbox + preview actions', () => {
    expect(checkpointForAction('write_files')).toBeNull();
    expect(checkpointForAction('run_build')).toBeNull();
    expect(checkpointForAction('deploy_preview')).toBeNull();
    expect(requiresCheckpoint('deploy_preview')).toBe(false);
  });

  it('maps irreversible/sensitive actions to the right checkpoint kind', () => {
    expect(checkpointForAction('deploy_production')).toBe('prod_deploy');
    expect(checkpointForAction('spend_money')).toBe('spend_money');
    expect(checkpointForAction('delete_resource')).toBe('destructive');
    expect(checkpointForAction('publish_external')).toBe('external_publish');
    expect(checkpointForAction('change_scope')).toBe('scope_change');
    expect(checkpointForAction('approve_roadmap')).toBe('roadmap_approval');
    expect(requiresCheckpoint('deploy_production')).toBe(true);
  });

  it('exposes all six checkpoint kinds', () => {
    expect(CHECKPOINT_KINDS).toHaveLength(6);
  });
});

describe('checkpoint transitions', () => {
  it('only allows open → terminal transitions', () => {
    expect(canTransition('open', 'approved')).toBe(true);
    expect(canTransition('open', 'denied')).toBe(true);
    expect(canTransition('open', 'expired')).toBe(true);
    expect(canTransition('approved', 'denied')).toBe(false);
    expect(canTransition('denied', 'approved')).toBe(false);
    expect(canTransition('open', 'open')).toBe(false);
  });

  it('identifies terminal states', () => {
    expect(isTerminal('open')).toBe(false);
    expect(isTerminal('approved')).toBe(true);
    expect(isTerminal('expired')).toBe(true);
  });

  it('only "approved" clears the gate', () => {
    expect(isCleared('approved')).toBe(true);
    expect(isCleared('denied')).toBe(false);
    expect(isCleared('open')).toBe(false);
  });

  it('resolveCheckpoint records who/when on a valid transition', () => {
    const r = resolveCheckpoint('open', { to: 'approved', resolvedBy: 'user-1', at: '2026-06-08T00:00:00.000Z' });
    expect(r.status).toBe('approved');
    expect(r.resolvedBy).toBe('user-1');
    expect(r.resolvedAt).toBe('2026-06-08T00:00:00.000Z');
  });

  it('auto-expiry has no resolver', () => {
    const r = resolveCheckpoint('open', { to: 'expired' });
    expect(r.status).toBe('expired');
    expect(r.resolvedBy).toBeNull();
  });

  it('throws on an invalid transition', () => {
    expect(() => resolveCheckpoint('approved', { to: 'denied' })).toThrow(/Invalid checkpoint transition/);
  });
});
