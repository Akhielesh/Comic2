// touchedKeys / opActor (versions plan §4.1–§4.2) and describeChanges (§4.3) on real ops (H0).
import { describe, expect, it } from 'vitest';
import { normalizeDoc } from '../doc';
import { applyOps, type DocOp } from '../ops';
import { historyV5Doc } from './__fixtures__/books';
import { changeItemsFromDiff, describeChanges, pageRangeText } from './describe';
import { diffBooks } from './diff';
import { sectionSignatures } from './sections';
import { CAPTURE_NEUTRAL_OPS, opActor, touchedKeys } from './touched';

const v5 = () => normalizeDoc(historyV5Doc());

describe('touchedKeys', () => {
  it('names exactly the sections an op changes (checked against the real section diff)', () => {
    const doc = v5();
    const ops: DocOp[] = [
      { op: 'line', pageId: 'pg_2', panelId: 'pg_2_p2', id: 'pg_2_l2', patch: { text: 'x' } },
      { op: 'balloon', pageId: 'pg_2', lineId: 'pg_2_l2', patch: { x: 0.5 } },
      { op: 'translation', lang: 'te', lineId: 'pg_1_l1', patch: { text: 'y' } },
      { op: 'character', id: 'ch_maya', patch: { voice: 'calm' } },
      { op: 'cover', patch: { tagline: 'New' } },
      { op: 'glossary_term', id: 'g_new', patch: { term: 'kite' } },
      { op: 'brief', patch: { tone: 'dark' } },
      { op: 'page_delete', id: 'pg_6', deletedAt: 5 }
    ];
    for (const op of ops) {
      const after = applyOps(doc, [op], 5);
      const a = sectionSignatures(doc);
      const b = sectionSignatures(after);
      const changed = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => a[k] !== b[k]).sort();
      const keys = touchedKeys(op, doc);
      for (const k of changed) expect(keys, `${op.op} must name ${k}`).toContain(k);
    }
  });

  it('a reorder and forward-only records touch nothing', () => {
    const doc = v5();
    expect(touchedKeys({ op: 'pages_reorder', order: ['pg_2'] }, doc)).toEqual([]);
    for (const op of ['message', 'spend', 'gate', 'memory', 'safety', 'asset_meta', 'publication'] as const) expect(CAPTURE_NEUTRAL_OPS.has(op), op).toBe(true);
    expect(touchedKeys({ op: 'memory', text: 'x' }, doc)).toEqual([]);
  });

  it('classifies who made a change (§4.2)', () => {
    const doc = v5();
    const line: DocOp = { op: 'line', pageId: 'pg_2', panelId: 'pg_2_p2', id: 'pg_2_l2', patch: { text: 'x' } };
    expect(opActor(line, 'user', doc)).toBe('you');
    expect(opActor(line, 'director', doc)).toBe('ai');
    expect(opActor({ op: 'render', target: { kind: 'page', id: 'pg_1' }, patch: { status: 'ready', asset: { path: 'n.webp', source: 'generated', at: 1 }, origin: 'render' } }, 'job', doc)).toBe('ai');
    expect(opActor({ op: 'render', target: { kind: 'page', id: 'pg_1' }, patch: { status: 'ready', asset: { path: 'f.webp', source: 'derived', at: 1 }, origin: 'derived' } }, 'job', doc)).toBe('editor');
    expect(opActor({ op: 'balloons', pageId: 'pg_1', balloons: [] }, 'job', doc)).toBe('editor');
    expect(opActor({ op: 'translations', lang: 'te', lines: { pg_3_l1: { text: 't', status: 'machine', sourceHash: 'h', at: 1 } } }, 'job', doc)).toBe('ai');
    expect(opActor({ op: 'image_model', lock: { modelId: 'm', lockedAt: 1, origin: 'user_change' } }, 'job', doc)).toBe('ai');
    expect(opActor({ op: 'spend', entry: { id: 's', at: 1, kind: 'page', label: 'x', usd: 1, byok: false, estimated: false } }, 'job', doc)).toBeNull();
  });
});

describe('describeChanges', () => {
  it('words AI runs, your edits and the editor plainly — never git words', () => {
    const doc = v5();
    const ai = applyOps(doc, [{ op: 'line', pageId: 'pg_3', panelId: 'pg_3_p1', id: 'pg_3_l1', patch: { text: 'AI' } }, { op: 'panel', pageId: 'pg_4', id: 'pg_4_p2', patch: { action: 'AI action' } }], 5);
    const items = changeItemsFromDiff(diffBooks(doc, ai), 'ai', ai);
    expect(describeChanges(items, 'ai')).toBe('AI revised pages 3–4');
    expect(describeChanges(items, 'before_ai')).toBe('Before the AI revised pages 3–4');
    const yours = changeItemsFromDiff(diffBooks(doc, applyOps(doc, [{ op: 'line', pageId: 'pg_2', panelId: 'pg_2_p2', id: 'pg_2_l2', patch: { text: 'Mine' } }, { op: 'line', pageId: 'pg_5', panelId: 'pg_5_p2', id: 'pg_5_l2', patch: { text: 'Mine' } }], 5)), 'you');
    expect(describeChanges(yours, 'edits')).toBe('You edited dialogue on pages 2 and 5');
    expect(describeChanges([{ what: 'balloons', by: 'editor', pageNs: [2] }], 'edits')).toBe('The editor re-fitted balloons on page 2, no AI cost');
    expect(describeChanges([{ what: 'translation', by: 'ai', lang: 'te', count: 58 }], 'ai')).toBe('AI translated 58 lines to Telugu');
    expect(describeChanges([], 'start')).toBe('History starts here');
    expect(describeChanges([], 'edits', { final: true })).toBe('Where you left off');
    expect(describeChanges([], 'restore', { from: 'Draft 2' })).toBe('Restored from Draft 2');
    const GIT = /\b(branch|merge|commit|checkout|fork|HEAD|diff|rebase|revert)\b/i;
    for (const label of [describeChanges(items, 'ai'), describeChanges(yours, 'edits'), describeChanges([], 'switch', { name: 'New ending' }), describeChanges([], 'before_restore')]) expect(label).not.toMatch(GIT);
  });

  it('page ranges read naturally', () => {
    expect(pageRangeText([3])).toBe('page 3');
    expect(pageRangeText([4, 3])).toBe('pages 3–4');
    expect(pageRangeText([2, 5])).toBe('pages 2 and 5');
    expect(pageRangeText([1, 2, 3, 6])).toBe('pages 1–3 and 6');
    expect(pageRangeText([1, 3, 5])).toBe('pages 1, 3 and 5');
  });
});
