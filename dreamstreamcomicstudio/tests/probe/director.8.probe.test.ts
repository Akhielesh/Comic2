// @vitest-environment node
// Probe: a big book (40 pages, 24 cast, 14 notes — all within DOC_LIMITS) makes the DOC SUMMARY longer
// than SUMMARY_CHAR_BUDGET (12 000). The clip cuts the END of the summary — which is exactly where the
// money lines, the open approval, the user's focus (selected balloons) and OPEN QUESTIONS live.
import { describe, expect, it } from 'vitest';
import { createEmptyDoc, emptyRender, type Page } from '../../shared/comic/doc.js';
import { summarizeDocForDirector } from '../../server/src/comic/director.js';

describe('DOC SUMMARY on a big book', () => {
  it('keeps the settings, spend, open gate and focus lines', () => {
    const doc = createEmptyDoc('big-1', 'The Long Voyage');
    doc.brief = { ...doc.brief, logline: 'A crew of friends sails across a sea of islands to find a lost lighthouse.', premise: 'Lorem ipsum '.repeat(50), notes: Array.from({ length: 14 }, (_, i) => `Note ${i + 1}: ${'keep the tone warm and the jokes gentle, '.repeat(4)}`) };
    doc.cast = Array.from({ length: 24 }, (_, i) => ({
      id: `c_${i}`, name: `Crew Member ${i + 1}`, tier: i < 2 ? 'lead' as const : 'support' as const, role: 'deckhand with a secret past and a loud laugh',
      look: { summary: `A ${['tall', 'short', 'wiry', 'round'][i % 4]} sailor with ${['braided', 'cropped', 'curly', 'long'][i % 4]} hair, a weathered coat, brass buttons, a scar on the left cheek and bright eyes` },
      refs: [], sheet: emptyRender()
    }));
    doc.places = Array.from({ length: 8 }, (_, i) => ({ id: `pl_${i}`, name: `Island ${i + 1}`, look: 'Rocky shore, a crooked pier, fishing huts and gulls everywhere', refs: [], sheet: emptyRender() }));
    const page = (n: number): Page => ({
      id: `pg_${n}`, n, summary: `Page ${n}: the crew lands on island ${n} and meets someone new who changes the plan in a surprising way`, layout: '', balloons: [], render: emptyRender(),
      panels: [1, 2, 3, 4].map((k) => ({ id: `pn_${n}_${k}`, n: k, size: 'medium' as const, shot: 'medium' as const, action: `Action ${n}.${k}`, castIds: ['c_0'], lines: [{ id: `ln_${n}_${k}`, kind: 'speech' as const, speakerId: 'c_0', text: `Line ${n}.${k}` }] }))
    });
    doc.pages = Array.from({ length: 40 }, (_, i) => page(i + 1));
    doc.planStatus = 'approved';
    doc.gate = { id: 'gate_1', action: { type: 'render_pages' }, title: 'Draw pages 1–40?', summary: '', estimateUsd: 2.4, imageCount: 40, model: 'Nano Banana 2.1', createdAt: Date.now(), status: 'open', reason: 'policy' };
    const out = summarizeDocForDirector(doc, false, [], { userText: 'make these red', focus: { pageId: 'pg_40', lineIds: ['ln_40_1', 'ln_40_2'], surface: 'page_editor' } });
    process.stderr.write(`probe8 ${JSON.stringify({ length: out.length, tail: out.slice(-200) })}\n`);
    expect(out).toContain('Settings:');
    expect(out).toContain('Spend so far');
    expect(out).toContain('Waiting on approval');
    expect(out).toContain('Focus:');
  });
});
