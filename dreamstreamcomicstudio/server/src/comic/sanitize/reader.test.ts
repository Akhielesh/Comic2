// Reader patch sanitizer (contract §5.4 `reader`): enums and booleans, ≤ 140-char credits/dedication,
// null clears (deep-merge op), rejected alias guidedDefault, whole-batch rejection, and the shared
// sanitizePatchOps path (the same validator the UI's "Reader look" panel uses).
import { describe, expect, it } from 'vitest';
import { applyOps } from '../../../../shared/comic/ops.js';
import { DEFAULT_READER, pageSpecHash, readerOf } from '../../../../shared/comic/doc.js';
import { DEFAULT_CAPS } from '../../../../shared/comic/capabilities.js';
import { DOC_LIMITS } from '../../../../shared/comic/limits.js';
import { plannedDoc } from '../orchestrator.fakes.js';
import { sanitizePatchOps } from '../jobs.js';
import { opSanitizerFor } from './index.js';
import { READER_SANITIZERS, cleanReaderText, sanitizeReaderPatch } from './reader.js';
import type { SanitizeCtx } from '../extensions.js';
import { StudioError } from '../types.js';

const sctx: SanitizeCtx = { userId: 'user-1', caps: DEFAULT_CAPS, rating: 'PG-13', now: 1_800_000_000_000 };

const rejects = (fn: () => unknown, re: RegExp) => {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(StudioError);
    expect((err as StudioError).status).toBe(400);
    expect((err as StudioError).userMessage).toMatch(re);
    return;
  }
  throw new Error('expected a 400');
};

describe('registry', () => {
  it('owns the reader op (no NOT_AVAILABLE stub left)', () => {
    expect(READER_SANITIZERS.map((s) => s.op)).toEqual(['reader']);
    expect(opSanitizerFor('reader')).toBe(READER_SANITIZERS[0]);
  });
});

describe('sanitizeReaderPatch', () => {
  it('keeps only the keys that were sent, with clean values', () => {
    expect(sanitizeReaderPatch({ turn: 'slide' })).toEqual({ turn: 'slide' });
    expect(sanitizeReaderPatch({ paperTexture: false, ambient: true, guidedOverview: false })).toEqual({ paperTexture: false, ambient: true, guidedOverview: false });
    expect(sanitizeReaderPatch({ credits: '  Written by   Asha\nand Ravi  ' })).toEqual({ credits: 'Written by Asha and Ravi' });
  });

  it('null and empty text clear a key (deep-merge op: null = clear)', () => {
    expect(sanitizeReaderPatch({ credits: null })).toEqual({ credits: null });
    expect(sanitizeReaderPatch({ dedication: '   ' })).toEqual({ dedication: null });
  });

  it('rejects bad enums, non-booleans, non-text, too-long text, unknown keys and empty patches', () => {
    rejects(() => sanitizeReaderPatch({ turn: 'curl' }), /paper, slide, fade/);
    rejects(() => sanitizeReaderPatch({ ambient: 'yes' }), /ambient must be true or false/);
    rejects(() => sanitizeReaderPatch({ credits: 42 }), /credits line must be text/);
    rejects(() => sanitizeReaderPatch({ credits: 'x'.repeat(DOC_LIMITS.readerTextChars + 1) }), /to 140 characters \(it has 141\)/);
    rejects(() => sanitizeReaderPatch({ sound: true }), /Unknown reader setting: sound/);
    rejects(() => sanitizeReaderPatch({}), /Nothing to change/);
    rejects(() => sanitizeReaderPatch(null), /Invalid reader settings/);
    rejects(() => sanitizeReaderPatch(['turn']), /Invalid reader settings/);
  });

  it('explains instead of silently dropping the rejected alias guidedDefault', () => {
    rejects(() => sanitizeReaderPatch({ guidedDefault: true }), /never the default/);
  });

  it('strips control and bidi-override characters from text', () => {
    expect(cleanReaderText('For\u0000 Mia‮ and​ Leo')).toBe('For Mia and Leo');
  });

  it('drops lone surrogates (jsonb rejects them) and keeps whole emoji', () => {
    expect(cleanReaderText('For Mia \uD83C and Leo \uDC00🦊')).toBe('For Mia and Leo 🦊');
    expect(sanitizeReaderPatch({ credits: 'Art: Maya \uD83E' })).toEqual({ credits: 'Art: Maya' });
  });
});

describe('through sanitizePatchOps (the UI path)', () => {
  it('commits a clean reader op that merges onto the defaults and never stales a page', () => {
    const doc = plannedDoc();
    const hashes = doc.pages.map((p) => pageSpecHash(doc, p));
    const ops = sanitizePatchOps(doc, [{ op: 'reader', patch: { turn: 'fade', credits: 'By the Rao family' } }], sctx);
    expect(ops).toEqual([{ op: 'reader', patch: { turn: 'fade', credits: 'By the Rao family' } }]);
    const next = applyOps(doc, ops);
    expect(readerOf(next)).toEqual({ ...DEFAULT_READER, turn: 'fade', credits: 'By the Rao family' });
    expect(next.pages.map((p) => pageSpecHash(next, p))).toEqual(hashes);
    const cleared = applyOps(next, sanitizePatchOps(next, [{ op: 'reader', patch: { credits: null } }], sctx));
    expect(readerOf(cleared).credits).toBeUndefined();
    expect(readerOf(cleared).turn).toBe('fade');
  });

  it('one bad reader op rejects the whole batch', () => {
    const doc = plannedDoc();
    rejects(
      () => sanitizePatchOps(doc, [{ op: 'brief', patch: { title: 'Ok' } }, { op: 'reader', patch: { turn: 'spin' } }], sctx),
      /Page-turn style/
    );
  });
});
