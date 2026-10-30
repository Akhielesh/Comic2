// @vitest-environment node
//
// RichDoc v1 (plan §5.2, W1.2): the schema accepts the contract fixtures; applyDocOps applies every op, refuses a
// malformed op with the same document reference, refuses a stale baseRev, applies each op id at most once, and every
// applied batch has an exact inverse (including remove_section ↔ insert_section at the old index); page breaks are
// sections, so a break never restyles the paragraph before it; accepting a suggestion re-stamps its baseRev only after
// its target is found.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { DocBlock, DocOp, DocSection, DocSuggestion, RichDoc } from './index.js';
import {
  RICHDOC_LIMITS,
  acceptDocSuggestion,
  applyDocOps,
  checkDocOp,
  checkRichDoc,
  invertDocOp,
  invertDocOps,
  migrateRichDoc,
} from './index.js';

const fixture = <T = unknown>(name: string): T => JSON.parse(readFileSync(new URL(`../../../fixtures/${name}`, import.meta.url), 'utf8')) as T;

const minimal = (): RichDoc => fixture<RichDoc>('contract/richdoc/minimal.json');
const full = (): RichDoc => fixture<RichDoc>('contract/richdoc/full.json');
const contractOps = (): DocOp[] => fixture<DocOp[]>('contract/richdoc/ops.json');

/** The document without its revision (undo restores content; `rev` keeps moving forward). */
const content = (doc: RichDoc): Omit<RichDoc, 'rev'> => {
  const out = { ...doc };
  delete out.rev;
  return out;
};

const para = (id: string, text: string, style?: 'body' | 'lead' | 'quote' | 'caption'): DocBlock =>
  style ? { type: 'paragraph', id, style, runs: [{ text }] } : { type: 'paragraph', id, runs: [{ text }] };

const undoIds = (op: DocOp, i: number) => `undo-${i}-${op.id}`.slice(0, 64);

/** Apply, invert, apply the inverse: the content comes back exactly. Returns the result of the forward call. */
const roundTrip = (doc: RichDoc, ops: DocOp[]) => {
  const forward = applyDocOps(doc, ops);
  const undo = invertDocOps(doc, forward.applied, { baseRev: forward.doc.rev ?? 0, id: undoIds });
  expect(undo).not.toBeNull();
  const back = applyDocOps(forward.doc, undo!);
  expect(back.rejected).toEqual([]);
  expect(back.applied).toHaveLength(forward.applied.length);
  expect(content(back.doc)).toEqual(content(doc));
  return forward;
};

describe('RichDoc schema', () => {
  it('accepts every contract fixture as it is, and migrate() reads v1 into the same document', () => {
    for (const doc of [minimal(), full()]) {
      expect(checkRichDoc(doc)).toEqual({ ok: true, value: doc });
      expect(migrateRichDoc(doc)).toEqual({ ok: true, value: doc });
    }
    for (const op of contractOps()) expect(checkDocOp(op)).toEqual({ ok: true, value: op });
  });

  it('migrate() refuses a version it does not know, and a value with no version', () => {
    expect(migrateRichDoc({ ...minimal(), v: 2 })).toMatchObject({ ok: false, errors: [{ path: 'v', code: 'literal', message: 'RichDoc v2 is not supported (this build reads v1)' }] });
    expect(migrateRichDoc({ ...minimal(), v: '1' })).toMatchObject({ ok: false, errors: [{ path: 'v', code: 'literal', message: 'this RichDoc version is not supported (this build reads v1)' }] });
    const noVersion: Record<string, unknown> = { ...minimal() };
    delete noVersion.v;
    expect(migrateRichDoc(noVersion)).toMatchObject({ ok: false, errors: [{ path: 'v', code: 'required' }] });
    expect(migrateRichDoc('not a doc')).toMatchObject({ ok: false, errors: [{ path: '', code: 'type' }] });
  });

  it('update_block must keep the block id (a refinement the DSL cannot say)', () => {
    const op = { op: 'update_block', id: 'op-x', baseRev: 0, blockId: 'p1', block: para('p2', 'x') };
    expect(checkDocOp(op)).toMatchObject({ ok: false, errors: [{ path: 'block.id', code: 'literal' }] });
    const r = applyDocOps(minimal(), [op as DocOp]);
    expect(r.rejected).toMatchObject([{ index: 0, opId: 'op-x', code: 'invalid' }]);
  });
});

describe('applyDocOps', () => {
  it('applies every contract op in order, bumps rev once, and leaves the input untouched', () => {
    const doc = minimal();
    const before = JSON.stringify(doc);
    const r = applyDocOps(doc, contractOps());
    expect(r.rejected).toEqual([]);
    expect(r.applied.map((o) => o.id)).toEqual(['op-1', 'op-2', 'op-3', 'op-4', 'op-5', 'op-6', 'op-7']);
    expect(r.doc).toEqual({
      v: 1,
      rev: 1,
      title: 'Notes, revised',
      sections: [{ id: 's1', pageBreakBefore: false, blocks: [{ type: 'heading', id: 'h-new', level: 2, runs: [{ text: 'Summary' }] }, { type: 'divider', id: 'd-new' }] }],
    });
    expect(JSON.stringify(doc)).toBe(before);
    expect(checkRichDoc(r.doc).ok).toBe(true);
  });

  it('a malformed op returns the SAME document object and is listed in rejected', () => {
    const doc = full();
    const bad: unknown[] = [
      null,
      'insert_block',
      { op: 'insert_block', id: 'op-a', baseRev: 3, sectionId: 's-intro', block: { type: 'paragraph', id: 'p9', runs: [{ text: 'x'.repeat(4001) }] } },
      { op: 'insert_block', id: 'op-b', baseRev: 3, sectionId: 's-intro', block: { type: 'html', id: 'p9', html: '<script>alert(1)</script>' } },
      { op: 'delete_everything', id: 'op-c', baseRev: 3 },
      { op: 'set_title', id: 'op-d', title: 'No baseRev' },
      { op: 'set_title', id: '../op', baseRev: 3, title: 'Bad id' },
      { op: 'set_title', id: 'op-e', baseRev: 3, title: 'Two\nlines' },
    ];
    const r = applyDocOps(doc, bad as DocOp[]);
    expect(r.doc).toBe(doc);
    expect(r.applied).toEqual([]);
    expect(r.rejected.map((x) => [x.index, x.code])).toEqual(bad.map((_, i) => [i, 'invalid']));
    expect(r.rejected[0].opId).toBeUndefined();
    expect(r.rejected[2]).toMatchObject({ opId: 'op-a', message: expect.stringContaining('block.runs[0].text') });
    expect(r.rejected[6].opId).toBeUndefined(); // an id that is not ID_PATTERN is never echoed
    expect(applyDocOps(doc, 'not a list' as unknown as DocOp[])).toEqual({ doc, applied: [], rejected: [{ index: 0, code: 'invalid', message: 'ops must be a list' }] });
  });

  it('a stale baseRev is refused as stale, and the current one applies', () => {
    const doc = full(); // rev 3
    const op = (baseRev: number): DocOp => ({ op: 'set_title', id: `op-${baseRev}`, baseRev, title: `Rev ${baseRev}` });
    const stale = applyDocOps(doc, [op(0), op(2), op(4)]);
    expect(stale.doc).toBe(doc);
    expect(stale.rejected.map((x) => x.code)).toEqual(['stale', 'stale', 'stale']);
    const fresh = applyDocOps(doc, [op(3)]);
    expect(fresh.doc).toMatchObject({ rev: 4, title: 'Rev 3' });
    expect(minimal().rev).toBeUndefined(); // absent rev is 0
    expect(applyDocOps(minimal(), [op(0)]).doc.rev).toBe(1);
  });

  it('is idempotent per op id: a repeat in one call, a replayed batch and an id in the host log never apply twice', () => {
    const doc = minimal();
    const ins: DocOp = { op: 'insert_block', id: 'op-1', baseRev: 0, sectionId: 's1', block: para('p2', 'Once') };
    const again: DocOp = { op: 'insert_block', id: 'op-1', baseRev: 0, sectionId: 's1', block: para('p3', 'Twice?') };
    const r = applyDocOps(doc, [ins, again]);
    expect(r.applied.map((o) => o.id)).toEqual(['op-1']);
    expect(r.rejected).toMatchObject([{ index: 1, opId: 'op-1', code: 'duplicate' }]);
    expect(r.doc.sections[0].blocks.map((b) => b.id)).toEqual(['p1', 'p2']);

    const replay = applyDocOps(r.doc, [ins]);
    expect(replay.doc).toBe(r.doc);
    expect(replay.rejected).toMatchObject([{ code: 'stale' }]);

    const restamped = { ...ins, baseRev: 1 };
    const logged = applyDocOps(r.doc, [restamped], { seenOpIds: ['op-1'] });
    expect(logged.doc).toBe(r.doc);
    expect(logged.rejected).toMatchObject([{ opId: 'op-1', code: 'duplicate' }]);
  });

  it('refuses missing targets, reused ids, positions past the end and over-cap documents', () => {
    const doc = full();
    const base = { baseRev: 3 };
    const cases: [DocOp, string][] = [
      [{ op: 'insert_block', id: 'o1', ...base, sectionId: 'nope', block: para('n1', 'x') }, 'not-found'],
      [{ op: 'update_block', id: 'o2', ...base, blockId: 'nope', block: para('nope', 'x') }, 'not-found'],
      [{ op: 'remove_block', id: 'o3', ...base, blockId: 'nope' }, 'not-found'],
      [{ op: 'remove_section', id: 'o4', ...base, sectionId: 'nope' }, 'not-found'],
      [{ op: 'insert_block', id: 'o5', ...base, sectionId: 's-intro', block: para('sc1', 'id of a block in another section') }, 'invalid'],
      [{ op: 'insert_block', id: 'o6', ...base, sectionId: 's-intro', index: 10, block: para('n2', 'x') }, 'invalid'],
      [{ op: 'insert_section', id: 'o7', ...base, section: { id: 's-intro', pageBreakBefore: true, blocks: [] } }, 'invalid'],
      [{ op: 'insert_section', id: 'o8', ...base, section: { id: 's9', pageBreakBefore: true, blocks: [para('h1', 'reused')] } }, 'invalid'],
      [{ op: 'insert_section', id: 'o9', ...base, section: { id: 's9', pageBreakBefore: true, blocks: [para('n3', 'a'), para('n3', 'b')] } }, 'invalid'],
      [{ op: 'insert_section', id: 'o10', ...base, index: 3, section: { id: 's9', pageBreakBefore: true, blocks: [] } }, 'invalid'],
    ];
    const r = applyDocOps(doc, cases.map((c) => c[0]));
    expect(r.doc).toBe(doc);
    expect(r.rejected.map((x) => x.code)).toEqual(cases.map((c) => c[1]));

    const sections: DocSection[] = [];
    for (let i = 0; i < RICHDOC_LIMITS.sections; i++) sections.push({ id: `s${i}`, pageBreakBefore: i > 0, blocks: [] });
    const fullSections: RichDoc = { v: 1, title: 'Many', sections };
    expect(applyDocOps(fullSections, [{ op: 'insert_section', id: 'o', baseRev: 0, section: { id: 'more', pageBreakBefore: true, blocks: [] } }]).rejected).toMatchObject([
      { code: 'limit' },
    ]);
    const blocks: DocBlock[] = [];
    for (let i = 0; i < RICHDOC_LIMITS.blocksPerSection; i++) blocks.push({ type: 'divider', id: `d${i}` });
    const fullBlocks: RichDoc = { v: 1, title: 'Long', sections: [{ id: 's1', pageBreakBefore: false, blocks }] };
    expect(applyDocOps(fullBlocks, [{ op: 'insert_block', id: 'o', baseRev: 0, sectionId: 's1', block: para('more', 'x') }]).rejected).toMatchObject([{ code: 'limit' }]);
  });

  it('applies what it can and lists the rest (partial batches are well defined)', () => {
    const r = applyDocOps(minimal(), [
      { op: 'set_title', id: 'ok-1', baseRev: 0, title: 'One' },
      { op: 'remove_block', id: 'bad', baseRev: 0, blockId: 'nope' },
      { op: 'insert_block', id: 'ok-2', baseRev: 0, sectionId: 's1', index: 0, block: para('p0', 'Zero') },
    ]);
    expect(r.applied.map((o) => o.id)).toEqual(['ok-1', 'ok-2']);
    expect(r.rejected).toMatchObject([{ index: 1, opId: 'bad', code: 'not-found' }]);
    expect(r.doc.title).toBe('One');
    expect(r.doc.sections[0].blocks.map((b) => b.id)).toEqual(['p0', 'p1']);
  });
});

describe('page breaks are sections (the pageBreak fixture)', () => {
  const pb = fixture<{ doc: RichDoc; ops: DocOp[] }>('models/richdoc/pagebreak.json');

  it('inserting a page-break section and writing into it never restyles the paragraph before the break', () => {
    const doc = pb.doc;
    const r = applyDocOps(doc, pb.ops);
    expect(r.rejected).toEqual([]);
    expect(r.doc.sections.map((s) => [s.id, s.pageBreakBefore])).toEqual([
      ['s1', false],
      ['s2', true],
      ['s3', true],
    ]);
    // The section before the break is the very same object: nothing about it was rewritten.
    expect(r.doc.sections[0]).toBe(doc.sections[0]);
    expect(r.doc.sections[2]).toBe(doc.sections[1]);
    const last = r.doc.sections[0].blocks[r.doc.sections[0].blocks.length - 1];
    expect(last).toEqual({ type: 'paragraph', id: 'p2', style: 'quote', runs: [{ text: 'The light never lies.', marks: ['i'] }] });
    expect(r.doc.sections[1].blocks.map((b) => b.id)).toEqual(['sc1', 'h2', 'p3']);
  });

  it('removing the break (undo) gives back the document exactly, the paragraph before it still untouched', () => {
    const r = roundTrip(pb.doc, pb.ops);
    const undo = invertDocOps(pb.doc, r.applied, { baseRev: 1, id: undoIds })!;
    expect(undo.map((o) => o.op)).toEqual(['remove_block', 'remove_section']);
    const back = applyDocOps(r.doc, undo).doc;
    expect(back.sections[0]).toBe(r.doc.sections[0]);
  });
});

describe('exact inverses', () => {
  it('every contract op, alone and as one batch, is undone exactly', () => {
    const ops = contractOps();
    // Each op alone, in the context the batch gives it.
    let doc = minimal();
    for (const op of ops) {
      const r = roundTrip(doc, [{ ...op, baseRev: doc.rev ?? 0 }]);
      expect(r.applied).toHaveLength(1);
      doc = r.doc;
    }
    roundTrip(minimal(), ops);
    roundTrip(full(), [
      { op: 'remove_block', id: 'r1', baseRev: 3, blockId: 'l1' },
      { op: 'update_block', id: 'r2', baseRev: 3, blockId: 'sc3', block: { type: 'script', id: 'sc3', kind: 'dialogue', speaker: 'KEEPER', runs: [{ text: 'Who goes there?' }] } },
      { op: 'remove_section', id: 'r3', baseRev: 3, sectionId: 's-intro' },
      { op: 'set_title', id: 'r4', baseRev: 3, title: 'Renamed' },
    ]);
  });

  it('remove_section inverts to insert_section carrying the section at its OLD index', () => {
    const doc = full();
    const op: DocOp = { op: 'remove_section', id: 'rm', baseRev: 3, sectionId: 's-intro' };
    expect(invertDocOp(doc, op, { id: 'undo-rm', baseRev: 4 })).toEqual({ op: 'insert_section', id: 'undo-rm', baseRev: 4, index: 0, section: doc.sections[0] });
    const ins: DocOp = { op: 'insert_section', id: 'ins', baseRev: 3, index: 1, section: { id: 's-new', pageBreakBefore: true, blocks: [] } };
    expect(invertDocOp(doc, ins, { id: 'undo-ins', baseRev: 4 })).toEqual({ op: 'remove_section', id: 'undo-ins', baseRev: 4, sectionId: 's-new' });
    const rmBlock: DocOp = { op: 'remove_block', id: 'rb', baseRev: 3, blockId: 'sc2' };
    expect(invertDocOp(doc, rmBlock, { id: 'u', baseRev: 4 })).toEqual({ op: 'insert_block', id: 'u', baseRev: 4, sectionId: 's-script', index: 2, block: doc.sections[1].blocks[2] });
    expect(invertDocOp(doc, { op: 'remove_block', id: 'x', baseRev: 3, blockId: 'nope' }, { id: 'u', baseRev: 4 })).toBeNull();
    expect(invertDocOps(minimal(), [{ op: 'remove_block', id: 'x', baseRev: 0, blockId: 'nope' }], { baseRev: 1, id: undoIds })).toBeNull();
  });

  it('random batches (seeded) always apply in full and always come back exactly, and redo gives the batch result again', () => {
    let seed = 0x2f6e2b1;
    const rnd = (): number => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const pick = <T,>(list: readonly T[]): T => list[Math.floor(rnd() * list.length)];
    let n = 0;
    const fresh = () => `x${++n}`;
    const block = (id: string): DocBlock =>
      pick<DocBlock>([
        para(id, `p ${id}`, pick(['body', 'lead', 'quote', 'caption'] as const)),
        { type: 'heading', id, level: pick([1, 2, 3] as const), runs: [{ text: `h ${id}`, marks: ['b'] }] },
        { type: 'divider', id },
        { type: 'script', id, kind: pick(['scene', 'panel', 'dialogue', 'caption', 'sfx'] as const), runs: [{ text: `s ${id}` }] },
      ]);
    const nextOp = (doc: RichDoc): DocOp => {
      const blocks = doc.sections.reduce<string[]>((acc, s) => acc.concat(s.blocks.map((b) => b.id)), []);
      const kinds = ['insert_section', 'set_title'];
      if (doc.sections.length) kinds.push('insert_block', 'insert_block', 'remove_section');
      if (blocks.length) kinds.push('update_block', 'remove_block', 'remove_block');
      const base = { id: fresh(), baseRev: doc.rev ?? 0 };
      switch (pick(kinds)) {
        case 'insert_block': {
          const s = pick(doc.sections);
          return { op: 'insert_block', ...base, sectionId: s.id, index: Math.floor(rnd() * (s.blocks.length + 1)), block: block(fresh()) };
        }
        case 'update_block': {
          const id = pick(blocks);
          return { op: 'update_block', ...base, blockId: id, block: block(id) };
        }
        case 'remove_block':
          return { op: 'remove_block', ...base, blockId: pick(blocks) };
        case 'insert_section':
          return {
            op: 'insert_section',
            ...base,
            index: Math.floor(rnd() * (doc.sections.length + 1)),
            section: { id: fresh(), pageBreakBefore: rnd() < 0.5, blocks: rnd() < 0.5 ? [block(fresh())] : [] },
          };
        case 'remove_section':
          return { op: 'remove_section', ...base, sectionId: pick(doc.sections).id };
        default:
          return { op: 'set_title', ...base, title: `Title ${fresh()}` };
      }
    };
    let doc = full();
    for (let round = 0; round < 150; round++) {
      // Build a batch against the evolving document, all stamped with the batch's baseRev.
      const batch: DocOp[] = [];
      let scratch = doc;
      for (let k = 0, size = 1 + Math.floor(rnd() * 5); k < size; k++) {
        const op = nextOp(scratch);
        scratch = applyDocOps(scratch, [op]).doc;
        batch.push({ ...op, baseRev: doc.rev ?? 0 });
      }
      const r = roundTrip(doc, batch);
      expect(r.rejected).toEqual([]);
      expect(content(r.doc)).toEqual(content(scratch));
      expect(checkRichDoc(r.doc).ok).toBe(true);
      // Redo: the inverse of the undo is the batch again.
      const undo = invertDocOps(doc, r.applied, { baseRev: r.doc.rev!, id: undoIds })!;
      const undone = applyDocOps(r.doc, undo);
      const redo = invertDocOps(r.doc, undone.applied, { baseRev: undone.doc.rev!, id: (op, i) => `redo-${i}-${op.id}`.slice(0, 64) })!;
      expect(content(applyDocOps(undone.doc, redo).doc)).toEqual(content(r.doc));
      doc = r.doc;
    }
  });
});

describe('acceptDocSuggestion', () => {
  const suggestion = (): DocSuggestion => fixture<DocSuggestion>('contract/richdoc/suggestion.json');
  const log = { seenOpIds: [] as string[] };

  it('re-stamps baseRev, so accepting one suggestion never makes the others stale', () => {
    const doc = minimal();
    const a = suggestion(); // update_block p1, made at rev 0
    const b: DocSuggestion = { id: 'sg-2', author: 'agent', at: 1793318400001, op: { op: 'set_title', id: 'op-sg-2', baseRev: 0, title: 'Agreed title' } };
    const first = acceptDocSuggestion(doc, a, log);
    expect(first.applied).toHaveLength(1);
    expect(first.doc.rev).toBe(1);
    const second = acceptDocSuggestion(first.doc, b, { seenOpIds: ['op-sg-1'] });
    expect(second.rejected).toEqual([]);
    expect(second.applied).toEqual([{ ...b.op, baseRev: 1 }]);
    expect(second.doc).toMatchObject({ rev: 2, title: 'Agreed title' });
    // Without the re-stamp the same op is stale.
    expect(applyDocOps(first.doc, [b.op]).rejected).toMatchObject([{ code: 'stale' }]);
  });

  it('checks the target FIRST: a suggestion whose block is gone is not-found and is not re-stamped or applied', () => {
    const removed = applyDocOps(minimal(), [{ op: 'remove_block', id: 'rm', baseRev: 0, blockId: 'p1' }]).doc;
    const r = acceptDocSuggestion(removed, suggestion(), log);
    expect(r.doc).toBe(removed);
    expect(r.applied).toEqual([]);
    expect(r.rejected).toEqual([{ index: 0, opId: 'op-sg-1', code: 'not-found', message: "the suggestion's block p1 is gone" }]);
    const gone: DocSuggestion = { id: 'sg-3', author: 'agent', at: 1, op: { op: 'insert_block', id: 'op-sg-3', baseRev: 0, sectionId: 's9', block: para('q', 'x') } };
    expect(acceptDocSuggestion(minimal(), gone, log).rejected).toMatchObject([{ code: 'not-found', message: "the suggestion's section s9 is gone" }]);
    // The target is checked before anything else: a suggestion whose block is gone is not-found even when its op id is
    // also in the host's log (applying it would have said duplicate).
    expect(acceptDocSuggestion(removed, suggestion(), { seenOpIds: ['op-sg-1'] }).rejected).toMatchObject([{ code: 'not-found' }]);
  });

  it('refuses a malformed suggestion, and applies a suggestion at most once with the host op log', () => {
    const bad = { ...suggestion(), author: 'user' } as unknown as DocSuggestion;
    expect(acceptDocSuggestion(minimal(), bad, log)).toMatchObject({ applied: [], rejected: [{ code: 'invalid', message: expect.stringContaining('author') }] });
    const once = acceptDocSuggestion(minimal(), suggestion(), log);
    const twice = acceptDocSuggestion(once.doc, suggestion(), { seenOpIds: ['op-sg-1'] });
    expect(twice.doc).toBe(once.doc);
    expect(twice.rejected).toMatchObject([{ code: 'duplicate' }]);
  });

  it('the op log is REQUIRED: a call without it does not compile and is refused at run time, so a re-stamp never replays', () => {
    const sg: DocSuggestion = { id: 'sg-t', author: 'agent', at: 1, op: { op: 'set_title', id: 'op-t', baseRev: 0, title: 'Once' } };
    const doc = minimal();
    // @ts-expect-error -- the host's op log is a required argument (the re-stamp bypasses the stale guard)
    const bare = acceptDocSuggestion(doc, sg);
    expect(bare.doc).toBe(doc);
    expect(bare.applied).toEqual([]);
    expect(bare.rejected).toEqual([{ index: 0, code: 'invalid', message: expect.stringContaining('seenOpIds') }]);
    const notAList = acceptDocSuggestion(minimal(), sg, { seenOpIds: 'op-t' } as unknown as { seenOpIds: string[] });
    expect(notAList.rejected).toMatchObject([{ code: 'invalid' }]);
    // With the log, the same suggestion accepted twice moves rev once.
    const first = acceptDocSuggestion(minimal(), sg, { seenOpIds: [] });
    const again = acceptDocSuggestion(first.doc, sg, { seenOpIds: first.applied.map((o) => o.id) });
    expect([first.doc.rev, again.doc.rev]).toEqual([1, 1]);
    expect(again.doc).toBe(first.doc);
    expect(again.rejected).toMatchObject([{ opId: 'op-t', code: 'duplicate' }]);
  });
});
