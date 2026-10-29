// @vitest-environment node
// The translation pipeline end to end with a fake LLM (no network, $0): software-first plan, the
// writer-class translator per chunk, validation + one repair round, the safety hook, the linguist
// review (always), duplicates copied for free, spend, the appended completion message, gating.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { editionReadiness, editionProgress, i18nOf, lineSourceHash, textSourceHash } from '../../../../shared/comic/i18n.js';
import { applyOps, type StudioAction } from '../../../../shared/comic/ops.js';
import { AUTO_CORRECTED_NOTE, editionTextEntry, planTranslation } from '../../../../shared/comic/translationPlan.js';
import type { ComicDoc } from '../../../../shared/comic/doc.js';
import { GOLDEN_DOCS } from '../golden/fixtures.js';
import { JOB_TIMINGS, startAction } from '../jobs.js';
import { newSession, opsOf, scriptedLlm, testContext, type TestContext } from '../orchestrator.fakes.js';
import { DEFAULT_CAPS, type StudioCaps } from '../../../../shared/comic/capabilities.js';
import type { Card, Msg } from '../../../../shared/comic/doc.js';
import { costViewFor } from '../costText.js';
import { TEXT_ROLE_DEFAULTS } from '../textModels.js';
import { completionMessage, estimateTranslation, quoteTranslation, resetTranslationCalibration, resolveLanguage, resolveLanguages, runTranslation, translationRunning } from './index.js';
import { applyReview } from './linguist.js';
import { linguistSystemPrompt } from './prompts.js';
import { checkLine, readTranslatorOutput, scriptShare } from './translate.js';
import { fakeLinguist, fakeTranslator, requestedItems, sixPageKidsDoc, times } from './testing.js';
import type { LlmRequest } from '../types.js';

vi.mock('../safety/index.js', async (orig) => {
  const real = await orig<typeof import('../safety/index.js')>();
  return { ...real, prefilterText: vi.fn(real.prefilterText) };
});
const safety = await import('../safety/index.js');

beforeEach(() => {
  JOB_TIMINGS.retryBackoffMs = 0;
  resetTranslationCalibration();
  vi.mocked(safety.prefilterText).mockClear();
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

const T = (action: Partial<Extract<StudioAction, { type: 'translate' }>> = {}): Extract<StudioAction, { type: 'translate' }> => ({ type: 'translate', languages: ['te'], ...action });

async function run(doc: ComicDoc, llmScript: Parameters<typeof scriptedLlm>[0], action = T(), keys?: TestContext['keys']) {
  const session = newSession(doc);
  const llm = scriptedLlm(llmScript);
  const ctx = testContext(session, { llm, ...(keys ? { keys } : {}) });
  const started = await runTranslation(ctx, action, { confirmed: true, origin: 'user' });
  await started.done;
  await ctx.settled();
  return { session, ctx, llm, started };
}

const roles = (ctx: TestContext, role: string) => ctx.llmFake.calls.filter((c) => c.role === role);

describe('acceptance — a Telugu run on a 6-page comic is publishable after the review; a rerun makes no LLM call', () => {
  it('6-page kids comic → te: translated, reviewed (gloss on every line), publishable; rerun is $0', async () => {
    const tr = fakeTranslator();
    const { session, ctx, started } = await run(sixPageKidsDoc(), { translator: times(4, tr.step), linguist: times(2, fakeLinguist()) });
    expect(started.outcome.status).toBe('started');
    expect(roles(ctx, 'translator')).toHaveLength(2); // 6 pages → two 3-page chunks; titles ride in the first
    expect(roles(ctx, 'linguist')).toHaveLength(1); // the review ALWAYS runs
    const doc = session.doc;
    const p = editionProgress(doc, 'te');
    expect(p).toMatchObject({ missing: 0, stale: 0, unreviewed: 0, total: 12 });
    expect(editionReadiness(doc, 'te')).toEqual({ publishable: true, issues: [] });
    const e = i18nOf(doc).editions.te;
    // the duplicate "Ribbit!" (l5) and the "..." line cost nothing, and still read as reviewed
    expect(e.lines.l5).toMatchObject({ text: e.lines.l2.text, status: 'reviewed', gloss: e.lines.l2.gloss });
    expect(e.lines.l4).toMatchObject({ text: '…', status: 'reviewed' });
    for (const id of ['l1', 'l3', 'l6', 'l9', 'l12']) expect(e.lines[id].gloss).toMatch(/^Means: /);
    expect(e.brief?.title?.status).toBe('reviewed');
    // writer-class translator chain (amendment): the translator role resolves to the writer chain
    expect(TEXT_ROLE_DEFAULTS.translator.models).toEqual(TEXT_ROLE_DEFAULTS.writer.models);
    // spend recorded under 'translate'; the completion message is a NEW message at the end
    expect(doc.spend.entries.some((s) => s.kind === 'translate' && s.label === 'Translate · Telugu' && s.usd > 0)).toBe(true);
    const last = doc.conversation[doc.conversation.length - 1];
    expect(last.role).toBe('assistant');
    expect(last.text).toContain('Telugu is translated and reviewed.');
    expect(last.text).toContain('Ready to publish in తెలుగు');
    expect(last.nextSteps?.map((s) => s.label)).toEqual(expect.arrayContaining(['Review translations', 'Publish']));

    // rerun: cache hit by sourceHash → no LLM call, done, "$0"
    const llm2 = scriptedLlm({});
    const ctx2 = testContext(session, { llm: llm2 });
    const again = await runTranslation(ctx2, T(), { confirmed: true, origin: 'user' });
    await again.done;
    expect(llm2.calls).toHaveLength(0);
    expect(again.outcome).toMatchObject({ status: 'done' });
    expect(again.outcome.message).toContain('already up to date. Nothing to translate ($0)');
    expect((await estimateTranslation(ctx2, T())).usd).toBe(0);
  });

  it('the golden six-page action comic (6 × "Jump!") needs ONE translated line; 5 duplicates are free', async () => {
    const tr = fakeTranslator();
    const { session, ctx } = await run(GOLDEN_DOCS['six-drawn'](), { translator: times(2, tr.step), linguist: times(2, fakeLinguist()) }, T({ languages: ['hi'] }));
    expect(roles(ctx, 'translator')).toHaveLength(1);
    const items = requestedItems(tr.calls[0]);
    expect(Object.keys(items).filter((id) => id.startsWith('ln_six'))).toEqual(['ln_six_1']);
    const r = editionReadiness(session.doc, 'hi');
    expect(r.publishable).toBe(true);
    // the painted cover title is a non-blocking warning, with the one-time textless offer
    expect(r.issues.map((i) => i.code)).toEqual(['cover_in_art']);
    const last = session.doc.conversation[session.doc.conversation.length - 1];
    expect(last.nextSteps?.find((s) => s.label === 'Textless cover')?.action).toMatchObject({ type: 'render_cover', textless: true });
  });
});

describe('software first: caching and misses', () => {
  it('miss: only the stale ids go to the translator, with their previous translation', async () => {
    const first = await run(sixPageKidsDoc(), { translator: times(4, fakeTranslator().step), linguist: times(2, fakeLinguist()) });
    const doc = applyOps(first.session.doc, [{ op: 'line', pageId: 'pg_5', panelId: 'pn_5', id: 'l9', patch: { text: 'We found the moon together, Frog.' } }]);
    const tr = fakeTranslator();
    const second = await run(doc, { translator: times(2, tr.step), linguist: times(2, fakeLinguist()) });
    expect(roles(second.ctx, 'translator')).toHaveLength(1);
    const items = requestedItems(tr.calls[0]);
    const lineIds = Object.keys(items).filter((id) => /^l\d+$/.test(id));
    expect(lineIds).toEqual(['l9']);
    expect(items.l9.previous).toBe(i18nOf(doc).editions.te.lines.l9.text);
    // only the re-translated line is reviewed again
    expect(roles(second.ctx, 'linguist')[0].messages[1].content).toContain('"id":"l9"');
    expect(roles(second.ctx, 'linguist')[0].messages[1].content).not.toContain('"id":"l1"');
  });

  it('human-edited translations are never overwritten', async () => {
    const first = await run(sixPageKidsDoc(), { translator: times(4, fakeTranslator().step), linguist: times(2, fakeLinguist()) });
    let doc = applyOps(first.session.doc, [{ op: 'translation', lang: 'te', lineId: 'l1', patch: { text: 'చంద్రుడు ఎటు పోయాడు?', status: 'edited' } }]);
    doc = applyOps(doc, [{ op: 'line', pageId: 'pg_1', panelId: 'pn_1', id: 'l1', patch: { text: 'Where did our moon go?' } }]);
    const second = await run(doc, { translator: times(2, fakeTranslator().step), linguist: times(2, fakeLinguist()) });
    expect(roles(second.ctx, 'translator')).toHaveLength(0);
    expect(i18nOf(second.session.doc).editions.te.lines.l1).toMatchObject({ text: 'చంద్రుడు ఎటు పోయాడు?', status: 'edited' });
  });

  it('edits the author makes WHILE the run is going survive: a later chunk and the review never overwrite them', async () => {
    const session = newSession(sixPageKidsDoc());
    const tr = fakeTranslator();
    const lineOf = (id: string) => session.doc.pages.flatMap((p) => p.panels.flatMap((pn) => pn.lines)).find((l) => l.id === id)!;
    const edit = (id: string, text: string) =>
      session.commit([{ op: 'translation', lang: 'te', lineId: id, patch: { text, status: 'edited', sourceHash: lineSourceHash(lineOf(id)), at: Date.now() } }], { origin: 'user', label: 'Edit translation' });
    let calls = 0;
    const translator = (req: LlmRequest) => {
      calls += 1;
      // Chunk 1 (pages 1–3) is with the model: the author types the Telugu for l9 (page 5 → chunk 2), and
      // their own Telugu title (the title rides in chunk 1's extras, so chunk 1's commit is the one to beat).
      if (calls === 1) {
        edit('l9', 'నా స్వంత అనువాదం తొమ్మిది');
        session.commit([{ op: 'edition_text', lang: 'te', field: 'brief.title', value: { text: 'నా శీర్షిక', status: 'edited', sourceHash: textSourceHash(session.doc.brief.title), at: Date.now() } }], { origin: 'user', label: 'Edit translation' });
      }
      // Chunk 2 is with the model: the author rewrites l1 (committed as machine text by chunk 1).
      if (calls === 2) edit('l1', 'నా స్వంత అనువాదం ఒకటి');
      return tr.step(req);
    };
    // The linguist would "fix" l1 (major, with a suggestion) — but it is the author's line now.
    const linguist = fakeLinguist((id) => (id === 'l1' ? { verdict: 'fix', severity: 'major', issue: 'Meaning is off.', suggestion: 'చంద్రుడు ఎక్కడ?' } : undefined));
    const ctx = testContext(session, { llm: scriptedLlm({ translator: times(4, translator), linguist: times(2, linguist) }) });
    const started = await runTranslation(ctx, T(), { confirmed: true, origin: 'user' });
    await started.done;
    await ctx.settled();
    const e = i18nOf(session.doc).editions.te;
    // Without the fix: l9 = chunk 2's machine text ('reviewed'); l1 = the linguist's suggestion, 'Auto-corrected'.
    expect(e.lines.l9).toMatchObject({ text: 'నా స్వంత అనువాదం తొమ్మిది', status: 'edited' });
    expect(e.lines.l1).toMatchObject({ text: 'నా స్వంత అనువాదం ఒకటి', status: 'edited' });
    expect(e.lines.l1.issue).toBeUndefined();
    // Without the fix the title is chunk 1's machine text, then reviewed.
    expect(editionTextEntry(session.doc, 'te', 'brief.title')).toMatchObject({ text: 'నా శీర్షిక', status: 'edited' });
    // The author's lines and title were not sent to the linguist either (their words are not up for review).
    const reviewed = String(roles(ctx, 'linguist')[0].messages[1].content);
    expect(reviewed).not.toContain('"id":"l1"');
    expect(reviewed).not.toContain('"id":"l9"');
    expect(reviewed).not.toContain('"id":"brief.title"');
    expect(editionReadiness(session.doc, 'te').publishable).toBe(true);
  });

  it('several languages run with concurrency ≤ 3; one chunk per ≤ 40 lines', async () => {
    const doc = sixPageKidsDoc();
    let inflight = 0;
    let peak = 0;
    const tr = fakeTranslator();
    const slow = async (req: Parameters<typeof tr.step>[0]) => {
      inflight += 1;
      peak = Math.max(peak, inflight);
      await new Promise((r) => setTimeout(r, 5));
      inflight -= 1;
      return tr.step(req);
    };
    const { session, ctx } = await run(doc, { translator: times(12, slow), linguist: times(6, fakeLinguist()) }, T({ languages: ['te', 'hi', 'ta', 'ja'] }));
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
    expect(roles(ctx, 'translator')).toHaveLength(8); // 2 chunks × 4 languages
    for (const lang of ['te', 'hi', 'ta', 'ja']) expect(editionReadiness(session.doc, lang).publishable).toBe(true);
    for (const c of roles(ctx, 'translator')) expect(Object.keys(requestedItems(c)).filter((id) => /^l\d+$/.test(id)).length).toBeLessThanOrEqual(40);
  });
});

describe('validation and repair (§8.6)', () => {
  it('a script failure triggers exactly ONE repair round; a persistent failure is committed with a major issue', async () => {
    const tr = fakeTranslator({ text: (id, _lang, attempt) => (id === 'l3' ? 'Look up there, friend!' : undefined), omit: () => false });
    const { session, ctx } = await run(sixPageKidsDoc(), { translator: times(5, tr.step), linguist: times(2, fakeLinguist()) });
    // chunk 1: first call + one repair; chunk 2: one call
    expect(roles(ctx, 'translator')).toHaveLength(3);
    const asked = roles(ctx, 'translator')[1].messages; // cloned at call time
    const repair = asked[asked.length - 1];
    expect(String(repair.content)).toContain('line l3 is not written in Telugu');
    const e = i18nOf(session.doc).editions.te.lines.l3;
    expect(e.issue?.severity).toBe('major');
    expect(editionReadiness(session.doc, 'te').publishable).toBe(false);
    expect(editionReadiness(session.doc, 'te').issues.map((i) => i.code)).toContain('major_issue');
  });

  it('a repaired line is accepted; a line the translator never returns stays honestly missing', async () => {
    const tr = fakeTranslator({ text: (id, _l, attempt) => (id === 'l7' && attempt === 1 ? 'Hold on!' : undefined), omit: (id) => id === 'l8' });
    const { session } = await run(sixPageKidsDoc(), { translator: times(6, tr.step), linguist: times(2, fakeLinguist()) });
    const e = i18nOf(session.doc).editions.te;
    expect(e.lines.l7.issue).toBeUndefined();
    expect(e.lines.l8).toBeUndefined();
    expect(editionProgress(session.doc, 'te').missing).toBe(1);
    const last = session.doc.conversation[session.doc.conversation.length - 1];
    expect(last.text).toContain('1 still missing');
    expect(last.nextSteps?.find((s) => s.label === 'Translate missing lines')?.action).toMatchObject({ type: 'translate', languages: ['te'] });
  });

  it('translated text goes through the safety pre-filter; a blocked line is never committed', async () => {
    vi.mocked(safety.prefilterText).mockImplementation((text: string) => ({ decision: /నేస్తం/.test(text) ? 'block' : 'clear', categories: [], ip: [] }));
    const { session } = await run(sixPageKidsDoc(), { translator: times(6, fakeTranslator().step), linguist: times(2, fakeLinguist()) });
    expect(safety.prefilterText).toHaveBeenCalled();
    const e = i18nOf(session.doc).editions.te;
    for (const t of Object.values(e.lines)) expect(t.text).not.toContain('నేస్తం');
    vi.mocked(safety.prefilterText).mockReset();
  });

  it('checkLine / scriptShare / reader helpers', () => {
    expect(scriptShare('చంద్రుడు ఎక్కడ?', 'te')).toBe(1);
    expect(scriptShare('Chandrudu ekkada', 'te')).toBe(0);
    expect(scriptShare('A!', 'te')).toBe(1); // < 2 letters
    const item = { id: 'x', source: 'Where is Milo?', maxChars: 10, forms: ['మైలో'], keep: [] };
    expect(checkLine('te', 'everyday', item, 'మైలో ఎక్కడ?', 'PG-13', 'en').problem).toBeUndefined();
    expect(checkLine('te', 'everyday', item, 'ఎక్కడ?', 'PG-13', 'en').problem).toBe('glossary');
    expect(checkLine('te', 'everyday', item, undefined, 'PG-13', 'en').problem).toBe('missing');
    expect(checkLine('te', 'code_mixed', { ...item, forms: [] }, 'Milo ఎక్కడ ఉన్నాడు?', 'PG-13', 'en').problem).toBeUndefined();
    expect(checkLine('te', 'everyday', { ...item, forms: [] }, 'మైలో ఎక్కడ ఉన్నాడు, ఎక్కడ ఉన్నాడు?', 'PG-13', 'en').tooLong).toBe(true);
    expect(readTranslatorOutput({ lines: [{ id: 'a', text: 'x' }, { id: 1 }], glossary: [{ term: 'Milo', form: 'మైలో' }] })).toEqual({ lines: [{ id: 'a', text: 'x', fits: true }], glossary: [{ term: 'Milo', form: 'మైలో' }], notes: '' });
    expect(resolveLanguage('Telugu')).toBe('te');
    expect(resolveLanguage('తెలుగు')).toBe('te');
    expect(resolveLanguage('zh-CN')).toBe('zh-Hans');
    expect(resolveLanguage('Chinese')).toBe('zh-Hans');
    expect(resolveLanguage('Klingon')).toBeUndefined();
    expect(resolveLanguages(sixPageKidsDoc(), ['English', 'hindi', 'hi', 'xx'])).toEqual({ codes: ['hi'], unknown: ['xx'], includedSource: true });
  });

  it('a name the translator coins in chunk 1 is used by chunk 2 (glossary)', async () => {
    const tr = fakeTranslator({ glossary: [{ term: 'Milo', form: 'మైలో' }], text: (id) => (id === 'l12' ? 'శుభరాత్రి, మైలో.' : undefined) });
    const { session } = await run(sixPageKidsDoc(), { translator: times(4, tr.step), linguist: times(2, fakeLinguist()) });
    expect(i18nOf(session.doc).glossary.find((g) => g.term === 'Milo')?.forms.te).toBe('మైలో');
    expect(String(tr.calls[1].messages[1].content)).toMatch(/GLOSSARY[\s\S]*Milo → మైలో/);
  });
});

describe('the linguist review (always)', () => {
  it('ok → reviewed; minor → issue with suggestion; major + suggestion → auto-corrected (revertible); major alone → blocks', async () => {
    const verdicts = (id: string) =>
      id === 'l1'
        ? { verdict: 'fix' as const, severity: 'minor' as const, issue: 'Sounds stiff.', suggestion: 'చంద్రుడు ఎక్కడికి పోయాడు?' }
        : id === 'l3'
          ? { verdict: 'fix' as const, severity: 'major' as const, issue: 'Wrong meaning.', suggestion: 'అదిగో, పైకి చూడు!', gloss: 'There, look up!' }
          : id === 'l7'
            ? { verdict: 'fix' as const, severity: 'major' as const, issue: 'Wrong speaker gender.', suggestion: '' }
            : undefined;
    const { session } = await run(sixPageKidsDoc(), { translator: times(4, fakeTranslator().step), linguist: times(2, fakeLinguist(verdicts)) });
    const e = i18nOf(session.doc).editions.te.lines;
    expect(e.l9).toMatchObject({ status: 'reviewed' });
    expect(e.l1).toMatchObject({ status: 'reviewed', issue: { severity: 'minor', note: 'Sounds stiff.', suggestion: 'చంద్రుడు ఎక్కడికి పోయాడు?' } });
    expect(e.l3.text).toBe('అదిగో, పైకి చూడు!');
    expect(e.l3).toMatchObject({ status: 'reviewed', gloss: 'There, look up!', issue: { severity: 'minor' } });
    expect(e.l3.issue?.note.startsWith(AUTO_CORRECTED_NOTE)).toBe(true);
    expect(e.l3.issue?.suggestion).toBeTruthy(); // the original, to revert
    expect(e.l7).toMatchObject({ status: 'machine', issue: { severity: 'major', note: 'Wrong speaker gender.' } });
    const r = editionReadiness(session.doc, 'te');
    expect(r.publishable).toBe(false);
    expect(r.issues.find((i) => i.code === 'major_issue')?.count).toBe(1);
    const last = session.doc.conversation[session.doc.conversation.length - 1];
    expect(last.text).toContain('1 line corrected by the review');
    expect(last.text).toContain('1 line flagged for a look');
  });

  it('"Mixed with English": the linguist is told about the voice and a valid Hinglish line survives its review', async () => {
    const doc = applyOps(sixPageKidsDoc(), [{ op: 'edition', lang: 'hi', patch: { register: 'code_mixed' } }]);
    // The prompt names the voice (without the fix it only says "the wrong script" is major and asks for spoken Hindi).
    const mixed = linguistSystemPrompt(doc, 'hi');
    expect(mixed).toMatch(/code-mixed|mixed with English|English words/i);
    expect(mixed).not.toContain('or the wrong script');
    // …in both spellings the translator may use: Devanagari (as the translator prompt asks) or Latin letters.
    expect(mixed).toContain('common English words, written in Devanagari script or in Latin letters, are correct here');
    expect(mixed).toContain('a script other than Devanagari (English words excepted)');
    expect(linguistSystemPrompt(doc, 'hi', 'code_mixed')).toBe(mixed); // the edition's own voice is the default
    expect(linguistSystemPrompt(sixPageKidsDoc(), 'hi')).toContain('or the wrong script');
    expect(linguistSystemPrompt(doc, 'hi', 'formal')).toContain('polished written Hindi');

    // Natural Hinglish (Devanagari + an English word) that software accepts under the code-mixed threshold.
    const HINGLISH = 'चाँद कहाँ गया, bro?';
    const session = newSession(doc);
    const tr = fakeTranslator({ text: (id, lang) => (id === 'l1' && lang === 'hi' ? HINGLISH : undefined) });
    // A reviewer that still objects to the English words (as the old prompt told it to) and offers pure Hindi.
    const linguist = fakeLinguist((id) => (id === 'l1' ? { verdict: 'fix', severity: 'major', issue: 'Wrong script: English words in a Hindi line.', suggestion: 'चाँद कहाँ गया?' } : undefined));
    const ctx = testContext(session, { llm: scriptedLlm({ translator: times(4, tr.step), linguist: times(2, linguist) }) });
    const started = await runTranslation(ctx, T({ languages: ['hi'] }), { confirmed: true, origin: 'user' });
    await started.done;
    await ctx.settled();
    // The review call carried the edition's voice.
    expect(String(roles(ctx, 'linguist')[0].messages[0].content)).toMatch(/mixed with English/);
    const l1 = i18nOf(session.doc).editions.hi.lines.l1;
    // Without the fix: l1.text === 'चाँद कहाँ गया?' with "Auto-corrected by review: Wrong script…".
    expect(l1.text).toBe(HINGLISH);
    expect(l1.status).toBe('reviewed');
    // The reviewer's wording stays available as a one-tap suggestion, never applied over the author's voice.
    expect(l1.issue).toMatchObject({ severity: 'minor', suggestion: 'चाँद कहाँ गया?' });
    expect(l1.issue?.note.startsWith(AUTO_CORRECTED_NOTE)).toBe(false);
    expect(editionReadiness(session.doc, 'hi').publishable).toBe(true);
  });

  it('"Mixed with English": a MAJOR wrong-meaning verdict is still auto-corrected, whatever its note says about English', async () => {
    const doc = applyOps(sixPageKidsDoc(), [{ op: 'edition', lang: 'hi', patch: { register: 'code_mixed' } }]);
    const WRONG = 'सूरज कहाँ गया, bro?'; // "where did the SUN go, bro?" — passes the code-mixed script check
    const RIGHT = 'चाँद कहाँ गया, bro?';
    const session = newSession(doc);
    const tr = fakeTranslator({ text: (id, lang) => (id === 'l1' && lang === 'hi' ? WRONG : undefined) });
    // The linguist writes its note in the source language, so a code-mixed note often names "English".
    const linguist = fakeLinguist((id) => (id === 'l1' ? { verdict: 'fix', severity: 'major', issue: 'Wrong meaning: the English source says moon, not sun.', suggestion: RIGHT } : undefined));
    const ctx = testContext(session, { llm: scriptedLlm({ translator: times(4, tr.step), linguist: times(2, linguist) }) });
    const started = await runTranslation(ctx, T({ languages: ['hi'] }), { confirmed: true, origin: 'user' });
    await started.done;
    await ctx.settled();
    const l1 = i18nOf(session.doc).editions.hi.lines.l1;
    // Without the fix: l1 keeps 'सूरज…' as 'reviewed' with a minor note — a wrong-meaning line that can be published.
    expect(l1.text).toBe(RIGHT);
    expect(l1.status).toBe('reviewed');
    expect(l1.issue?.note.startsWith(AUTO_CORRECTED_NOTE)).toBe(true);
    expect(l1.issue?.suggestion).toBe(WRONG); // the original, to revert
  });

  it('"Mixed with English": only a suggestion that merely DROPS English words is the voice; a swapped English word is a real fix', () => {
    const base = applyOps(sixPageKidsDoc(), [{ op: 'edition', lang: 'hi', patch: { register: 'code_mixed' } }]);
    const [l1, l2] = base.pages[0].panels[0].lines;
    const doc = applyOps(base, [
      {
        op: 'translations',
        lang: 'hi',
        lines: {
          l1: { text: 'देखो, sun कहाँ गया?', status: 'machine', sourceHash: lineSourceHash(l1), at: 1 },
          l2: { text: 'टर्र टर्र, bro!', status: 'machine', sourceHash: lineSourceHash(l2), at: 1 }
        }
      }
    ]);
    const v = (id: string, issue: string, suggestion: string, reviewed: string) => [id, { id, gloss: 'g', verdict: 'fix' as const, severity: 'major' as const, issue, suggestion, reviewed }] as const;
    const out = applyReview(
      doc,
      'hi',
      new Map([
        // The English word itself carries the wrong meaning: another English word fixes it (a real correction).
        v('l1', 'Wrong meaning: the English source says moon, not sun.', 'देखो, moon कहाँ गया?', 'देखो, sun कहाँ गया?'),
        // Dropping the English word is the reviewer objecting to the voice the author chose.
        v('l2', 'Wrong script: English word in a Hindi line.', 'टर्र टर्र!', 'टर्र टर्र, bro!')
      ]),
      'PG',
      2
    );
    const lines = (out.ops.find((o) => o.op === 'translations') as Extract<(typeof out.ops)[number], { op: 'translations' }>).lines;
    expect(lines.l1).toMatchObject({ text: 'देखो, moon कहाँ गया?', status: 'reviewed', issue: { severity: 'minor', suggestion: 'देखो, sun कहाँ गया?' } });
    expect(lines.l1.issue?.note.startsWith(AUTO_CORRECTED_NOTE)).toBe(true);
    expect(lines.l2).toMatchObject({ text: 'टर्र टर्र, bro!', status: 'reviewed', issue: { severity: 'minor', suggestion: 'टर्र टर्र!' } });
    expect(out.autoFixed).toBe(1);

    // A Latin-script edition cannot tell its own words from English ones: dropping "No" is a meaning fix.
    const es = applyOps(sixPageKidsDoc(), [
      { op: 'edition', lang: 'es', patch: { register: 'code_mixed' } },
      { op: 'translations', lang: 'es', lines: { l1: { text: 'No quiero ir, bro.', status: 'machine', sourceHash: lineSourceHash(l1), at: 1 } } }
    ]);
    const esOut = applyReview(es, 'es', new Map([v('l1', 'Wrong meaning: the source does not say "not".', 'Quiero ir, bro.', 'No quiero ir, bro.')]), 'PG', 2);
    expect(esOut.autoFixed).toBe(1);
    expect((esOut.ops[0] as Extract<(typeof esOut.ops)[number], { op: 'translations' }>).lines.l1).toMatchObject({ text: 'Quiero ir, bro.', issue: { suggestion: 'No quiero ir, bro.' } });
  });

  it('applyReview leaves a line alone when its text is no longer the one the linguist was shown, or the author wrote it', () => {
    const first = applyOps(sixPageKidsDoc(), [{ op: 'edition', lang: 'te', patch: {} }]);
    const l1 = first.pages[0].panels[0].lines[0];
    const doc = applyOps(first, [
      { op: 'translations', lang: 'te', lines: { l1: { text: 'రచయిత మాట', status: 'machine', sourceHash: lineSourceHash(l1), at: 1 }, l2: { text: 'నా మాట', status: 'edited', sourceHash: lineSourceHash(first.pages[0].panels[0].lines[1]), at: 1 } } }
    ]);
    const verdicts = new Map([
      // The review call went out with the machine text; the author rewrote l1 before the verdict came back.
      ['l1', { id: 'l1', gloss: 'g', verdict: 'fix' as const, severity: 'major' as const, issue: 'Off.', suggestion: 'చంద్రుడు ఎక్కడ?', reviewed: 'యంత్ర మాట' }],
      ['l2', { id: 'l2', gloss: 'g', verdict: 'ok' as const, severity: 'none' as const, issue: '', suggestion: '', reviewed: 'నా మాట' }]
    ]);
    const out = applyReview(doc, 'te', verdicts, 'PG', 2);
    expect(out.ops).toEqual([]);
    expect(out.reviewed + out.autoFixed + out.flagged).toBe(0);
  });

  it('a review that fails leaves lines "waiting for review"; the next run reviews them without re-translating', async () => {
    const first = await run(sixPageKidsDoc(), { translator: times(4, fakeTranslator().step), linguist: [new Error('boom')] });
    expect(editionProgress(first.session.doc, 'te').unreviewed).toBeGreaterThan(5);
    expect(editionReadiness(first.session.doc, 'te').publishable).toBe(false);
    const plan = planTranslation(first.session.doc, 'te');
    expect(plan.calls).toBe(0);
    expect(plan.toReview!.length).toBeGreaterThan(5);
    const second = await run(first.session.doc, { linguist: times(2, fakeLinguist()) });
    expect(roles(second.ctx, 'translator')).toHaveLength(0);
    expect(roles(second.ctx, 'linguist')).toHaveLength(1);
    expect(editionReadiness(second.session.doc, 'te').publishable).toBe(true);
  });
});

describe('money: quote, gate, BYOK, cancel, keys', () => {
  it('the quote is per language, BYOK has no markup, and matches the gate estimate', async () => {
    const doc = sixPageKidsDoc();
    const platform = quoteTranslation(doc, { openrouter: { key: 'k', byok: false } }, { languages: ['te', 'hi'] });
    const byok = quoteTranslation(doc, { openrouter: { key: 'k', byok: true } }, { languages: ['te', 'hi'] });
    expect(platform.perLanguage.map((l) => l.lang)).toEqual(['te', 'hi']);
    expect(platform.perLanguage[0]).toMatchObject({ lines: 12, free: 2, upToDate: false }); // 10 lines + title + logline
    expect(platform.perLanguage[0].usd).toBeGreaterThan(platform.perLanguage[1].usd); // Telugu outputs more tokens
    expect(byok.estimate.usd).toBeLessThan(platform.estimate.usd);
    expect(platform.estimate.usd).toBeGreaterThan(0.005);
    expect(platform.estimate.usd).toBeLessThan(0.5); // "a 6-page comic costs about $0.05 per language"
    expect(platform.estimate.model).toBe('Claude Sonnet 5.5 + review');
    const session = newSession(doc);
    const ctx = testContext(session);
    expect((await estimateTranslation(ctx, T({ languages: ['Telugu', 'Hindi'] }))).usd).toBe(platform.estimate.usd);
  });

  it('the text quote follows the translator’s key: an own Gemini key beside the platform OpenRouter key still pays the platform markup', () => {
    const doc = sixPageKidsDoc();
    const platform = quoteTranslation(doc, { openrouter: { key: 'k', byok: false } }, { languages: ['te'] });
    // Text routes are OpenRouter-first, so the translator runs on the platform key for this user.
    const mixed = quoteTranslation(doc, { openrouter: { key: 'k', byok: false }, gemini: { key: 'own', byok: true } }, { languages: ['te'] });
    expect(mixed.byok).toBe(false);
    expect(mixed.estimate.usd).toBe(platform.estimate.usd);
    expect(mixed.perLanguage[0].usd).toBe(platform.perLanguage[0].usd);
    // An own Gemini key alone runs the translator on it: no markup.
    const ownGemini = quoteTranslation(doc, { gemini: { key: 'own', byok: true } }, { languages: ['te'] });
    expect(ownGemini.byok).toBe(true);
    const done = completionMessage(doc, [{ lang: 'te', usd: 0.02, free: 0 } as never], { openrouter: { key: 'k', byok: false }, gemini: { key: 'own', byok: true } });
    expect(done.text).toContain('Cost $0.02.');
    expect(done.text).not.toContain('on your key');
  });

  it('the quote learns from the bill (a repair round and the review included): a run billed above its plan raises the next quote, bounded', async () => {
    const doc = sixPageKidsDoc();
    const keys = { openrouter: { key: 'sk-or-test', byok: false } };
    const before = quoteTranslation(doc, keys, { languages: ['te'] }).perLanguage[0].usd;
    // Chunk 1 needs a repair round (a script failure on the first answer): three translator calls for two chunks.
    const tr = fakeTranslator({ text: (id, _l, attempt) => (id === 'l3' && attempt === 1 ? 'Look up there!' : undefined) });
    // Every call bills far above its share of the plan while reporting almost no completion tokens: the old
    // output-token calibration would LOWER the next quote (ratio clamped to 0.5 → factor 0.85).
    const pricey = (req: LlmRequest) => ({ ...tr.step(req), costUsd: 0.05, completionTokens: 1 });
    const { ctx, session } = await run(doc, { translator: times(6, pricey), linguist: times(2, fakeLinguist()) }, T(), keys);
    expect(roles(ctx, 'translator')).toHaveLength(3);
    const billed = session.doc.spend.entries.find((s) => s.kind === 'translate')!.usd;
    expect(billed).toBeGreaterThan(before);
    const after = quoteTranslation(sixPageKidsDoc(), keys, { languages: ['te'] }).perLanguage[0].usd;
    expect(after).toBeGreaterThan(before);
    expect(after).toBeCloseTo(before * 1.3, 3); // one EMA step: 0.7 × 1 + 0.3 × (ratio clamped at 2)
    // A stopped run billed less than it planned: it does not pull the calibration down.
    const s2 = newSession(sixPageKidsDoc());
    const tr2 = fakeTranslator();
    const ctx2 = testContext(s2, { keys, llm: scriptedLlm({ translator: [(req) => { s2.abort.abort(); return tr2.step(req); }, tr2.step], linguist: times(2, fakeLinguist()) }) });
    const stopped = await runTranslation(ctx2, T(), { confirmed: true, origin: 'user' });
    await stopped.done;
    await ctx2.settled();
    expect(quoteTranslation(sixPageKidsDoc(), keys, { languages: ['te'] }).perLanguage[0].usd).toBe(after);
  });

  it('confirm "always" and an over-budget quote open a gate (nothing runs until approved)', async () => {
    for (const settings of [{ confirm: 'always' as const }, { budgetUsd: 0.0001 }]) {
      const doc = sixPageKidsDoc();
      doc.settings = { ...doc.settings, ...settings };
      const session = newSession(doc);
      const ctx = testContext(session, { llm: scriptedLlm({}) });
      const started = await startAction(ctx, T(), { confirmed: false, origin: 'user' });
      expect(started.outcome.status).toBe('gated');
      expect(session.doc.gate).toMatchObject({ status: 'open', action: { type: 'translate', languages: ['te'] } });
      expect(ctx.llmFake.calls).toHaveLength(0);
      expect(i18nOf(session.doc).editions.te).toBeUndefined();
    }
  });

  it('approving the gate runs it; spend is recorded with BYOK honored', async () => {
    const doc = sixPageKidsDoc();
    doc.settings = { ...doc.settings, confirm: 'always' };
    const session = newSession(doc);
    const keys = { openrouter: { key: 'mine', byok: true } };
    const ctx = testContext(session, { keys, llm: scriptedLlm({ translator: times(4, fakeTranslator().step), linguist: times(2, fakeLinguist()) }) });
    await startAction(ctx, T(), { confirmed: false, origin: 'user' });
    // the gate quotes the BYOK price (no platform markup)
    expect(session.doc.gate!.estimateUsd).toBe(quoteTranslation(doc, keys, { languages: ['te'] }).estimate.usd);
    expect(session.doc.gate!.estimateUsd).toBeLessThan(quoteTranslation(doc, { openrouter: { key: 'k', byok: false } }, { languages: ['te'] }).estimate.usd);
    const started = await startAction(ctx, { type: 'approve_gate', gateId: session.doc.gate!.id }, { confirmed: true, origin: 'user' });
    await started.done;
    await ctx.settled();
    expect(editionReadiness(session.doc, 'te').publishable).toBe(true);
    const entry = session.doc.spend.entries.find((s) => s.kind === 'translate');
    expect(entry).toMatchObject({ kind: 'translate', label: 'Translate · Telugu' });
    expect(session.doc.spend.byKind.translate).toBeGreaterThan(0);
  });

  it('cancel stops after the current chunk; finished chunks are kept', async () => {
    const doc = sixPageKidsDoc();
    const session = newSession(doc);
    const tr = fakeTranslator();
    const ctx = testContext(session, {
      llm: scriptedLlm({
        translator: [
          (req) => {
            session.abort.abort();
            return tr.step(req);
          },
          tr.step
        ],
        linguist: times(2, fakeLinguist())
      })
    });
    const started = await runTranslation(ctx, T(), { confirmed: true, origin: 'user' });
    await started.done;
    await ctx.settled();
    expect(ctx.llmFake.calls.filter((c) => c.role === 'translator')).toHaveLength(1);
    const p = editionProgress(session.doc, 'te');
    expect(p.done).toBeGreaterThan(2);
    expect(p.missing).toBeGreaterThan(0);
    expect(session.doc.conversation[session.doc.conversation.length - 1].text).toContain('Stopped');
  });

  it('no AI key → an honest refusal, nothing committed; unknown languages are refused with the list', async () => {
    const session = newSession(sixPageKidsDoc());
    const ctx = testContext(session, { keys: {} });
    const out = await runTranslation(ctx, T(), { confirmed: true, origin: 'user' });
    expect(out.outcome).toMatchObject({ status: 'blocked', code: 'NO_TEXT_KEY' });
    expect(i18nOf(session.doc).editions.te).toBeUndefined();
    const bad = await runTranslation(testContext(session), T({ languages: ['Klingon'] }), { confirmed: true, origin: 'user' });
    expect(bad.outcome.status).toBe('blocked');
    expect(bad.outcome.message).toContain('I can translate into: Hindi, Telugu');
  });
});

describe('overlay lettering is required for translated editions', () => {
  it('in-art pages: translations are made, readiness blocks, and the completion offers the quoted overlay conversion', async () => {
    const doc = GOLDEN_DOCS['six-drawn']();
    doc.format = { ...doc.format, lettering: 'in_art' };
    const { session } = await run(doc, { translator: times(2, fakeTranslator().step), linguist: times(2, fakeLinguist()) }, T({ languages: ['hi'] }));
    const r = editionReadiness(session.doc, 'hi');
    expect(r.publishable).toBe(false);
    expect(r.issues.find((i) => i.code === 'in_art_pages')).toMatchObject({ blocking: true, count: 6 });
    const last = session.doc.conversation[session.doc.conversation.length - 1];
    expect(last.text).toMatch(/redrawing 6 pages without text costs ≈ \$/);
    expect(last.nextSteps?.map((s) => s.label)).toContain('Set up lettering for translations');
    expect(last.nextSteps?.map((s) => s.label)).not.toContain('Publish');
  });

  it('completionMessage is honest about cost on the user key', () => {
    const doc = sixPageKidsDoc();
    const { text } = completionMessage(doc, [{ lang: 'te', translated: 0, free: 0, reviewed: 0, autoFixed: 0, failed: 0, unsafe: 0, tooLong: 0, reviewSkipped: 0, cancelled: false, usd: 0.0421, byok: true }], { openrouter: { key: 'k', byok: true } });
    expect(text).toContain('on your key');
    expect(text).toContain('12 lines done');
  });
});

describe('director turns', () => {
  it('a director-started run puts the live card in the director message and APPENDS the completion message', async () => {
    const session = newSession(sixPageKidsDoc());
    const cards: unknown[] = [];
    const ctx = testContext(session, { llm: scriptedLlm({ translator: times(4, fakeTranslator().step), linguist: times(2, fakeLinguist()) }) });
    const before = session.doc.conversation.length;
    const started = await runTranslation(ctx, T(), { confirmed: true, origin: 'director', collectCard: (c) => cards.push(c) });
    expect(cards).toEqual([expect.objectContaining({ type: 'translation', languages: ['te'] })]);
    expect(started.outcome.message).toContain('The result arrives as a new message.');
    await started.done;
    await ctx.settled();
    expect(session.doc.conversation.length).toBe(before + 1);
    const last = session.doc.conversation[session.doc.conversation.length - 1];
    expect(last.text).toContain('Telugu is translated and reviewed.');
    expect(last.at).toBeGreaterThan(0);
  });
});

describe('review fixes: no double charge, Stop semantics, honest message order', () => {
  it('a second translate of a language already running starts nothing and charges nothing (double tap / director mid-run)', async () => {
    const session = newSession(sixPageKidsDoc());
    const tr = fakeTranslator();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const llm = scriptedLlm({
      translator: [
        async (req) => {
          await gate; // the first chunk is still with the model when the second request arrives
          return tr.step(req);
        },
        tr.step
      ],
      linguist: times(2, fakeLinguist())
    });
    const ctx = testContext(session, { llm });
    const first = await runTranslation(ctx, T(), { confirmed: true, origin: 'user' });
    expect(first.outcome.status).toBe('started');
    expect(translationRunning(ctx, 'te')).toBe(true);
    const second = await runTranslation(testContext(session, { llm }), T(), { confirmed: true, origin: 'user' });
    expect(second.outcome).toMatchObject({ status: 'blocked', code: 'CONFLICT' });
    expect(second.outcome.message).toContain('Telugu is already being translated');
    expect(second.outcome.message).toContain('Nothing new was started or charged');
    release();
    await first.done;
    await ctx.settled();
    expect(llm.calls.filter((c) => c.role === 'translator')).toHaveLength(2); // the first run's two chunks only
    expect(translationRunning(ctx, 'te')).toBe(false);
    expect(editionReadiness(session.doc, 'te').publishable).toBe(true);
    // Once finished, the language can be asked for again (here: $0, already up to date).
    const third = await runTranslation(testContext(session, { llm: scriptedLlm({}) }), T(), { confirmed: true, origin: 'user' });
    expect(third.outcome.status).toBe('done');
  });

  it('a dropped stream (phone locked) does not cancel the run; only Stop does — even after a later resetAbort', async () => {
    const dropped = new AbortController();
    const s1 = newSession(sixPageKidsDoc());
    const tr1 = fakeTranslator();
    const ctx1 = testContext(s1, {
      signal: dropped.signal,
      llm: scriptedLlm({
        translator: [
          (req) => {
            dropped.abort(); // the HTTP stream closes mid-run
            return tr1.step(req);
          },
          tr1.step
        ],
        linguist: times(2, fakeLinguist())
      })
    });
    const run1 = await runTranslation(ctx1, T(), { confirmed: true, origin: 'user' });
    await run1.done;
    await ctx1.settled();
    expect(ctx1.llmFake.calls.filter((c) => c.role === 'translator')).toHaveLength(2);
    expect(editionReadiness(s1.doc, 'te').publishable).toBe(true);

    const s2 = newSession(sixPageKidsDoc());
    const tr2 = fakeTranslator();
    const ctx2 = testContext(s2, {
      llm: scriptedLlm({
        translator: [
          (req) => {
            s2.abort.abort(); // Stop…
            s2.resetAbort(); // …then the next request clears it for ITS work
            return tr2.step(req);
          },
          tr2.step
        ],
        linguist: times(2, fakeLinguist())
      })
    });
    const run2 = await runTranslation(ctx2, T(), { confirmed: true, origin: 'user' });
    await run2.done;
    await ctx2.settled();
    expect(ctx2.llmFake.calls.filter((c) => c.role === 'translator')).toHaveLength(1); // the Stop still holds
    expect(s2.doc.conversation[s2.doc.conversation.length - 1].text).toContain('Stopped');
    // Stop takes effect AFTER the current chunk: the started (paid) call was not aborted and its lines are kept.
    expect(ctx2.llmFake.calls.find((c) => c.role === 'translator')?.signal).toBeUndefined();
    expect(editionProgress(s2.doc, 'te').done).toBeGreaterThan(2);
    // …and the review that had not started yet is skipped (those lines honestly wait for review).
    expect(ctx2.llmFake.calls.filter((c) => c.role === 'linguist')).toHaveLength(0);
    expect(editionProgress(s2.doc, 'te').unreviewed).toBeGreaterThan(0);
  });

  it('UI-started: when the user wrote meanwhile, the summary is APPENDED and the progress message points to it', async () => {
    const session = newSession(sixPageKidsDoc());
    const tr = fakeTranslator();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const ctx = testContext(session, {
      llm: scriptedLlm({
        translator: [
          async (req) => {
            await gate;
            return tr.step(req);
          },
          tr.step
        ],
        linguist: times(2, fakeLinguist())
      })
    });
    const started = await runTranslation(ctx, T(), { confirmed: true, origin: 'user' });
    const progress = session.doc.conversation[session.doc.conversation.length - 1];
    expect(progress.text).toMatch(/^Translating /);
    session.commit([{ op: 'message', msg: { id: 'm_user_mid', role: 'user', text: 'also make the cover pop', at: Date.now() } }], { origin: 'user' });
    release();
    await started.done;
    await ctx.settled();
    const conv = session.doc.conversation;
    const last = conv[conv.length - 1];
    expect(last.id).not.toBe(progress.id);
    expect(last.text).toContain('Telugu is translated and reviewed.');
    expect(conv.findIndex((m) => m.id === 'm_user_mid')).toBeLessThan(conv.length - 1);
    expect(conv.find((m) => m.id === progress.id)?.text).toContain('The result is below.');
    const ats = conv.map((m) => m.at);
    expect([...ats].sort((a, b) => a - b)).toEqual(ats);
  });
});

// P2-GATE L1: runTranslation commits its own messages (start, completion, notices) outside jobs.ts
// governMsg, so it words every price itself: a governed user (not admin, not own key) never reads a
// dollar amount — "≈2% of your usage" instead; admins and own keys keep real prices.
describe('governed users never read dollars in translation messages (P2-GATE L1)', () => {
  const GOVERNED: StudioCaps = { ...DEFAULT_CAPS, usage: { governed: true, pctLeft: 80, exhausted: false, pctPerStandardPage: 5 } };
  const ADMIN: StudioCaps = { ...DEFAULT_CAPS, admin: true, plan: 'admin' };
  const DOLLAR = /\$\s?\d|\$0\b/;

  /** Every text this run put in front of the user: committed messages, patches, their cards, collected cards. */
  const shownTexts = (ctx: TestContext, extra: Card[] = []): string[] => {
    const out: string[] = [];
    const card = (c: Card) => {
      if (c.type === 'notice') out.push(c.text);
    };
    for (const op of opsOf(ctx.events)) {
      if (op.op === 'message') {
        out.push((op.msg as Msg).text);
        (op.msg as Msg).cards?.forEach(card);
      } else if (op.op === 'message_patch' && typeof op.patch.text === 'string') out.push(op.patch.text);
    }
    extra.forEach(card);
    return out;
  };

  it('a UI-started run: the start line, the completion and the outcome are in usage terms', async () => {
    const session = newSession(sixPageKidsDoc());
    const ctx = testContext(session, { caps: GOVERNED, llm: scriptedLlm({ translator: times(4, fakeTranslator().step), linguist: times(2, fakeLinguist()) }) });
    const started = await runTranslation(ctx, T(), { confirmed: true, origin: 'user', caps: GOVERNED });
    expect(started.outcome.status).toBe('started');
    expect(started.outcome.message).toMatch(/^Translating \d+ lines into Telugu \(≈[\d.]+% of your usage\)/);
    expect(started.outcome.message).not.toMatch(DOLLAR);
    await started.done;
    await ctx.settled();
    const texts = shownTexts(ctx);
    expect(texts.length).toBeGreaterThanOrEqual(2);
    for (const t of texts) expect(t).not.toMatch(DOLLAR);
    const last = session.doc.conversation[session.doc.conversation.length - 1];
    expect(last.text).toContain('Telugu is translated and reviewed.');
    expect(last.text).toMatch(/Used (?:≈[\d.]+%|<0\.1%) of your usage\.$/);
    // The ledger still records real dollars (server-side truth); only the words change.
    expect(session.doc.spend.entries.some((e) => e.kind === 'translate' && e.usd > 0)).toBe(true);
  });

  it('the request caps decide even when the context has none (opts.caps ?? ctx.caps), director turn included', async () => {
    const session = newSession(sixPageKidsDoc());
    const cards: Card[] = [];
    const ctx = testContext(session, { llm: scriptedLlm({ translator: times(4, fakeTranslator().step), linguist: times(2, fakeLinguist()) }) });
    const started = await runTranslation(ctx, T(), { confirmed: true, origin: 'director', caps: GOVERNED, collectCard: (c) => cards.push(c) });
    expect(started.outcome.message).toContain('% of your usage');
    expect(started.outcome.message).not.toMatch(DOLLAR);
    await started.done;
    await ctx.settled();
    for (const t of shownTexts(ctx, cards)) expect(t).not.toMatch(DOLLAR);
  });

  it('in-art lettering + a painted cover: the overlay and textless-cover quotes are usage words too', async () => {
    const doc = GOLDEN_DOCS['six-drawn']();
    doc.format = { ...doc.format, lettering: 'in_art' };
    doc.cover = { ...doc.cover, lettering: 'in_art', render: { status: 'ready', history: [], asset: { path: 'u/user-1/p/proj-1/img/cover.webp', source: 'generated', at: 1 } } };
    const session = newSession(doc);
    const ctx = testContext(session, { caps: GOVERNED, llm: scriptedLlm({ translator: times(2, fakeTranslator().step), linguist: times(2, fakeLinguist()) }) });
    const started = await runTranslation(ctx, T({ languages: ['hi'] }), { confirmed: true, origin: 'user' });
    await started.done;
    await ctx.settled();
    const last = session.doc.conversation[session.doc.conversation.length - 1];
    expect(last.text).toMatch(/redrawing 6 pages without text uses ≈[\d.]+% of your usage/);
    expect(last.text).toMatch(/A textless cover with an editable title is a one-time ≈[\d.]+% of your usage/);
    expect(last.text).not.toMatch(DOLLAR);
    // The chips keep their quoted amounts (structured data the client words for the user).
    expect(last.nextSteps?.find((st) => st.label === 'Textless cover')?.usd).toBeGreaterThan(0);
  });

  it('free paths: "already up to date" reads free, never "$0"', async () => {
    const { session } = await run(sixPageKidsDoc(), { translator: times(4, fakeTranslator().step), linguist: times(2, fakeLinguist()) });
    const ctx = testContext(session, { caps: GOVERNED, llm: scriptedLlm({}) });
    const again = await runTranslation(ctx, T(), { confirmed: true, origin: 'user' });
    expect(again.outcome.status).toBe('done');
    expect(again.outcome.message).toContain('Nothing to translate (free).');
    for (const t of [again.outcome.message, ...shownTexts(ctx)]) expect(t).not.toMatch(DOLLAR);
  });

  it('admins (and own keys) keep real prices', async () => {
    const session = newSession(sixPageKidsDoc());
    const ctx = testContext(session, { caps: ADMIN, llm: scriptedLlm({ translator: times(4, fakeTranslator().step), linguist: times(2, fakeLinguist()) }) });
    const started = await runTranslation(ctx, T(), { confirmed: true, origin: 'user' });
    expect(started.outcome.message).toMatch(/\(≈ \$\d+\.\d{2}\)/);
    await started.done;
    await ctx.settled();
    expect(session.doc.conversation[session.doc.conversation.length - 1].text).toMatch(/ Cost <?\$\d+\.\d{2}\.$/);
  });

  it('completionMessage(view): usage words, a free run, and the net under an error text that carries dollars', () => {
    const doc = sixPageKidsDoc();
    const base = { lang: 'te', translated: 0, free: 0, reviewed: 0, autoFixed: 0, failed: 0, unsafe: 0, tooLong: 0, reviewSkipped: 0, cancelled: false, byok: false };
    const view = costViewFor(GOVERNED);
    expect(completionMessage(doc, [{ ...base, usd: 0.0421 }], {}, view).text).toMatch(/ Used ≈[\d.]+% of your usage\.$/);
    expect(completionMessage(doc, [{ ...base, usd: 0 }], {}, view).text).toMatch(/ Free — done by the editor, no AI needed\.$/);
    const err = completionMessage(doc, [{ ...base, usd: 0.01, error: 'That would go over your $5.00 monthly budget' }], {}, view).text;
    expect(err).not.toMatch(DOLLAR);
    expect(err).toContain('% of your usage monthly budget');
    // Without a view (no caps: tests, legacy callers) the dollar wording is unchanged.
    expect(completionMessage(doc, [{ ...base, usd: 0 }], {}).text).toMatch(/ Cost \$0 — done by the editor, no AI cost\.$/);
  });
});
