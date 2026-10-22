// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComicDoc } from '../../../../shared/comic/doc.js';
import { editionProgress, editionReadiness, i18nOf, lineSourceHash, textSourceHash } from '../../../../shared/comic/i18n.js';
import { applyOps } from '../../../../shared/comic/ops.js';
import { AUTO_CORRECTED_NOTE } from '../../../../shared/comic/translationPlan.js';
import { startAction } from '../jobs.js';
import { newSession, testContext } from '../orchestrator.fakes.js';
import { sixPageKidsDoc } from '../i18n/testing.js';
import { actionHandlerFor } from './index.js';
import { I18N_ACTIONS, swapSourceOps } from './i18n.js';

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

const lines = (doc: ComicDoc) => doc.pages.flatMap((p) => p.panels.flatMap((pn) => pn.lines));
function translated(doc = sixPageKidsDoc(), lang = 'te'): ComicDoc {
  let d = applyOps(doc, [{ op: 'edition', lang, patch: {} }]);
  const out: Record<string, { text: string; status: 'reviewed'; sourceHash: string; at: number }> = {};
  for (const l of lines(d)) out[l.id] = { text: `${lang}:${l.id}`, status: 'reviewed', sourceHash: lineSourceHash(l), at: 1 };
  d = applyOps(d, [{ op: 'translations', lang, lines: out }]);
  d = applyOps(d, [{ op: 'edition_text', lang, field: 'brief.title', value: { text: `${lang}:title`, status: 'reviewed', sourceHash: textSourceHash(d.brief.title), at: 1 } }]);
  return d;
}

describe('i18n actions registry', () => {
  it('registers translate (spend + estimate), swap_source_language and accept_translation_issue', () => {
    expect(I18N_ACTIONS.map((a) => [a.type, a.spend, !!a.estimate])).toEqual([
      ['translate', true, true],
      ['swap_source_language', false, false],
      ['accept_translation_issue', false, false]
    ]);
    for (const a of I18N_ACTIONS) expect(actionHandlerFor(a.type)).toBe(a);
  });
});

describe('swap_source_language', () => {
  it('a complete edition becomes the source for free; the old source becomes a reviewed edition; others stay current', async () => {
    const doc = translated(translated(), 'hi');
    const session = newSession(doc);
    const ctx = testContext(session);
    const out = await startAction(ctx, { type: 'swap_source_language', lang: 'te' }, { confirmed: true, origin: 'user' });
    expect(out.outcome.status).toBe('done');
    const d = session.doc;
    expect(d.format.language).toBe('te');
    expect(d.brief.title).toBe('te:title');
    expect(lines(d).find((l) => l.id === 'l1')?.text).toBe('te:l1');
    expect(i18nOf(d).editions.te).toBeUndefined();
    expect(i18nOf(d).editions.en.lines.l1).toMatchObject({ text: 'Where did the moon go?', status: 'reviewed' });
    expect(i18nOf(d).editions.en.brief?.title?.text).toBe('Milo and the Moon');
    expect(editionReadiness(d, 'en').publishable).toBe(true);
    expect(editionProgress(d, 'hi')).toMatchObject({ missing: 0, stale: 0 });
    expect(d.spend.totalUsd).toBe(0);
    expect(d.conversation[d.conversation.length - 1].text).toContain("is now the comic's language");
  });

  it('an incomplete edition is refused with a quoted "translate missing" chip', async () => {
    const doc = applyOps(translated(), [{ op: 'line', pageId: 'pg_1', panelId: 'pn_1', id: 'l1', patch: { text: 'Where is the moon tonight?' } }]);
    const session = newSession(doc);
    const out = await startAction(testContext(session), { type: 'swap_source_language', lang: 'te' }, { confirmed: true, origin: 'user' });
    expect(out.outcome).toMatchObject({ status: 'blocked', code: 'NOT_READY' });
    const last = session.doc.conversation[session.doc.conversation.length - 1];
    expect(last.text).toContain('1 line out of date');
    expect(last.nextSteps?.[0]).toMatchObject({ label: 'Translate missing lines', action: { type: 'translate', languages: ['te'] } });
    expect(session.doc.format.language).toBe('en');
  });

  it('swapSourceOps renames glossary terms both ways', () => {
    let doc = translated();
    doc = applyOps(doc, [{ op: 'glossary_term', id: 'g_milo', patch: { term: 'Milo', forms: { te: 'మైలో' } } }]);
    const next = applyOps(doc, swapSourceOps(doc, 'te'));
    expect(i18nOf(next).glossary.find((g) => g.id === 'g_milo')).toMatchObject({ term: 'మైలో', forms: { en: 'Milo' } });
  });
});

describe('accept_translation_issue', () => {
  it('"Use suggestion" applies it and clears the issue; "Looks right" marks reviewed; stale lines are refused', async () => {
    let doc = translated();
    const l1 = lines(doc)[0];
    doc = applyOps(doc, [
      { op: 'translation', lang: 'te', lineId: 'l1', patch: { status: 'reviewed', gloss: 'g', issue: { severity: 'minor', note: 'Stiff.', suggestion: 'చంద్రుడు ఎక్కడ?' } } },
      { op: 'translation', lang: 'te', lineId: 'l3', patch: { status: 'machine', issue: { severity: 'major', note: 'Wrong meaning.' } } },
      { op: 'translation', lang: 'te', lineId: 'l7', patch: { issue: { severity: 'minor', note: `${AUTO_CORRECTED_NOTE}: off`, suggestion: 'అసలు వాక్యం' } } }
    ]);
    expect(editionReadiness(doc, 'te').publishable).toBe(false);
    const session = newSession(doc);
    const ctx = testContext(session);
    await startAction(ctx, { type: 'accept_translation_issue', lang: 'te', lineId: 'l1', useSuggestion: true }, { confirmed: true, origin: 'user' });
    expect(i18nOf(session.doc).editions.te.lines.l1).toEqual({ text: 'చంద్రుడు ఎక్కడ?', status: 'reviewed', sourceHash: lineSourceHash(l1), at: expect.any(Number) });
    await startAction(ctx, { type: 'accept_translation_issue', lang: 'te', lineId: 'l3', useSuggestion: false }, { confirmed: true, origin: 'user' });
    expect(i18nOf(session.doc).editions.te.lines.l3).toMatchObject({ status: 'reviewed' });
    expect(i18nOf(session.doc).editions.te.lines.l3.issue).toBeUndefined();
    // reverting an auto-correction restores the original
    await startAction(ctx, { type: 'accept_translation_issue', lang: 'te', lineId: 'l7', useSuggestion: true }, { confirmed: true, origin: 'user' });
    expect(i18nOf(session.doc).editions.te.lines.l7.text).toBe('అసలు వాక్యం');
    expect(editionReadiness(session.doc, 'te').publishable).toBe(true);
    // no chat noise for inline review taps
    expect(session.doc.conversation).toHaveLength(doc.conversation.length);
    const stale = applyOps(session.doc, [{ op: 'line', pageId: 'pg_5', panelId: 'pn_5', id: 'l9', patch: { text: 'Found it!' } }]);
    const s2 = newSession(stale);
    const refused = await startAction(testContext(s2), { type: 'accept_translation_issue', lang: 'te', lineId: 'l9', useSuggestion: false }, { confirmed: true, origin: 'user' });
    expect(refused.outcome).toMatchObject({ status: 'blocked', code: 'CONFLICT' });
    const none = await startAction(testContext(s2), { type: 'accept_translation_issue', lang: 'te', lineId: 'l2', useSuggestion: true }, { confirmed: true, origin: 'user' });
    expect(none.outcome).toMatchObject({ status: 'blocked', code: 'NOT_FOUND' });
  });

  it('works for cover/brief texts too', async () => {
    let doc = translated();
    doc = applyOps(doc, [{ op: 'edition_text', lang: 'te', field: 'brief.title', value: { text: 'te:title', status: 'machine', sourceHash: textSourceHash(doc.brief.title), at: 1, issue: { severity: 'minor', note: 'n', suggestion: 'మైలో చంద్రుడు' } } }]);
    const session = newSession(doc);
    await startAction(testContext(session), { type: 'accept_translation_issue', lang: 'te', lineId: 'brief.title', useSuggestion: true }, { confirmed: true, origin: 'user' });
    expect(i18nOf(session.doc).editions.te.brief?.title).toMatchObject({ text: 'మైలో చంద్రుడు', status: 'reviewed' });
  });
});
