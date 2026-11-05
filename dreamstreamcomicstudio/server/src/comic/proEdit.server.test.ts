// @vitest-environment node
// Pro Edit contract on the server (master plan §2.10, §2.12 PE-0; owner sign-off D5 pending): access.ts turns the three
// new flags into caps (all off when unset), and no client batch can write a Pro op or a Pro field yet: the patch
// sanitizer refuses the motion ops (not client-patchable), effect layers (an unknown kind to it), patches to an opaque
// layer, Pro keys on overlays, reader motion and Pro lettering. PE-SERVER widens each of these behind its sanitizer.

import { beforeEach, describe, expect, it } from 'vitest';
import type { Request } from 'express';
import { DEFAULT_CAPS } from '../../../shared/comic/capabilities.js';
import { normalizeDoc, type ComicDoc, type PageLayer } from '../../../shared/comic/doc.js';
import { applyOps, type DocOp } from '../../../shared/comic/ops.js';
import { __resetAccessCacheForTests, studioCapsFor } from './access.js';
import { sanitizePatchOps } from './jobs.js';
import type { SanitizeCtx } from './extensions.js';
import { plannedDoc } from './orchestrator.fakes.js';

const req = (userId?: string) => ({ user: userId ? { id: userId } : undefined }) as unknown as Request;
const capsDeps = (admin: boolean, env: Record<string, string | undefined> = {}) => ({
  billingEnabled: true,
  planFor: async () => 'free',
  isAdminFor: async () => admin,
  accountCeilingFor: async () => 'PG-13' as const,
  env
});
const sctx = (): SanitizeCtx => ({ userId: 'user-1', caps: DEFAULT_CAPS, rating: 'PG-13', now: 1_800_000_000_000 });
const box = { x: 0.1, y: 0.1, w: 0.2, h: 0.2 };

beforeEach(() => __resetAccessCacheForTests());

describe('access.ts: the Pro Edit flags become caps', () => {
  it('unset env: motion, stickers and reader motion are off for everyone, admins included', async () => {
    for (const admin of [false, true]) {
      expect(await studioCapsFor(req(admin ? 'a1' : 'u1'), { byok: false }, capsDeps(admin))).toMatchObject({ proMotion: false, proStickers: false, readerMotion: false });
    }
  });

  it('motion and stickers are stages (a bare on = admins only); reader motion is off | all', async () => {
    const env = { COMIC_PRO_MOTION: 'on', COMIC_PRO_STICKERS: 'all', COMIC_READER_MOTION: 'admins' };
    expect(await studioCapsFor(req('u2'), { byok: false }, capsDeps(false, env))).toMatchObject({ proMotion: false, proStickers: true, readerMotion: false });
    expect(await studioCapsFor(req('a2'), { byok: false }, capsDeps(true, env))).toMatchObject({ proMotion: true, proStickers: true, readerMotion: false });
    expect(await studioCapsFor(req('u3'), { byok: false }, capsDeps(false, { COMIC_READER_MOTION: 'all' }))).toMatchObject({ readerMotion: true });
    // The W0 flags are untouched by the new ones.
    expect(await studioCapsFor(req('a3'), { byok: false }, capsDeps(true, env))).toMatchObject({ proEditorV2: true, liveAgent: { queue: true, steer: false, conflicts: true } });
  });

  it('a failed admin lookup fails closed: admins-only Pro Edit parts stay off', async () => {
    const caps = await studioCapsFor(req('u4'), { byok: false }, { ...capsDeps(false, { COMIC_PRO_MOTION: 'admins' }), isAdminFor: async () => { throw new Error('roles down'); } });
    expect(caps.proMotion).toBe(false);
  });
});

describe('no client can write a Pro op or a Pro field (PE-0)', () => {
  const fixture = (): ComicDoc => {
    const doc = normalizeDoc(JSON.parse(JSON.stringify(plannedDoc())));
    const page = doc.pages[0];
    page.layers = normalizeDoc({ ...doc, pages: [{ ...page, layers: [{ id: 'ly_future', kind: 'hologram', box } as unknown as PageLayer, { id: 'ly_shape', kind: 'shape', box, shape: { type: 'rect' } }] }] }).pages[0].layers;
    return doc;
  };
  const refuse = (doc: ComicDoc, ops: unknown[], message: RegExp) => expect(() => sanitizePatchOps(doc, ops, sctx())).toThrow(message);

  it('the motion ops are not client-patchable while PRO_EDIT_OPS_PATCHABLE is off', () => {
    const doc = fixture();
    const pageId = doc.pages[0].id;
    const lineId = doc.pages[0].panels[0].lines[0]?.id ?? 'l1';
    refuse(doc, [{ op: 'motion', pageId, id: 'mc_a', patch: { target: { k: 'line', id: lineId }, role: 'enter', preset: 'pop', at: { anchor: 'reveal', ms: 0 } } }], /can't be changed directly/);
    refuse(doc, [{ op: 'page_motion', pageId, patch: { hold: 500 } }], /can't be changed directly/);
  });

  it('effect layers, patches to an opaque layer and reader motion are refused; Pro keys never reach a stored overlay', () => {
    const doc = fixture();
    const pageId = doc.pages[0].id;
    expect(doc.pages[0].layers!.map((l) => l.id)).toEqual(['ly_future', 'ly_shape']);
    refuse(doc, [{ op: 'layer', pageId, id: 'ly_fx', patch: { kind: 'effect', box, fx: { gen: 'speed-lines', v: 1, seed: 1, params: {} } } }], /overlay kind/);
    refuse(doc, [{ op: 'layer', pageId, id: 'ly_future', patch: { box: { x: 0.3, y: 0.3, w: 0.2, h: 0.2 } } }], /Invalid overlay/);
    refuse(doc, [{ op: 'reader', patch: { motion: 'on' } }], /Unknown reader setting/);
    const lined = doc.pages.flatMap((p) => p.panels.flatMap((pn) => pn.lines.map((l) => ({ pageId: p.id, lineId: l.id }))))[0];
    expect(lined).toBeDefined();
    refuse(doc, [{ op: 'line_style', pageId: lined.pageId, lineIds: [lined.lineId], patch: { warp: 'arc', fillGradient: { from: '#000000', to: '#ffffff', angle: 0 } } }], /nothing valid/);
    // Pro keys on an ordinary overlay patch are dropped by the sanitizer (only known keys are rebuilt).
    const ops = sanitizePatchOps(doc, [{ op: 'layer', pageId, id: 'ly_shape', patch: { opacity: 0.5, blend: 'multiply', fx: { gen: 'x', v: 1, seed: 1, params: {} } } }], sctx()) as DocOp[];
    expect(ops).toEqual([{ op: 'layer', pageId, id: 'ly_shape', patch: { opacity: 0.5 } }]);
    const after = applyOps(doc, ops);
    expect(after.pages[0].layers!.find((l) => l.id === 'ly_shape')).toEqual({ id: 'ly_shape', kind: 'shape', box, shape: { type: 'rect' }, opacity: 0.5 });
    // A delete of the opaque layer passes the sanitizer but the op leaves it as written (never client-writable).
    const del = sanitizePatchOps(doc, [{ op: 'layer', pageId, id: 'ly_future', patch: null }], sctx()) as DocOp[];
    expect(applyOps(doc, del).pages[0].layers!.map((l) => l.id)).toEqual(['ly_future', 'ly_shape']);
  });
});
