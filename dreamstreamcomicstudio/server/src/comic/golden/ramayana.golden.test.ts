// @vitest-environment node
// The Ramayana golden case (PROGRAM5 P5-GOLD; research-case §9.5). The owner's own comic, de-identified to text, is
// compiled with the real compiler, page check and run order. Two kinds of test:
//   - "today" tests pin what the case measured on the day (numbers in ramayana-setu.expected.json). They keep the
//     fixture honest: if one breaks without a quality change, the fixture or the compiler drifted.
//   - `it.fails` tests state what a correct Ramayana page needs. They fail today, so `it.fails` passes. The package
//     that fixes a fault turns its test into a plain `it` (and moves the matching "today" pin behind its flag off).
// No model call, no network, nothing spent.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { coverCastOf, type ComicDoc, type Page } from '../../../../shared/comic/doc.js';
import { previousPageFor, scheduleRun } from '../consistency/schedule.js';
import { compileCharacterSheet, paletteWords } from '../prompts.js';
import type { LlmClient } from '../types.js';
import { analyzePageRender, normalizeMarks } from '../vision.js';
import {
  CASE_COMPILE_VARIANTS,
  EXPRESSION_WORDS,
  RAMAYANA_CASE_ID,
  RAMAYANA_EXPECTED_PATH,
  RAMAYANA_FIXTURE_PATH,
  RAMAYANA_FIXTURE_TIME,
  compileCaseCover,
  compileCaseEdit,
  compileCasePages,
  countOf,
  expressionWordsInAnchors,
  insideAnchors,
  loadRamayanaCase,
  mustContain,
  mustNotContain,
  outsideAnchors,
  pageByN,
  panelDirectionMisses,
  privacyLeaks,
  readRamayanaExpected,
  readRamayanaFixture,
  whoLines
} from './promptChecks.js';

const expected = readRamayanaExpected();
const today = expected.today;
const SMILE = 'serene calm smile';

const pageId = (doc: ComicDoc, n: number) => pageByN(doc, n).id;
const castNamed = (doc: ComicDoc, name: string) => {
  const c = doc.cast.find((x) => x.name === name);
  if (!c) throw new Error(`No ${name} in the case.`);
  return c;
};
/** The page with a drawn take, so the page check's marks are read as on the day. */
const marksFor = (doc: ComicDoc, page: Page, reply: Record<string, unknown>, opts: { v2?: boolean } = {}) => normalizeMarks(reply, doc, page, opts);
const headsAreReal = (heads: { head: { x: number; y: number } }[]) => heads.every((h) => h.head.x > 0.01 && h.head.y > 0.01);
/** The page check run for real ($0): a stand-in model answers with the rebuilt reply (twice: one repair round). */
const checkWithReply = async (doc: ComicDoc, page: Page, reply: Record<string, unknown>, opts: { qcV2?: boolean } = {}) => {
  const full = { balloons: [], issues: [], extraOrMissingCharacters: [], ...(opts.qcV2 ? { acting: [], inscriptions: [] } : {}), ...reply };
  const replies = [full, full];
  const llm: LlmClient = {
    complete: async () => {
      const json = replies.shift();
      if (!json) throw new Error('unexpected call');
      return { text: JSON.stringify(json), json, model: 'stand-in', byok: false, provider: 'openrouter' };
    }
  };
  return analyzePageRender({ doc, page, dataUrl: 'data:image/png;base64,AAAA', llm, ...(opts.qcV2 ? { qcV2: {} } : {}) });
};
/** The one glossary entry the page check needs (the case's i18n is stripped): Rama, written राम in Devanagari. */
const withRamaGlossary = (doc: ComicDoc): ComicDoc => ({
  ...doc,
  i18n: { editions: {}, glossary: [{ id: 'g_rama', term: 'Rama', kind: 'character', refId: castNamed(doc, 'Rama').id, policy: 'transliterate', forms: { hi: 'राम' } }] }
});

describe('the Ramayana golden case: the fixture', () => {
  it('loads as a 10-page, 20-panel comic with its cast, place, plan and brief', () => {
    const doc = loadRamayanaCase();
    expect(doc.id).toBe(RAMAYANA_CASE_ID);
    expect(doc.brief.title).toBe('Brick Legends: Rama Setu');
    expect(doc.pages.map((p) => p.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(doc.pages.reduce((n, p) => n + p.panels.length, 0)).toBe(20);
    expect(doc.cast.map((c) => c.name)).toEqual(['Rama', 'Hanuman', 'Nila', 'Lakshmana', 'Sugriva', 'Varuna', 'Squirrel']);
    expect(doc.places.map((p) => p.name)).toEqual(['Southern Shore of Rameshwaram']);
    expect(doc.style.palette).toEqual(['#FFD700', '#C8102E', '#0055A5', '#FF9933', '#2E7D32']);
    expect(doc.planStatus).toBe('approved');
    // Every speaker and cast id points at a card; every place id at the place.
    const ids = new Set(doc.cast.map((c) => c.id));
    for (const p of doc.pages)
      for (const panel of p.panels) {
        for (const id of panel.castIds) expect(ids.has(id)).toBe(true);
        for (const l of panel.lines) if (l.speakerId) expect(ids.has(l.speakerId)).toBe(true);
        if (panel.placeId) expect(doc.places.some((pl) => pl.id === panel.placeId)).toBe(true);
      }
  });

  it('compiles every page, the cover, a cast sheet and the page-9 edit with the real compiler', () => {
    const doc = loadRamayanaCase();
    const pages = compileCasePages(doc);
    expect(pages).toHaveLength(10);
    for (const { job } of pages) {
      expect(job.prompt.length).toBeGreaterThan(2000);
      mustContain(job.prompt, 'PANEL 1 of 2', 'PANEL 2 of 2');
    }
    // The previous page each page used on the day is attached (page 1 has none).
    for (const { n, job } of pages) expect(job.references.some((r) => r.label === 'PREVIOUS PAGE')).toBe(n !== 1);
    expect(compileCaseCover(doc).prompt.length).toBeGreaterThan(500);
    expect(compileCharacterSheet(doc, castNamed(doc, 'Lakshmana'), {}).prompt).toContain('LAKSHMANA');
    expect(compileCaseEdit(doc).prompt.startsWith(today.editPromptHead)).toBe(true);
  });

  it('page 9 starts from page 8’s bridge work even though its stored image referenced page 7', () => {
    const doc = loadRamayanaCase();
    const job = compileCasePages(doc).find(({ n }) => n === 9)!.job;
    expect(job.references).toContainEqual({ label: 'PREVIOUS PAGE', path: pageByN(doc, 7).render.asset!.path });
    expect(job.prompt).toContain('This reference does not establish the current scene');
    expect(job.prompt).toContain('STORY HANDOFF — Page 8 ended with: Nila on the left holds his surveyor tools');
    expect(job.prompt).toContain('The keystone slots into the last gap');
  });

  it('is a fresh copy on every load, and synthetic image stand-ins never reach the fixture file', () => {
    const a = loadRamayanaCase();
    a.pages[0].panels[0].action = 'changed';
    expect(loadRamayanaCase().pages[0].panels[0].action).not.toBe('changed');
    const raw = JSON.stringify(readRamayanaFixture());
    expect(raw).not.toContain('"asset"');
    expect(raw).not.toContain('golden:');
  });
});

type Fx = { cast: { id: string }[]; pages: { id: string; panels: { id: string }[] }[]; brief: { notes?: string } };

describe('the Ramayana golden case: privacy (the repository is public)', () => {
  const files = [RAMAYANA_FIXTURE_PATH, RAMAYANA_EXPECTED_PATH].map((p) => ({ p, text: readFileSync(p, 'utf8') }));

  it.each(files.map((f) => [f.p.split('/').pop()!, f.text]))('%s holds no address, link, storage key, image, uuid, hash, date or old id', (_name, text) => {
    expect(privacyLeaks(text)).toEqual([]);
  });

  // The guard itself has teeth: each leak a later edit could bring back, put into the fixture one at a time, is caught.
  it.each([
    ['an original cast id (prefix + hex)', (fx: Fx) => void (fx.cast[0].id = 'c_c7ac414430l')],
    ['an original page id', (fx: Fx) => void (fx.pages[0].id = 'pg_743d90151f43')],
    ['a .jpeg storage path', (fx: Fx) => void (fx.brief.notes = 'comic-private/abc/p1.jpeg')],
    ['a .gif, .avif or .svg image', (fx: Fx) => void (fx.brief.notes = 'see cover.avif')],
    ['an ISO date', (fx: Fx) => void (fx.brief.notes = 'drawn 2026-11-12T19:08:15Z')],
    ['a short job hash', (fx: Fx) => void (fx.brief.notes = 'job 7f3a9c2e')],
    ['an epoch time in seconds', (fx: Fx) => void (fx.brief.notes = 'at 1794508387')],
    ['an epoch time in milliseconds', (fx: Fx) => void (fx.brief.notes = 'at 1794508387962')],
    ['a mixed letter-and-digit token', (fx: Fx) => void (fx.brief.notes = 'key ab12cd34ef56gh')],
    ['an id outside the allowed spellings', (fx: Fx) => void (fx.pages[0].panels[0].id = 'panel-a')],
    ['an email address', (fx: Fx) => void (fx.brief.notes = 'someone@example.org')]
  ])('the privacy guard catches %s', (_what, leak) => {
    const fx = JSON.parse(files[0].text) as Fx;
    leak(fx);
    expect(privacyLeaks(JSON.stringify(fx, null, 2)).length).toBeGreaterThan(0);
  });

  it('the plan hash is a placeholder, not the original value', () => {
    expect(readRamayanaFixture().planInputHash).toBe('rama-setu-plan');
  });

  it('the fixture keeps only the allowed fields: no assets, models, costs, versions, share links or chat replies', () => {
    const fx = readRamayanaFixture();
    expect(Object.keys(fx).sort()).toEqual(
      ['book', 'brief', 'cast', 'conversation', 'cover', 'createdAt', 'format', 'id', 'letterStyle', 'pages', 'places', 'planInputHash', 'planStatus', 'reader', 'settings', 'style', 'updatedAt', 'v'].sort()
    );
    const text = JSON.stringify(fx);
    for (const key of ['asset', 'path', 'model', 'costUsd', 'spend', 'jobHash', 'specHash', 'publication', 'slug', 'safety', 'i18n', 'qc', 'history', 'variants', 'rev'])
      expect(text, key).not.toContain(`"${key}"`);
    // The only chat kept is the owner's brief (two user messages); every time is the one constant.
    const conversation = fx.conversation as { role: string; at: number }[];
    expect(conversation.length).toBeLessThanOrEqual(2);
    expect(conversation.every((m) => m.role === 'user')).toBe(true);
    const times: number[] = [];
    JSON.parse(text, (k, v) => {
      if (k === 'at' || k === 'createdAt' || k === 'updatedAt' || k === 'checkedAt') times.push(v);
      return v;
    });
    expect(times.length).toBeGreaterThan(0);
    expect(times.every((t) => t === RAMAYANA_FIXTURE_TIME)).toBe(true);
    // No other epoch-millisecond number anywhere (a stray stored time would date the original).
    expect(text).not.toMatch(new RegExp(`\\b(?!${RAMAYANA_FIXTURE_TIME}\\b)1[6-9]\\d{11}\\b`));
  });

  it('no golden render script mentions the case (run.ts renders every .json in golden/)', () => {
    const dir = dirname(fileURLToPath(import.meta.url));
    const jsonFiles = readdirSync(dir).filter((f) => f.endsWith('.json'));
    expect(jsonFiles.length).toBeLessThanOrEqual(5);
    for (const f of jsonFiles) {
      const text = readFileSync(join(dir, f), 'utf8').toLowerCase();
      for (const word of ['ramayana', 'rama-setu', 'rama setu', 'lanka', 'hanuman']) expect(text, `${f}: ${word}`).not.toContain(word);
    }
    // The fixture never sits in golden/ (or its scenarios/ folder).
    expect(jsonFiles.some((f) => f.includes('rama'))).toBe(false);
    expect(readdirSync(join(dir, 'scenarios')).some((f) => f.includes('rama'))).toBe(false);
  });
});

describe('the Ramayana golden case: today (what the case measured on the day)', () => {
  it(`"${SMILE}" is inside the identity anchors ${today.sereneSmileHits} times across ${today.sereneSmilePrompts} page prompts`, () => {
    const pages = compileCasePages(loadRamayanaCase());
    const hits = pages.map(({ job }) => countOf(job.prompt, SMILE));
    expect(hits.reduce((a, b) => a + b, 0)).toBe(today.sereneSmileHits);
    expect(hits.filter((h) => h > 0)).toHaveLength(today.sereneSmilePrompts);
    // The Who lines carry it, inside Rama's anchor.
    const page1 = pages[0].job.prompt;
    expect(whoLines(page1).some((l) => l.includes(SMILE))).toBe(true);
    expect(insideAnchors(page1).some((a) => a.includes(SMILE))).toBe(true);
    expect(expressionWordsInAnchors(page1).length).toBeGreaterThan(0);
  });

  it(`saffron and cobalt are named "${today.paletteWordsSaffronCobalt}"; the style palette reads "${today.stylePaletteWords}"`, () => {
    expect(paletteWords(['#FF9933', '#0055A5'])).toBe(today.paletteWordsSaffronCobalt);
    const page1 = compileCasePages(loadRamayanaCase())[0].job.prompt;
    mustContain(page1, today.stylePaletteWords);
    mustNotContain(page1, 'saffron', 'royal blue');
  });

  it('Lakshmana, a person on the support tier, is left out of the cover cast and the cover prompt', () => {
    const doc = loadRamayanaCase();
    expect(coverCastOf(doc).map((c) => c.name)).toEqual(today.coverCast);
    mustNotContain(compileCaseCover(doc).prompt, 'LAKSHMANA');
  });

  it('now pairs page 3 with page 2 instead of its historical dependency on page 1', () => {
    const doc = loadRamayanaCase();
    const ids = doc.pages.map((p) => p.id);
    const run = scheduleRun(doc, ids);
    expect(today.page3WaitsFor).toBe(1);
    expect(run.after[pageId(doc, 3)]).toBe(pageId(doc, 2));
    expect(run.after[pageId(doc, 5)]).toBe(pageId(doc, 4));
    expect(run.after[pageId(doc, 4)]).toBe(pageId(doc, 1));
  });

  it('the page-4 and page-9 reply shapes (boxes 0–1000, heads 0–1) collapse the heads into the page corner', () => {
    const doc = loadRamayanaCase();
    const p4 = marksFor(doc, pageByN(doc, 4), expected.replyShapes.page4);
    expect(p4.heads.map((h) => h.head)).toEqual(today.page4HeadsAfterCheck);
    expect(p4.heads.map((h) => h.characterId)).toEqual([castNamed(doc, 'Nila').id, castNamed(doc, 'Nila').id, castNamed(doc, 'Rama').id]);
    const p9 = marksFor(doc, pageByN(doc, 9), expected.replyShapes.page9);
    expect(p9.heads.map((h) => h.head)).toEqual(today.page9HeadsAfterCheck);
  });

  it('the rebuilt page-4 and page-9 replies reproduce the stored keepOut too ([]: the scale-setting box is dropped)', () => {
    const doc = loadRamayanaCase();
    expect(marksFor(doc, pageByN(doc, 4), expected.replyShapes.page4).keepOut).toEqual(today.page4And9KeepOutAfterCheck);
    expect(marksFor(doc, pageByN(doc, 9), expected.replyShapes.page9).keepOut).toEqual(today.page4And9KeepOutAfterCheck);
  });

  it("the page-9 check reads Rama's name on the bridge stones as stray text and caps the score", async () => {
    const doc = loadRamayanaCase();
    const { qc } = await checkWithReply(doc, pageByN(doc, 9), expected.replyShapes.page9);
    expect(qc.textFound).toEqual(['RAM', 'RAM']);
    expect(qc.issues).toEqual(today.page9Issues);
    expect(qc.score).toBe(today.page9Score);
    expect(qc.heads?.map((h) => h.head)).toEqual(today.page9HeadsAfterCheck);
    // Page 4's 'राम' (two letters) is below the stray-text bar today, as on the day.
    const p4 = await checkWithReply(doc, pageByN(doc, 4), { ...expected.replyShapes.page4, panels: expected.replyShapes.page9.panels, score: 0.98 });
    expect(p4.qc.issues).toEqual([]);
  });

  it('the page-9 edit prompt starts with the raw edit note (the owner\'s request, in tidied words)', () => {
    const doc = loadRamayanaCase();
    const note = pageByN(doc, 9).render.note || '';
    expect(note.length).toBeGreaterThan(10);
    const prompt = compileCaseEdit(doc).prompt;
    expect(prompt.startsWith(today.editPromptHead)).toBe(true);
    expect(prompt.slice(today.editPromptHead.length).toLowerCase().startsWith(note.toLowerCase())).toBe(true);
  });
});

// These hold today and must hold after every quality package: a fix may not pass the golden by deleting what the owner
// wrote or what a good page check found. A package that adds a flag adds its flag-on variant to CASE_COMPILE_VARIANTS
// (prompts) or runs the page-check tests below with its flag on (COMIC_QC_V2).
describe('the Ramayana golden case: must stay true after every quality fix', () => {
  it.each(CASE_COMPILE_VARIANTS.map((v) => [v.label, v.opts] as const))(
    "each panel's mood, action (positions included), shot and angle reach its own panel block, outside the anchors (%s)",
    (_label, opts) => {
      const doc = loadRamayanaCase();
      const pages = compileCasePages(doc, opts);
      for (const { n, job } of pages) expect(panelDirectionMisses(pageByN(doc, n), job.prompt)).toEqual([]);
      const page1 = outsideAnchors(pages[0].job.prompt);
      mustContain(page1, 'serene, rising magical glow', 'eyes calm', 'at his left shoulder', 'high angle', 'low angle');
    }
  );

  it('the direction check catches a smile fix that strips the feeling words from the whole prompt', () => {
    const doc = loadRamayanaCase();
    const strip = (prompt: string) => EXPRESSION_WORDS.reduce((t, w) => t.replace(new RegExp(`\\b${w}\\w*`, 'gi'), ''), prompt);
    const stripped = compileCasePages(doc).map(({ n, job }) => ({ n, prompt: strip(job.prompt) }));
    // That fix would pass the anchor check …
    for (const { prompt } of stripped) expect(expressionWordsInAnchors(prompt)).toEqual([]);
    // … and lose page 1's mood and Rama's calm eyes.
    const misses = panelDirectionMisses(pageByN(doc, 1), stripped[0].prompt);
    expect(misses.some((m) => m.includes('mood: serene, rising magical glow'))).toBe(true);
    expect(misses.some((m) => m.includes('eyes calm'))).toBe(true);
  });

  it("a good page keeps its heads: page 3's two Hanuman heads and four marks survive the page check", () => {
    const doc = loadRamayanaCase();
    const marks = marksFor(doc, pageByN(doc, 3), expected.replyShapes.page3);
    expect(marks.heads.map((h) => h.head)).toEqual(today.page3HeadsAfterCheck);
    expect(marks.heads.map((h) => h.characterId)).toEqual([castNamed(doc, 'Hanuman').id, castNamed(doc, 'Hanuman').id]);
    expect(marks.keepOut).toHaveLength(4);
  });
});

describe('the Ramayana golden case: what a correct page needs (fails today; the fixing package flips each one)', () => {
  // P5-TRUTH (COMIC_STORY_FIXES): a card's face holds identity, not a mood. Fixed with the flag on (the "today" pin
  // above keeps the flag-off prompt as it was).
  it('no expression word sits inside any identity anchor (COMIC_STORY_FIXES on)', () => {
    for (const { n, job } of compileCasePages(loadRamayanaCase(), { storyFixes: true })) expect(expressionWordsInAnchors(job.prompt), `page ${n}`).toEqual([]);
    for (const { job } of compileCasePages(loadRamayanaCase(), { storyFixes: true })) for (const l of whoLines(job.prompt)) mustNotContain(l, SMILE, 'grin');
  });

  // P5-TRUTH (COMIC_STORY_FIXES): exact colour names an Indian epic needs, with their codes.
  it('saffron is called saffron and cobalt royal blue, each with its code (COMIC_STORY_FIXES on)', () => {
    const words = paletteWords(['#FF9933', '#0055A5'], { storyFixes: true });
    expect(words).toBe('saffron (#FF9933) and royal blue (#0055A5)');
    mustNotContain(words, 'coral', 'teal');
    const page1 = compileCasePages(loadRamayanaCase(), { storyFixes: true })[0].job.prompt;
    mustContain(page1, 'Palette: gold (#FFD700), crimson (#C8102E), royal blue (#0055A5), saffron (#FF9933) and green (#2E7D32).');
  });

  // P5-COVER (W3): the hero's brother belongs on the cover.
  it.fails('Lakshmana is in the cover cast', () => {
    expect(coverCastOf(loadRamayanaCase()).map((c) => c.name)).toContain('Lakshmana');
  });

  // P5-TRUTH (COMIC_RUN_CHAINS): pages of one scene draw one after another. The scene rule is B4's deriveScenes (no
  // ledger scenes in the case): a page with no place continues the scene before it, so page 3 (no place, inland) is
  // still the shore scene and is drawn from page 2. Fixed with the flag on; the "today" pin above keeps it off.
  it('page 3 waits for page 2 and is drawn from it: a page with no place continues the scene before it (COMIC_RUN_CHAINS on)', () => {
    const doc = loadRamayanaCase();
    expect(scheduleRun(doc, doc.pages.map((p) => p.id), { chains: true }).after[pageId(doc, 3)]).toBe(pageId(doc, 2));
    expect(previousPageFor(doc, pageByN(doc, 3), { chains: true })?.n).toBe(2);
  });

  // P5-QC (COMIC_QC_V2, flipped): heads keep their own scale, or are dropped, and a good page keeps its heads. With the
  // flag off the "today" pins above still hold (the same replies collapse to the page corner).
  it('the page-4 and page-9 heads stay above 0.01 or are dropped, and page 3 keeps both of its heads (COMIC_QC_V2)', () => {
    const doc = loadRamayanaCase();
    for (const [n, reply] of [[4, expected.replyShapes.page4], [9, expected.replyShapes.page9]] as const) {
      const { heads } = marksFor(doc, pageByN(doc, n), reply, { v2: true });
      expect(headsAreReal(heads), `page ${n}`).toBe(true);
      expect(heads.length, `page ${n}`).toBeGreaterThan(0);
    }
    expect(marksFor(doc, pageByN(doc, 3), expected.replyShapes.page3, { v2: true }).heads.map((h) => h.head)).toEqual(today.page3HeadsAfterCheck);
    expect(marksFor(doc, pageByN(doc, 9), expected.replyShapes.page9, { v2: true }).heads.map((h) => h.head)).toEqual([
      { x: 0.3, y: 0.2 },
      { x: 0.7, y: 0.2 }
    ]);
  });

  // P5-QC (COMIC_QC_V2, flipped): Rama's name on the bridge stones is an inscription the story needs, not stray text. The
  // case has no glossary (i18n is stripped), so the in-memory doc gets the one glossary entry it needs (Rama → राम). The
  // v2 check lists the stones' text among the scene's inscriptions (the day's v1 reply had no such field, so the test
  // adds what a v2 reply says). A glossary name the check did not list stays stray text: name labels painted next to
  // characters are a real overlay failure.
  it("the page-9 check does not call Rama's name on the bridge stones stray text, and says it is in Latin letters (COMIC_QC_V2)", async () => {
    const doc = withRamaGlossary(loadRamayanaCase());
    const page9 = { ...expected.replyShapes.page9, inscriptions: [{ text: 'RAM', script: 'Latin' }] };
    const { qc } = await checkWithReply(doc, pageByN(doc, 9), page9, { qcV2: true });
    expect(qc.issues.filter((i) => i.startsWith('Stray text'))).toEqual([]);
    expect(qc.issues).toContain('Inscription "RAM" (Rama) is drawn in Latin letters; the glossary writes it राम.');
    expect(qc.score).toBeGreaterThan(today.page9Score);
    expect(qc.heads?.every((h) => h.head.x > 0.01 && h.head.y > 0.01)).toBe(true);
    // Without a glossary the same reply is still capped: v2 never treats a bare cast name as an inscription.
    const bare = await checkWithReply(loadRamayanaCase(), pageByN(doc, 9), page9, { qcV2: true });
    expect(bare.qc.score).toBe(today.page9Score);
    // With the glossary but without the check listing it as part of the scene, it is still stray text.
    const unlisted = await checkWithReply(doc, pageByN(doc, 9), expected.replyShapes.page9, { qcV2: true });
    expect(unlisted.qc.score).toBe(today.page9Score);
  });

  // P5-EDIT-INTENT (W3): the note is understood before a picture is paid for.
  it.fails('the page-9 edit prompt does not start with the raw note', () => {
    const doc = loadRamayanaCase();
    const note = (pageByN(doc, 9).render.note || '').toLowerCase();
    expect(compileCaseEdit(doc).prompt.toLowerCase()).not.toContain(note);
  });
});
