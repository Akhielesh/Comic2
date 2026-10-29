// Probe: lettering-editor (pure ops). P1 (LE-1, Move to panel N) moved to components/comicstudio/lettering/styleOps.test.ts and removed here. A FAILING assertion here = a confirmed defect; passing ones are
// context checks that pin the realistic path down. Nothing here touches the network or the server.
import { describe, expect, it, vi } from 'vitest';
// The worktree's symlinked node_modules makes Vite deny the @fontsource `?url` asset imports; the loader
// is a no-op in jsdom anyway (no document.fonts), so the file table is stubbed.
vi.mock('../../components/comicstudio/lettering/fontFiles', () => ({ FONT_FILES: {} }));
import { SAMPLE_NOW, makeSampleDoc } from '../../components/comicstudio/board/__fixtures__/sampleDoc';
import { applyOps } from '../../shared/comic/ops';
import { editionReadiness, lineSourceHash, translationStatus } from '../../shared/comic/i18n';
import { estimateMeasure, planLettering } from '../../shared/comic/lettering/layout';
import { resolvePlacements } from '../../components/comicstudio/lettering/useLetterPlans';
import { easyShapeOps, findLineRef, linkOps, lockOps, tidyOps, zOrderOps } from '../../components/comicstudio/lettering/styleOps';
import { editionOps, editionViewDoc } from '../../components/comicstudio/mobile/editor/editorModel';
import type { ComicDoc } from '../../shared/comic/doc';

const ASPECT = 2 / 3;

/** The sample doc with a reviewed Telugu translation of pg_1_l2 (a whisper, spoken by Maya). */
const withTelugu = (mutate?: (d: ComicDoc) => void) =>
  makeSampleDoc((d) => {
    const line = d.pages[0].panels.flatMap((p) => p.lines).find((l) => l.id === 'pg_1_l2')!;
    d.i18n = {
      glossary: [],
      editions: {
        te: {
          lang: 'te',
          register: 'everyday',
          lines: { pg_1_l2: { text: 'పదండి!', status: 'reviewed', sourceHash: lineSourceHash(line), at: SAMPLE_NOW } },
          balloons: { pg_1_l2: { x: 0.1, y: 0.5, w: 0.22, pinned: true } }
        }
      }
    };
    mutate?.(d);
  });

describe('P2 — Easy "Balloon type" and translations', () => {
  it('whisper → speech (same text, same speaker) does not invalidate a reviewed translation or block publishing', () => {
    const doc = withTelugu();
    const page = doc.pages[0];
    const ops = easyShapeOps(doc, page, ['pg_1_l2'], 'speech');
    const after = applyOps(doc, ops);
    const line = findLineRef(after.pages[0], 'pg_1_l2')!.line;
    expect(line.kind).toBe('speech');
    expect(line.text).toBe('Just one more…');
    expect(line.speakerId).toBe('ch_maya');
    expect(translationStatus(after, 'te', line)).toBe('reviewed');
    expect(editionReadiness(after, 'te').issues.filter((i) => i.code === 'stale')).toEqual([]);
  });
});

describe('P3 — editing a translated edition: stacking / lock / link on balloons', () => {
  const setup = (mutate?: (d: ComicDoc) => void) => {
    const doc = withTelugu(mutate);
    const vDoc = editionViewDoc(doc, 'te');
    const page = vDoc.pages[0];
    const plans = planLettering(vDoc, page, ASPECT, estimateMeasure);
    const placements = resolvePlacements(vDoc, page, ASPECT, estimateMeasure);
    return { doc, vDoc, page, plans, placements };
  };

  it('"Bring to front" on a software-placed balloon never freezes its geometry into the edition as a side effect', () => {
    const { doc, page, plans, placements } = setup();
    expect(page.balloons.some((b) => b.lineId === 'pg_1_l4')).toBe(false); // software-placed in both languages
    const r = editionOps(zOrderOps(page, ['pg_1_l4'], 'front', plans, placements.balloons), 'te', doc);
    // The z change is dropped (a notice says "belongs to the original")…
    expect(r.dropped).toBe(1);
    // …so nothing else may land either. It does: x/y/w(+tail) are written as an edition override.
    expect(r.ops.filter((o) => o.op === 'edition_balloon')).toEqual([]);
  });

  it('"Lock" on a software-placed balloon in an edition either locks or does nothing — not half of it', () => {
    const { doc, page, placements } = setup();
    const r = editionOps(lockOps(page, ['pg_1_l4'], true, placements.balloons), 'te', doc);
    const landed = r.ops.filter((o) => o.op === 'edition_balloon');
    // Half applied: pinned geometry lands in the edition, `locked` is dropped with a notice.
    expect(r.dropped === 0 || landed.length === 0).toBe(true);
  });

  it('"Unlink" in an edition removes the connector (or says it cannot) and does not freeze every balloon on the page', () => {
    const { doc, page, placements } = setup((d) => {
      d.pages[0].balloons.push({ lineId: 'pg_1_l4', x: 0.5, y: 0.6, w: 0.2, linkTo: 'pg_1_l3' });
    });
    const ops = linkOps(page, 'pg_1_l4', false, placements.balloons);
    expect(ops).toHaveLength(1);
    expect(ops[0].op).toBe('balloons');
    const r = editionOps(ops, 'te', doc);
    const removesLink = r.ops.some((o) => o.op === 'balloons' || (o.op === 'balloon' && !!o.patch && 'linkTo' in o.patch));
    // Nothing removes the link and the user is not told (dropped stays 0)…
    expect(removesLink || r.dropped > 0).toBe(true);
    // …while every stored balloon on the page is written into the edition as a geometry override.
    expect(r.ops.filter((o) => o.op === 'edition_balloon')).toEqual([]);
  });
});

describe('P4 — Tidy', () => {
  it('returns nothing to do when every balloon is pinned (the stored order alone differs)', () => {
    const doc = makeSampleDoc((d) => {
      const page = d.pages[0];
      page.balloons = [...page.balloons.map((b) => ({ ...b, pinned: true })), { lineId: 'pg_1_l4', x: 0.3, y: 0.55, w: 0.25, tailX: 0.4, tailY: 0.7, pinned: true }].reverse();
    });
    const page = doc.pages[0];
    const ops = tidyOps(doc, page, ASPECT, estimateMeasure);
    const after = applyOps(doc, ops);
    const byId = (p: typeof page) => new Map(p.balloons.map((b) => [b.lineId, b]));
    // No balloon moves…
    for (const [id, b] of byId(page)) expect(byId(after.pages[0]).get(id)).toMatchObject({ x: b.x, y: b.y, w: b.w });
    // …so the toolbar's Tidy must be disabled (it is enabled on `tidy.length`), and no undo entry must be made.
    expect(ops).toEqual([]);
  });

  it('keeps the stored balloon of a line whose text is temporarily empty', () => {
    const doc = makeSampleDoc((d) => {
      d.pages[0].panels[0].lines[0].text = '';
      d.pages[0].balloons = d.pages[0].balloons.map((b) => ({ ...b, pinned: true }));
    });
    const ops = tidyOps(doc, doc.pages[0], ASPECT, estimateMeasure);
    const after = applyOps(doc, ops);
    expect(after.pages[0].balloons.some((b) => b.lineId === 'pg_1_l1')).toBe(true);
  });
});
