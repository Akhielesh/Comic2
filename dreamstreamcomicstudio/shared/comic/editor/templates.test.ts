import { describe, expect, it } from 'vitest';
import { estimatePanelBoxes, layoutPanelCount, parseLayout } from '../pageGeometry.js';
import { apply, baseDoc, drawnPage, line, pageOf, panel, undrawnPage, withPages } from './__fixtures__/editorDoc.js';
import { framesFromLayoutText, layoutTextFits, layoutTextOf } from './layoutText.js';
import type { EditOk } from './scene.js';
import { applyTemplateEdit, bestTemplate, DEFAULT_TEMPLATE_ID, PAGE_TEMPLATES, templateLayout, templatesFor, templatesForKind } from './templates.js';

/**
 * Panel areas of the $0 probe (pro/_design/areas.ts over the real estimatePanelBoxes; margin and gutter 0.02) and the
 * design's template table (design-pro-editor-confidence §4.4). The inset is the design's 0.08.
 */
const PROBE: Record<string, number[]> = {
  splash: [0.922],
  'two-tiers': [0.451, 0.451],
  'hero-inset': [0.922, 0.08],
  'big-top-two': [0.451, 0.221, 0.221],
  'two-big-bottom': [0.221, 0.221, 0.451],
  'tall-left-two': [0.406, 0.243, 0.243],
  'tall-right-two': [0.243, 0.406, 0.243],
  'three-tiers': [0.294, 0.294, 0.294],
  'four-grid': [0.221, 0.221, 0.221, 0.221],
  'wide-tall-left-two': [0.301, 0.265, 0.157, 0.157],
  'wide-two-wide': [0.294, 0.144, 0.144, 0.294],
  'fast-five': [0.294, 0.144, 0.144, 0.144, 0.144]
};
const area = (b: { w: number; h: number }) => b.w * b.h;
const INSET_CLAUSE = / with a small inset panel in its lower right corner \(panel 2\)/;

describe('templates', () => {
  it('twelve curated templates (plus three webtoon stacks), the default first among the three-panel ones', () => {
    expect(templatesForKind('comic').map((t) => t.id)).toEqual(Object.keys(PROBE));
    expect(templatesForKind('webtoon').map((t) => t.id)).toEqual(['stack-2', 'stack-3', 'stack-4']);
    expect(DEFAULT_TEMPLATE_ID).toBe('big-top-two');
  });

  it('round-trip through parseLayout; areas within 0.01 of the probe, in both reading directions', () => {
    for (const t of PAGE_TEMPLATES) {
      const kind = t.webtoon ? 'webtoon' : 'comic';
      for (const rtl of [false, true]) {
        const { frames, sentence } = templateLayout(t, { rtl });
        // The sentence parses to the template's panel count (so the prompt keeps it as the page's layout).
        expect(layoutPanelCount(parseLayout(sentence)), `${t.id} ${rtl}`).toBe(t.panels);
        if (t.webtoon) expect(parseLayout(sentence)!.mode).toBe('stack');
        // Frames → sentence → frames.
        expect(layoutTextOf(frames, { rtl, kind })).toBe(sentence);
        expect(framesFromLayoutText(sentence, t.panels, { rtl })).toEqual(frames);
        // Against the design's probe table.
        if (PROBE[t.id]) frames.forEach((b, i) => expect(Math.abs(area(b) - PROBE[t.id][i]), `${t.id} panel ${i + 1}`).toBeLessThanOrEqual(0.01));
        // Against the real blueprint geometry (estimatePanelBoxes), box by box; the inset has no blueprint geometry.
        const live = estimatePanelBoxes(
          { layout: t.id === 'hero-inset' ? sentence.replace(INSET_CLAUSE, '') : sentence, panels: t.sizes.slice(0, t.id === 'hero-inset' ? 1 : t.panels).map((size) => ({ size })) as never },
          { kind, readingDirection: rtl ? 'rtl' : 'ltr' }
        );
        live.forEach((b, i) => {
          expect(Math.abs(area(b) - area(frames[i])), `${t.id} live ${i + 1}`).toBeLessThanOrEqual(0.01);
          expect(Math.abs(b.x - frames[i].x) + Math.abs(b.y - frames[i].y)).toBeLessThanOrEqual(0.01);
        });
      }
    }
  });

  it('the inset sits inside its hero, above it, and the sentence still counts it', () => {
    const t = PAGE_TEMPLATES.find((x) => x.id === 'hero-inset')!;
    const { frames, z } = templateLayout(t);
    const [hero, inset] = frames;
    expect(inset.x).toBeGreaterThan(hero.x);
    expect(inset.x + inset.w).toBeLessThan(hero.x + hero.w);
    expect(inset.y + inset.h).toBeLessThan(hero.y + hero.h);
    expect(z).toEqual([undefined, 1]);
    expect(layoutTextFits(t.sentence, 2)).toBe(true);
  });

  it('frames follow the page gutter and margin', () => {
    const t = PAGE_TEMPLATES.find((x) => x.id === 'four-grid')!;
    const { frames } = templateLayout(t, { gutter: 0.05, margin: 0.04 });
    expect(frames[0].x).toBeCloseTo(0.04, 4);
    expect(frames[1].x - (frames[0].x + frames[0].w)).toBeCloseTo(0.05, 4);
  });

  it('any frame arrangement gets a sentence that counts its panels', () => {
    const frames = [
      { x: 0.02, y: 0.02, w: 0.96, h: 0.2 },
      { x: 0.02, y: 0.24, w: 0.3, h: 0.74 },
      { x: 0.34, y: 0.24, w: 0.64, h: 0.36 },
      { x: 0.34, y: 0.62, w: 0.64, h: 0.36 }
    ];
    const text = layoutTextOf(frames);
    expect(text).toBe('Row 1: one short panel across the full width (panel 1). Rows 2–3: one tall panel on the left (panel 2) beside two stacked panels on the right (panels 3–4).');
    expect(layoutTextFits(text, 4)).toBe(true);
  });
});

describe('fit dots and best fit', () => {
  const words = 'We have to get across the river before the storm comes down the valley and floods the old bridge again';
  const page = (wordy: number) =>
    undrawnPage('pg_u', 1, [1, 2, 3].map((n) => panel(`u${n}`, n, n === wordy ? [line(`l${n}a`, words), line(`l${n}b`, words)] : [line(`l${n}`, 'Yes.')])));

  it('best fit gives the wordy panel the big frame', () => {
    const doc = withPages(baseDoc(), [page(1)]);
    expect(bestTemplate(doc, pageOf(doc, 'pg_u'))?.id).toBe('big-top-two');
    const doc3 = withPages(baseDoc(), [page(3)]);
    expect(bestTemplate(doc3, pageOf(doc3, 'pg_u'))?.id).toBe('two-big-bottom');
    const choices = templatesFor(doc3, pageOf(doc3, 'pg_u'));
    expect(choices.map((c) => c.template.panels).every((n) => n === 3)).toBe(true);
    expect(choices.filter((c) => c.best)).toHaveLength(1);
    const bigTop = choices.find((c) => c.template.id === 'big-top-two')!;
    expect(bigTop.fit.panels[2].fit).toBeGreaterThan(bigTop.fit.panels[0].fit);
  });
});

describe('applying a template', () => {
  it('on a page not drawn yet: frames, the layout sentence and panel sizes; undo restores', () => {
    const p = undrawnPage('pg_u', 1, [panel('u1', 1), panel('u2', 2), panel('u3', 3)], 'Row 1: three small panels side by side.');
    const doc = withPages(baseDoc(), [p]);
    const r = applyTemplateEdit(doc, p, 'tall-left-two') as EditOk;
    expect(r.ok).toBe(true);
    expect(r.label).toBe('Use the “Tall left + two” layout');
    const after = apply(doc, r.ops);
    const pa = pageOf(after, 'pg_u');
    expect(pa.layout).toBe('Rows 1–2: one tall panel on the left (panel 1) beside two stacked panels on the right (panels 2–3).');
    expect(pa.panels.map((x) => x.size)).toEqual(['tall', 'medium', 'medium']);
    expect(pa.panels.map((x) => x.frame!.box)).toEqual(templateLayout(PAGE_TEMPLATES.find((t) => t.id === 'tall-left-two')!).frames);
    const strip = (v: unknown): unknown => JSON.parse(JSON.stringify(v, (_k, x) => (x === null ? undefined : x)));
    expect(strip(apply(after, r.undo))).toEqual(strip(doc));
  });

  it('on a drawn page: frames only (the layout text stays, so the page stays up to date)', () => {
    const p = drawnPage('pg_a', 1, 'big-top-two', [panel('p1', 1), panel('p2', 2), panel('p3', 3)]);
    const doc = withPages(baseDoc(), [p]);
    const r = applyTemplateEdit(doc, p, 'two-big-bottom') as EditOk;
    expect(r.ops.map((o) => o.op)).toEqual(['page_frames']);
    expect(r.notes).toContain('The drawing is kept: only where the panels sit changes.');
    expect(pageOf(apply(doc, r.ops), 'pg_a').layout).toBe(p.layout);
  });

  it('refuses another panel count, a locked panel, and a drawn page that is not editable yet', () => {
    const p = drawnPage('pg_a', 1, 'big-top-two', [panel('p1', 1), panel('p2', 2), panel('p3', 3)]);
    const doc = withPages(baseDoc(), [p]);
    expect(applyTemplateEdit(doc, p, 'four-grid')).toEqual({ ok: false, reason: 'This layout has 4 panels; page 1 has 3.' });
    const locked = { ...p, panels: p.panels.map((x, i) => (i === 1 ? { ...x, frame: { ...x.frame!, locked: true as const } } : x)) };
    expect(applyTemplateEdit(withPages(doc, [locked]), locked, 'tall-left-two')).toEqual({ ok: false, reason: 'Panel 2 is locked. Unlock it to change it.' });
    const asDrawn = { ...p, artMode: undefined, render: { ...p.render, cuts: undefined } };
    expect(applyTemplateEdit(withPages(doc, [asDrawn]), asDrawn, 'tall-left-two')).toEqual({ ok: false, reason: 'Page 1 is shown as drawn. Make its panels editable first (free), then pick a layout.' });
  });
});
