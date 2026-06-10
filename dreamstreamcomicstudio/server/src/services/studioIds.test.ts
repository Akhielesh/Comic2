import { describe, expect, it } from 'vitest';
import { normalizeStudioId, normalizeStudioIdOrNew } from './studioIds.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('normalizeStudioId', () => {
  it('strips the client proj_/sess_ prefixes from UUID ids', () => {
    expect(normalizeStudioId('proj_03793f8f-2860-43cc-9845-50b8fb19fb83')).toBe('03793f8f-2860-43cc-9845-50b8fb19fb83');
    expect(normalizeStudioId('sess_03793F8F-2860-43CC-9845-50B8FB19FB83')).toBe('03793f8f-2860-43cc-9845-50b8fb19fb83');
  });

  it('passes bare UUIDs through (lowercased)', () => {
    expect(normalizeStudioId('61A2E276-80C9-45AD-B333-249197DECC6C')).toBe('61a2e276-80c9-45ad-b333-249197decc6c');
  });

  it('maps non-UUID ids to a stable, valid UUID', () => {
    const a = normalizeStudioId('proj_lx2hbz9q4k8f3m1');
    const b = normalizeStudioId('proj_lx2hbz9q4k8f3m1');
    expect(a).toBe(b); // deterministic — retries hit the same project row
    expect(a).toMatch(UUID_RE);
    expect(normalizeStudioId('proj_other')).not.toBe(a);
  });

  it('returns undefined for missing/blank input', () => {
    expect(normalizeStudioId(undefined)).toBeUndefined();
    expect(normalizeStudioId('')).toBeUndefined();
    expect(normalizeStudioId('   ')).toBeUndefined();
    expect(normalizeStudioId(42)).toBeUndefined();
  });

  it('normalizeStudioIdOrNew always yields a valid UUID', () => {
    expect(normalizeStudioIdOrNew('proj_03793f8f-2860-43cc-9845-50b8fb19fb83')).toBe('03793f8f-2860-43cc-9845-50b8fb19fb83');
    expect(normalizeStudioIdOrNew(undefined)).toMatch(UUID_RE);
  });
});
