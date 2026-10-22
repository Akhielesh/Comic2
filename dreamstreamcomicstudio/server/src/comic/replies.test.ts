// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createEmptyDoc, emptyRender, type ComicDoc } from '../../../shared/comic/doc.js';
import { lakeBriefDoc, lakeDrawnDoc, lakePlannedDoc } from './golden/fixtures.js';
import { plannedDoc } from './orchestrator.fakes.js';
import {
  composeTurnReply,
  detectNamedIp,
  drawIntentOf,
  limitWords,
  materialGaps,
  nothingNextSteps,
  openQuestionsLine,
  recapLine,
  reconcileReply,
  retryNextSteps,
  runOutcome,
  wantsRecap
} from './replies.js';
import { createDirectorTurn, type DirectorTurn } from './tools.js';

const withUserTurns = (doc: ComicDoc, n: number, text = 'hi'): ComicDoc => ({
  ...doc,
  conversation: Array.from({ length: n }, (_, i) => ({ id: `u${i}`, role: 'user' as const, text, at: i }))
});

const turnOf = (init: Partial<DirectorTurn> = {}) => createDirectorTurn({ startedAt: 1000, runs: [], bgErrors: [], ...init });

describe('recapLine', () => {
  it('says what was understood in one line, with groups and companions', () => {
    const line = recapLine(lakeBriefDoc());
    expect(line).toBe('“Splash Day”, a 1-page storybook for kids 2–6, set at a sunny lake shore — The Baby with three Ducklings, a Frog and a Bunny');
  });

  it('never states the untouched default page count, and is empty when nothing is known', () => {
    const doc = createEmptyDoc('d', 'Untitled comic', 1);
    expect(recapLine(doc)).toBe('');
    doc.brief.premise = 'A heist in Mumbai';
    doc.brief.genre = 'heist';
    expect(recapLine(doc)).toBe('a heist comic');
    expect(recapLine(lakePlannedDoc())).toContain(', in Watercolor storybook');
  });
});

describe('drawIntentOf', () => {
  it.each([
    ['generate all pages', 'explicit'],
    ['Draw it!', 'explicit'],
    ['yes, go ahead', 'explicit'],
    ['make the cover', 'explicit'],
    ['redraw page 1', 'redraw'],
    ['draw page 2 again', 'redraw'],
    ['the cover is bad, give me another take', 'redraw'],
    ['the cover is bad it doesnt represent the baby picture', 'none'],
    ['how much would it cost to draw all pages?', 'none'],
    ["don't draw anything yet", 'none'],
    ['make it in watercolor storybook style', 'explicit'],
    ['who is in the story?', 'none'],
    ['', 'none']
  ])('%s → %s', (text, want) => {
    expect(drawIntentOf(text)).toBe(want);
  });
});

describe('detectNamedIp', () => {
  it('finds trademarked names (and nothing in ordinary text)', () => {
    expect(detectNamedIp('make a comic of Shin-chan pranking his dad')).toEqual(['Shin-chan']);
    expect(detectNamedIp('Baahubali fights with LEGO soldiers')).toEqual(['Baahubali', 'LEGO']);
    expect(detectNamedIp('a crayon shin chan story')).toEqual(['Shin-chan']);
    expect(detectNamedIp('a duck named Mario learns to swim')).toEqual([]);
    expect(detectNamedIp('a baby by the lake')).toEqual([]);
  });
});

describe('materialGaps', () => {
  it('vague group → pick companions; page count when nothing was said', () => {
    const doc = createEmptyDoc('d', 'Untitled comic', 1);
    doc.brief.premise = 'A baby plays near a lake';
    expect(materialGaps(doc, 'baby playing near a lake with other animals')).toEqual(['vague_group', 'page_count']);
    expect(materialGaps(doc, 'a single page with other animals')).toEqual(['vague_group']);
    expect(materialGaps(lakeBriefDoc(), 'with other animals')).toEqual([]); // non-human cast exists
  });

  it('feedback on drawn art → ask which fix before spending; images without a purpose', () => {
    expect(materialGaps(lakeDrawnDoc(), 'the cover is bad it doesnt look like her')).toContain('spend_intent');
    expect(materialGaps(lakeDrawnDoc(), 'redo the cover, it is bad')).not.toContain('spend_intent');
    const doc = withUserTurns(lakeBriefDoc(), 1);
    doc.conversation[0].attachments = [{ path: 'u/x/p/y/ref/1.webp', source: 'upload', at: 1 }];
    expect(materialGaps(doc, 'look')).toContain('attachments_purpose');
    expect(materialGaps(doc, 'this is the baby')).not.toContain('attachments_purpose');
    expect(openQuestionsLine(doc, 'look')).toMatch(/^OPEN QUESTIONS: the user attached images/);
  });
});

describe('composeTurnReply (never silent)', () => {
  it('ask_user only on turn 1: "Got it — recap." then the question', () => {
    const before = withUserTurns(createEmptyDoc('d', 'Untitled comic', 1), 1);
    const after = withUserTurns(lakeBriefDoc(), 1);
    const turn = turnOf({ question: 'Which art style?', askedUser: true, log: [{ tool: 'ask_user', ok: true, cost: 'free', result: 'Asked' }] });
    const text = composeTurnReply({ before, after, turn, userText: 'baby playing near a lake with other animals' });
    expect(text.startsWith('Got it — ')).toBe(true);
    expect(text).toContain('three Ducklings');
    expect(text).toContain('I picked those companions');
    expect(text.endsWith('Which art style?')).toBe(true);
    expect(text.split(/\s+/).length).toBeLessThanOrEqual(75);
  });

  it('plan + options: the plan in one line and the question', () => {
    const before = withUserTurns(lakeBriefDoc(), 5);
    const after = withUserTurns(lakePlannedDoc(), 5);
    const turn = turnOf({ plannedThisTurn: true, question: 'Ready to draw?' });
    const text = composeTurnReply({ before, after, turn, userText: 'use watercolor' });
    expect(text).toContain("Here's the plan — 1 page, 3 panels");
    expect(text.endsWith('Ready to draw?')).toBe(true);
  });

  it('a gate: the price and "tap Approve"', () => {
    const before = withUserTurns(plannedDoc(), 6);
    const after = { ...before, gate: { id: 'g1', action: { type: 'render_cover' }, title: 'Draw the cover?', summary: '', estimateUsd: 0.07, imageCount: 1, model: 'NB', createdAt: 1, status: 'open' } } as ComicDoc;
    const text = composeTurnReply({ before, after, turn: turnOf(), userText: 'cover please' });
    expect(text).toBe("That's ≈ $0.07 for the cover — tap Approve when you're ready.");
  });

  it('nothing to draw: $0 said plainly', () => {
    const doc = withUserTurns(lakeDrawnDoc(), 6);
    const text = composeTurnReply({ before: doc, after: doc, turn: turnOf({ outcome: 'nothing' }), userText: 'generate all pages' });
    expect(text).toBe('Everything is already drawn and up to date — 1 page. Nothing was spent.');
  });

  it('started drawing, free edits, errors only, and nothing at all', () => {
    const doc = withUserTurns(plannedDoc(), 6);
    const started = turnOf({ log: [{ tool: 'render_pages', ok: true, cost: 'paid', result: 'Started drawing pages 1–3 (≈ $0.21 on Nano Banana). They appear…' }] });
    expect(composeTurnReply({ before: doc, after: doc, turn: started, userText: 'draw' })).toBe('Drawing pages 1–3 now (≈ $0.21) — it appears on the board as it finishes.');
    const edited = turnOf({ captured: ["page 2 panel 1's text"], log: [{ tool: 'edit_panel_text', ok: true, cost: 'free', result: 'Page 2 panel 1 now has 1 line.' }] });
    expect(composeTurnReply({ before: doc, after: doc, turn: edited, userText: 'change it' })).toBe("Done — page 2 panel 1's text.");
    const failed = turnOf({ log: [{ tool: 'revise_pages', ok: false, cost: 'text', result: 'Error: No page 9 — the plan has 3 pages.' }] });
    expect(composeTurnReply({ before: doc, after: doc, turn: failed, userText: 'fix page 9' })).toBe("I couldn't do that: No page 9 — the plan has 3 pages.");
    const modelFacing = turnOf({ log: [{ tool: 'update_brief', ok: false, cost: 'free', result: 'Error: Pass at least one brief field.' }] });
    expect(composeTurnReply({ before: doc, after: doc, turn: modelFacing, userText: '?' })).toBe("I couldn't do that one — could you say it another way?");
    expect(composeTurnReply({ before: doc, after: doc, turn: turnOf(), userText: 'hmm' })).toBe('Next: draw the pages?');
  });

  it('IP homage is said once, naming the original character', () => {
    const before = withUserTurns(createEmptyDoc('d', 'Untitled comic', 1), 4);
    const after = { ...before, cast: [{ id: 'c1', name: 'Chintu', tier: 'lead' as const, look: { summary: 'cheeky 5-year-old in a red tee' }, refs: [], sheet: emptyRender() }] };
    const text = composeTurnReply({ before, after, turn: turnOf({ ipNames: ['Shin-chan'] }), userText: 'a Shin-chan comic' });
    expect(text).toContain("Shin-chan is trademarked, so I'm making an original homage — Chintu with the same spirit.");
  });
});

describe('honest run outcomes (production bug 2026-10-22: "kicked off" after the runs had failed)', () => {
  const failedStyles = (): ComicDoc => {
    const doc = withUserTurns(createEmptyDoc('d', 'Untitled comic', 1), 2);
    doc.style.options = ['Ink', 'Watercolor', 'Pop'].map((name, i) => ({
      id: `so_${i}`,
      name,
      spec: `${name} spec`,
      render: { ...emptyRender(), status: 'failed', error: 'The image service is busy right now (rate limited).', updatedAt: 2000 }
    }));
    return doc;
  };
  const runs = [0, 1, 2].map((i) => ({ kind: 'style_option' as const, id: `so_${i}` }));

  it('replaces the false progress claim with the real outcome and keeps the rest', () => {
    const after = failedStyles();
    const turn = turnOf({ runs, outcome: 'started' });
    expect(runOutcome(after, turn)).toMatchObject({ failed: runs, busy: [], ready: [] });
    const text = reconcileReply("Love the vibe! I've kicked off 3 style tests — tap one when they land. Want a cast next?", { after, turn });
    expect(text).toBe(
      "3 style tests didn't come through — the image service is busy right now (rate limited). Nothing new was drawn — tap Try again or ask me to retry. Love the vibe! Want a cast next?"
    );
    expect(text).not.toMatch(/kicked off/);
  });

  it('leaves a reply alone while the runs are still drawing, and offers retry chips once they failed', () => {
    const after = failedStyles();
    after.style.options[2].render = { ...emptyRender(), status: 'rendering', updatedAt: 2000 };
    const turn = turnOf({ runs, outcome: 'started' });
    expect(reconcileReply("I've kicked off 3 style tests.", { after, turn })).toBe("I've kicked off 3 style tests.");
    const steps = retryNextSteps(failedStyles(), runs);
    expect(steps).toEqual([expect.objectContaining({ label: 'Try again', action: expect.objectContaining({ type: 'render_style_options', directions: expect.any(Array), quotedUsd: expect.any(Number) }) })]);
  });

  it('a silent model after failed runs still gets the honest line', () => {
    const after = failedStyles();
    const text = composeTurnReply({ before: after, after, turn: turnOf({ runs, outcome: 'started' }), userText: 'show me styles' });
    expect(text).toMatch(/^3 style tests didn't come through/);
  });

  it('background failure with no queued target (style directions) is reported too', () => {
    const doc = withUserTurns(createEmptyDoc('d', 'Untitled comic', 1), 2);
    const turn = turnOf({ outcome: 'started', bgErrors: ['The writer is busy right now (rate limited).'] });
    expect(reconcileReply('Style tests are on their way!', { after: doc, turn })).toBe(
      "That didn't go through — The writer is busy right now (rate limited). Nothing new was drawn."
    );
  });
});

describe('next steps and helpers', () => {
  it('nothing-to-draw chips: read it, the cover (priced), add a page, a new take (priced), share', () => {
    const steps = nothingNextSteps(lakeDrawnDoc());
    expect(steps.map((s) => s.label)).toEqual(['Read it', 'Make the cover', 'Add a page', 'New take of page 1', 'Share it']);
    expect(steps[1]).toMatchObject({ action: { type: 'render_cover' }, usd: expect.any(Number) });
    expect(steps[3]).toMatchObject({ say: 'Draw a new take of page 1' });
    expect(drawIntentOf(steps[3].say!)).toBe('redraw');
  });

  it('wantsRecap: early turns that learned something, or any turn with 2+ changes', () => {
    const empty = withUserTurns(createEmptyDoc('d', 'Untitled comic', 1), 1);
    expect(wantsRecap(empty, withUserTurns(lakeBriefDoc(), 1))).toBe(true);
    const late = withUserTurns(lakeBriefDoc(), 5);
    const noteOnly = { ...late, brief: { ...late.brief, notes: ['no gore'] } };
    expect(wantsRecap(late, noteOnly)).toBe(false);
  });

  it('limitWords keeps whole sentences', () => {
    expect(limitWords('One two three. Four five six. Seven.', 4)).toBe('One two three.');
  });
});
