// @vitest-environment node
// Golden page prompts (plan §10 A2): the Ship 1 page prompt for pages shaped like the owner's measured
// pages (b4b5774f p2/p4, f8312c86 p1; synthetic). The *.prompt.txt files are the byte-for-byte golden
// that B5 must reproduce for a doc without Ship 2 data (I8); update them deliberately (`vitest -u`)
// and read the diff like a code change.
import { describe, it, expect } from 'vitest';
import { castKindOf, isPageStale, pageSpecHash, type ComicDoc, type Page } from '../../../../../shared/comic/doc.js';
import { getImageModel, resolveImageJob } from '../../../../../shared/comic/models.js';
import { LAYOUT_REFERENCE_PATH, compilePage, identityAnchor, planPageReferences, upperName } from '../../prompts.js';
import { pageFixture, pageFixtures, type PageFixture } from './fixtures.js';

const compile = (f: PageFixture, extra: { layoutGuide?: boolean; safe?: boolean } = {}) =>
  compilePage(f.doc, f.page, { ...(f.previousPage ? { previousPage: f.previousPage } : {}), ...extra });

/** The PANELS section split into one block per panel ("PANEL n of N — …" up to the next one). */
const panelBlocks = (prompt: string): string[] => {
  const start = prompt.indexOf('\n\nPANELS:\n');
  const end = prompt.indexOf('\n\n', start + 2);
  return prompt
    .slice(start + '\n\nPANELS:\n'.length, end)
    .split(/\n(?=PANEL \d+ of \d+ — )/)
    .filter(Boolean);
};

const lineOf = (block: string, label: string): string | undefined => block.split('\n').find((l) => l.startsWith(label));

/** The panel's POV viewer when the action names one ("From Dev's view…"). */
const viewerName = (doc: ComicDoc, page: Page, i: number): string | undefined => {
  const p = page.panels[i];
  if (p.shot !== 'pov') return undefined;
  return doc.cast.find((c) => new RegExp(`\\bfrom ${c.name}['’]s view\\b`, 'i').test(p.action))?.name;
};

describe('golden page prompts (Ship 1)', () => {
  const fixtures = pageFixtures();

  it('covers the three measured shapes', () => {
    expect(fixtures.map((f) => f.key)).toEqual(['courier-p2', 'courier-p4', 'pond-p1']);
  });

  for (const key of ['courier-p2', 'courier-p4', 'pond-p1']) {
    it(`${key}: no blank-bar wording; "Never draw blank boxes"; matches its golden`, async () => {
      const f = pageFixture(key);
      const job = compile(f);
      expect(job.prompt).not.toContain('Leave natural empty space');
      expect(job.prompt).not.toMatch(/empty space near the top/i);
      expect(job.prompt).toContain('Never draw blank boxes');
      // Plan §4.2's replacement for the blank-bar wording, verbatim.
      expect(job.prompt).toContain(
        "Balloons are added later by software. Where a panel lists 'Speaks', compose open background (sky, wall, floor, shadow) beside the speaker's head. Never draw blank boxes, empty bars or white strips."
      );
      await expect(job.prompt).toMatchFileSnapshot(`./${key}.prompt.txt`);
    });

    it(`${key}: every panel block has box N, Must show, Who with an identity anchor, and Speaks or OFF-PANEL VOICE`, () => {
      const f = pageFixture(key);
      const blocks = panelBlocks(compile(f).prompt);
      expect(blocks).toHaveLength(f.page.panels.length);
      blocks.forEach((block, i) => {
        const n = f.page.panels[i].n;
        expect(block.startsWith(`PANEL ${n} of ${f.page.panels.length} — box ${i + 1} in the layout (`), block).toBe(true);
        expect(block).toMatch(/\(rows? \d+(–\d+)?, (left|right|center|full width); \d+% wide × \d+% tall\)\./);
        expect(lineOf(block, 'Camera: '), block).toBeTruthy();
        expect(lineOf(block, 'Must show: '), block).toBeTruthy();
        const who = lineOf(block, 'Who: ');
        expect(who, block).toBeTruthy();
        const viewer = viewerName(f.doc, f.page, i);
        const drawn = f.page.panels[i].castIds
          .map((id) => f.doc.cast.find((c) => c.id === id)!)
          .filter((c) => c.name !== viewer);
        for (const c of drawn) {
          const anchor = identityAnchor(c, { colors: f.doc.format.colorMode !== 'bw' });
          expect(anchor.length, c.name).toBeGreaterThan(0);
          // "NAME (Image k — anchor)" or "NAME (anchor)".
          expect(who).toMatch(new RegExp(`${upperName(c.name)} \\((?:Images? [\\d, and]+ — )?${anchor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)`));
        }
        if (!drawn.length && !viewer) expect(who).toBe('Who: no characters.');
        expect(block, block).toMatch(/^(Speaks: |OFF-PANEL VOICE: )/m);
      });
    });
  }

  it('courier-p2: the POV viewer is heard, not drawn; the visible speaker gets open background beside her head', () => {
    const blocks = panelBlocks(compile(pageFixture('courier-p2')).prompt);
    const pov = blocks[5];
    expect(pov).toContain("seen through DEV's eyes (do not draw DEV; at most a hand at the frame edge)");
    expect(pov).toContain('Speaks: ISHA — 1 balloon; compose open background (sky, wall, floor or shadow) beside her head for it. OFF-PANEL VOICE: DEV (do not draw) — 1 balloon.');
    // A silent wide panel fills its frame (no bar for balloons that never come).
    expect(blocks[2]).toContain('Speaks: nobody (a silent panel); fill the panel with art to its borders.');
  });

  it('pond-p1 (f8312c86-shaped): the extra protagonist’s sheet is attached, within the character slots of every model', () => {
    const f = pageFixture('pond-p1');
    const job = compile(f);
    const spec = resolveImageJob('page', f.doc.settings.quality, f.doc.settings.imageModelOverride).spec;
    const chars = planPageReferences(f.doc, f.page, spec, f.previousPage).filter((r) => r.slot === 'character');
    expect(chars[0]).toMatchObject({ kind: 'character', label: 'CHARACTER SHEET: MINA', path: 'u/golden/pond/sheets/mina.webp', characterId: 'c_mina' });
    expect(chars.length).toBeLessThanOrEqual(spec.refs.characters);
    expect(job.references.map((r) => r.label)).toEqual([
      'CHARACTER SHEET: MINA',
      'PHOTO OF MINA (likeness)',
      'CHARACTER SHEET: PUDDLE',
      'STYLE BOARD'
    ]);
    expect(job.prompt).toContain('- MINA (Images 1 and 2): ');
    expect(job.prompt).not.toContain('MINA (no reference');
    // Tight caps: presence ranks Mina (4 panels) first, so she keeps a sheet even with 2 character slots.
    for (const id of ['nano-banana-2.1', 'nano-banana-pro', 'nano-banana-legacy', 'flux-3']) {
      const model = getImageModel(id)!;
      const refs = planPageReferences(f.doc, f.page, model).filter((r) => r.slot === 'character');
      expect(refs[0]?.label, id).toBe('CHARACTER SHEET: MINA');
      expect(refs.length, id).toBeLessThanOrEqual(model.refs.characters);
    }
  });

  it('courier-p2 with the layout guide: Image 1 is PAGE LAYOUT GUIDE and the counts stay within the slots', async () => {
    const f = pageFixture('courier-p2');
    const job = compile(f, { layoutGuide: true });
    expect(job.references[0]).toEqual({ label: 'PAGE LAYOUT GUIDE', path: LAYOUT_REFERENCE_PATH });
    const spec = resolveImageJob('page', f.doc.settings.quality).spec;
    expect(job.references.length).toBeLessThanOrEqual(spec.refs.total);
    expect(panelBlocks(job.prompt).every((b) => / — box \d+ in the layout guide \(/.test(b))).toBe(true);
    await expect(job.prompt).toMatchFileSnapshot('./courier-p2.guide.prompt.txt');
  });

  it('pageSpecHash is unchanged on every fixture: Ship 1 never makes a page drawn before it stale', () => {
    for (const f of pageFixtures()) {
      const before = structuredClone(f.doc);
      const hash = pageSpecHash(f.doc, f.page);
      // The pre-Ship-1 value, in today's serialisation or F1's canonical one (K1), never a third.
      expect(f.pins, f.key).toContain(hash);
      expect(f.page.render.specHash, f.key).toBe(f.pins[0]);
      if (hash === f.pins[0]) expect(isPageStale(f.doc, f.page), f.key).toBe(false);
      // Compiling with every Ship 1 option reads the doc and never writes it.
      for (const opts of [{}, { layoutGuide: true }, { safe: true }]) compile(f, opts);
      expect(f.doc, f.key).toEqual(before);
      expect(pageSpecHash(f.doc, f.page), f.key).toBe(hash);
    }
  });

  it('fixtures stay synthetic and drawable (every being has a look; animals are typed)', () => {
    for (const f of pageFixtures()) {
      for (const c of f.doc.cast) {
        expect(c.look.summary.length, c.name).toBeGreaterThan(10);
        if (['Puddle', 'Hopper', 'Bramble'].includes(c.name)) expect(castKindOf(c)).toBe('animal');
        for (const r of c.refs) expect(r.path.startsWith('u/golden/'), r.path).toBe(true);
        if (c.sheet.asset) expect(c.sheet.asset.path.startsWith('u/golden/')).toBe(true);
      }
    }
  });
});
