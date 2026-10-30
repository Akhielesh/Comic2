// @vitest-environment node
// K2b (pro plan §5.3, §10 Wave 2): the Ship 2 client-patch sanitizers. Every rejection the plan lists (an out-of-range
// box, an unknown panel, 13 cuts, a non-hex colour, a stale page_cuts path, a foreign / client-writable / blocked src,
// 25 overlays, 3 extra pictures, NaN), the page_cuts provenance rule (keepBy only for server-stamped cuts), and one
// acceptance test per op shape the editor engine sends (B9 wave notes). Everything goes through the real entry point,
// jobs.ts sanitizePatchOps, the way a client batch reaches the doc.
import { beforeEach, describe, expect, it } from 'vitest';
import { applyOps, CLIENT_PATCHABLE_OPS, PRO_PAGE_OPS_PATCHABLE, PRO_PAGE_PATCH_OPS, type DocOp } from '../../../../shared/comic/ops.js';
import { inverseOps } from '../../../../shared/comic/undo.js';
import { emptyRender, findPage, type AssetRef, type Balloon, type ComicDoc, type PanelCuts } from '../../../../shared/comic/doc.js';
import { DEFAULT_CAPS } from '../../../../shared/comic/capabilities.js';
import { plannedDoc } from '../orchestrator.fakes.js';
import { sanitizePatchOps } from '../jobs.js';
import type { SanitizeCtx } from '../extensions.js';
import { StudioError } from '../types.js';
import { opSanitizerFor } from './index.js';
import { CONSISTENCY_SANITIZERS } from './consistency.js';
import { PANELS_SANITIZERS, __resetStampedCutsForTests } from './panels.js';

const NOW = 1_800_000_000_000;
const sctx = (over: Partial<SanitizeCtx> = {}): SanitizeCtx => ({ userId: 'user-1', caps: DEFAULT_CAPS, rating: 'PG-13', now: NOW, ...over });
const own = (name: string) => `u/user-1/p/proj-1/img/${name}.webp`;
const asset = (path: string, extra: Partial<AssetRef> = {}): AssetRef => ({ path, source: 'generated', at: 1, w: 800, h: 1200, safety: { assessed: 'G', at: 1 }, ...extra });

const STAMPED: PanelCuts = {
  status: 'ok',
  by: 'detect',
  at: 5,
  cuts: [
    { drawn: 1, box: { x: 0.02, y: 0.02, w: 0.96, h: 0.46 }, conf: 0.93 },
    { drawn: 2, box: { x: 0.02, y: 0.52, w: 0.46, h: 0.46 }, conf: 0.91 },
    { drawn: 3, box: { x: 0.52, y: 0.52, w: 0.46, h: 0.46 }, conf: 0.9 }
  ]
};

/**
 * Page 1 drawn (two earlier takes, detector cuts, panels mode with frames); page 2 drawn; page 3 planned. Images the
 * comic holds: an uploaded photo in its ref lane, a classic client-writable photo, a blocked take, another project's
 * image named by an attachment. A Hindi edition. A scene.
 */
const fixture = (): ComicDoc => {
  const doc = plannedDoc();
  const [p1, p2, p3] = doc.pages;
  doc.cast = doc.cast.map((c) =>
    c.id === 'c_maya'
      ? { ...c, refs: [{ path: 'u/user-1/p/proj-1/ref/maya.webp', source: 'upload', at: 2, w: 600, h: 600 }, { path: 'user-1/classic-photo.webp', source: 'upload', at: 2 }] }
      : c
  );
  doc.pages = [
    {
      ...p1,
      artMode: 'panels',
      panels: p1.panels.map((pn, j) => ({ ...pn, frame: { box: STAMPED.cuts[j].box } })),
      render: {
        status: 'ready',
        asset: asset(own('p1-v3')),
        history: [asset(own('p1-v1')), asset(own('p1-v2')), asset(own('p1-bad'), { safety: { assessed: 'X', at: 3, categories: ['graphic_gore'] } })],
        cuts: STAMPED,
        qc: { score: 0.8, issues: [], checkedAt: 1, checkV: 2, findings: [{ id: 'f_1', kind: 'identity', panel: 1, severity: 'minor', note: 'Scarf colour' }] }
      },
      balloons: [{ lineId: 'ln_1_2', x: 0.1, y: 0.55, w: 0.3 }]
    },
    { ...p2, render: { status: 'ready', asset: asset(own('p2-v1')), history: [] } },
    { ...p3, render: emptyRender() }
  ];
  doc.conversation = [{ id: 'm1', role: 'user', text: 'here', at: 1, attachments: [{ path: 'u/user-2/p/proj-9/img/theirs.webp', source: 'upload', at: 3 }] }];
  doc.scenes = [{ id: 'sc_market', name: 'Market' }];
  return applyOps(doc, [{ op: 'edition', lang: 'hi', patch: {} }], 2);
};

const sanitize = (doc: ComicDoc, ops: unknown[], ctx = sctx()) => sanitizePatchOps(doc, ops, ctx);

const rejects = (fn: () => unknown, status: number, code?: string): StudioError => {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(StudioError);
    expect((err as StudioError).status).toBe(status);
    if (code) expect((err as StudioError).code).toBe(code);
    return err as StudioError;
  }
  throw new Error('expected the batch to be rejected');
};

const frameOp = (frame: Record<string, unknown>, panelId = 'pn_1_2'): Record<string, unknown> => ({ op: 'page_frames', pageId: 'pg_1', frames: [{ panelId, frame }] });

beforeEach(() => __resetStampedCutsForTests());

describe('the switch and the registry', () => {
  it('the ten Ship 2 ops are client-patchable and each has its own sanitizer (none is a stub)', () => {
    expect(PRO_PAGE_OPS_PATCHABLE).toBe(true);
    for (const op of PRO_PAGE_PATCH_OPS) {
      expect(CLIENT_PATCHABLE_OPS.has(op)).toBe(true);
      expect(opSanitizerFor(op)).toBe([...PANELS_SANITIZERS, ...CONSISTENCY_SANITIZERS].find((s) => s.op === op));
    }
  });
});

describe('every sanitizer rejection (pro plan §10 K2b tests)', () => {
  it('an out-of-range box: a frame past the page edge, an empty one, an overlay off the page', () => {
    const doc = fixture();
    rejects(() => sanitize(doc, [frameOp({ box: { x: 0.7, y: 0.1, w: 0.5, h: 0.3 } })]), 400, 'BAD_REQUEST');
    rejects(() => sanitize(doc, [frameOp({ box: { x: -0.2, y: 0.1, w: 0.5, h: 0.3 } })]), 400);
    rejects(() => sanitize(doc, [frameOp({ box: { x: 0.1, y: 0.1, w: 0, h: 0.3 } })]), 400);
    rejects(() => sanitize(doc, [frameOp({ box: { x: 0.1, y: 0.1, w: 0.01, h: 0.3 } })]), 400); // under frameMin
    rejects(() => sanitize(doc, [{ op: 'layer', pageId: 'pg_1', id: 'ly_a', patch: { kind: 'shape', box: { x: 0.9, y: 0.9, w: 0.3, h: 0.3 }, shape: { type: 'rect' } } }]), 400);
    rejects(() => sanitize(doc, [{ op: 'page_cuts', pageId: 'pg_1', path: own('p1-v3'), cuts: { ...STAMPED, cuts: [{ drawn: 1, box: { x: 0.5, y: 0, w: 0.6, h: 1 }, conf: 0.9 }] } }]), 400);
  });

  it('an unknown panel: in frames, cuts, order, a removal, lines going to it and an overlay clip', () => {
    const doc = fixture();
    rejects(() => sanitize(doc, [frameOp({ box: { x: 0.1, y: 0.1, w: 0.3, h: 0.3 } }, 'pn_ghost')]), 400);
    rejects(() => sanitize(doc, [{ op: 'page_cuts', pageId: 'pg_1', path: own('p1-v3'), cuts: { ...STAMPED, by: 'user', cuts: [{ ...STAMPED.cuts[0], panelId: 'pn_ghost' }] } }]), 400);
    rejects(() => sanitize(doc, [{ op: 'panels_order', pageId: 'pg_1', order: ['pn_1_2', 'pn_ghost'] }]), 400);
    rejects(() => sanitize(doc, [{ op: 'panel_remove', pageId: 'pg_1', id: 'pn_ghost' }]), 400);
    rejects(() => sanitize(doc, [{ op: 'panel_remove', pageId: 'pg_1', id: 'pn_1_1', linesTo: 'pn_ghost' }]), 400);
    rejects(() => sanitize(doc, [{ op: 'layer', pageId: 'pg_1', id: 'ly_a', patch: { kind: 'shape', box: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, shape: { type: 'rect' }, clip: 'pn_ghost' } }]), 400);
    // A frame on another page's panel is unknown to this page.
    rejects(() => sanitize(doc, [frameOp({ box: { x: 0.1, y: 0.1, w: 0.3, h: 0.3 } }, 'pn_2_1')]), 400);
  });

  it('13 cuts (EDITOR_LIMITS.maxCuts is 12)', () => {
    const doc = fixture();
    const cut = (i: number) => ({ drawn: i + 1, box: { x: 0, y: i / 13, w: 1, h: 1 / 13 - 0.001 }, conf: 0.9 });
    rejects(() => sanitize(doc, [{ op: 'page_cuts', pageId: 'pg_1', path: own('p1-v3'), cuts: { status: 'ok', by: 'user', at: 9, cuts: Array.from({ length: 13 }, (_, i) => cut(i)) } }]), 400);
    // 12 is fine.
    const ok = sanitize(doc, [{ op: 'page_cuts', pageId: 'pg_1', path: own('p1-v3'), cuts: { status: 'ok', by: 'user', at: 9, cuts: Array.from({ length: 12 }, (_, i) => cut(i)) } }]);
    expect((ok[0] as Extract<DocOp, { op: 'page_cuts' }>).cuts!.cuts).toHaveLength(12);
  });

  it('a non-hex colour: frame style, frame border, overlay shape', () => {
    const doc = fixture();
    for (const color of ['red', '#fff', 'rgb(0,0,0)', 'url(x)', '#12345g']) {
      rejects(() => sanitize(doc, [{ op: 'page_frames', pageId: 'pg_1', frameStyle: { color } }]), 400);
      rejects(() => sanitize(doc, [frameOp({ box: { x: 0.1, y: 0.1, w: 0.3, h: 0.3 }, border: { color } })]), 400);
      rejects(() => sanitize(doc, [{ op: 'layer', pageId: 'pg_1', id: 'ly_a', patch: { kind: 'shape', box: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, shape: { type: 'rect', fill: color } } }]), 400);
    }
    rejects(() => sanitize(doc, [{ op: 'page_frames', pageId: 'pg_1', frameStyle: { bg: 'white' } }]), 400);
  });

  it('a stale page_cuts path: cuts for a drawing that is no longer the page’s are refused (409), never applied to the new one', () => {
    const doc = fixture();
    const err = rejects(() => sanitize(doc, [{ op: 'page_cuts', pageId: 'pg_1', path: own('p1-v2'), cuts: { ...STAMPED, by: 'user' } }]), 409, 'CONFLICT');
    expect(err.userMessage).toMatch(/redrawn/);
    rejects(() => sanitize(doc, [{ op: 'page_cuts', pageId: 'pg_3', path: own('p1-v3'), cuts: null }]), 409);
  });

  it('a foreign, client-writable or blocked src (frames and overlays alike)', () => {
    const doc = fixture();
    const box = { x: 0.1, y: 0.1, w: 0.3, h: 0.3 };
    const layer = (path: string) => ({ op: 'layer', pageId: 'pg_1', id: 'ly_a', patch: { kind: 'image', box, src: { path } } });
    // Foreign: a path this comic does not hold (another user's object), or another project's image the doc names.
    for (const path of ['u/user-2/p/proj-9/img/other.webp', 'u/user-2/p/proj-9/img/theirs.webp', 'https://evil.example/x.png', '../../etc/passwd']) {
      rejects(() => sanitize(doc, [frameOp({ box, src: { path } })]), 400);
      rejects(() => sanitize(doc, [layer(path)]), 400);
    }
    // Client-writable: the classic `<uid>/<file>` lane.
    expect(rejects(() => sanitize(doc, [frameOp({ box, src: { path: 'user-1/classic-photo.webp' } })]), 400).userMessage).toMatch(/upload it again/);
    rejects(() => sanitize(doc, [layer('user-1/classic-photo.webp')]), 400);
    // Blocked: a take that didn't pass the content check.
    rejects(() => sanitize(doc, [frameOp({ box, src: { path: own('p1-bad') } })]), 409, 'CONTENT_POLICY');
    rejects(() => sanitize(doc, [layer(own('p1-bad'))]), 409, 'CONTENT_POLICY');
    // A planted `upload` in the public img lane (the publish boundary refuses it, so the editor does too).
    const planted = fixture();
    planted.conversation = [{ id: 'm2', role: 'user', text: 'x', at: 1, attachments: [{ path: own('planted'), source: 'upload', at: 3 }] }];
    expect(rejects(() => sanitize(planted, [frameOp({ box, src: { path: own('planted') } })]), 400).userMessage).toMatch(/outside the studio/);
  });

  it('25 overlays (EDITOR_LIMITS.layersPerPage is 24): 409 LIMIT; an existing overlay still edits', () => {
    const doc = fixture();
    const box = { x: 0.1, y: 0.1, w: 0.1, h: 0.1 };
    doc.pages[0] = { ...doc.pages[0], layers: Array.from({ length: 24 }, (_, i) => ({ id: `ly_${i}`, kind: 'shape' as const, box, shape: { type: 'rect' as const } })) };
    rejects(() => sanitize(doc, [{ op: 'layer', pageId: 'pg_1', id: 'ly_new', patch: { kind: 'shape', box, shape: { type: 'rect' } } }]), 409, 'LIMIT');
    expect(sanitize(doc, [{ op: 'layer', pageId: 'pg_1', id: 'ly_3', patch: { opacity: 0.5 } }])).toHaveLength(1);
    // A batch that adds two more to 23 is refused at the 25th as well.
    doc.pages[0].layers = doc.pages[0].layers!.slice(0, 23);
    rejects(() => sanitize(doc, [1, 2].map((i) => ({ op: 'layer', pageId: 'pg_1', id: `ly_n${i}`, patch: { kind: 'shape', box, shape: { type: 'rect' } } }))), 409, 'LIMIT');
  });

  it('3 extra pictures on one page (EDITOR_LIMITS.sourcesPerPage is 2): 409 LIMIT, in frames and in an added panel', () => {
    const doc = fixture();
    const box = { x: 0.1, y: 0.1, w: 0.3, h: 0.3 };
    const ops = [
      { op: 'page_frames', pageId: 'pg_1', frames: [
        { panelId: 'pn_1_1', frame: { box, src: { path: own('p1-v1') } } },
        { panelId: 'pn_1_2', frame: { box, src: { path: own('p1-v2') } } },
        { panelId: 'pn_1_3', frame: { box, src: { path: 'u/user-1/p/proj-1/ref/maya.webp' } } }
      ] }
    ];
    rejects(() => sanitize(doc, ops), 409, 'LIMIT');
    // Two are fine; the same picture twice counts once.
    expect(sanitize(doc, [{ ...ops[0], frames: [ops[0].frames[0], ops[0].frames[1], { panelId: 'pn_1_3', frame: { box, src: { path: own('p1-v1') } } }] }])).toHaveLength(1);
    const two = applyOps(doc, sanitize(doc, [{ ...ops[0], frames: ops[0].frames.slice(0, 2) }]), 3);
    rejects(() => sanitize(two, [{ op: 'panel_add', pageId: 'pg_1', panel: { id: 'pn_new', n: 0, size: 'medium', shot: 'medium', action: '', castIds: [], lines: [], frame: { box, src: { path: 'u/user-1/p/proj-1/ref/maya.webp' } } } }]), 409, 'LIMIT');
  });

  it('NaN (and Infinity, and strings) anywhere a number goes', () => {
    const doc = fixture();
    rejects(() => sanitize(doc, [frameOp({ box: { x: NaN, y: 0.1, w: 0.3, h: 0.3 } })]), 400);
    rejects(() => sanitize(doc, [frameOp({ box: { x: 0.1, y: 0.1, w: 0.3, h: 0.3 }, fit: { s: NaN, x: 0, y: 0 } })]), 400);
    rejects(() => sanitize(doc, [frameOp({ box: { x: 0.1, y: 0.1, w: Infinity, h: 0.3 } })]), 400);
    rejects(() => sanitize(doc, [frameOp({ box: { x: '0.1', y: 0.1, w: 0.3, h: 0.3 } })]), 400);
    rejects(() => sanitize(doc, [{ op: 'page_frames', pageId: 'pg_1', frameStyle: { gutter: NaN } }]), 400);
    rejects(() => sanitize(doc, [{ op: 'layer', pageId: 'pg_1', id: 'ly_a', patch: { kind: 'shape', box: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, shape: { type: 'rect' }, rot: NaN } }]), 400);
    rejects(() => sanitize(doc, [{ op: 'page_cuts', pageId: 'pg_1', path: own('p1-v3'), cuts: { ...STAMPED, by: 'user', cuts: [{ ...STAMPED.cuts[0], conf: NaN }] } }]), 400);
    rejects(() => sanitize(doc, [{ op: 'balloon', pageId: 'pg_1', lineId: 'ln_1_2', patch: { rot: NaN } }]), 400);
    rejects(() => sanitize(doc, [{ op: 'balloon', pageId: 'pg_1', lineId: 'ln_1_2', patch: { minH: NaN } }]), 400);
  });

  it('the whole batch goes: one bad op refuses the good ones before it', () => {
    const doc = fixture();
    rejects(() => sanitize(doc, [{ op: 'page_frames', pageId: 'pg_1', artMode: null }, frameOp({ box: { x: 0.9, y: 0, w: 0.5, h: 0.5 } })]), 400);
  });

  it('structure and consistency: lines-per-panel held, foreign lines, unknown scene / character / page, finding text', () => {
    const doc = fixture();
    // 9 panels max.
    const nine = fixture();
    nine.pages[2] = { ...nine.pages[2], panels: Array.from({ length: 9 }, (_, i) => ({ id: `pn_x${i}`, n: i + 1, size: 'small' as const, shot: 'medium' as const, action: '', castIds: [], lines: [] })) };
    rejects(() => sanitize(nine, [{ op: 'panel_add', pageId: 'pg_3', panel: { id: 'pn_10', lines: [] } }]), 409, 'LIMIT');
    // A line of another page can't be pulled into a new panel.
    rejects(() => sanitize(doc, [{ op: 'panel_add', pageId: 'pg_1', panel: { id: 'pn_new', lines: [{ id: 'ln_2_2' }] } }]), 400);
    // Moving every line of a full panel into another full one breaks linesPerPanel (8).
    const full = fixture();
    const lines = (p: string) => Array.from({ length: 5 }, (_, i) => ({ id: `${p}_l${i}`, kind: 'speech' as const, text: 'x' }));
    full.pages[0].panels = full.pages[0].panels.map((pn, j) => (j < 2 ? { ...pn, lines: lines(pn.id) } : pn));
    rejects(() => sanitize(full, [{ op: 'panel_remove', pageId: 'pg_1', id: 'pn_1_1', linesTo: 'pn_1_2' }]), 400);
    rejects(() => sanitize(doc, [{ op: 'continuity', pageId: 'pg_1', patch: { sceneId: 'sc_ghost' } }]), 400);
    rejects(() => sanitize(doc, [{ op: 'continuity', pageId: 'pg_1', patch: { cast: { c_ghost: { outfit: 'red coat' } } } }]), 400);
    rejects(() => sanitize(doc, [{ op: 'consistency', patch: { styleKeyPageId: 'pg_ghost' } }]), 400);
    rejects(() => sanitize(doc, [{ op: 'consistency', patch: { maxRefs: 99 } }]), 400);
    rejects(() => sanitize(doc, [{ op: 'scene', id: 'sc_new', patch: { time: 'dusk' } }]), 400); // a new scene needs a name
    rejects(() => sanitize(doc, [{ op: 'finding', pageId: 'pg_1', id: 'f_1', patch: { dismissed: true, note: 'all good' } }]), 400);
    rejects(() => sanitize(doc, [{ op: 'finding', pageId: 'pg_1', id: 'f_ghost', patch: { dismissed: true } }]), 400);
  });
});

describe('page_cuts provenance: keepBy only for cuts the server stamped', () => {
  const naming = { op: 'page_cuts', pageId: 'pg_1', path: own('p1-v3'), cuts: { ...STAMPED, cuts: STAMPED.cuts.map((c, j) => ({ ...c, panelId: `pn_1_${j + 1}` })) }, moveBalloons: false };

  it('a client cannot forge detector cuts: keepBy with cuts the server never stamped rejects the batch (not stripped)', () => {
    const doc = fixture();
    const forged = { ...STAMPED, by: 'detect' as const, cuts: STAMPED.cuts.map((c) => ({ ...c, conf: 0.99 })) };
    rejects(() => sanitize(doc, [{ op: 'page_cuts', pageId: 'pg_1', path: own('p1-v3'), cuts: forged, keepBy: true }]), 400);
    // Without keepBy the same cuts are the user's (applyOp writes by: 'user').
    const after = applyOps(doc, sanitize(doc, [{ op: 'page_cuts', pageId: 'pg_1', path: own('p1-v3'), cuts: forged }]), 3);
    expect(findPage(after, 'pg_1')!.render.cuts!.by).toBe('user');
  });

  it('the editor names the cuts (no keepBy, moveBalloons:false); its undo puts the stamped cuts back with keepBy', () => {
    const doc = fixture();
    const ops = sanitize(doc, [naming]);
    expect(ops[0]).toMatchObject({ op: 'page_cuts', moveBalloons: false });
    expect((ops[0] as { keepBy?: boolean }).keepBy).toBeUndefined();
    const named = applyOps(doc, ops, 3);
    expect(findPage(named, 'pg_1')!.render.cuts!.by).toBe('user');
    const undo = inverseOps(doc, ops);
    expect(undo[0]).toMatchObject({ op: 'page_cuts', keepBy: true, cuts: STAMPED });
    // The live cuts are the user's now: the stamped ones were remembered when the client first replaced them.
    const back = applyOps(named, sanitize(named, undo), 4);
    expect(findPage(back, 'pg_1')!.render.cuts).toEqual(STAMPED);
  });

  it('keepBy for the current server-stamped cuts is accepted; a user-written value is never "stamped"', () => {
    const doc = fixture();
    expect(sanitize(doc, [{ op: 'page_cuts', pageId: 'pg_1', path: own('p1-v3'), cuts: STAMPED, keepBy: true }])[0]).toMatchObject({ keepBy: true });
    const userCuts = { ...STAMPED, by: 'user' as const };
    const mine = fixture();
    mine.pages[0].render.cuts = userCuts;
    rejects(() => sanitize(mine, [{ op: 'page_cuts', pageId: 'pg_1', path: own('p1-v3'), cuts: { ...STAMPED, at: 99 }, keepBy: true }]), 400);
  });

  it('moveBalloons and keepBy are booleans only', () => {
    const doc = fixture();
    rejects(() => sanitize(doc, [{ ...naming, moveBalloons: 'no' }]), 400);
    rejects(() => sanitize(doc, [{ ...naming, keepBy: 1 }]), 400);
  });
});

describe('the op shapes the editor engine sends are accepted (B9 wave notes; one test per shape)', () => {
  it('page_frames whose frame.src is the page’s own drawing: allowed and not an extra picture', () => {
    const doc = fixture();
    const box = { x: 0.1, y: 0.1, w: 0.3, h: 0.3 };
    const ops = sanitize(doc, [{ op: 'page_frames', pageId: 'pg_1', frames: [
      { panelId: 'pn_1_1', frame: { box, src: { path: own('p1-v1') } } },
      { panelId: 'pn_1_2', frame: { box, src: { path: own('p1-v2') } } },
      { panelId: 'pn_1_3', frame: { box, src: { path: own('p1-v3'), box: { x: 0.5, y: 0.5, w: 0.5, h: 0.5 } }, fit: { s: 2, x: 0.25, y: -0.5 } } }
    ] }]);
    const after = applyOps(doc, ops, 3);
    expect(findPage(after, 'pg_1')!.panels.map((p) => p.frame?.src?.path)).toEqual([own('p1-v1'), own('p1-v2'), own('p1-v3')]);
  });

  it('frame.z on an inset (and border, lock)', () => {
    const doc = fixture();
    const [op] = sanitize(doc, [frameOp({ box: { x: 0.6, y: 0.6, w: 0.3, h: 0.3 }, z: 2, border: { w: 0.006, color: '#111111' }, locked: true })]);
    expect((op as Extract<DocOp, { op: 'page_frames' }>).frames![0].frame).toEqual({ box: { x: 0.6, y: 0.6, w: 0.3, h: 0.3 }, z: 2, border: { w: 0.006, color: '#111111' }, locked: true });
  });

  it('page_cuts naming the panels with moveBalloons:false and no keepBy', () => {
    const doc = fixture();
    const [op] = sanitize(doc, [{ op: 'page_cuts', pageId: 'pg_1', path: own('p1-v3'), cuts: { ...STAMPED, cuts: STAMPED.cuts.map((c, j) => ({ ...c, panelId: `pn_1_${j + 1}` })) }, moveBalloons: false }]);
    expect(op).toMatchObject({ op: 'page_cuts', moveBalloons: false });
    expect((op as Extract<DocOp, { op: 'page_cuts' }>).cuts!.cuts.map((c) => c.panelId)).toEqual(['pn_1_1', 'pn_1_2', 'pn_1_3']);
  });

  it('panel patch {castIds, direction:{cast:{[id]:{pos}}, offPanel, by:"user"}} (the off-panel fix)', () => {
    const doc = fixture();
    const [op] = sanitize(doc, [{ op: 'panel', pageId: 'pg_2', id: 'pn_2_2', patch: { castIds: ['c_arjun'], direction: { cast: { c_arjun: { pos: 'left' } }, offPanel: ['c_maya'], by: 'user' } } }]);
    expect(op).toEqual({ op: 'panel', pageId: 'pg_2', id: 'pn_2_2', patch: { castIds: ['c_arjun'], direction: { cast: { c_arjun: { pos: 'left' } }, offPanel: ['c_maya'], by: 'user' } } });
    const after = applyOps(doc, [op], 3);
    expect(findPage(after, 'pg_2')!.panels[1].direction).toEqual({ cast: { c_arjun: { pos: 'left' } }, offPanel: ['c_maya'], by: 'user' });
  });

  it('panel patches {placeId} and {size} on an undrawn page, and a join {castIds, action ≤ 2000, placeId, direction}', () => {
    const doc = fixture();
    expect(sanitize(doc, [{ op: 'panel', pageId: 'pg_3', id: 'pn_3_1', patch: { placeId: 'pl_market' } }])[0]).toMatchObject({ patch: { placeId: 'pl_market' } });
    expect(sanitize(doc, [{ op: 'panel', pageId: 'pg_3', id: 'pn_3_2', patch: { size: 'wide' } }])[0]).toMatchObject({ patch: { size: 'wide' } });
    const action = `${'Maya leaps the stall. '.repeat(90)}`.slice(0, 2000);
    const [join] = sanitize(doc, [{ op: 'panel', pageId: 'pg_3', id: 'pn_3_1', patch: { castIds: ['c_maya', 'c_arjun'], action, placeId: 'pl_market', direction: { lens: 'wide', light: 'warm dusk', by: 'user' } } }]);
    expect(join).toMatchObject({ patch: { castIds: ['c_maya', 'c_arjun'], placeId: 'pl_market', direction: { lens: 'wide', light: 'warm dusk', by: 'user' } } });
    expect((join as Extract<DocOp, { op: 'panel' }>).patch.action).toHaveLength(action.trim().length);
  });

  it('a panel patch never carries a frame (frames move through page_frames so their lettering follows); direction null clears', () => {
    const doc = fixture();
    const [op] = sanitize(doc, [{ op: 'panel', pageId: 'pg_1', id: 'pn_1_1', patch: { frame: { box: { x: 0, y: 0, w: 1, h: 1 } }, mood: 'tense', direction: null } }]);
    expect(op).toEqual({ op: 'panel', pageId: 'pg_1', id: 'pn_1_1', patch: { mood: 'tense', direction: null } });
  });

  it('page {layout} (undrawn pages); page drops artMode, frameStyle, layers and continuity', () => {
    const doc = fixture();
    const [op] = sanitize(doc, [{ op: 'page', id: 'pg_3', patch: { layout: 'Row 1: two panels. Row 2: one wide panel.', artMode: 'panels', frameStyle: { gutter: 0.05 }, layers: [], continuity: { notes: ['x'] } } }]);
    expect(op).toEqual({ op: 'page', id: 'pg_3', patch: { layout: 'Row 1: two panels. Row 2: one wide panel.' } });
  });

  it('a layer created with print:false (a real person’s photo, guide only; PD-5)', () => {
    const doc = fixture();
    const [op] = sanitize(doc, [{ op: 'layer', pageId: 'pg_1', id: 'ly_photo', index: 0, patch: { kind: 'image', box: { x: 0.6, y: 0.1, w: 0.3, h: 0.3 }, src: { path: 'u/user-1/p/proj-1/ref/maya.webp' }, print: false, name: 'Maya photo', clip: 'pn_1_1' } }]);
    const after = applyOps(doc, [op], 3);
    expect(findPage(after, 'pg_1')!.layers).toEqual([{ id: 'ly_photo', kind: 'image', box: { x: 0.6, y: 0.1, w: 0.3, h: 0.3 }, src: { path: 'u/user-1/p/proj-1/ref/maya.webp' }, name: 'Maya photo', clip: 'pn_1_1', print: false }]);
  });

  it('line_style {sizeScale}, line {kind:"caption"} and edition_balloon {lang, lineId, patch:{x, y, w, pinned:true}}', () => {
    const doc = fixture();
    const ops = sanitize(doc, [
      { op: 'line_style', pageId: 'pg_1', lineIds: ['ln_1_2'], patch: { sizeScale: 1.2 } },
      { op: 'line', pageId: 'pg_1', panelId: 'pn_1_2', id: 'ln_1_2', patch: { kind: 'caption' } },
      { op: 'edition_balloon', lang: 'hi', lineId: 'ln_1_2', patch: { x: 0.2, y: 0.6, w: 0.3, pinned: true } }
    ]);
    expect(ops.map((o) => o.op)).toEqual(['line_style', 'line', 'edition_balloon']);
    expect(ops[2]).toMatchObject({ patch: { x: 0.2, y: 0.6, w: 0.3, pinned: true } });
  });

  it('a whole-page `balloons` snapshot carrying rot and minH survives sanitizePatchOps unchanged', () => {
    const doc = fixture();
    const balloons: Balloon[] = [{ lineId: 'ln_1_2', x: 0.1, y: 0.55, w: 0.3, rot: -12.5, minH: 0.18, pinned: true }];
    const [op] = sanitize(doc, [{ op: 'balloons', pageId: 'pg_1', balloons }]);
    expect(op).toEqual({ op: 'balloons', pageId: 'pg_1', balloons });
    // Out of range is clamped as the client clamps it; NaN is dropped from a snapshot (never stored).
    const [clamped] = sanitize(doc, [{ op: 'balloons', pageId: 'pg_1', balloons: [{ lineId: 'ln_1_2', x: 0.1, y: 0.5, w: 0.3, rot: 80, minH: 0.9 }] }]);
    expect((clamped as Extract<DocOp, { op: 'balloons' }>).balloons[0]).toMatchObject({ rot: 45, minH: 0.6 });
  });

  it('the `balloon` op takes rot and minH (clamped; null clears)', () => {
    const doc = fixture();
    expect(sanitize(doc, [{ op: 'balloon', pageId: 'pg_1', lineId: 'ln_1_2', patch: { rot: -60, minH: 0.2 } }])[0]).toEqual({ op: 'balloon', pageId: 'pg_1', lineId: 'ln_1_2', patch: { rot: -45, minH: 0.2 } });
    expect(sanitize(doc, [{ op: 'balloon', pageId: 'pg_1', lineId: 'ln_1_2', patch: { rot: null, minH: null } }])[0]).toEqual({ op: 'balloon', pageId: 'pg_1', lineId: 'ln_1_2', patch: { rot: null, minH: null } });
  });

  it('undoing a panel removal in one batch: the panel, its lines’ balloons, translations and clipped overlays come back', () => {
    const doc = fixture();
    doc.pages[0] = { ...doc.pages[0], layers: [{ id: 'ly_star', kind: 'shape', box: { x: 0.1, y: 0.1, w: 0.1, h: 0.1 }, shape: { type: 'ellipse' }, clip: 'pn_1_2' }] };
    const withHi = applyOps(doc, [{ op: 'translation', lang: 'hi', lineId: 'ln_1_2', patch: { text: 'नमस्ते', status: 'reviewed', sourceHash: 'h', at: 3 } }], 2);
    const remove = sanitize(withHi, [{ op: 'panel_remove', pageId: 'pg_1', id: 'pn_1_2' }]);
    const removed = applyOps(withHi, remove, 3);
    expect(findPage(removed, 'pg_1')!.balloons).toEqual([]);
    const undo = inverseOps(withHi, remove);
    expect(undo.map((o) => o.op)).toEqual(['panel_add', 'balloons', 'translation', 'layer']);
    const back = applyOps(removed, sanitize(removed, undo), 4);
    expect(findPage(back, 'pg_1')!.panels.map((p) => p.id)).toEqual(['pn_1_1', 'pn_1_2', 'pn_1_3']);
    expect(findPage(back, 'pg_1')!.balloons).toEqual(findPage(withHi, 'pg_1')!.balloons);
    expect(findPage(back, 'pg_1')!.layers![0].clip).toBe('pn_1_2');
  });

  it('a scene created earlier in the batch exists for a continuity op after it; safe mode softens direction text', () => {
    const doc = fixture();
    const ops = sanitize(doc, [
      { op: 'scene', id: 'sc_alley', patch: { name: 'Back alley', light: 'neon' } },
      { op: 'continuity', pageId: 'pg_2', patch: { sceneId: 'sc_alley', cast: { c_maya: { holding: ['lantern'] } } } }
    ]);
    expect(ops.map((o) => o.op)).toEqual(['scene', 'continuity']);
    const kids = sanitize(doc, [{ op: 'panel', pageId: 'pg_2', id: 'pn_2_1', patch: { direction: { focus: 'the bloody blade' } } }], sctx({ rating: 'G' }));
    expect((kids[0] as Extract<DocOp, { op: 'panel' }>).patch.direction).toEqual({ focus: 'the blade' });
    const teen = sanitize(doc, [{ op: 'panel', pageId: 'pg_2', id: 'pn_2_1', patch: { direction: { focus: 'the bloody blade' } } }]);
    expect((teen[0] as Extract<DocOp, { op: 'panel' }>).patch.direction).toEqual({ focus: 'the bloody blade' });
  });

  it('finding: only `dismissed` (true / false / null)', () => {
    const doc = fixture();
    expect(sanitize(doc, [{ op: 'finding', pageId: 'pg_1', id: 'f_1', patch: { dismissed: true } }])[0]).toEqual({ op: 'finding', pageId: 'pg_1', id: 'f_1', patch: { dismissed: true } });
    expect(sanitize(doc, [{ op: 'finding', pageId: 'pg_1', id: 'f_1', patch: { dismissed: null } }])[0]).toEqual({ op: 'finding', pageId: 'pg_1', id: 'f_1', patch: { dismissed: null } });
  });
});
