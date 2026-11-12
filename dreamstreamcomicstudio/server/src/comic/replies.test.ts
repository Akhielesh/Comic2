// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createEmptyDoc, emptyRender, type ComicDoc } from '../../../shared/comic/doc.js';
import { lakeBriefDoc, lakeDrawnDoc, lakePlannedDoc } from './golden/fixtures.js';
import { plannedDoc } from './orchestrator.fakes.js';
import {
  composeTurnReply,
  contradictionsOf,
  detectNamedIp,
  dialogueTargetGap,
  drawIntentInContext,
  drawIntentOf,
  limitWords,
  materialGaps,
  nothingLine,
  nothingNextSteps,
  openQuestionsLine,
  recapLine,
  reconcileReply,
  requestedLetteringPreset,
  requestedPageCount,
  retryNextSteps,
  runOutcome,
  statedAudience,
  statedLanguage,
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
    // Golden set (P2-SERVER): "make" + a free lettering/script edit is not a draw request.
    ['make the shouts red', 'none'],
    ['make the text a bit bigger', 'none'],
    ['make it funnier', 'none'],
    ['make the ending happier', 'none'],
    ['make the text bigger and redraw page 2', 'redraw'],
    ['make the captions bold and draw the cover', 'explicit'],
    ['who is in the story?', 'none'],
    ['', 'none']
  ])('%s → %s', (text, want) => {
    expect(drawIntentOf(text)).toBe(want);
  });
});

describe('drawIntentInContext (a bare "yes" to the studio\'s own offer to draw)', () => {
  const asked = (question: string, viaCard = false): ComicDoc => {
    const doc = lakePlannedDoc();
    doc.conversation = [
      { id: 'u1', role: 'user', text: 'a lake story', at: 1 },
      viaCard
        ? { id: 'a1', role: 'assistant', text: 'Here is the plan.', at: 2, cards: [{ type: 'options', id: 'o1', question, choices: [{ id: 'x', label: 'Yes' }, { id: 'y', label: 'Not yet' }], answered: ['Yes'] }] }
        : { id: 'a1', role: 'assistant', text: `The plan is on the board. ${question}`, at: 2 },
      { id: 'u2', role: 'user', text: 'yes', at: 3 }
    ];
    return doc;
  };

  it.each([
    ['Ready to draw page 1 (≈ $0.07)?', 'yes', 'explicit'],
    ['Shall I make the cover?', 'ok go', 'explicit'],
    ['Want a new take of page 1 (≈ $0.07)?', 'yes please', 'redraw'],
    ['Which style do you like?', 'yes', 'none'],
    ['Ready to draw page 1?', 'ok thanks', 'none'],
    ['Ready to draw page 1?', 'yes but smaller', 'none'],
    ['Ready to draw page 1?', 'go ahead', 'explicit']
  ])('"%s" → "%s" → %s', (question, answer, want) => {
    expect(drawIntentInContext(asked(question), answer)).toBe(want);
  });

  it('a tapped "Yes" on an options card counts; never while an approval card is open', () => {
    expect(drawIntentInContext(asked('Ready to draw?', true), 'Yes')).toBe('explicit');
    const gated = asked('Ready to draw?');
    gated.gate = { id: 'g1', action: { type: 'render_pages' }, title: 'Draw 1 page?', summary: '', estimateUsd: 0.07, imageCount: 1, model: 'NB', createdAt: 1, status: 'open', reason: 'first_render' } as ComicDoc['gate'];
    expect(drawIntentInContext(gated, 'yes')).toBe('none');
    expect(drawIntentInContext(gated, 'draw it')).toBe('explicit'); // the user's own words still count
  });
});

describe('detectNamedIp', () => {
  it('ordinary words that are also brands are not IP ("marvel at", "minions", "a barbie", "bluey-green")', () => {
    for (const t of ['they marvel at the stars', "the villain's minions attack", 'the transformer blew up', 'a snoopy neighbour', 'bluey-green water', 'a barbie on the beach', 'taking the mickey', 'my uncle Garfield', 'the avengers of the village']) {
      expect(detectNamedIp(t), t).toEqual([]);
    }
    expect(detectNamedIp('a Marvel style hero with the Minions and Optimus Prime')).toEqual(['Marvel', 'Transformers', 'the Minions']);
  });

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

describe('contradiction gaps (agent-editor plan §3 A3.2: ask once, never override silently)', () => {
  const ON = { contradictions: true } as const;
  const gapsOf = (doc: ComicDoc, text: string, focus?: { pageId?: string; lineIds?: string[] }) => contradictionsOf(doc, text, focus).map((c) => c.gap);
  const approved = (): ComicDoc => ({ ...plannedDoc(), planStatus: 'approved' });
  /** Page 1 panel 2 line ln_1_2 has a balloon the creator pinned; page 3's is placed automatically. */
  const pinned = (): ComicDoc => {
    const doc = plannedDoc();
    doc.pages[0].balloons = [{ lineId: 'ln_1_2', x: 0.1, y: 0.1, w: 0.2, pinned: true }];
    doc.pages[2].balloons = [{ lineId: 'ln_3_2', x: 0.5, y: 0.5, w: 0.2 }];
    return doc;
  };

  it('contradiction_pages: a new page count against an approved plan or drawn pages', () => {
    expect(gapsOf(approved(), 'make it 5 pages')).toEqual(['contradiction_pages']);
    const [c] = contradictionsOf(approved(), 'actually, a 5-page comic');
    expect(c.text).toBe(
      'the user asked for 5 pages, but the approved plan has 3 pages — ask_user once: "Keep 3 pages" / "Change to 5 pages", saying what changes (the plan is rewritten). Never change it silently.'
    );
    const drawn = plannedDoc();
    drawn.pages[0].render = { ...drawn.pages[0].render, status: 'ready', asset: { path: 'u/p/1.webp', source: 'generated', at: 1 } };
    expect(contradictionsOf(drawn, 'make it two pages')[0].text).toContain('but the comic has 3 pages (1 drawn)');
    // Silent: the same count, a draft plan, pages that exist ("the first 2 pages", "redraw 2 pages", "add 2 pages").
    expect(gapsOf(approved(), 'make it 3 pages')).toEqual([]);
    expect(gapsOf(plannedDoc(), 'make it 5 pages')).toEqual([]);
    for (const t of ['fix the first 2 pages', 'redraw 2 pages', 'add 2 pages at the end', 'swap pages 2 and 3']) expect(gapsOf(approved(), t), t).toEqual([]);
  });

  it("contradiction_style: a lettering preset switch over the comic's own looks", () => {
    const doc = plannedDoc();
    doc.letterStyle = { presetId: 'classic', auto: false, kinds: { shout: { textColor: '#cc0000' } } };
    expect(gapsOf(doc, 'switch the lettering to manga')).toEqual(['contradiction_style']);
    expect(contradictionsOf(doc, 'use the manga lettering')[0].text).toBe(
      'the user asked for the Manga lettering, but the comic has its own looks for shouts on top of Classic comic — ask_user once: "Keep my looks" (stay on Classic comic) / "Switch to Manga" (drops the base and kind looks; speaker and line looks stay on top), naming those looks. Never drop them silently.'
    );
    // Silent: no own looks, the same preset, or no lettering words ("make it noir" is the art).
    expect(gapsOf(plannedDoc(), 'switch the lettering to manga')).toEqual([]);
    expect(gapsOf(doc, 'keep the classic lettering')).toEqual([]);
    expect(gapsOf(doc, 'make the art more noir')).toEqual([]);
  });

  it('contradiction_pinned: the target is a balloon the creator pinned or locked', () => {
    expect(gapsOf(pinned(), 'move it to the top left', { pageId: 'pg_1', lineIds: ['ln_1_2'] })).toEqual(['contradiction_pinned']);
    expect(contradictionsOf(pinned(), 'rearrange the balloons on page 1')[0].text).toBe(
      'the user asked to move a balloon they pinned by hand (page 1 · panel 2 · line 1 “Line on page 1”) — ask_user once: "Keep it where it is" / "Move it" before moving; until then leave pinned balloons where they are. Never move them silently.'
    );
    const locked = pinned();
    locked.pages[0].balloons[0].locked = true;
    expect(contradictionsOf(locked, 'move it lower', { lineIds: ['ln_1_2'] })[0].text).toContain('they pinned or locked by hand');
    // Silent: a balloon placed automatically, an edit that is not a move, a page without pinned balloons.
    expect(gapsOf(pinned(), 'move it to the top left', { pageId: 'pg_3', lineIds: ['ln_3_2'] })).toEqual([]);
    expect(gapsOf(pinned(), 'make it a whisper', { lineIds: ['ln_1_2'] })).toEqual([]);
    expect(gapsOf(pinned(), 'rearrange the balloons on page 3')).toEqual([]);
  });

  it('contradiction_note: the same slot as an earlier brief note with a different value', () => {
    const doc = plannedDoc();
    doc.brief.notes = ['kids 2–6', '1 page, 4:5', 'Telugu dialogue'];
    expect(gapsOf(doc, 'this is a comic for adults')).toEqual(['contradiction_note']);
    expect(contradictionsOf(doc, 'make it for teens')[0].text).toBe(
      'the user now says the audience is teens, but an earlier note says “kids 2–6” (kids) — ask_user once: "Keep kids" / "Change to teens", quoting that note. Never override it silently.'
    );
    expect(contradictionsOf(doc, 'write it in Hindi')[0].text).toContain('the language is Hindi, but an earlier note says “Telugu dialogue” (Telugu)');
    expect(contradictionsOf(doc, 'make it 4 pages')[0].text).toContain('the page count is 4 pages, but an earlier note says “1 page, 4:5” (1 page)');
    // Silent: the same value, a translation (another edition), nothing stated.
    for (const t of ['for kids please', 'a 1-page comic', 'in Telugu', 'translate it to Hindi', 'make the duck bigger']) expect(gapsOf(doc, t), t).toEqual([]);
  });

  it('fires on the clear ways of setting each slot', () => {
    for (const t of ['I want 6 pages.', '6 pages please', 'cut it down to 2 pages', 'let us do it in 8 pages', 'it should be 4 pages long', 'change the page count to 4', 'ok, 2 pages', 'make it a 4 page story'])
      expect(gapsOf(approved(), t), t).toEqual(['contradiction_pages']);
    const sel = { pageId: 'pg_1', lineIds: ['ln_1_2'] };
    for (const t of ['put it in the bottom corner', 'place it at the top', 'a bit lower', 'nudge it left', 'slide it up']) expect(gapsOf(pinned(), t, sel), t).toEqual(['contradiction_pinned']);
    expect(gapsOf(pinned(), 'tidy the balloons', { pageId: 'pg_1' })).toEqual(['contradiction_pinned']);
    const teens = plannedDoc();
    teens.brief.notes = ['audience: teens'];
    for (const t of ['this is a comic for adults', 'make it for kids', 'a kids comic please', 'the audience is adults', 'for ages 8-12', 'make it R-rated']) expect(gapsOf(teens, t), t).toEqual(['contradiction_note']);
    expect(gapsOf(teens, 'rated PG-13')).toEqual([]);
    const telugu = plannedDoc();
    telugu.brief.notes = ['Telugu dialogue'];
    for (const t of ['write it in Hindi', 'a Tamil comic', 'language: English', 'switch the dialogue to Hindi', 'Hindi only']) expect(gapsOf(telugu, t), t).toEqual(['contradiction_note']);
    const looks = plannedDoc();
    looks.letterStyle = { presetId: 'classic', auto: false, kinds: { shout: { textColor: '#cc0000' } } };
    for (const t of ['switch the lettering to manga', 'use the manga lettering', 'go with noir fonts', 'handwritten fonts please', 'switch to the minimal preset'])
      expect(gapsOf(looks, t), t).toEqual(['contradiction_style']);
  });

  it('stays silent on everyday edits that only mention a number, a place, an audience word, a language or a preset name', () => {
    // (a) A number of pages with no length context names pages to work on, never a new count.
    for (const t of [
      'redo 2 pages',
      'rewrite 2 pages please',
      'update 2 pages',
      'polish 2 pages',
      'regenerate 2 pages',
      'make 2 pages brighter',
      'change 2 pages to night',
      'my 4 pages look great',
      'these 2 pages are dark',
      'add rain to 2 pages',
      'I need 2 pages redrawn',
      'redo the 2-page spread',
      'fix only 2 pages.',
      'only 2 pages are drawn'
    ])
      expect(gapsOf(approved(), t), t).toEqual([]);
    // (b) put / place / position with no place to go edits the words; a page-wide move needs a real move verb.
    const sel = { pageId: 'pg_1', lineIds: ['ln_1_2'] };
    for (const t of ['put more emotion in this line', 'put an exclamation mark here', 'place the stress on "go"', 'position is fine, change the words', 'make the text lower case', 'change the text in the top balloon', 'shift the tone a bit'])
      expect(gapsOf(pinned(), t, sel), t).toEqual([]);
    for (const t of ['put the dialogue in Hindi', 'put the lines in a calmer tone', 'translate the lines', 'fix all the lines']) expect(gapsOf(pinned(), t, { pageId: 'pg_1' }), t).toEqual([]);
    // (c) An audience word that is a character in the story, not the readers.
    const teens = plannedDoc();
    teens.brief.notes = ['audience: teens'];
    for (const t of ['add a panel where the kids look for the dog', 'the child waits for her mom', 'make the kids smile for the last panel', 'a scene for the grown-ups at the party', 'Mira and Leo, ages 8 and 10, run home'])
      expect(gapsOf(teens, t), t).toEqual([]);
    const adults = plannedDoc();
    adults.brief.notes = ['for adults'];
    expect(gapsOf(adults, 'the kids hide for a while')).toEqual([]);
    // (d) A language spoken in the story, not the comic's own.
    const telugu = plannedDoc();
    telugu.brief.notes = ['Telugu dialogue'];
    for (const t of ['the sign says hello in Hindi', 'she shouts in English at the guard']) expect(gapsOf(telugu, t), t).toEqual([]);
    // (e) A preset name as an everyday word, or a bubble look for one kind of line.
    const looks = plannedDoc();
    looks.letterStyle = { presetId: 'manga', auto: false, kinds: { shout: { textColor: '#cc0000' } } };
    for (const t of ['keep the dialogue minimal', 'less text, keep the speech minimal', 'the captions feel too noir', 'use classic speech bubbles for the thoughts', 'set in a noir city, use big fonts', 'make the lettering minimal'])
      expect(gapsOf(looks, t), t).toEqual([]);
  });

  it("contradiction_style asks only when the switch would drop the creator's base or kind looks", () => {
    const doc = plannedDoc();
    // Speaker, line and saved-style looks stay on top of any preset: no question.
    doc.letterStyle = { presetId: 'classic', auto: false, speakers: { c_maya: { italic: true } } };
    doc.pages[0].panels[1].lines[0].style = { textColor: '#0000cc' };
    expect(gapsOf(doc, 'switch the lettering to manga')).toEqual([]);
    // A base look would be dropped: ask, naming only what the switch drops.
    doc.letterStyle = { ...doc.letterStyle, base: { font: 'bangers' } };
    const [c] = contradictionsOf(doc, 'switch the lettering to manga');
    expect(c.gap).toBe('contradiction_style');
    expect(c.text).toContain('its own looks for the base look on top of Classic comic');
    expect(c.text).not.toContain('Maya');
  });

  it('stays silent on everyday requests across the fixtures', () => {
    const docs = [createEmptyDoc('d', 'Untitled comic', 1), plannedDoc(), approved(), pinned(), lakeDrawnDoc(), lakePlannedDoc()];
    const everyday = ['make it funnier', 'draw page 2', 'the cover is too dark', 'add a dog to page 3', 'change the title to Spice Run', 'make the shout red'];
    for (const doc of docs) for (const t of everyday) expect(gapsOf(doc, t), t).toEqual([]);
  });

  it('only behind the flag: materialGaps and OPEN QUESTIONS lead with a contradiction when asked, else stay as before', () => {
    expect(materialGaps(approved(), 'make it 5 pages')).toEqual([]);
    expect(materialGaps(approved(), 'make it 5 pages', ON)).toEqual(['contradiction_pages']);
    expect(openQuestionsLine(approved(), 'make it 5 pages')).toBe('');
    expect(openQuestionsLine(approved(), 'make it 5 pages', ON)).toMatch(/^OPEN QUESTIONS: the user asked for 5 pages, but the approved plan has 3 pages/);
    expect(materialGaps(pinned(), 'move it up', { ...ON, focus: { lineIds: ['ln_1_2'] } })).toEqual(['contradiction_pinned']);
  });

  it('the slot readers', () => {
    expect(requestedPageCount('a one-shot')).toBe(1);
    expect(requestedPageCount('let us do it in 8 pages')).toBe(8);
    expect(requestedPageCount('the next 2 pages are wrong')).toBeUndefined();
    expect(requestedPageCount('make it 99 pages')).toBeUndefined();
    expect(requestedLetteringPreset('handwritten fonts please')).toBe('handwritten');
    expect(requestedLetteringPreset('switch the captions to the pulp lettering')).toBe('retro_pulp');
    // A look for one kind of line is not a preset switch, and "minimal" alone is everyday speech.
    expect(requestedLetteringPreset('a pulp look for the captions')).toBeUndefined();
    expect(requestedLetteringPreset('keep the lettering minimal')).toBeUndefined();
    expect(requestedLetteringPreset('use the minimal lettering style')).toBe('minimal');
    expect(requestedLetteringPreset('manga')).toBeUndefined();
    expect(statedAudience('for ages 13-15')).toBe('teens');
    expect(statedAudience('my kids like it')).toBeUndefined();
    expect(statedAudience('the kids look for the dog')).toBeUndefined();
    expect(statedAudience('audience: teens', true)).toBe('teens');
    expect(requestedPageCount('redo 2 pages')).toBeUndefined();
    expect(requestedPageCount('1 page, 4:5')).toBe(1);
    expect(requestedPageCount('pages: 6')).toBe(6);
    expect(requestedPageCount('pages: 2 and 3 are dark')).toBeUndefined();
    expect(statedLanguage('the sign says hello in Hindi')).toBeUndefined();
    expect(statedLanguage('Telugu dialogue', true)).toBe('Telugu');
    expect(statedLanguage('a Tamil comic')).toBe('Tamil');
    expect(statedLanguage('Tamil')).toBeUndefined();
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
    expect(text).toBe('The page is already drawn and up to date — nothing was spent. The cover isn’t drawn yet.');
    const all = withUserTurns(lakeDrawnDoc(), 6);
    all.cover.render = { ...emptyRender(), status: 'ready', asset: { path: 'c.webp', source: 'generated', at: 1 } };
    expect(composeTurnReply({ before: all, after: all, turn: turnOf({ outcome: 'nothing' }), userText: 'draw everything' })).toBe(
      'Everything is already drawn and up to date — 1 page and the cover. Nothing was spent.'
    );
  });

  it('nothing to draw never claims "everything" when only the cover is current (or pages are drawing)', () => {
    const doc = withUserTurns(lakePlannedDoc(), 6);
    doc.cover.render = { ...emptyRender(), status: 'ready', asset: { path: 'c.webp', source: 'generated', at: 1 } };
    const coverTurn = turnOf({ outcome: 'nothing', log: [{ tool: 'render_cover', ok: true, cost: 'paid', result: 'Nothing to draw: the cover is already drawn' }] });
    expect(nothingLine(doc, coverTurn)).toBe('The cover is already drawn and up to date — nothing was spent.');
    expect(composeTurnReply({ before: doc, after: doc, turn: coverTurn, userText: 'make the cover' })).not.toMatch(/Everything|0 pages/);
    doc.pages[0].render = { ...emptyRender(), status: 'rendering' };
    expect(nothingLine(doc, turnOf({ outcome: 'nothing' }))).toBe("It's already drawing — nothing new to start, and nothing was spent.");
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
    // A reply that already says so honestly is kept as written (no double failure line).
    expect(reconcileReply('The style tests failed — the image service is busy. Want me to try again?', { after, turn })).toBe(
      'The style tests failed — the image service is busy. Want me to try again?'
    );
  });

  it('leaves a reply alone while the runs are still drawing, and offers retry chips once they failed', () => {
    const after = failedStyles();
    after.style.options[2].render = { ...emptyRender(), status: 'rendering', updatedAt: 2000 };
    const turn = turnOf({ runs, outcome: 'started' });
    expect(reconcileReply("I've kicked off 3 style tests.", { after, turn })).toBe("I've kicked off 3 style tests.");
    const steps = retryNextSteps(failedStyles(), runs);
    expect(steps).toEqual([expect.objectContaining({ label: 'Try again', action: expect.objectContaining({ type: 'render_style_options', directions: expect.any(Array), quotedUsd: expect.any(Number) }) })]);
  });

  it('a target put back un-drawn (stopped/skipped job) is never reported as ready', () => {
    const after = failedStyles();
    after.style.options[0].render = { ...emptyRender(), status: 'ready', asset: { path: 'a.webp', source: 'generated', at: 2000 }, updatedAt: 2000 };
    after.style.options[1].render = { ...emptyRender(), status: 'none', updatedAt: 2000 };
    const turn = turnOf({ runs, outcome: 'started' });
    const out = runOutcome(after, turn);
    expect(out.ready).toEqual([runs[0]]);
    expect(out.failed).toEqual([runs[1], runs[2]]);
    expect(reconcileReply('On their way!', { after, turn })).toMatch(/^The style test is ready, but 2 style tests didn't come through/);
  });

  it('a long early-turn recap never pushes the failure line out of the word budget', () => {
    const before = withUserTurns(createEmptyDoc('d', 'Untitled comic', 1), 1);
    const after = withUserTurns(lakeBriefDoc(), 1);
    after.style.options = failedStyles().style.options;
    const text = composeTurnReply({ before, after, turn: turnOf({ runs, outcome: 'started', question: 'Which style should we try next?' }), userText: 'baby by a lake with other animals' });
    expect(text).toContain("3 style tests didn't come through");
    expect(text).toContain('tap Try again');
    expect(text.endsWith('Which style should we try next?')).toBe(true);
    expect(text).not.toContain('I picked those companions'); // the least important clause went first
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

describe('the dialogue_target gap (plan §3 A3.2; built in wave 2 B-TOOL on resolveLineRef / whichLineChoices)', () => {
  const ON = { contradictions: true } as const;

  it('a dialogue request that matches several lines asks through dialogue_edit, quoting each candidate', () => {
    const gap = dialogueTargetGap(plannedDoc(), "make Maya's line a whisper")!;
    expect(gap.gap).toBe('dialogue_target');
    expect(gap.choices.map((c) => c.visual)).toEqual([
      { kind: 'balloon', pageId: 'pg_1', lineId: 'ln_1_2' },
      { kind: 'balloon', pageId: 'pg_2', lineId: 'ln_2_2' }
    ]);
    expect(gap.text).toBe(
      `the request could mean 2 lines (${gap.choices.map((c) => c.label).join('; ')}) — call dialogue_edit with the user's words and let it ask "Which line?" (it shows each balloon); never change all of them unless the user said all / every / both.`
    );
    expect(materialGaps(plannedDoc(), "make Maya's line a whisper", ON)).toEqual(['dialogue_target']);
    expect(openQuestionsLine(plannedDoc(), "make Maya's line a whisper", ON)).toBe(`OPEN QUESTIONS: ${gap.text}`);
  });

  it('silent when it is clear: one match, the selection, a plural, or not about dialogue; and only behind the flag', () => {
    const doc = plannedDoc();
    expect(dialogueTargetGap(doc, "make Arjun's line a shout")).toBeUndefined();
    expect(dialogueTargetGap(doc, 'make it a whisper', { pageId: 'pg_2', lineIds: ['ln_2_2'] })).toBeUndefined();
    expect(dialogueTargetGap(doc, "make all of Maya's lines whispers")).toBeUndefined();
    expect(dialogueTargetGap(doc, 'draw page 2 again')).toBeUndefined();
    expect(dialogueTargetGap(doc, `${'make it a whisper '.repeat(40)}`)).toBeUndefined();
    expect(materialGaps(doc, "make Maya's line a whisper")).toEqual([]);
    expect(openQuestionsLine(doc, "make Maya's line a whisper")).toBe('');
  });

  it('a contradiction still comes first', () => {
    const approved: ComicDoc = { ...plannedDoc(), planStatus: 'approved' };
    const gaps = materialGaps(approved, "make it 5 pages and make Maya's line a whisper", ON);
    expect(gaps[0]).toBe('contradiction_pages');
    expect(openQuestionsLine(approved, "make it 5 pages and make Maya's line a whisper", ON)).toMatch(/^OPEN QUESTIONS: the user asked for 5 pages/);
  });
});
