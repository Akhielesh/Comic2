// P1-REFS client-patch sanitizers (refs.md §2.2, §9 "jobs.test.ts / sanitizer"): path-addressed ref
// ops reach the doc only through these rules — unknown paths refused, client metadata stripped,
// label/note only, honest 409 caps (also across one batch), never into the inbox.
import { describe, expect, it } from 'vitest';
import type { ComicDoc, RefAsset } from '../../../../shared/comic/doc.js';
import { applyOps } from '../../../../shared/comic/ops.js';
import { DEFAULT_CAPS } from '../../../../shared/comic/capabilities.js';
import { sanitizePatchOps } from '../jobs.js';
import { plannedDoc } from '../orchestrator.fakes.js';
import type { SanitizeCtx } from '../extensions.js';
import { OP_SANITIZERS } from './index.js';

const ref = (n: number, extra: Partial<RefAsset> = {}): RefAsset => ({ path: `u/user-1/p/proj-1/ref/r${n}.webp`, source: 'upload', at: n, ...extra });
const MAYA = { kind: 'character', id: 'c_maya' } as const;
const ARJUN = { kind: 'character', id: 'c_arjun' } as const;
const ctx = (): SanitizeCtx => ({ userId: 'user-1', caps: DEFAULT_CAPS, rating: 'PG-13', now: 1234 });
const run = (doc: ComicDoc, ops: unknown[], c: SanitizeCtx = ctx()) => sanitizePatchOps(doc, ops, c);

const docWithAttachment = () => {
  const doc = plannedDoc();
  doc.conversation = [
    { id: 'm1', role: 'user', text: 'hi', at: 1, attachments: [ref(1, { label: 'face', hash: '0123456789abcdef', dhash: 'ffffffffffffffff', caption: 'a girl', safety: { assessed: 'G', at: 1 } })] }
  ];
  return doc;
};

describe('registration', () => {
  it('registers one sanitizer per ref op', () => {
    for (const op of ['ref_add', 'ref_patch', 'ref_move', 'ref_remove', 'ref_transfer']) expect(OP_SANITIZERS[op]?.op).toBe(op);
  });
});

describe('ref_add', () => {
  it('refuses a path this comic does not hold', () => {
    expect(() => run(plannedDoc(), [{ op: 'ref_add', owner: MAYA, ref: { path: 'u/other/p/x/ref/evil.webp', source: 'upload', at: 1 } }])).toThrow(
      /isn't part of this comic/
    );
    expect(() => run(plannedDoc(), [{ op: 'ref_add', owner: MAYA, ref: { path: '../../etc/passwd', source: 'upload', at: 1 } }])).toThrow(/Invalid photo path/);
  });

  it('rebuilds a known path server-side: client meta dropped, existing meta kept', () => {
    const [op] = run(docWithAttachment(), [
      {
        op: 'ref_add',
        owner: MAYA,
        index: 0,
        ref: { path: ref(1).path, source: 'generated', at: 99, hash: 'deadbeefdeadbeef', quality: {}, safety: { assessed: 'G', at: 5 }, original: { path: 'u/x/evil' }, label: 'side', note: ' my\nnote ' }
      }
    ]);
    expect(op).toEqual({
      op: 'ref_add',
      owner: MAYA,
      index: 0,
      ref: {
        path: ref(1).path,
        source: 'upload',
        at: 1234,
        addedBy: 'user',
        safety: { assessed: 'G', at: 1 },
        caption: 'a girl',
        hash: '0123456789abcdef',
        dhash: 'ffffffffffffffff',
        label: 'side',
        note: 'my note'
      }
    });
  });

  it('allows this project’s own private lane (Undo of a remove) but not another project’s', () => {
    const own = 'u/user-1/p/proj-1/ref/abc_123.webp';
    const [op] = run(plannedDoc(), [{ op: 'ref_add', owner: MAYA, ref: { path: own, source: 'upload', at: 1, safety: { assessed: 'G', at: 1 } } }]);
    expect(op).toMatchObject({ ref: { path: own, source: 'upload', addedBy: 'user' } });
    expect((op as { ref: RefAsset }).ref.safety).toBeUndefined();
    expect(() => run(plannedDoc(), [{ op: 'ref_add', owner: MAYA, ref: { path: 'u/user-1/p/other/ref/abc.webp' } }])).toThrow(/isn't part of this comic/);
    expect(() => run(plannedDoc(), [{ op: 'ref_add', owner: MAYA, ref: { path: 'u/user-2/p/proj-1/ref/abc.webp' } }])).toThrow(/isn't part of this comic/);
    // Contract §5.4 restore paths (P2-SERVER): the project's image lane too (a legacy upload or a sheet used as a
    // reference, removed with its character), rebuilt without any client verdict — never a variant, q/ or pub/ copy.
    const [img] = run(plannedDoc(), [{ op: 'ref_add', owner: MAYA, ref: { path: 'u/user-1/p/proj-1/img/up-3.webp', safety: { assessed: 'G', at: 1 } } }]);
    expect((img as { ref: RefAsset }).ref).toEqual({ path: 'u/user-1/p/proj-1/img/up-3.webp', source: 'upload', at: 1234, addedBy: 'user' });
    for (const bad of ['u/user-1/p/proj-1/img/gen-1_w480.webp', 'q/user-1/proj-1/q-1.webp', 'pub/AAAAAAAAAAAAAAAAAAAAAA/p1-0123456789ab.webp', 'u/user-1/p/proj-1/img/x.svg']) {
      expect(() => run(plannedDoc(), [{ op: 'ref_add', owner: MAYA, ref: { path: bad } }])).toThrow(/isn't part of this comic/);
    }
  });

  it('refuses blocked images and the inbox as a destination', () => {
    const doc = docWithAttachment();
    doc.conversation[0].attachments = [ref(2, { safety: { assessed: 'X', at: 1 } })];
    expect(() => run(doc, [{ op: 'ref_add', owner: MAYA, ref: { path: ref(2).path } }])).toThrow(/content check/);
    expect(() => run(docWithAttachment(), [{ op: 'ref_add', owner: { kind: 'inbox' }, ref: { path: ref(1).path } }])).toThrow(/uploading/);
  });

  it('is a 409 with the limit at the cap, also when a batch squeezes two adds past it', () => {
    const doc = docWithAttachment();
    doc.conversation[0].attachments!.push(ref(2));
    doc.cast[0].refs = Array.from({ length: 11 }, (_, i) => ref(100 + i));
    expect(run(doc, [{ op: 'ref_add', owner: MAYA, ref: { path: ref(1).path } }])).toHaveLength(1);
    let err: unknown;
    try {
      run(doc, [
        { op: 'ref_add', owner: MAYA, ref: { path: ref(1).path } },
        { op: 'ref_add', owner: MAYA, ref: { path: ref(2).path } }
      ]);
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({ code: 'LIMIT', status: 409, userMessage: 'MAYA already has 12 photos (the limit) — remove one to add another.' });
    // A remove earlier in the same batch makes room.
    expect(
      run(doc, [
        { op: 'ref_remove', owner: MAYA, path: ref(100).path },
        { op: 'ref_add', owner: MAYA, ref: { path: ref(1).path } },
        { op: 'ref_add', owner: MAYA, ref: { path: ref(2).path } }
      ])
    ).toHaveLength(3);
  });

  it('an unknown owner is a 400', () => {
    expect(() => run(docWithAttachment(), [{ op: 'ref_add', owner: { kind: 'character', id: 'c_gone' }, ref: { path: ref(1).path } }])).toThrow(/no longer in the cast/);
    expect(() => run(docWithAttachment(), [{ op: 'ref_add', owner: { kind: 'character', id: '../x' }, ref: { path: ref(1).path } }])).toThrow(/Invalid photo owner/);
  });
});

describe('ref_patch / ref_move / ref_remove / ref_transfer', () => {
  const doc = () => {
    const d = plannedDoc();
    d.cast[0].refs = [ref(1), ref(2), ref(3)];
    return d;
  };

  it('ref_patch: label and note only', () => {
    expect(run(doc(), [{ op: 'ref_patch', owner: MAYA, path: ref(2).path, patch: { label: 'side', note: 'red   scarf' } }])).toEqual([
      { op: 'ref_patch', owner: MAYA, path: ref(2).path, patch: { label: 'side', note: 'red scarf' } }
    ]);
    expect(run(doc(), [{ op: 'ref_patch', owner: MAYA, path: ref(2).path, patch: { label: null, note: '' } }])[0]).toMatchObject({ patch: { label: null, note: null } });
    expect(() => run(doc(), [{ op: 'ref_patch', owner: MAYA, path: ref(2).path, patch: { path: 'u/x/evil.webp' } }])).toThrow(/Only the label and the note/);
    expect(() => run(doc(), [{ op: 'ref_patch', owner: MAYA, path: ref(2).path, patch: { safety: null } }])).toThrow(/Only the label and the note/);
    expect(() => run(doc(), [{ op: 'ref_patch', owner: MAYA, path: ref(2).path, patch: { label: 'banana' } }])).toThrow(/Unknown photo label/);
    // A real label that is not a character view (style vocabulary) does not fit MAYA.
    expect(() => run(doc(), [{ op: 'ref_patch', owner: MAYA, path: ref(2).path, patch: { label: 'linework' } }])).toThrow(/doesn't fit MAYA/);
    expect(() => run(doc(), [{ op: 'ref_patch', owner: MAYA, path: ref(9).path, patch: { label: 'side' } }])).toThrow(/no longer on MAYA/);
  });

  it('ref_move clamps; Home = to 0 makes the main photo', () => {
    const [op] = run(doc(), [{ op: 'ref_move', owner: MAYA, path: ref(3).path, to: 99 }]);
    expect(op).toEqual({ op: 'ref_move', owner: MAYA, path: ref(3).path, to: 2 });
    const moved = applyOps(doc(), run(doc(), [{ op: 'ref_move', owner: MAYA, path: ref(3).path, to: 0 }]));
    expect(moved.cast[0].refs[0].path).toBe(ref(3).path);
  });

  it('ref_remove is idempotent', () => {
    expect(run(doc(), [{ op: 'ref_remove', owner: MAYA, path: ref(9).path }])).toEqual([{ op: 'ref_remove', owner: MAYA, path: ref(9).path }]);
    expect(run(doc(), [{ op: 'ref_remove', owner: { kind: 'character', id: 'c_gone' }, path: ref(1).path }])).toHaveLength(1);
  });

  it('ref_transfer checks the destination’s capacity and refuses duplicates and the inbox', () => {
    const d = doc();
    d.cast[1].refs = Array.from({ length: 12 }, (_, i) => ref(100 + i));
    expect(() => run(d, [{ op: 'ref_transfer', from: MAYA, to: ARJUN, path: ref(1).path }])).toThrow(/ARJUN already has 12 photos/);
    const ok = doc();
    const ops = run(ok, [{ op: 'ref_transfer', from: MAYA, to: { kind: 'style' }, path: ref(2).path }]);
    const after = applyOps(ok, ops);
    expect(after.style.refs.map((r) => r.path)).toEqual([ref(2).path]);
    expect(after.cast[0].refs.map((r) => r.path)).toEqual([ref(1).path, ref(3).path]);
    const dup = doc();
    dup.style.refs = [ref(1)];
    expect(() => run(dup, [{ op: 'ref_transfer', from: MAYA, to: { kind: 'style' }, path: ref(1).path }])).toThrow(/already on the style/);
    expect(() => run(doc(), [{ op: 'ref_transfer', from: MAYA, to: { kind: 'inbox' }, path: ref(1).path }])).toThrow(/uploading/);
  });

  it('notes still pass the safety screen with the rest of the batch', () => {
    // The screen sees ref_patch notes like any other free text (no throw for a harmless note).
    expect(run(doc(), [{ op: 'ref_patch', owner: MAYA, path: ref(1).path, patch: { note: 'her festival outfit' } }])).toHaveLength(1);
  });
});
