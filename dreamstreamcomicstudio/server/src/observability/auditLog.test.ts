import { describe, it, expect } from 'vitest';
import { buildAuditRecord } from './auditLog.js';

describe('buildAuditRecord', () => {
  it('fills defaults and maps to the snake_case row', () => {
    const r = buildAuditRecord({ action: 'ventures.kill' });
    expect(r.action).toBe('ventures.kill');
    expect(r.actor_id).toBeNull();
    expect(r.target_type).toBeNull();
    expect(r.target_id).toBeNull();
    expect(r.detail).toBeNull();
    expect(typeof r.created_at).toBe('string');
  });

  it('preserves provided fields', () => {
    const r = buildAuditRecord({
      actorId: 'u1',
      action: 'ventures.checkpoint.resolve',
      targetType: 'checkpoint',
      targetId: 'c1',
      detail: { decision: 'approved' },
      at: '2026-06-08T00:00:00.000Z'
    });
    expect(r).toEqual({
      actor_id: 'u1',
      action: 'ventures.checkpoint.resolve',
      target_type: 'checkpoint',
      target_id: 'c1',
      detail: { decision: 'approved' },
      created_at: '2026-06-08T00:00:00.000Z'
    });
  });
});
