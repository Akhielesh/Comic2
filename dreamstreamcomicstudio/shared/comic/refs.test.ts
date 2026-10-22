import { describe, expect, it } from 'vitest';
import { makeSampleDoc } from '../../components/comicstudio/board/__fixtures__/sampleDoc';
import { normalizeDoc } from './doc';
import { REF_LABELS, REF_LABELS_FOR, REF_LABEL_TEXT, REF_LIMITS, capFor, findRefOwners, parseRefOwnerKey, refOwnerKey, refsOf, totalRefs } from './refs';
import { DOC_LIMITS } from './limits';

describe('refs', () => {
  it('owner keys round-trip', () => {
    for (const o of [{ kind: 'style' }, { kind: 'inbox' }, { kind: 'character', id: 'c_1' }, { kind: 'place', id: 'pl:x' }] as const) {
      expect(parseRefOwnerKey(refOwnerKey(o))).toEqual(o);
    }
    expect(parseRefOwnerKey('nope')).toBeNull();
  });
  it('caps and lookups', () => {
    const doc = normalizeDoc(makeSampleDoc());
    expect(capFor({ kind: 'character', id: 'x' })).toBe(12);
    expect(capFor({ kind: 'place', id: 'x' })).toBe(8);
    expect(REF_LIMITS.project).toBe(DOC_LIMITS.refsProject);
    expect(refsOf(doc, { kind: 'character', id: 'ch_maya' })?.map((r) => r.path)).toEqual(['u/proj/refs/maya.jpg']);
    expect(refsOf(doc, { kind: 'character', id: 'ghost' })).toBeUndefined();
    expect(refsOf(doc, { kind: 'inbox' })).toEqual([]);
    expect(totalRefs(doc)).toBe(1);
    expect(findRefOwners(doc, 'u/proj/refs/maya.jpg')).toEqual([{ kind: 'character', id: 'ch_maya' }]);
    expect(REF_LIMITS.maxSourceBytes).toBeGreaterThan(REF_LIMITS.maxUploadBytes);
  });
  it('labels', () => {
    expect(REF_LABELS).toHaveLength(20);
    for (const l of REF_LABELS) expect(REF_LABEL_TEXT[l]).toBeTruthy();
    for (const list of Object.values(REF_LABELS_FOR)) for (const l of list) expect(REF_LABELS).toContain(l);
  });
});
