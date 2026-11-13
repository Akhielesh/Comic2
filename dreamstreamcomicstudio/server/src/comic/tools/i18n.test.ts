// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { editionProgress, i18nOf, lineSourceHash, textSourceHash } from '../../../../shared/comic/i18n.js';
import { applyOps } from '../../../../shared/comic/ops.js';
import type { ComicDoc } from '../../../../shared/comic/doc.js';
import { DEFAULT_CAPS, type StudioCaps } from '../../../../shared/comic/capabilities.js';
import { LANGUAGES } from '../../../../shared/comic/languages.js';
import { LAKE_MODEL, makeLakeComic } from '../../../../shared/comic/__fixtures__/lakeComic.js';
import { runDirectorTurn } from '../director.js';
import { MAX_TOOLS_PER_TURN } from '../extensions.js';
import { sixPageDrawnDoc } from '../golden/fixtures.js';
import { JOB_TIMINGS } from '../jobs.js';
import { newSession, plannedDoc, scriptedLlm, testContext } from '../orchestrator.fakes.js';
import { buildTurnToolset, createDirectorTurn, type DirectorTurn } from '../tools.js';
import { toolGroups } from './index.js';
import { resetTranslationCalibration } from '../i18n/index.js';
import { fakeLinguist, fakeTranslator, sixPageKidsDoc, times } from '../i18n/testing.js';
import { I18N_PROMPT_RULES, i18nPromptRules, i18nToolGroup, isLanguageAsk, languagesSummary } from './i18n.js';

vi.mock('../safety/index.js', async (orig) => {
  const real = await orig<typeof import('../safety/index.js')>();
  return { ...real, prefilterText: vi.fn(real.prefilterText) };
});
const safety = await import('../safety/index.js');

beforeEach(() => {
  vi.mocked(safety.prefilterText).mockClear();
  JOB_TIMINGS.retryBackoffMs = 0;
  resetTranslationCalibration();
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

const lineOf = (doc: ComicDoc, id: string) => doc.pages.flatMap((p) => p.panels.flatMap((pn) => pn.lines)).find((l) => l.id === id)!;

function setup(doc: ComicDoc = sixPageKidsDoc(), userText = 'translate it into Telugu', llmScript: Parameters<typeof scriptedLlm>[0] = {}, caps?: StudioCaps) {
  const session = newSession(doc);
  const ctx = testContext(session, { llm: scriptedLlm(llmScript), ...(caps ? { caps } : {}) });
  const turn: DirectorTurn = createDirectorTurn({ userText });
  const tools = Object.fromEntries(i18nToolGroup.tools(ctx, turn).map((t) => [t.spec.function.name, t]));
  return { session, ctx, turn, tools };
}

/** A Telugu edition, translated and reviewed, without any model. */
function translated(doc = sixPageKidsDoc(), lang = 'te'): ComicDoc {
  let d = applyOps(doc, [{ op: 'edition', lang, patch: {} }]);
  const lines: Record<string, { text: string; status: 'reviewed'; sourceHash: string; at: number; gloss: string }> = {};
  for (const p of d.pages) for (const pn of p.panels) for (const l of pn.lines) lines[l.id] = { text: `తెలుగు ${l.id}`, status: 'reviewed', sourceHash: lineSourceHash(l), at: 1, gloss: `Means: ${l.text}` };
  d = applyOps(d, [{ op: 'translations', lang, lines }]);
  for (const field of ['brief.title', 'brief.logline'] as const) {
    const source = field === 'brief.title' ? d.brief.title : d.brief.logline || '';
    d = applyOps(d, [{ op: 'edition_text', lang, field, value: { text: `తెలుగు ${field}`, status: 'reviewed', sourceHash: textSourceHash(source), at: 1 } }]);
  }
  return d;
}

describe('i18n tool group', () => {
  it('phase gate: language words, a non-English comic, or editions exist', () => {
    const { ctx } = setup();
    expect(i18nToolGroup.when!(ctx, createDirectorTurn({ userText: 'make the hero taller' }))).toBe(false);
    expect(i18nToolGroup.when!(ctx, createDirectorTurn({ userText: 'can readers get this in Hindi?' }))).toBe(true);
    expect(i18nToolGroup.when!(ctx, createDirectorTurn({ userText: 'దీన్ని తెలుగులో చేయి' }))).toBe(true);
    const withEdition = setup(translated()).ctx;
    expect(i18nToolGroup.when!(withEdition, createDirectorTurn({ userText: 'hello' }))).toBe(true);
    expect(Object.keys(setup().tools).sort()).toEqual(['edit_translation', 'read_translation', 'set_comic_language', 'set_glossary', 'translate_comic']);
    expect(setup().tools.translate_comic.spec.function.description.startsWith('PAID (quoted) — ')).toBe(true);
    expect(setup().tools.read_translation.spec.function.description.startsWith('FREE — ')).toBe(true);
    // no published list, no set_reader_languages (owner amendment)
    expect(Object.keys(setup().tools)).not.toContain('set_reader_languages');
    expect(I18N_PROMPT_RULES).toContain('set_comic_language with mode relabel BEFORE plan_pages');
  });

  it('summary line lists the source and each edition with its state', () => {
    expect(languagesSummary(sixPageKidsDoc())).toBeUndefined();
    const doc = applyOps(translated(), [{ op: 'line', pageId: 'pg_1', panelId: 'pn_1', id: 'l1', patch: { text: 'Where is the moon now?' } }]);
    expect(languagesSummary(doc)).toBe('Languages: source en; editions te (draft, 92%: 1 stale)');
    expect(languagesSummary(translated())).toBe('Languages: source en; editions te (publishable, 100%)');
  });

  it('language words: every registry language by its English name and by its own name, "versions" and "mother tongue"', () => {
    const { ctx } = setup();
    const opens = (userText: string) => i18nToolGroup.when!(ctx, createDirectorTurn({ userText }));
    expect(opens('in my mother tongue please')).toBe(true);
    expect(opens('other versions for my cousins')).toBe(true);
    for (const l of LANGUAGES) {
      const english = l.english.replace(/\s*\(.*$/, '');
      expect(opens(`add a ${english} one`), l.english).toBe(true);
      expect(opens(`one more: ${l.endonym}`), l.endonym).toBe(true);
    }
    // In a sentence, any letter case; a longer word that only starts like a language name is not one.
    expect(opens('y también en español, por favor')).toBe(true);
    expect(opens('AUF DEUTSCH BITTE')).toBe(true);
    expect(opens('the hero is a Germanic warrior')).toBe(false);
    expect(opens('make the hero taller')).toBe(false);
  });

  it('the rule: translate the languages named, never ask which to "set active", and say truthfully when the user approves', () => {
    expect(I18N_PROMPT_RULES).toContain('call translate_comic with the languages they named');
    expect(I18N_PROMPT_RULES).toContain('Never use ask_user to choose languages');
    expect(I18N_PROMPT_RULES).toMatch(/never offer to "switch" or "set active" a language/);
    expect(I18N_PROMPT_RULES).toContain("Call set_comic_language only when they ask to change the comic's own language");
    expect(I18N_PROMPT_RULES).toContain('If they named no language');
    // ask_user is the tool that shows tappable options: banned for languages already named, used when none were. Its
    // chip replies name a language, so the next turn opens the language tools (the phase gate reads only that turn).
    expect(I18N_PROMPT_RULES).toContain('Never use ask_user to choose languages they already named');
    expect(I18N_PROMPT_RULES).toMatch(/If they named no language, call ask_user once with multi: true and two to five languages[^.]*its reply is "Translate into <language>"/);
    const { ctx } = setup();
    expect(i18nToolGroup.when!(ctx, createDirectorTurn({ userText: 'Translate into Telugu' }))).toBe(true);
    // The old promise was untrue under "big spends only" (a cheap translate started with no card).
    expect(I18N_PROMPT_RULES).not.toContain('quotes first');
    expect(I18N_PROMPT_RULES).toContain("the studio shows the price and waits for the user's Approve");
    // The languages on offer are the real ones, never the comic's own.
    expect(I18N_PROMPT_RULES).toContain('You can translate into: Hindi, Telugu, Tamil,');
    expect(I18N_PROMPT_RULES).not.toMatch(/translate into: [^.]*English/);
    const telugu = sixPageKidsDoc();
    telugu.format = { ...telugu.format, language: 'te' };
    expect(i18nPromptRules(telugu)).toMatch(/You can translate into: English, Hindi, Tamil,/);
    const never = sixPageKidsDoc();
    never.settings = { ...never.settings, confirm: 'never' };
    expect(i18nToolGroup.promptRules!(never)).toBe(i18nPromptRules(never));
    expect(i18nToolGroup.promptRules!(sixPageKidsDoc())).toBe(I18N_PROMPT_RULES);
  });
});

describe('translate_comic', () => {
  it('names resolve ("Telugu", "తెలుగు"); unknown names get the supported list; the source is a no-op', async () => {
    const { tools } = setup();
    expect(await tools.translate_comic.execute({ languages: ['Klingon'] })).toMatch(/^Error: I don't know Klingon as a language\. I can translate into: Hindi, Telugu/);
    expect(await tools.translate_comic.execute({ languages: ['English'] })).toContain("already the comic's language");
    expect(await tools.translate_comic.execute({ languages: ['te'], pages: [9] })).toBe('Error: There is no page 9. The comic has 6 pages.');
  });

  it('starts a quoted spend under the policy (small → runs) and the director message gets the live card', async () => {
    const { tools, turn, ctx, session } = setup(sixPageKidsDoc(), 'translate it into తెలుగు', { translator: times(4, fakeTranslator().step), linguist: times(2, fakeLinguist()) });
    const out = await tools.translate_comic.execute({ languages: ['తెలుగు'] });
    expect(out).toMatch(/^Translating 12 lines into Telugu \(≈ \$0\.\d+\); 2 lines reused for free\. Every line gets a linguist review\./);
    expect(turn.cards.map((c) => c.type)).toEqual(['translation']);
    expect(turn.spentUsd).toBeGreaterThan(0);
    await ctx.settled();
    expect(editionProgress(session.doc, 'te').missing).toBe(0);
  });

  it('a proactive offer (no language words) always gates; one approval per turn', async () => {
    const { tools, turn, session, ctx } = setup(sixPageKidsDoc(), 'looks great, what next?');
    const out = await tools.translate_comic.execute({ languages: ['hi'] });
    expect(out).toMatch(/Quoted|Waiting|waiting/);
    // The card names the languages by code; the director reads their names.
    expect(out).toContain('That is Hindi: say the languages and the price in one line and stop');
    expect(turn.gated).toBe(true);
    expect(session.doc.gate).toMatchObject({ status: 'open', reason: 'no_intent' });
    expect(ctx.llmFake.calls).toHaveLength(0);
    expect(await tools.translate_comic.execute({ languages: ['ta'] })).toMatch(/^Refused: a spend from this turn is already waiting/);
  });

  it('$0 when everything is cached: no gate, no model call, honest "already up to date"', async () => {
    const doc = translated();
    doc.settings = { ...doc.settings, confirm: 'always' };
    const { tools, ctx, session } = setup(doc, 'translate into Telugu');
    const out = await tools.translate_comic.execute({ languages: ['te'] });
    expect(out).toContain('Telugu is already up to date. Nothing to translate ($0).');
    expect(session.doc.gate).toBeNull();
    expect(ctx.llmFake.calls).toHaveLength(0);
  });

  it('in-art comics get the overlay note with the redraw price', async () => {
    const doc = sixPageKidsDoc();
    doc.format = { ...doc.format, lettering: 'in_art' };
    doc.pages = doc.pages.map((p) => ({ ...p, render: { ...p.render, status: 'ready', asset: { path: `u/x/p/${p.id}.webp`, source: 'generated', at: 1 } } }));
    doc.settings = { ...doc.settings, confirm: 'always' };
    const { tools } = setup(doc, 'translate into Hindi');
    const out = await tools.translate_comic.execute({ languages: ['hi'] });
    expect(out).toMatch(/translated editions need overlay lettering \(owner rule\): redrawing 6 pages without text costs ≈ \$/);
  });
});

describe('a language ask keeps its tools (the real registry, as director.ts builds a turn)', () => {
  /** A drawn, model-locked book whose pages have versions: its timeline group alone fills the rest of the budget. */
  const lockedLakeDoc = () => makeLakeComic((d) => (d.imageModel = { modelId: LAKE_MODEL, lockedAt: 1, origin: 'first_render' }));
  const FIXTURES: Record<string, () => ComicDoc> = { plannedDoc: () => plannedDoc(), sixPageDrawnDoc, lockedLakeDoc };
  const offered = (doc: ComicDoc, userText: string) => {
    const set = buildTurnToolset(testContext(newSession(doc)), createDirectorTurn({ userText }), toolGroups());
    return { groups: set.groups, names: set.tools.map((t) => t.spec.function.name), rules: set.promptRules.join('\n') };
  };

  // "version", "book", "switch" and "copy" are timeline words: they used to hand these turns to the page timeline,
  // and the director was left with no translate tool and no language rule (the owner's "add telugu and hindi versions").
  const ASKS = ['add telugu and hindi versions', 'translate the book into Hindi', 'switch the comic to Hindi', 'make a Tamil copy', 'Telugu version కూడా add చేయి', 'हिंदी version भी बनाओ'];
  for (const [fixture, make] of Object.entries(FIXTURES)) {
    for (const ask of ASKS) {
      it(`${fixture}: "${ask}" offers translate_comic and the language rule`, () => {
        const { groups, names, rules } = offered(make(), ask);
        expect(groups, ask).toContain('i18n');
        expect(names, ask).toEqual(expect.arrayContaining(['translate_comic', 'set_comic_language', 'read_translation']));
        expect(rules, ask).toContain('Never use ask_user to choose languages');
        // The page timeline stood down: its tools and this group's cannot both fit.
        expect(groups, ask).not.toContain('timeline');
        expect(names.length).toBeLessThanOrEqual(MAX_TOOLS_PER_TURN);
      });
    }
  }

  // A page, or a numbered or earlier take, is what these sentences act on: the timeline keeps the turn, as before.
  const PAGE_TURNS: [string, string][] = [
    ['restore the previous version of page 2', 'use_version'],
    ['use version 2 of the Hindi edition', 'use_version'],
    ['go back to the earlier version in Hindi', 'use_version'],
    ['delete page 3 of the Hindi version', 'delete_page'],
    ['duplicate page 1 and translate it into Tamil', 'duplicate_page'],
    // A language name used as a plain adjective is not an ask; neither is a message that only happens to be typed in another script.
    ['restore the earlier version with the Chinese dragon', 'use_version'],
    ['దీన్ని duplicate చేయి', 'duplicate_page'],
    ['move the second page to the top', 'move_page'],
    // A page put or dragged, or the book's shape, on an edition: still the timeline's (commit 2 used to take these).
    ['put page 3 before page 2 in the Hindi version', 'move_page'],
    ['make the Hindi edition a square book', 'set_book']
  ];
  // The same kind of sentence, but the timeline's tools did not fit even before the language stand-down (an older
  // budget loss in tools.ts): never a language ask, so this group does not make it worse.
  const PAGE_TURNS_OVER_BUDGET = [
    'drag page 4 to the front of the Telugu edition',
    'use the old version of page 2 in Hindi',
    'go back to the original page 2 from before the Hindi translation'
  ];
  for (const [say, tool] of PAGE_TURNS) {
    it(`lockedLakeDoc: "${say}" keeps ${tool}`, () => {
      const { groups, names } = offered(lockedLakeDoc(), say);
      expect(groups, say).toContain('timeline');
      expect(names, say).toContain(tool);
    });
  }

  it('isLanguageAsk: a language named as what the comic should be in, never a page action', () => {
    for (const ask of ASKS) expect(isLanguageAsk(ask), ask).toBe(true);
    for (const ask of ['make it in Telugu too', 'translate this into Hindi and Tamil', 'हिन्दी में भी चाहिए']) expect(isLanguageAsk(ask), ask).toBe(true);
    for (const [say] of PAGE_TURNS) expect(isLanguageAsk(say), say).toBe(false);
    for (const say of PAGE_TURNS_OVER_BUDGET) expect(isLanguageAsk(say), say).toBe(false);
    // Not a page action: "copy page 2 into Hindi" and Hindi subtitles on every page are translations.
    for (const ask of ['copy page 2 into Hindi', 'add Hindi subtitles to every page']) expect(isLanguageAsk(ask), ask).toBe(true);
    for (const say of ['make the hero taller', 'other versions for my cousins', 'show me other versions of the cover', '']) expect(isLanguageAsk(say), say).toBe(false);
  });

  it("the owner's words on a drawn book: the director gets the tool, calls it for both languages, and the Approve card waits", async () => {
    // "Always ask": this test is about the tools reaching the director, whatever the money settings decide.
    const session = newSession(makeLakeComic((d) => ((d.imageModel = { modelId: LAKE_MODEL, lockedAt: 1, origin: 'first_render' }), (d.settings = { ...d.settings, confirm: 'always' }))));
    const call = { id: 'c1', name: 'translate_comic', arguments: JSON.stringify({ languages: ['Telugu', 'Hindi'] }) };
    const llm = scriptedLlm({ director: [{ text: '', toolCalls: [call] }, { text: 'Telugu and Hindi are priced. Tap Approve to start.' }] });
    const ctx = testContext(session, { llm });
    await runDirectorTurn(ctx, { text: 'add telugu and hindi versions', attachments: [] });
    await ctx.settled();
    const first = llm.calls[0];
    expect(first.tools!.map((t) => t.function.name)).toContain('translate_comic');
    expect(JSON.stringify(first.messages[0])).toContain('Never use ask_user to choose languages');
    expect(session.doc.gate).toMatchObject({ status: 'open', reason: 'policy', action: { type: 'translate', languages: ['te', 'hi'] } });
    const reply = session.doc.conversation[session.doc.conversation.length - 1];
    expect(reply.cards!.map((c) => c.type)).toContain('gate');
    expect(llm.calls.filter((c) => c.role !== 'director')).toHaveLength(0);
    expect(session.doc.spend.entries.filter((e) => e.kind === 'translate')).toHaveLength(0);
  });
});

describe('set_comic_language', () => {
  it('relabel is free when the lines are already in that language (or none exist); English lines are never mislabelled', async () => {
    // Lines already typed in Telugu but labelled English → relabel fixes the label for free.
    const native = sixPageKidsDoc();
    for (const p of native.pages) for (const pn of p.panels) for (const l of pn.lines) l.text = 'మనం ఆలస్యం అయ్యాం!';
    const { tools, session } = setup(native, 'make it a Telugu comic');
    expect(await tools.set_comic_language.execute({ language: 'Telugu', mode: 'relabel' })).toContain('The comic is now written in తెలుగు (Telugu) (free).');
    expect(session.doc.format.language).toBe('te');
    // English lines: relabelling to Telugu would only mislabel them — the tool says to translate instead.
    const en = setup(sixPageKidsDoc(), 'make it a Telugu comic');
    const refused = await en.tools.set_comic_language.execute({ language: 'Telugu', mode: 'relabel' });
    expect(refused).toContain('relabelling would mislabel them');
    expect(refused).toContain('mode rewrite');
    expect(en.session.doc.format.language).toBe('en');
    // Same script (English → Spanish) can't be told apart by software: the director's call stands.
    const es = setup(sixPageKidsDoc(), 'these lines are Spanish');
    expect(await es.tools.set_comic_language.execute({ language: 'es', mode: 'relabel' })).toContain('(free)');
    const t = setup(translated(), 'make it Telugu');
    expect(await t.tools.set_comic_language.execute({ language: 'te', mode: 'relabel' })).toContain('mode rewrite');
  });

  it('rewrite with a complete edition swaps the source for free; other editions stay current', async () => {
    const doc = translated(translated(), 'hi');
    const { tools, session } = setup(doc, 'make the comic itself Telugu');
    const out = await tools.set_comic_language.execute({ language: 'te', mode: 'rewrite' });
    expect(out).toContain("తెలుగు (Telugu) is now the comic's language; English became a reviewed translation (free).");
    const d = session.doc;
    expect(d.format.language).toBe('te');
    expect(lineOf(d, 'l1').text).toBe('తెలుగు l1');
    expect(i18nOf(d).editions.te).toBeUndefined();
    expect(i18nOf(d).editions.en.lines.l1).toMatchObject({ text: 'Where did the moon go?', status: 'reviewed' });
    expect(editionProgress(d, 'en')).toMatchObject({ missing: 0, stale: 0, unreviewed: 0 });
    expect(editionProgress(d, 'hi')).toMatchObject({ missing: 0, stale: 0 }); // re-hashed, not stale
  });

  it('rewrite with an incomplete edition translates first (quoted)', async () => {
    const doc = sixPageKidsDoc();
    doc.settings = { ...doc.settings, confirm: 'always' };
    const { tools, session } = setup(doc, 'switch the comic to Hindi');
    const out = await tools.set_comic_language.execute({ language: 'hi', mode: 'rewrite' });
    expect(out).toContain('call set_comic_language rewrite again');
    expect(session.doc.gate?.action).toMatchObject({ type: 'translate', languages: ['hi'] });
  });
});

describe('edit_translation / read_translation / set_glossary', () => {
  it('edit_translation commits an edited line and reports the fit', async () => {
    const { tools, session } = setup(translated(), 'change the Telugu on page 1');
    expect(await tools.edit_translation.execute({ language: 'te', page: 1, panel: 1, line: 1, text: 'చంద్రుడు ఎక్కడ?' })).toBe('Updated. Fits its balloon.');
    expect(i18nOf(session.doc).editions.te.lines.l1).toMatchObject({ text: 'చంద్రుడు ఎక్కడ?', status: 'edited' });
    expect(i18nOf(session.doc).editions.te.lines.l1.gloss).toBeUndefined();
    const long = 'చంద్రుడు '.repeat(30);
    expect(await tools.edit_translation.execute({ language: 'Telugu', lineId: 'l2', text: long })).toMatch(/^Updated, but it's \d+ characters longer than the balloon on page 1/);
    expect(await tools.edit_translation.execute({ language: 'te', page: 1, panel: 1, text: 'x' })).toMatch(/^Error: Page 1 panel 1 has 2 lines; say which/);
    expect(await tools.edit_translation.execute({ language: 'en', page: 1, panel: 1, line: 1, text: 'x' })).toMatch(/edit_panel_text/);
  });

  it('read_translation lists source → translation with status and gloss (≤ 6 KB)', async () => {
    const { tools } = setup(translated(), 'how does it read in Telugu?');
    const out = await tools.read_translation.execute({ language: 'Telugu', pages: [1] });
    expect(out.split('\n')[0]).toBe('తెలుగు (Telugu) — ready to publish');
    expect(out).toContain('P1·Panel 1 · MILO (speech): "Where did the moon go?" → "తెలుగు l1" [reviewed] gloss: "Means: Where did the moon go?"');
    expect(out.length).toBeLessThan(6500);
    const none = setup().tools;
    expect(await none.read_translation.execute({ language: 'hi' })).toMatch(/^There is no Hindi translation yet\. translate_comic would cost ≈ \$/);
  });

  it('set_glossary adds terms and renames a form through the edition for $0', async () => {
    let doc = translated();
    doc = applyOps(doc, [{ op: 'translations', lang: 'te', lines: { l12: { text: 'శుభరాత్రి, మైలో.', status: 'reviewed', sourceHash: lineSourceHash(lineOf(doc, 'l12')), at: 1 } } }]);
    doc = applyOps(doc, [{ op: 'glossary_term', id: 'gl_c_c_milo', patch: { term: 'Milo', kind: 'character', forms: { te: 'మైలో' } } }]);
    const { tools, session } = setup(doc, 'spell Milo as మిలో in Telugu');
    const out = await tools.set_glossary.execute({ entries: [{ term: 'Milo', forms: { Telugu: 'మిలో' } }, { term: 'Moon Lake', policy: 'translate' }] });
    expect(out).toBe('Glossary saved ($0): Milo (మైలో → మిలో in 1 Telugu line), Moon Lake (added).');
    expect(i18nOf(session.doc).editions.te.lines.l12.text).toBe('శుభరాత్రి, మిలో.');
    expect(i18nOf(session.doc).glossary.find((g) => g.term === 'Moon Lake')).toMatchObject({ policy: 'translate', kind: 'term' });
  });

  it('set_glossary never copies a blocked form into the translated lines (the same $0 pre-filter as typed text)', async () => {
    let doc = translated();
    doc = applyOps(doc, [{ op: 'translations', lang: 'te', lines: { l12: { text: 'శుభరాత్రి, మైలో.', status: 'reviewed', sourceHash: lineSourceHash(lineOf(doc, 'l12')), at: 1 } } }]);
    doc = applyOps(doc, [{ op: 'glossary_term', id: 'gl_c_c_milo', patch: { term: 'Milo', kind: 'character', forms: { te: 'మైలో' } } }]);
    const real = vi.mocked(safety.prefilterText).getMockImplementation()!;
    vi.mocked(safety.prefilterText).mockImplementation((text, rating) => (text === 'BADWORD' ? { decision: 'block', categories: [], ip: [] } : real(text, rating)));
    const { tools, session } = setup(doc, 'rename Milo in Telugu');
    const out = await tools.set_glossary.execute({ entries: [{ term: 'Milo', forms: { te: 'BADWORD' } }, { term: 'BADWORD' }] });
    expect(out).toContain("Telugu: skipped — that wording doesn't fit the content rules");
    expect(out).toContain('BADWORD (skipped');
    expect(i18nOf(session.doc).editions.te.lines.l12.text).toBe('శుభరాత్రి, మైలో.');
    expect(i18nOf(session.doc).glossary.some((g) => g.term === 'BADWORD' || g.forms.te === 'BADWORD')).toBe(false);
    vi.mocked(safety.prefilterText).mockImplementation(real);
  });
});

describe('prices the director reads are worded for the user', () => {
  const governed: StudioCaps = { ...DEFAULT_CAPS, usage: { governed: true, pctLeft: 80, exhausted: false, pctPerStandardPage: 5 } };
  const usage = /(?:≈[\d.]+|<0\.1)% of your usage/;

  it('a governed user: the overlay note and the "no translation yet" quote are a share of the usage, never dollars', async () => {
    const doc = sixPageKidsDoc();
    doc.format = { ...doc.format, lettering: 'in_art' };
    doc.pages = doc.pages.map((p) => ({ ...p, render: { ...p.render, status: 'ready', asset: { path: `u/x/p/${p.id}.webp`, source: 'generated', at: 1 } } }));
    doc.settings = { ...doc.settings, confirm: 'always' };
    const { tools } = setup(doc, 'translate into Hindi', {}, governed);
    const out = await tools.translate_comic.execute({ languages: ['hi'] });
    expect(out).toMatch(new RegExp(`redrawing 6 pages without text costs ${usage.source}`));
    expect(out).not.toMatch(/\$\d/);
    const none = setup(sixPageKidsDoc(), 'how is the Hindi?', {}, governed).tools;
    const quote = await none.read_translation.execute({ language: 'hi' });
    expect(quote).toMatch(new RegExp(`^There is no Hindi translation yet\\. translate_comic would cost ${usage.source}\\.$`));
  });

  it('an admin still reads the same dollar quote as before', async () => {
    const none = setup(sixPageKidsDoc(), 'how is the Hindi?', {}, { ...governed, admin: true }).tools;
    expect(await none.read_translation.execute({ language: 'hi' })).toMatch(/^There is no Hindi translation yet\. translate_comic would cost ≈ \$\d/);
  });

  it("the run's own words reach the director in the same currency: started and cached runs never carry dollars", async () => {
    const { tools, ctx } = setup(sixPageKidsDoc(), 'translate it into తెలుగు', { translator: times(4, fakeTranslator().step), linguist: times(2, fakeLinguist()) }, governed);
    const out = await tools.translate_comic.execute({ languages: ['తెలుగు'] });
    expect(out).toMatch(/Telugu/);
    expect(out).not.toMatch(/\$/);
    expect(out).toMatch(new RegExp(`^Translating 12 lines into Telugu \\(${usage.source}\\)`));
    await ctx.settled();
    const cachedDoc = translated();
    cachedDoc.settings = { ...cachedDoc.settings, confirm: 'always' };
    const cached = await setup(cachedDoc, 'translate into Telugu', {}, governed).tools.translate_comic.execute({ languages: ['te'] });
    expect(cached).toContain('Telugu is already up to date. Nothing to translate (free).');
  });
});
