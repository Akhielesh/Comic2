// Compare (versions plan §5; H0): the semantic filter hides QC-, variant- and safety-only differences; real changes
// are reported per page/panel/line with a word diff; manifests diff without loading bodies.
import { describe, expect, it } from 'vitest';
import { normalizeDoc, type ComicDoc } from '../doc';
import { applyOps } from '../ops';
import { historyV5Doc } from './__fixtures__/books';
import { changedPageCount, diffBooks, diffManifests, diffWords, drawnModelOf } from './diff';
import { buildManifest, sectionContent, splitSections } from './sections';

const v5 = () => normalizeDoc(historyV5Doc());
const P2 = 'u/user-b/p/proj-v5/img/p2.webp';

describe('diffBooks semantic filter', () => {
  it('hides QC-only, variant-only and safety-only changes', () => {
    const a = v5();
    const b = applyOps(
      a,
      [
        { op: 'render', target: { kind: 'page', id: 'pg_2' }, patch: { qc: { score: 0.2, issues: ['hands'], checkedAt: 99 } } },
        { op: 'asset_meta', path: P2, patch: { variants: [{ path: 'u/user-b/p/proj-v5/img/p2_w1080.webp', w: 1080, h: 1620 }], safety: { assessed: 'PG', at: 99, by: 'check' } } },
        { op: 'asset_meta', path: 'u/user-b/p/proj-v5/ref/maya_crop.webp', patch: { safety: { assessed: 'G', at: 99 } } },
        { op: 'render', target: { kind: 'cover' }, patch: { qc: { score: 0.9, issues: [], checkedAt: 99 } } }
      ],
      99
    );
    expect(b).not.toEqual(a);
    const d = diffBooks(a, b);
    expect(d.same).toBe(true);
    expect(d.pages).toEqual([]);
    expect(d.cast).toEqual([]);
    expect(d.cover).toEqual({ text: false, art: false });
  });

  it('reports a real change: changed dialogue with a word diff, new art, a moved page', () => {
    const a = v5();
    const b = applyOps(
      a,
      [
        { op: 'line', pageId: 'pg_3', panelId: 'pg_3_p3', id: 'pg_3_l3', patch: { text: 'You owe me a real answer, Maya (3).' } },
        { op: 'render', target: { kind: 'page', id: 'pg_5' }, patch: { status: 'ready', asset: { path: 'x/p5-new.webp', source: 'generated', at: 9, model: 'gpt-image-2' } } },
        { op: 'pages_reorder', order: ['pg_1', 'pg_2', 'pg_3', 'pg_4', 'pg_6', 'pg_5'] }
      ],
      9
    );
    const d = diffBooks(a, b);
    expect(d.same).toBe(false);
    const p3 = d.pages.find((p) => p.pageId === 'pg_3')!;
    expect(p3).toMatchObject({ status: 'changed', text: true, art: false });
    const words = p3.panels[0].lines[0].words!;
    expect(words.filter((w) => w.op === 'add').map((w) => w.text.trim()).join(' ')).toContain('real');
    expect(words.filter((w) => w.op !== 'add').map((w) => w.text).join('')).toBe('You owe me an answer, Maya (3).');
    expect(words.filter((w) => w.op !== 'del').map((w) => w.text).join('')).toBe('You owe me a real answer, Maya (3).');
    expect(d.pages.find((p) => p.pageId === 'pg_5')).toMatchObject({ status: 'changed', art: true, text: false, fromN: 5, toN: 6 });
    expect(d.pages.find((p) => p.pageId === 'pg_6')).toMatchObject({ status: 'moved', fromN: 6, toN: 5 });
    expect(changedPageCount(d)).toBe(2);
  });

  it('lists added and removed pages, characters and translations', () => {
    const a = v5();
    const b = applyOps(
      a,
      [
        { op: 'page_delete', id: 'pg_2', deletedAt: 9 },
        { op: 'character', id: 'ch_new', patch: { name: 'Dhruv', tier: 'support', look: { summary: 's' } } },
        { op: 'translation', lang: 'hi', lineId: 'pg_1_l2', patch: { text: 'बदला', status: 'edited' } }
      ],
      9
    );
    const d = diffBooks(a, b);
    expect(d.pages.find((p) => p.pageId === 'pg_2')).toMatchObject({ status: 'removed', fromN: 2 });
    expect(d.cast).toEqual([{ id: 'ch_new', status: 'added', name: 'Dhruv' }]);
    expect(d.editions).toEqual([{ lang: 'hi', status: 'changed', lineIds: ['pg_1_l2'], meta: false }]);
  });

  it('names the drawing model of each side', () => {
    const a = v5();
    const b = applyOps(a, a.pages.map((p) => ({ op: 'render' as const, target: { kind: 'page' as const, id: p.id }, patch: { status: 'ready' as const, asset: { path: `y/${p.id}.webp`, source: 'generated' as const, at: 5, model: 'flux-3' } } })), 5);
    expect(drawnModelOf(a)).toBe('nano-banana-2.1');
    expect(diffBooks(a, b).model).toEqual({ a: 'nano-banana-2.1', b: 'flux-3' });
  });
});

describe('diffManifests', () => {
  const manifest = (doc: ComicDoc) => buildManifest(splitSections(doc), (c) => sectionContent(c.body));
  it('tells which keys changed and which pages moved, from the manifests alone', () => {
    const a = v5();
    const b = applyOps(a, [{ op: 'pages_reorder', order: ['pg_2', 'pg_1', 'pg_3', 'pg_4', 'pg_5', 'pg_6'] }, { op: 'line', pageId: 'pg_4', panelId: 'pg_4_p1', id: 'pg_4_l1', patch: { text: 'Later.' } }], 3);
    const d = diffManifests(manifest(a), manifest(b));
    expect(d.changed).toEqual(['page:pg_4']);
    expect(d.moved).toEqual(['pg_1', 'pg_2']);
    expect(d.added).toEqual([]);
    expect(diffManifests(manifest(a), manifest(a)).same).toBe(true);
  });
});

describe('diffWords', () => {
  it('is a word-level LCS that reconstructs both sides', () => {
    const a = 'the quick brown fox jumps';
    const b = 'the slow brown fox leaps high';
    const parts = diffWords(a, b);
    expect(parts.filter((p) => p.op !== 'add').map((p) => p.text).join('')).toBe(a);
    expect(parts.filter((p) => p.op !== 'del').map((p) => p.text).join('')).toBe(b);
    expect(parts.filter((p) => p.op === 'same').map((p) => p.text).join('')).toContain('brown fox');
    expect(diffWords('', 'new')).toEqual([{ op: 'add', text: 'new' }]);
    expect(diffWords('same', 'same')).toEqual([{ op: 'same', text: 'same' }]);
  });

  it('handles non-Latin scripts', () => {
    const parts = diffWords('బస్ ఒక్కటి', 'బస్ ఇంకొకటి');
    expect(parts[0]).toEqual({ op: 'same', text: 'బస్ ' });
  });
});
