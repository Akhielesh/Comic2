// @vitest-environment node
// K2b (pro plan §8 "Publication", §10 Wave 2): the public snapshot copies Ship 2 GEOMETRY only — artMode, the frame
// style, frames (box, crop, border, stacking; src through its opaque copy), the current cut boxes (no detector
// diagnostics) and printed overlays — plus rot/minH in BALLOON_KEYS; the content fingerprint includes them. A comic
// published before Ship 2 builds the very same snapshot (golden captured on the base commit) and keeps its fingerprint.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { artModeOf, type ComicDoc, type Page } from '../../../../shared/comic/doc.js';
import { buildSnapshot, contentFingerprint, fingerprintMatches, planSnapshot, snapshotPaths } from './snapshot.js';
import { FIXTURE_PROJECT, FIXTURE_USER, fxAsset, legacyPublishedDoc } from './__fixtures__/ship2Books.js';

const GOLDEN = JSON.parse(fs.readFileSync(path.resolve(__dirname, '__fixtures__/legacy-snapshot.golden.json'), 'utf8'));
const KEY = 'K'.repeat(22);
const lane = (kind: 'img' | 'ref', name: string) => `u/${FIXTURE_USER}/p/${FIXTURE_PROJECT}/${kind}/${name}.webp`;
const snap = (doc: ComicDoc) => {
  const plan = { ...planSnapshot(doc, { assetKey: KEY, pageIds: doc.pages.map((p) => p.id), includeCover: true, languages: ['en'] }), publicationId: 'pub-fx', publishedAt: 77, rev: 9 };
  return { plan, snapshot: buildSnapshot(doc, plan) };
};

/** The legacy comic with page 1 made editable as panels, every Ship 2 field filled, private text everywhere it can go. */
const panelized = (): ComicDoc => {
  const doc = legacyPublishedDoc();
  const p1 = doc.pages[0];
  doc.cast[0].refs = [
    { ...fxAsset('sticker'), path: lane('ref', 'sticker'), source: 'upload' },
    { ...fxAsset('face'), path: lane('ref', 'face'), source: 'upload' },
    { path: lane('ref', 'unchecked'), source: 'upload', at: 2 }
  ];
  const take1 = p1.render.history[0].path; // another take of this page, checked G
  const boxes = [
    { x: 0.02, y: 0.02, w: 0.96, h: 0.46 },
    { x: 0.02, y: 0.52, w: 0.46, h: 0.46 },
    { x: 0.52, y: 0.52, w: 0.46, h: 0.46 }
  ];
  const page: Page = {
    ...p1,
    artMode: 'panels',
    frameStyle: { gutter: 0.03, color: '#202020' },
    continuity: { notes: ['PRIVATE-CONTINUITY'], cast: { c_maya: { outfit: 'PRIVATE-OUTFIT' } }, by: 'writer' },
    panels: p1.panels.map((pn, j) => ({
      ...pn,
      frame: {
        box: boxes[j],
        ...(j === 0 ? { fit: { s: 1.5, x: 0.2, y: -0.1 }, border: { w: 0.006, color: '#111111' }, z: 2, locked: true as const } : {}),
        ...(j === 1 ? { src: { path: take1, box: { x: 0, y: 0.5, w: 0.5, h: 0.5 } } } : {}),
        ...(j === 2 ? { src: { path: lane('ref', 'unchecked') } } : {})
      },
      direction: { light: 'PRIVATE-DIRECTION', cast: { c_maya: { expression: 'PRIVATE-EXPRESSION' } }, by: 'writer' }
    })),
    layers: [
      { id: 'ly_sticker', kind: 'image', name: 'PRIVATE-LAYER-NAME', box: { x: 0.7, y: 0.05, w: 0.2, h: 0.2 }, rot: 12, z: 3, clip: 'pn_1_1', opacity: 0.8, flip: 'h', locked: true, src: { path: lane('ref', 'sticker'), crop: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 } } },
      { id: 'ly_photo', kind: 'image', name: 'PRIVATE-PHOTO', box: { x: 0.1, y: 0.1, w: 0.3, h: 0.3 }, src: { path: lane('ref', 'face') }, print: false },
      { id: 'ly_box', kind: 'shape', box: { x: 0.4, y: 0.4, w: 0.2, h: 0.1 }, shape: { type: 'rect', fill: '#ffffff', stroke: '#000000', strokeW: 0.002 } }
    ],
    balloons: p1.balloons.map((b, i) => ({ ...b, ...(i === 0 ? { rot: -10, minH: 0.12 } : {}) })),
    render: {
      ...p1.render,
      cuts: {
        status: 'unsure',
        by: 'both',
        at: 1234,
        note: 'PRIVATE-CUT-NOTE',
        cuts: p1.panels.map((pn, j) => ({ panelId: pn.id, drawn: j + 1, box: boxes[j], conf: 0.87, shows: j + 1, ...(j === 2 ? { crosses: true as const } : {}) }))
      },
      parts: { panels: { pn_1_1: { c: 'aaaaaa', a: 'bbbbbb', p: 'cccccc', s: 'dddddd', m: 'eeeeee' } } },
      anchorKeys: ['char:c_maya'],
      qc: { ...p1.render.qc!, checkV: 2, beats: [1, 2, 3], findings: [{ id: 'f_1', kind: 'identity', panel: 1, severity: 'minor', note: 'PRIVATE-FINDING' }] }
    }
  };
  doc.pages = [page, doc.pages[1]];
  doc.scenes = [{ id: 'sc_1', name: 'PRIVATE-SCENE' }];
  doc.consistency = { skip: ['PRIVATE-SKIP'] };
  return doc;
};

describe('a comic published before Ship 2 (old snapshot fixture)', () => {
  it('builds a snapshot deep-equal to the one the base code built, from the same plan', () => {
    const { plan, snapshot } = snap(legacyPublishedDoc());
    expect(plan).toEqual(GOLDEN.plan);
    expect(snapshot).toEqual(GOLDEN.snapshot);
    expect(JSON.stringify(snapshot)).toBe(JSON.stringify(GOLDEN.snapshot)); // key order too: readers and the store see the same bytes
  });

  it('keeps its content fingerprint (no false “changes since publishing”), also with a guide-only overlay added', () => {
    const doc = legacyPublishedDoc();
    expect(contentFingerprint(doc, ['en'])).toBe(GOLDEN.fingerprint);
    expect(fingerprintMatches(doc, ['en'], GOLDEN.fingerprint)).toBe(true);
    const guide = legacyPublishedDoc();
    guide.pages[0] = { ...guide.pages[0], layers: [{ id: 'ly_g', kind: 'shape', box: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, shape: { type: 'rect' }, print: false }] };
    expect(contentFingerprint(guide, ['en'])).toBe(GOLDEN.fingerprint);
  });
});

describe('a panelized page in the public snapshot: geometry only', () => {
  it('copies artMode, the full frame style, frame geometry, cut boxes and printed overlays; balloons keep rot/minH', () => {
    const doc = panelized();
    const { plan, snapshot } = snap(doc);
    const page = snapshot.pages[0];
    expect(page.artMode).toBe('panels');
    expect(page.frameStyle).toEqual({ gutter: 0.03, margin: 0.02, border: 0.004, color: '#202020', bg: '#ffffff', radius: 0 });
    const take1 = doc.pages[0].render.history[0].path;
    expect(page.panels.map((p) => p.frame)).toEqual([
      { box: { x: 0.02, y: 0.02, w: 0.96, h: 0.46 }, fit: { s: 1.5, x: 0.2, y: -0.1 }, border: { w: 0.006, color: '#111111' }, z: 2 },
      { box: { x: 0.02, y: 0.52, w: 0.46, h: 0.46 }, src: { path: plan.paths[take1], box: { x: 0, y: 0.5, w: 0.5, h: 0.5 } } },
      // An unchecked upload can't go public: the frame shows its cut of the page instead.
      { box: { x: 0.52, y: 0.52, w: 0.46, h: 0.46 } }
    ]);
    expect(page.render.cuts).toEqual({
      status: 'ok',
      by: 'user',
      at: 0,
      cuts: doc.pages[0].panels.map((pn, j) => ({ panelId: pn.id, drawn: j + 1, box: doc.pages[0].render.cuts!.cuts[j].box, conf: 1 }))
    });
    expect(page.layers).toEqual([
      { id: 'ly_sticker', kind: 'image', box: { x: 0.7, y: 0.05, w: 0.2, h: 0.2 }, src: { path: plan.paths[lane('ref', 'sticker')], crop: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 } }, rot: 12, z: 3, clip: 'pn_1_1', opacity: 0.8, flip: 'h' },
      { id: 'ly_box', kind: 'shape', box: { x: 0.4, y: 0.4, w: 0.2, h: 0.1 }, shape: { type: 'rect', fill: '#ffffff', stroke: '#000000', strokeW: 0.002 } }
    ]);
    expect(page.balloons[0]).toMatchObject({ rot: -10, minH: 0.12 });
    // Readers show the page in frames from the snapshot alone (I2 holds on the public copy).
    expect(artModeOf(page)).toBe('panels');
    // The page shown as drawn is unchanged.
    expect(snapshot.pages[1]).toEqual(GOLDEN.snapshot.pages[1]);
  });

  it('has no private or diagnostic field: no directions, continuity, scenes, findings, beats, parts, anchor keys, names, locks, confidences or notes', () => {
    const { snapshot } = snap(panelized());
    const json = JSON.stringify(snapshot);
    for (const secret of ['PRIVATE-CONTINUITY', 'PRIVATE-OUTFIT', 'PRIVATE-DIRECTION', 'PRIVATE-EXPRESSION', 'PRIVATE-LAYER-NAME', 'PRIVATE-PHOTO', 'PRIVATE-CUT-NOTE', 'PRIVATE-FINDING', 'PRIVATE-SCENE', 'PRIVATE-SKIP', 'PRIVATE-SUMMARY', 'PRIVATE-ACTION']) {
      expect(json).not.toContain(secret);
    }
    // As keys (the style's status word "locked" is not the lock key).
    for (const key of ['direction', 'continuity', 'scenes', 'consistency', 'findings', 'beats', 'parts', 'anchorKeys', 'locked', 'shows', 'crosses', 'note', 'checkV', 'print']) {
      expect(json).not.toContain(`"${key}":`);
    }
    // Overlays and panels carry no names (cast names are public; a layer's name is not).
    for (const l of snapshot.pages[0].layers!) expect(Object.keys(l)).not.toContain('name');
    expect(json).not.toContain('0.87');
    expect(json).not.toMatch(/u\/user-fx|\/ref\/|proj-fx/);
    const page = snapshot.pages[0];
    expect(Object.keys(page).sort()).toEqual(['artMode', 'balloons', 'frameStyle', 'id', 'layers', 'layout', 'n', 'panels', 'render', 'summary']);
    expect(Object.keys(page.render).sort()).toEqual(['asset', 'cuts', 'history', 'qc', 'status']);
    for (const pn of page.panels) expect(Object.keys(pn).sort()).toEqual(['action', 'castIds', 'frame', 'id', 'lines', 'n', 'shot', 'size']);
  });

  it('copies only the frame and overlay pictures that may go public; the reader’s url map lists them', () => {
    const doc = panelized();
    const { plan, snapshot } = snap(doc);
    const take1 = doc.pages[0].render.history[0].path;
    expect(plan.paths[take1]).toMatch(/^pub\/K{22}\/page-[0-9a-f]{12}\.webp$/);
    expect(plan.paths[lane('ref', 'sticker')]).toMatch(/^pub\/K{22}\/page-[0-9a-f]{12}\.webp$/);
    expect(plan.paths[lane('ref', 'face')]).toBeUndefined(); // guide only: never published
    expect(plan.paths[lane('ref', 'unchecked')]).toBeUndefined(); // no verdict: never published
    // A blocked take or a client-writable classic photo is never copied either.
    const risky = panelized();
    risky.pages[0].render.history[0] = { ...risky.pages[0].render.history[0], safety: { assessed: 'X', at: 3, categories: ['graphic_gore'] } };
    risky.cast[0].refs.push({ path: `${FIXTURE_USER}/classic.webp`, source: 'upload', at: 2, safety: { assessed: 'G', at: 1 } });
    risky.pages[0].layers = [...risky.pages[0].layers!, { id: 'ly_classic', kind: 'image', box: { x: 0.1, y: 0.1, w: 0.1, h: 0.1 }, src: { path: `${FIXTURE_USER}/classic.webp` } }];
    const r = snap(risky);
    expect(r.plan.paths[take1]).toBeUndefined();
    expect(r.plan.paths[`${FIXTURE_USER}/classic.webp`]).toBeUndefined();
    expect(r.snapshot.pages[0].panels[1].frame).toEqual({ box: { x: 0.02, y: 0.52, w: 0.46, h: 0.46 } });
    expect(r.snapshot.pages[0].layers!.map((l) => l.id)).toEqual(['ly_sticker', 'ly_box']);
    // An over-rated picture is left out at the publication's rating.
    const pg = panelized();
    pg.cast[0].refs[0] = { ...pg.cast[0].refs[0], safety: { assessed: 'PG-13', at: 1 } };
    expect(planSnapshot(pg, { assetKey: KEY, pageIds: ['pg_1'], includeCover: false, languages: ['en'], rating: 'G' }).paths[lane('ref', 'sticker')]).toBeUndefined();
    expect(planSnapshot(pg, { assetKey: KEY, pageIds: ['pg_1'], includeCover: false, languages: ['en'], rating: 'PG-13' }).paths[lane('ref', 'sticker')]).toBeDefined();
    // Every published picture is in the url map, and only pub/ paths.
    const paths = snapshotPaths(snapshot);
    expect(paths).toEqual(expect.arrayContaining([plan.paths[take1], plan.paths[lane('ref', 'sticker')]]));
    for (const p of paths) expect(p).toMatch(/^pub\/K{22}\//);
  });

  it('shadow-mode cuts on a page shown as drawn are never published', () => {
    const doc = legacyPublishedDoc();
    doc.pages[0] = { ...doc.pages[0], render: { ...doc.pages[0].render, cuts: { status: 'ok', by: 'detect', at: 1, cuts: [{ drawn: 1, box: { x: 0, y: 0, w: 1, h: 0.5 }, conf: 0.9 }] } } };
    expect(snap(doc).snapshot).toEqual(GOLDEN.snapshot);
  });
});

describe('the content fingerprint sees the published layout', () => {
  it('changes when a frame moves, the frame style or display changes, a printed overlay moves, or a balloon rotates', () => {
    const base = panelized();
    const fp = contentFingerprint(base, ['en']);
    const moved = panelized();
    moved.pages[0].panels[0] = { ...moved.pages[0].panels[0], frame: { ...moved.pages[0].panels[0].frame!, box: { x: 0.02, y: 0.02, w: 0.9, h: 0.46 } } };
    expect(contentFingerprint(moved, ['en'])).not.toBe(fp);
    const styled = panelized();
    styled.pages[0].frameStyle = { gutter: 0.05 };
    expect(contentFingerprint(styled, ['en'])).not.toBe(fp);
    const asDrawn = panelized();
    delete asDrawn.pages[0].artMode;
    expect(contentFingerprint(asDrawn, ['en'])).not.toBe(fp);
    const sticker = panelized();
    sticker.pages[0].layers![0] = { ...sticker.pages[0].layers![0], box: { x: 0.6, y: 0.05, w: 0.2, h: 0.2 } };
    expect(contentFingerprint(sticker, ['en'])).not.toBe(fp);
    const rotated = panelized();
    rotated.pages[0].balloons[0] = { ...rotated.pages[0].balloons[0], rot: 20 };
    expect(contentFingerprint(rotated, ['en'])).not.toBe(fp);
  });

  it('does not change for edits readers never see: a guide-only overlay, directions, continuity, cut confidences', () => {
    const fp = contentFingerprint(panelized(), ['en']);
    const guide = panelized();
    guide.pages[0].layers![1] = { ...guide.pages[0].layers![1], box: { x: 0.2, y: 0.2, w: 0.3, h: 0.3 } };
    guide.pages[0].panels[0] = { ...guide.pages[0].panels[0], direction: { light: 'other' } };
    guide.pages[0].continuity = { notes: ['other'] };
    guide.pages[0].render = { ...guide.pages[0].render, cuts: { ...guide.pages[0].render.cuts!, cuts: guide.pages[0].render.cuts!.cuts.map((c) => ({ ...c, conf: 0.5 })) } };
    expect(contentFingerprint(guide, ['en'])).toBe(fp);
  });
});
