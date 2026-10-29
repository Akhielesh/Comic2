// @vitest-environment node
// planCheckGate: overfull pages are held back from "Render all" (PD-1), never refused; "Draw anyway" lets them in.
import { describe, expect, it } from 'vitest';
import { createEmptyDoc, emptyRender, type ComicDoc, type Line, type Page, type Panel } from '../../../shared/comic/doc.js';
import { heldBackNotice, planCheckGate, sanitizeDrawOverfull } from './planCheckGate.js';

const WORDS = 'listen the carrier behind those flower stalls has no plates and nobody has unloaded anything since morning which means someone wants us watching it closely tonight'.split(' ');
const text = (n: number, seed = 0) => Array.from({ length: n }, (_, i) => WORDS[(seed + i) % WORDS.length]).join(' ');
const sp = (id: string, who: string, n: number, seed = 0): Line => ({ id, kind: 'speech', speakerId: who, text: text(n, seed) });
const panel = (id: string, n: number, over: Partial<Panel> = {}): Panel => ({ id, n, size: 'medium', shot: 'medium', action: `Beat ${n}.`, castIds: [], lines: [], ...over });

/** A roomy 3-panel page. */
const roomy = (n: number): Page => ({
  id: `pg_${n}`,
  n,
  summary: '',
  layout: 'Row 1: one wide panel. Row 2: two equal panels.',
  panels: [panel(`pn_${n}_1`, 1, { size: 'wide', shot: 'establishing' }), panel(`pn_${n}_2`, 2, { lines: [sp(`l${n}`, 'c_kal', 10)] }), panel(`pn_${n}_3`, 3)],
  render: emptyRender(),
  balloons: []
});

/** b4b5774f-p2-shaped: a third-width pov panel carrying 29 words in two balloons. */
const overfull = (n: number): Page => ({
  id: `pg_${n}`,
  n,
  summary: '',
  layout: 'Row 1: two equal panels. Row 2: one wide panel. Row 3: three small panels.',
  panels: [
    panel(`pn_${n}_1`, 1, { shot: 'wide', lines: [sp('a', 'c_meera', 10)] }),
    panel(`pn_${n}_2`, 2),
    panel(`pn_${n}_3`, 3, { size: 'wide', shot: 'wide' }),
    panel(`pn_${n}_4`, 4, { size: 'small', shot: 'insert' }),
    panel(`pn_${n}_5`, 5, { size: 'small', shot: 'close_up', lines: [sp('b', 'c_meera', 17, 3)] }),
    panel(`pn_${n}_6`, 6, { size: 'small', shot: 'pov', lines: [sp('c', 'c_meera', 15, 5), sp('d', 'c_kal', 14, 9)] })
  ],
  render: emptyRender(),
  balloons: []
});

const docOf = (...pages: Page[]): ComicDoc => {
  const doc = createEmptyDoc('doc_gate', 'Gate Lights', 1);
  doc.format.pageAspect = '2:3';
  doc.format.pageCount = pages.length;
  doc.cast = [
    { id: 'c_kal', name: 'Kalyani', tier: 'lead', look: { summary: 'Courier' }, refs: [], sheet: emptyRender() },
    { id: 'c_meera', name: 'Meera', tier: 'lead', look: { summary: 'Engineer' }, refs: [], sheet: emptyRender() }
  ];
  doc.pages = pages;
  return doc;
};

describe('planCheckGate', () => {
  it('excludes an overfull page from the run, with its reason and the free layout fix', () => {
    const doc = docOf(roomy(1), overfull(2), roomy(3));
    const gate = planCheckGate(doc, ['pg_1', 'pg_2', 'pg_3']);
    expect(gate.pageIds).toEqual(['pg_1', 'pg_3']);
    expect(gate.heldBack).toHaveLength(1);
    expect(gate.heldBack[0]).toMatchObject({ pageId: 'pg_2', n: 2, panel: 6, layoutFix: 'Row 1: three small panels. Row 2: two equal panels. Row 3: one wide panel.' });
    expect(gate.heldBack[0].worst).toBeGreaterThan(0.3);
    expect(gate.notice).toBe("Page 2 isn't drawn yet: panel 6 has more words than it can hold. A layout that fits is ready (free), or draw it anyway.");
  });

  it('includes the overfull page when the user picked "Draw anyway" (drawOverfull)', () => {
    const doc = docOf(roomy(1), overfull(2));
    const gate = planCheckGate(doc, ['pg_1', 'pg_2'], ['pg_2']);
    expect(gate).toEqual({ pageIds: ['pg_1', 'pg_2'], heldBack: [] });
  });

  it('keeps order, passes unknown ids through, and ignores junk in drawOverfull', () => {
    const doc = docOf(overfull(1), roomy(2), overfull(3));
    const gate = planCheckGate(doc, ['pg_3', 'pg_x', 'pg_2', 'pg_1'], ['pg_nope', 42 as unknown as string]);
    expect(gate.pageIds).toEqual(['pg_x', 'pg_2']);
    expect(gate.heldBack.map((h) => h.pageId)).toEqual(['pg_3', 'pg_1']);
    expect(gate.notice).toBe("Pages 1 and 3 aren't drawn yet: each has a panel with more words than it can hold. Free fixes first, or draw them anyway.");
    expect(planCheckGate(doc, [])).toEqual({ pageIds: [], heldBack: [] });
  });

  it('sanitizes drawOverfull to this doc’s page ids, de-duplicated, in page order', () => {
    const doc = docOf(roomy(1), overfull(2), roomy(3));
    expect(sanitizeDrawOverfull(['pg_3', 'pg_2', 'pg_2', 'pg_9', null, { id: 'pg_1' }], doc)).toEqual(['pg_2', 'pg_3']);
    expect(sanitizeDrawOverfull('pg_2', doc)).toEqual([]);
    expect(sanitizeDrawOverfull(undefined, doc)).toEqual([]);
  });

  it('never holds back a forced new take of a drawn, current page (the user priced and approved it); a stale page still is', () => {
    const drawn = overfull(1);
    drawn.render = { status: 'ready', history: [], asset: { path: 'u/x/p1.webp', source: 'generated', at: 1 } };
    const stale = overfull(2);
    stale.render = { status: 'ready', history: [], specHash: 'an-older-plan', asset: { path: 'u/x/p2.webp', source: 'generated', at: 1 } };
    const doc = docOf(drawn, stale, overfull(3));
    const gate = planCheckGate(doc, ['pg_1', 'pg_2', 'pg_3']);
    expect(gate.pageIds).toEqual(['pg_1']);
    expect(gate.heldBack.map((h) => h.pageId)).toEqual(['pg_2', 'pg_3']);
    // A caller may exempt more pages (e.g. an explicit single-page draw), and they pass through unchanged.
    expect(planCheckGate(doc, ['pg_2', 'pg_3'], [], { exempt: (p) => p.id === 'pg_3' })).toMatchObject({ pageIds: ['pg_3'] });
  });

  it('says nothing when nothing is held back; never mentions money', () => {
    expect(heldBackNotice([])).toBeUndefined();
    const gate = planCheckGate(docOf(overfull(1)), ['pg_1']);
    expect(gate.notice).not.toMatch(/\$|usd|usage/i);
  });
});
