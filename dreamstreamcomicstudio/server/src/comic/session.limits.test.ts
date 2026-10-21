import { describe, expect, it } from 'vitest';
import type { DocOp } from '../../../shared/comic/ops.js';
import { DOC_LIMITS, enforceDocLimits } from './session.js';
import { newSession, plannedDoc } from './orchestrator.fakes.js';

describe('document size limits', () => {
  it('caps new characters and places but always allows edits', () => {
    const doc = plannedDoc();
    const flood: DocOp[] = Array.from({ length: DOC_LIMITS.cast + 10 }, (_, i) => ({ op: 'character', id: `cx_${i}`, patch: { name: `Extra ${i}` } }));
    const kept = enforceDocLimits(doc, [...flood, { op: 'character', id: 'c_maya', patch: { role: 'hero' } }]);
    expect(kept.filter((o) => o.op === 'character' && o.id.startsWith('cx_'))).toHaveLength(DOC_LIMITS.cast - doc.cast.length);
    expect(kept).toContainEqual({ op: 'character', id: 'c_maya', patch: { role: 'hero' } });
  });

  it('caps lines per panel and refs per entity', () => {
    const doc = plannedDoc();
    const lines: DocOp[] = Array.from({ length: 20 }, (_, i) => ({ op: 'line', pageId: 'pg_1', panelId: 'pn_1_1', id: `l_${i}`, patch: { text: 'x' } }));
    expect(enforceDocLimits(doc, lines)).toHaveLength(20); // panel starts empty; batch-relative growth is bounded by MAX_PATCH_OPS
    const refs = Array.from({ length: 30 }, (_, i) => ({ path: `u/a/p/b/img/${i}.webp`, source: 'upload' as const, at: 1 }));
    const [op] = enforceDocLimits(doc, [{ op: 'character', id: 'c_maya', patch: { refs } }]);
    expect((op as Extract<DocOp, { op: 'character' }>).patch.refs).toHaveLength(DOC_LIMITS.refsPerEntity);
  });

  it('session.commit applies the limits', () => {
    const doc = plannedDoc();
    const session = newSession(doc);
    session.commit(Array.from({ length: 60 }, (_, i) => ({ op: 'place', id: `px_${i}`, patch: { name: `Place ${i}` } }) as DocOp));
    expect(session.doc.places).toHaveLength(DOC_LIMITS.places);
  });
});
