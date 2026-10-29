// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { DEFAULT_CAPS } from '../../../../shared/comic/capabilities.js';
import type { ComicDoc } from '../../../../shared/comic/doc.js';
import { i18nOf, lineSourceHash, textSourceHash } from '../../../../shared/comic/i18n.js';
import { applyOps, type DocOp } from '../../../../shared/comic/ops.js';
import { inverseOps } from '../../../../shared/comic/undo.js';
import { editionReadiness } from '../../../../shared/comic/i18n.js';
import type { SanitizeCtx } from '../extensions.js';
import { sixPageKidsDoc } from '../i18n/testing.js';
import { sanitizePatchOps } from '../jobs.js';
import { opSanitizerFor } from './index.js';
import { I18N_SANITIZERS, sanitizeEdition, sanitizeEditionBalloon, sanitizeEditionText, sanitizeGlossaryTerm, sanitizeTranslation } from './i18n.js';

const CTX: SanitizeCtx = { userId: 'user-1', caps: DEFAULT_CAPS, rating: 'PG', now: 1_800_000_000_000 };
const withTe = (): ComicDoc => {
  const doc = applyOps(sixPageKidsDoc(), [{ op: 'edition', lang: 'te', patch: {} }]);
  const l1 = doc.pages[0].panels[0].lines[0];
  return applyOps(doc, [{ op: 'translations', lang: 'te', lines: { l1: { text: 'పాతది', status: 'reviewed', sourceHash: lineSourceHash(l1), at: 1, gloss: 'Old', model: 'm', issue: { severity: 'minor', note: 'n' } } } }]);
};
const expectCode = (fn: () => unknown, status: number) => {
  try {
    fn();
  } catch (err) {
    expect((err as { status?: number }).status).toBe(status);
    return;
  }
  throw new Error('expected a refusal');
};

describe('i18n sanitizers (contract §5.4)', () => {
  it('are all registered (none is the wave-0 NOT_AVAILABLE stub)', () => {
    for (const op of ['edition', 'translation', 'edition_text', 'edition_balloon', 'glossary_term']) expect(opSanitizerFor(op)).toBe(I18N_SANITIZERS.find((s) => s.op === op));
  });

  it('translation: forced {edited, now, current sourceHash}; model cleared; a sent gloss kept, an unsent one cleared; bounds', () => {
    const doc = withTe();
    const op = sanitizeTranslation.sanitize(doc, { op: 'translation', lang: 'te', lineId: 'l1', patch: { text: '  కొత్తది  ', status: 'reviewed', sourceHash: 'forged', at: 5, gloss: 'x', model: 'y' } }, CTX);
    expect(op.patch).toEqual({ text: 'కొత్తది', status: 'edited', at: CTX.now, sourceHash: lineSourceHash(doc.pages[0].panels[0].lines[0]), gloss: 'x', issue: undefined, model: undefined });
    const next = applyOps(doc, [op]);
    expect(i18nOf(next).editions.te.lines.l1).toEqual({ text: 'కొత్తది', status: 'edited', at: CTX.now, sourceHash: lineSourceHash(doc.pages[0].panels[0].lines[0]), gloss: 'x' });
    // A plain edit (no gloss sent) clears the old gloss, issue and model: they described a different text.
    const plain = applyOps(doc, [sanitizeTranslation.sanitize(doc, { op: 'translation', lang: 'te', lineId: 'l1', patch: { text: 'కొత్తది' } }, CTX)]);
    expect(i18nOf(plain).editions.te.lines.l1).toEqual({ text: 'కొత్తది', status: 'edited', at: CTX.now, sourceHash: lineSourceHash(doc.pages[0].panels[0].lines[0]) });
    expectCode(() => sanitizeTranslation.sanitize(doc, { op: 'translation', lang: 'te', lineId: 'l1', patch: { text: 'x'.repeat(601) } }, CTX), 400);
    expectCode(() => sanitizeTranslation.sanitize(doc, { op: 'translation', lang: 'te', lineId: 'l1', patch: { text: '   ' } }, CTX), 400);
    expectCode(() => sanitizeTranslation.sanitize(doc, { op: 'translation', lang: 'hi', lineId: 'l1', patch: { text: 'x' } }, CTX), 400); // no edition
    expectCode(() => sanitizeTranslation.sanitize(doc, { op: 'translation', lang: 'te', lineId: 'nope', patch: { text: 'x' } }, CTX), 400);
    expectCode(() => sanitizeTranslation.sanitize(doc, { op: 'translation', lang: 'en', lineId: 'l1', patch: { text: 'x' } }, CTX), 400); // the source
    expect(sanitizeTranslation.sanitize(doc, { op: 'translation', lang: 'te', lineId: 'l1', patch: null }, CTX).patch).toBeNull();
  });

  it('edition: registry tags only, never the source, only the register; the cap is a 409', () => {
    const doc = sixPageKidsDoc();
    expect(sanitizeEdition.sanitize(doc, { op: 'edition', lang: 'hi', patch: { register: 'formal', ...({ status: 'ready', published: true } as object) } }, CTX)).toEqual({ op: 'edition', lang: 'hi', patch: { register: 'formal' } });
    expectCode(() => sanitizeEdition.sanitize(doc, { op: 'edition', lang: 'xx', patch: {} }, CTX), 400);
    expectCode(() => sanitizeEdition.sanitize(doc, { op: 'edition', lang: 'en', patch: {} }, CTX), 400);
    expectCode(() => sanitizeEdition.sanitize(doc, { op: 'edition', lang: 'TE', patch: {} }, CTX), 400);
    expectCode(() => sanitizeEdition.sanitize(doc, { op: 'edition', lang: 'hi', patch: { register: 'shouty' as never } }, CTX), 400);
    let full = doc;
    for (const l of ['hi', 'te', 'ta', 'kn', 'ml', 'mr', 'bn', 'gu', 'pa', 'ur', 'es', 'fr', 'pt', 'de', 'id', 'ja', 'ko', 'zh-Hans', 'ar']) full = applyOps(full, [{ op: 'edition', lang: l, patch: {} }]);
    expect(Object.keys(i18nOf(full).editions)).toHaveLength(19);
    expect(sanitizeEdition.sanitize(full, { op: 'edition', lang: 'hi', patch: null }, CTX).patch).toBeNull();
  });

  it('edition_text: forced against the current source text; refused for an empty source field', () => {
    const doc = withTe();
    const op = sanitizeEditionText.sanitize(doc, { op: 'edition_text', lang: 'te', field: 'brief.title', value: { text: 'మైలో, చంద్రుడు', status: 'reviewed', sourceHash: 'x', at: 1, gloss: 'g' } }, CTX);
    expect(op.value).toEqual({ text: 'మైలో, చంద్రుడు', status: 'edited', sourceHash: textSourceHash('Milo and the Moon'), at: CTX.now });
    expectCode(() => sanitizeEditionText.sanitize(doc, { op: 'edition_text', lang: 'te', field: 'cover.tagline', value: { text: 'x', status: 'edited', sourceHash: '', at: 1 } }, CTX), 400);
    expectCode(() => sanitizeEditionText.sanitize(doc, { op: 'edition_text', lang: 'te', field: 'brief.premise' as never, value: null }, CTX), 400);
  });

  it('edition_balloon: clamped like a balloon; fontScale 0.7..1.3; unknown keys dropped', () => {
    const doc = withTe();
    const op = sanitizeEditionBalloon.sanitize(doc, { op: 'edition_balloon', lang: 'te', lineId: 'l1', patch: { x: -1, y: 2, w: 0.3, fontScale: 9, pinned: true, ...({ fill: 'red' } as object) } }, CTX);
    expect(op.patch).toEqual({ x: 0, y: 1, w: 0.3, fontScale: 1.3, pinned: true });
    expectCode(() => sanitizeEditionBalloon.sanitize(doc, { op: 'edition_balloon', lang: 'te', lineId: 'l1', patch: { x: Number.NaN } }, CTX), 400);
  });

  it('glossary_term: enums, lengths, registry form keys, the 200-term cap', () => {
    const doc = sixPageKidsDoc();
    const op = sanitizeGlossaryTerm.sanitize(doc, { op: 'glossary_term', id: 'gl_t_1', patch: { term: '  Moon Lake ', kind: 'place', policy: 'translate', forms: { te: 'చంద్ర సరస్సు', hi: '' }, note: 'n'.repeat(500), refId: 'nope' } }, CTX);
    expect(op.patch).toEqual({ term: 'Moon Lake', kind: 'place', policy: 'translate', forms: { te: 'చంద్ర సరస్సు', hi: null }, note: 'n'.repeat(140) });
    expectCode(() => sanitizeGlossaryTerm.sanitize(doc, { op: 'glossary_term', id: 'bad id!', patch: { term: 'x' } }, CTX), 400);
    expectCode(() => sanitizeGlossaryTerm.sanitize(doc, { op: 'glossary_term', id: 'g1', patch: { forms: { te: 'x' } } }, CTX), 400); // new term without wording
    expectCode(() => sanitizeGlossaryTerm.sanitize(doc, { op: 'glossary_term', id: 'g1', patch: { term: 'x', forms: { en: 'x' } } }, CTX), 400); // the source
    expectCode(() => sanitizeGlossaryTerm.sanitize(doc, { op: 'glossary_term', id: 'g1', patch: { term: 'x', policy: 'shout' as never } }, CTX), 400);
    let full = doc;
    const ops: DocOp[] = Array.from({ length: 200 }, (_, i) => ({ op: 'glossary_term', id: `g${i}`, patch: { term: `t${i}` } }));
    full = applyOps(full, ops);
    expectCode(() => sanitizeGlossaryTerm.sanitize(full, { op: 'glossary_term', id: 'g_new', patch: { term: 'one more' } }, CTX), 409);
  });

  it('Undo of a translation edit restores the gloss and the review flag (status stays "edited"), so a review-blocked edition stays blocked', () => {
    const doc = applyOps(sixPageKidsDoc(), [{ op: 'edition', lang: 'te', patch: {} }]);
    const lines = doc.pages.flatMap((p) => p.panels.flatMap((pn) => pn.lines));
    const entries: Record<string, { text: string; status: 'reviewed' | 'machine'; sourceHash: string; at: number; gloss?: string; issue?: { severity: 'major'; note: string; suggestion?: string } }> = {};
    for (const l of lines) entries[l.id] = { text: `తెలుగు ${l.id}`, status: 'reviewed', sourceHash: lineSourceHash(l), at: 1, gloss: `Means: ${l.text}` };
    entries.l3 = { ...entries.l3, status: 'machine', gloss: undefined, issue: { severity: 'major', note: 'Wrong meaning.', suggestion: 'చూడు, అక్కడ!' } };
    const before = applyOps(doc, [{ op: 'translations', lang: 'te', lines: entries }]);
    expect(editionReadiness(before, 'te').publishable).toBe(false); // l3 is flagged (and unreviewed)
    const edits = sanitizePatchOps(before, [
      { op: 'translation', lang: 'te', lineId: 'l1', patch: { text: 'కొత్త l1' } },
      { op: 'translation', lang: 'te', lineId: 'l3', patch: { text: 'కొత్త l3' } }
    ], CTX);
    const edited = applyOps(before, edits);
    expect(i18nOf(edited).editions.te.lines.l3.issue).toBeUndefined();
    // Undo: the client inverse carries the full previous entries; the server keeps gloss + issue, forces the rest.
    const undone = applyOps(edited, sanitizePatchOps(edited, inverseOps(before, edits), CTX));
    expect(i18nOf(undone).editions.te.lines.l1).toEqual({ text: 'తెలుగు l1', status: 'edited', at: CTX.now, sourceHash: lineSourceHash(lines[0]), gloss: 'Means: Where did the moon go?' });
    expect(i18nOf(undone).editions.te.lines.l3).toEqual({ text: 'తెలుగు l3', status: 'edited', at: CTX.now, sourceHash: lineSourceHash(lines[2]), issue: { severity: 'major', note: 'Wrong meaning.', suggestion: 'చూడు, అక్కడ!' } });
    expect(editionReadiness(undone, 'te').publishable).toBe(editionReadiness(before, 'te').publishable);
    expect(editionReadiness(undone, 'te').issues.map((i) => i.code)).toContain('major_issue');
    // Bounds: gloss and note are clipped, a malformed issue is dropped, nothing lets the client mint "reviewed".
    const long = sanitizeTranslation.sanitize(before, { op: 'translation', lang: 'te', lineId: 'l1', patch: { text: 'x', gloss: 'g'.repeat(400), issue: { severity: 'minor', note: 'n'.repeat(400), suggestion: 's'.repeat(700) } } }, CTX);
    expect(long.patch).toMatchObject({ status: 'edited', gloss: 'g'.repeat(300), issue: { severity: 'minor', note: 'n'.repeat(300), suggestion: 's'.repeat(600) } });
    const bad = sanitizeTranslation.sanitize(before, { op: 'translation', lang: 'te', lineId: 'l1', patch: { text: 'x', gloss: '   ', issue: { severity: 'fatal', note: 'n' } as never } }, CTX);
    expect(bad.patch).toMatchObject({ status: 'edited', gloss: undefined, issue: undefined });
  });

  it('through sanitizePatchOps: a client can never mark its own translation "reviewed"', () => {
    const doc = withTe();
    const out = sanitizePatchOps(doc, [{ op: 'translation', lang: 'te', lineId: 'l1', patch: { text: 'చంద్రుడు', status: 'reviewed' } }], CTX);
    expect(out[0]).toMatchObject({ op: 'translation', patch: { status: 'edited' } });
    expect(() => sanitizePatchOps(doc, [{ op: 'translations', lang: 'te', lines: {} } as DocOp], CTX)).toThrow();
  });
});

// P2-GATE L5: translations and glossary text are cleaned where they enter (sanitize/text.ts): no NUL or
// lone surrogate reaches the live doc (jsonb rejects both), and a clip never splits an emoji.
describe('i18n free text is jsonb-safe at the door', () => {
  it('translation: NUL and a lone surrogate are dropped, whole emoji stay; a NUL-only text is "empty"', () => {
    const doc = withTe();
    const op = sanitizeTranslation.sanitize(doc, { op: 'translation', lang: 'te', lineId: 'l1', patch: { text: ' కొత్త\u0000ది 🦊 \uD83C' } }, CTX);
    expect(op.patch?.text).toBe('కొత్తది 🦊');
    expectCode(() => sanitizeTranslation.sanitize(doc, { op: 'translation', lang: 'te', lineId: 'l1', patch: { text: '\u0000\uDC00' } }, CTX), 400);
  });

  it('glossary: term, note and forms are cleaned and clipped without splitting a pair', () => {
    const doc = withTe();
    const op = sanitizeGlossaryTerm.sanitize(
      doc,
      { op: 'glossary_term', id: 'gl_t_9', patch: { term: `${'m'.repeat(79)}🦊`, kind: 'place', policy: 'translate', note: 'see\u0000 map \uD800', forms: { te: 'చంద్ర\uDC00 🦊' } } },
      CTX
    );
    expect(op.patch).toMatchObject({ term: 'm'.repeat(79), note: 'see map', forms: { te: 'చంద్ర 🦊' } });
    expectCode(() => sanitizeGlossaryTerm.sanitize(doc, { op: 'glossary_term', id: 'gl_t_8', patch: { term: '\u0000' } }, CTX), 400);
  });
});
