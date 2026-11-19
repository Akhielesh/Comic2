// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { emptyRender, type ComicDoc } from '../../../shared/comic/doc.js';
import { lakeDrawnDoc, lakePlannedDoc, sixPageDrawnDoc } from './golden/fixtures.js';
import { canFastPath, normalizeIntentText, parseIntent, routeIntent } from './intents.js';
import { drawIntentOf } from './replies.js';
import { costFormatter, costViewFor } from './costText.js';
import { DEFAULT_CAPS } from '../../../shared/comic/capabilities.js';
import { lineSourceHash } from '../../../shared/comic/i18n.js';

const T_PUB = 1_700_000_000_000;

/** Six pages drawn, page 2 with an earlier version in history. */
const sixWithHistory = (): ComicDoc => {
  const doc = sixPageDrawnDoc();
  doc.pages[1].render.history = [{ path: 'old-p2.webp', source: 'generated', at: 1 }];
  return doc;
};

// ── Read-only intents ($0, no model call) ────────────────────────────────────

const SHOW: string[] = [
  'show me the pages',
  'Show me the pages please',
  'can you show the plan?',
  'show the breakdown',
  'see the storyboard',
  'list the pages',
  'view all the pages',
  'how many pages?',
  'How many panels are there',
  'what pages do we have',
  'show me the pages and panels',
  'breakdown',
  'overview',
  'display the page plan',
  'show me the whole comic'
];
const STATUS: string[] = ["what's left?", 'whats done so far', 'status', 'progress update', 'status check', 'where are we', 'are the pages done yet?', 'is everything drawn', 'what is still to draw'];
const COST: string[] = ['how much will it cost?', 'how much would the rest cost', 'how much to finish the comic', "what's the cost so far", 'quote it', 'how much does it cost to draw everything'];
const DRAW_ALL: string[] = [
  'generate all pages',
  'Generate all the pages!',
  'draw all pages',
  'draw every page',
  'render the remaining pages',
  'generate the missing pages',
  'draw the rest of the pages',
  'please draw all the pages now',
  'go ahead and draw them all',
  'make all pages',
  'finish it',
  'draw everything',
  'finish the comic'
];

describe('routeIntent phrase table (40+ phrasings)', () => {
  it('has at least 40 positive phrasings', () => {
    expect(SHOW.length + STATUS.length + COST.length + DRAW_ALL.length).toBeGreaterThanOrEqual(40);
  });

  it.each(SHOW)('show: %s', (text) => {
    const r = routeIntent(lakePlannedDoc(), text);
    expect(r).toMatchObject({ kind: 'show_pages', cards: [expect.objectContaining({ type: 'breakdown', view: 'plan' })] });
    expect(r!.reply).toBe('Here are the pages: 1 page · 3 panels · nothing drawn yet · cover not drawn yet.');
    expect(r!.nextSteps[0]).toMatchObject({ label: 'Draw page 1', action: { type: 'render_pages', pageIds: ['pg_lake_1'] } });
  });

  it.each(STATUS)('status: %s', (text) => {
    const r = routeIntent(lakeDrawnDoc(), text);
    expect(r).toMatchObject({ kind: 'show_pages', reply: '1 page · 3 panels · page 1 drawn · cover not drawn yet.', cards: [expect.objectContaining({ view: 'status' })] });
  });

  it.each(COST)('cost: %s', (text) => {
    const r = routeIntent(lakePlannedDoc(), text);
    expect(r?.kind).toBe('show_pages');
    expect(r!.reply).toMatch(/^Drawing what's left \(1 page \+ 4 character sheets \+ the cover\) is about \$\d+\.\d\d\./);
    expect(r!.cards[0]).toMatchObject({ type: 'breakdown', view: 'cost' });
  });

  it.each(DRAW_ALL)('draw-all on a drawn book is $0 and free: %s', (text) => {
    const doc = /everything|finish/.test(text) ? sixPageDrawnDoc() : lakeDrawnDoc();
    const r = routeIntent(doc, text);
    expect(r?.kind).toBe('nothing_to_draw');
    expect(r!.reply).toMatch(/^(Everything is already drawn and up to date — 6 pages and the cover\.|The page is already drawn and up to date — nothing was spent\. The cover isn’t drawn yet — want it\?)/);
    expect(r!.reply).toMatch(/nothing was spent/i);
    expect(r!.reply).not.toMatch(/^Everything.*cover isn’t drawn/); // never "everything" while the cover is missing
    expect(r!.nextSteps.map((s) => s.label)).toContain('Read it');
  });

  it('draw-all with real work goes to the director (it quotes); the cover counts only for "everything"', () => {
    expect(routeIntent(lakePlannedDoc(), 'generate all pages')).toBeNull();
    expect(routeIntent(lakeDrawnDoc(), 'draw everything')).toBeNull(); // the cover is missing → a real quote
    expect(routeIntent(lakeDrawnDoc(), 'generate all pages')?.reply).toContain('The cover isn’t drawn yet — want it?');
  });

  it('pages still drawing: nothing new to start', () => {
    const doc = lakeDrawnDoc();
    doc.pages[0].render = { ...emptyRender(), status: 'rendering' };
    expect(routeIntent(doc, 'draw all pages')?.reply).toBe('Everything is either drawn or already drawing — nothing new to start, and nothing was spent.');
  });

  const NEAR_MISSES = [
    'generate all pages in black and white',
    'draw all the pages again',
    'redraw all pages',
    'draw a dog on page 2',
    'show me a dragon',
    'show me what Maya looks like',
    'how many dogs are in the story?',
    'the pages look bad',
    'can you show me how to draw hands',
    'swap the pages’ colours',
    'make all pages darker',
    'what is the story about?',
    'pages',
    'draw it'
  ];
  it.each(NEAR_MISSES)('near miss → director: %s', (text) => {
    expect(routeIntent(lakeDrawnDoc(), text)).toBeNull();
  });

  it('no plan yet → the director answers', () => {
    const doc = lakeDrawnDoc();
    doc.pages = [];
    expect(routeIntent(doc, 'show me the pages')).toBeNull();
  });

  it('normalizes politeness and punctuation', () => {
    expect(normalizeIntentText('  Hey, could you please Show me the PAGES?? 🙏 ')).toBe('show me the pages');
    expect(drawIntentOf('generate all pages')).toBe('explicit');
  });
});

// ── Phase 2: structural free edits ───────────────────────────────────────────

describe('parseIntent phrase table (COMIC_FAST_INTENTS)', () => {
  const doc = sixWithHistory();
  it.each([
    ['swap pages 2 and 3', { tool: 'move_page', args: { page: 3, to: 2 } }],
    ['switch page 4 with page 5', { tool: 'move_page', args: { page: 5, to: 4 } }],
    ['move page 5 to 2', { tool: 'move_page', args: { page: 5, to: 2 } }],
    ['move page 2 after page 4', { tool: 'move_page', args: { page: 2, to: 4 } }],
    ['delete page 4', { tool: 'delete_page', args: { page: 4 } }],
    ['remove the last page', { tool: 'delete_page', args: { page: 6 } }],
    ['remove page six', { tool: 'delete_page', args: { page: 6 } }],
    ['duplicate page 2', { tool: 'duplicate_page', args: { page: 2 } }],
    ['copy page 1', { tool: 'duplicate_page', args: { page: 1 } }],
    ['add a page after 2', { tool: 'insert_page', args: { after: 2 } }],
    ['insert a blank page after page 6', { tool: 'insert_page', args: { after: 6 } }],
    ['add a new page at the end', { tool: 'insert_page', args: { after: 6 } }],
    ['use the earlier version of page 2', { tool: 'use_version', args: { target: 'page', page: 2, version: 'previous' } }],
    ['go back to the original version of page 2', { tool: 'use_version', args: { target: 'page', page: 2, version: 'original' } }],
    ['make the text bigger', { tool: 'set_lettering_style', args: { scope: 'comic', style: { size: 'larger' } } }],
    ['make all the shouts red', { tool: 'set_lettering_style', args: { scope: 'kind', kind: 'shout', style: { text_color: 'red' } } }],
    ['make the captions smaller', { tool: 'set_lettering_style', args: { scope: 'kind', kind: 'caption', style: { size: 'smaller' } } }],
    ['make whispers bold', { tool: 'set_lettering_style', args: { scope: 'kind', kind: 'whisper', style: { bold: true } } }],
    // near misses
    ["swap the pages' colours", null],
    ['swap pages 2 and 5', null], // not adjacent → the director plans two moves
    ['delete page 9', null], // no such page
    ['use the earlier version of page 3', null], // no history
    ['make the text funnier', null],
    ['delete the dog from page 4', null],
    ['duplicate maya', null]
  ])('%s', (text, want) => {
    const got = parseIntent(text, doc);
    if (want === null) expect(got).toBeNull();
    else expect(got).toMatchObject({ ...want, confidence: expect.any(Number) });
  });

  it('only runs with the flag, no attachments, no open gate and high confidence', () => {
    const parsed = parseIntent('delete page 4', doc);
    expect(canFastPath(parsed, { enabled: true, attachments: 0, gateOpen: false })).toBe(true);
    expect(canFastPath(parsed, { enabled: false, attachments: 0, gateOpen: false })).toBe(false);
    expect(canFastPath(parsed, { enabled: true, attachments: 1, gateOpen: false })).toBe(false);
    expect(canFastPath(parsed, { enabled: true, attachments: 0, gateOpen: true })).toBe(false);
    expect(canFastPath(null, { enabled: true, attachments: 0, gateOpen: false })).toBe(false);
  });
});

// ── PUB-5: "publish it" / "share it" show the card for free ──────────────────

describe('publish_card: the common publish and share phrases show the card with no model turn', () => {
  const CARD_REPLY = "Here's your Publish card. Nothing is published until you tap Publish. Readers can read and download, never edit.";
  const PHRASES = [
    'publish',
    'publish it',
    'publish this',
    'publish my comic',
    'publish the comic',
    'publish the book',
    'share',
    'share it',
    'share my comic',
    'share the comic',
    'Publish it!',
    'can you publish it please?',
    'Share it now 🙏'
  ];
  it.each(PHRASES)('routes: %s', (text) => {
    const r = routeIntent(lakeDrawnDoc(), text);
    expect(r).toMatchObject({ kind: 'publish_card', reply: CARD_REPLY, nextSteps: [] });
    // A pending Publish card, Link only; the comic has no editions, so the request is the plain one.
    expect(r!.cards).toEqual([expect.objectContaining({ type: 'publish', mode: 'publish', status: 'pending', request: { visibility: 'unlisted' } })]);
  });

  const OTHERS = [
    'publish it in hindi',
    'can you share the comic with my friend',
    'I want to share my screen',
    'share this with my mom',
    'how do I share it',
    "don't publish it yet",
    'publish it on instagram',
    'share it later',
    'publish the pages',
    'republish'
  ];
  it.each(OTHERS)('goes to the director: %s', (text) => {
    expect(routeIntent(lakeDrawnDoc(), text)).toBeNull();
  });

  it('paused by moderation → null; nothing drawn → null; live → the Share card', () => {
    const live = lakeDrawnDoc();
    live.publication = { visibility: 'unlisted', status: 'live', slug: 'Ab3dEf6hIj9kLm2nP', publishedRev: 4, publishedAt: T_PUB, languages: ['en'] };
    const shared = routeIntent(live, 'share it')!;
    expect(shared).toMatchObject({ kind: 'publish_card', reply: "Here's your link.", cards: [{ type: 'share', id: expect.any(String) }], nextSteps: [] });
    // "publish it" on a live link: the Share card, and the reply says edits since publishing are not live yet.
    expect(routeIntent(live, 'publish it')).toMatchObject({
      kind: 'publish_card',
      reply: "Here's your link. Any edits since you published stay private until you tap Update in the Share sheet.",
      cards: [{ type: 'share' }]
    });
    expect(routeIntent(live, 'publish')!.reply).toMatch(/stay private until you tap Update/);
    expect(routeIntent(live, 'share the comic')!.reply).toBe("Here's your link.");

    const paused = lakeDrawnDoc();
    paused.publication = { ...live.publication, status: 'suspended' };
    expect(routeIntent(paused, 'publish it')).toBeNull();
    expect(routeIntent(paused, 'share it')).toBeNull();

    expect(routeIntent(lakePlannedDoc(), 'publish it')).toBeNull();
    const failed = lakeDrawnDoc();
    failed.pages[0].render = { ...emptyRender(), status: 'failed', error: 'boom' };
    expect(routeIntent(failed, 'share it')).toBeNull();
  });

  it('the card request has only ready languages, and the reply names the ones it left out', () => {
    const doc = lakeDrawnDoc();
    doc.format = { ...doc.format, lettering: 'overlay' };
    const lines = doc.pages.flatMap((p) => p.panels.flatMap((pn) => pn.lines));
    const edition = (lang: string, status: 'reviewed' | 'machine') => ({
      lang,
      lines: Object.fromEntries(lines.map((l) => [l.id, { text: `${lang}: ${l.text}`, status, sourceHash: lineSourceHash(l), at: 1 }])),
      balloons: {},
      register: 'everyday' as const
    });
    doc.i18n = { editions: { hi: edition('hi', 'reviewed'), te: edition('te', 'machine') }, glossary: [] };
    const r = routeIntent(doc, 'publish it')!;
    expect(r.cards).toEqual([expect.objectContaining({ type: 'publish', request: { visibility: 'unlisted', languages: [doc.format.language, 'hi'] } })]);
    expect(r.reply).toBe(`${CARD_REPLY} Telugu isn't reviewed yet, so the card leaves it out. Add it from the Share sheet once it's ready.`);
  });

  it('a page still drawing is said up front (publishing waits for it)', () => {
    const doc = sixPageDrawnDoc();
    doc.pages[1].render = { ...doc.pages[1].render, status: 'rendering' };
    expect(routeIntent(doc, 'publish it')!.reply).toBe(`${CARD_REPLY} Page 2 is still drawing; tap Publish once it's done.`);
    doc.pages[2].render = { ...doc.pages[2].render, status: 'queued' };
    doc.cover.render = { ...doc.cover.render, status: 'rendering' };
    expect(routeIntent(doc, 'publish it')!.reply).toBe(`${CARD_REPLY} Pages 2, 3 and the cover are still drawing; tap Publish once they're done.`);
    doc.cover.render = { ...doc.cover.render, status: 'ready' };
    expect(routeIntent(doc, 'publish it')!.reply).toBe(`${CARD_REPLY} Pages 2 and 3 are still drawing; tap Publish once they're done.`);
    doc.pages[2].render = { ...doc.pages[2].render, status: 'ready' };
    doc.cover.render = { ...doc.cover.render, status: 'queued' };
    expect(routeIntent(doc, 'publish it')!.reply).toBe(`${CARD_REPLY} Page 2 and the cover are still drawing; tap Publish once they're done.`);
    doc.pages[1].render = { ...doc.pages[1].render, status: 'ready' };
    expect(routeIntent(doc, 'publish it')!.reply).toBe(`${CARD_REPLY} The cover is still drawing; tap Publish once it's done.`);
  });

  it('a governed user sees no $ (nothing here mentions money)', () => {
    const cost = costFormatter(costViewFor({ ...DEFAULT_CAPS, usage: { governed: true, pctLeft: 90, exhausted: false, pctPerStandardPage: 1.2 } }));
    for (const text of ['publish it', 'share it']) {
      const r = routeIntent(lakeDrawnDoc(), text, { cost })!;
      expect(r.kind).toBe('publish_card');
      expect(r.reply).not.toMatch(/\$|cents?\b/);
    }
  });
});

describe('P2-SERVER: one breakdown builder, honest cover wording, prices in the user\'s terms', () => {
  it('a failed cover says "cover failed" (never "not drawn yet"); cards come from breakdownCardFor', () => {
    const doc = lakeDrawnDoc();
    doc.cover.render = { ...emptyRender(), status: 'failed', error: 'boom' };
    const r = routeIntent(doc, 'status')!;
    expect(r.reply).toContain('cover failed');
    // The failed cover gets its tile (with a retry); a one-page book with no cover yet leads with the page.
    expect(r.cards[0]).toMatchObject({ type: 'breakdown', view: 'status', cover: true });
    expect(routeIntent(lakePlannedDoc(), 'show me the pages')!.cards[0]).toMatchObject({ type: 'breakdown', view: 'plan', cover: false });
  });

  it('a governed user\'s cost answer is in usage, never dollars', () => {
    const cost = costFormatter(costViewFor({ ...DEFAULT_CAPS, usage: { governed: true, pctLeft: 90, exhausted: false, pctPerStandardPage: 1.2 } }));
    const r = routeIntent(lakePlannedDoc(), 'how much will it cost', { cost })!;
    expect(r.reply).not.toMatch(/\$/);
    expect(r.reply).toMatch(/^Drawing what's left \(.+\) is about [\d.<]+% of your usage\. Text edits/);
  });
});

