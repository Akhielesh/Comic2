// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { editionProgress, i18nOf, lineSourceHash, textSourceHash } from '../../../../shared/comic/i18n.js';
import { applyOps } from '../../../../shared/comic/ops.js';
import type { ComicDoc } from '../../../../shared/comic/doc.js';
import { DEFAULT_CAPS, type StudioCaps } from '../../../../shared/comic/capabilities.js';
import { JOB_TIMINGS } from '../jobs.js';
import { newSession, scriptedLlm, testContext } from '../orchestrator.fakes.js';
import { createDirectorTurn, type DirectorTurn } from '../tools.js';
import { resetTranslationCalibration } from '../i18n/index.js';
import { fakeLinguist, fakeTranslator, sixPageKidsDoc, times } from '../i18n/testing.js';
import { I18N_PROMPT_RULES, i18nToolGroup, languagesSummary } from './i18n.js';

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
});
