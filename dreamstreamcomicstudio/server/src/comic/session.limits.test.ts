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
    expect(enforceDocLimits(doc, lines)).toHaveLength(DOC_LIMITS.linesPerPanel); // the per-panel cap applies within a single batch too
    const refs = Array.from({ length: 30 }, (_, i) => ({ path: `u/a/p/b/img/${i}.webp`, source: 'upload' as const, at: 1 }));
    const [op] = enforceDocLimits(doc, [{ op: 'character', id: 'c_maya', patch: { refs } }]);
    expect((op as Extract<DocOp, { op: 'character' }>).patch.refs).toHaveLength(DOC_LIMITS.refsPerCharacter);
    // Places have their own (smaller) cap — the same one capFor() uses.
    const [placeOp] = enforceDocLimits(doc, [{ op: 'place', id: 'pl_market', patch: { refs } }]);
    expect((placeOp as Extract<DocOp, { op: 'place' }>).patch.refs).toHaveLength(DOC_LIMITS.refsPerPlace);
  });

  it('lets a batch replace a full panel: earlier deletes free room for the new lines', () => {
    const doc = plannedDoc();
    // pn_1_1 starts empty; fill it to the cap so pre-batch it is full.
    doc.pages[0].panels[0].lines = Array.from({ length: DOC_LIMITS.linesPerPanel }, (_, i) => ({ id: `old_${i}`, kind: 'speech' as const, text: `old ${i}` }));
    const deletes: DocOp[] = doc.pages[0].panels[0].lines.map((l) => ({ op: 'line', pageId: 'pg_1', panelId: 'pn_1_1', id: l.id, patch: null }));
    const adds: DocOp[] = Array.from({ length: 3 }, (_, i) => ({ op: 'line', pageId: 'pg_1', panelId: 'pn_1_1', id: `new_${i}`, patch: { text: `new ${i}` } }));
    const kept = enforceDocLimits(doc, [...deletes, ...adds]);
    expect(kept).toHaveLength(DOC_LIMITS.linesPerPanel + 3); // all deletes + all adds survive
    expect(kept.filter((o) => o.op === 'line' && o.patch !== null)).toHaveLength(3);
  });

  it('still drops new lines that would exceed the cap on an already-full panel', () => {
    const doc = plannedDoc();
    doc.pages[0].panels[0].lines = Array.from({ length: DOC_LIMITS.linesPerPanel }, (_, i) => ({ id: `old_${i}`, kind: 'speech' as const, text: 'x' }));
    const adds: DocOp[] = Array.from({ length: 3 }, (_, i) => ({ op: 'line', pageId: 'pg_1', panelId: 'pn_1_1', id: `new_${i}`, patch: { text: 'y' } }));
    expect(enforceDocLimits(doc, adds)).toHaveLength(0);
  });

  it('session.commit applies the limits', () => {
    const doc = plannedDoc();
    const session = newSession(doc);
    session.commit(Array.from({ length: 60 }, (_, i) => ({ op: 'place', id: `px_${i}`, patch: { name: `Place ${i}` } }) as DocOp));
    expect(session.doc.places).toHaveLength(DOC_LIMITS.places);
  });
});
