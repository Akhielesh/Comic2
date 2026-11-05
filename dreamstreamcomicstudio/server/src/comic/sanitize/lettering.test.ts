import { describe, expect, it } from 'vitest';
import type { ComicDoc } from '../../../../shared/comic/doc.js';
import type { DocOp } from '../../../../shared/comic/ops.js';
import { applyOps } from '../../../../shared/comic/ops.js';
import { DEFAULT_CAPS } from '../../../../shared/comic/capabilities.js';
import type { SanitizeCtx } from '../extensions.js';
import { plannedDoc } from '../orchestrator.fakes.js';
import { StudioError } from '../types.js';
import { opSanitizerFor } from './index.js';
import { LETTERING_SANITIZERS, LINE_STYLE_MAX_IDS } from './lettering.js';

const ctx: SanitizeCtx = { userId: 'u1', caps: DEFAULT_CAPS, rating: 'PG-13', now: 1 };
const run = (doc: ComicDoc, op: unknown): DocOp => {
  const s = LETTERING_SANITIZERS.find((x) => x.op === (op as { op: string }).op)!;
  return s.sanitize(doc, op as DocOp, ctx);
};
const rejects = (doc: ComicDoc, op: unknown, message?: RegExp) => {
  let err: unknown;
  try {
    run(doc, op);
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(StudioError);
  expect(err).toMatchObject({ status: 400, code: 'BAD_REQUEST' });
  if (message) expect((err as StudioError).userMessage).toMatch(message);
};

describe('lettering sanitizers are registered (no longer NOT_AVAILABLE)', () => {
  it('letter_style and line_style resolve to these sanitizers', () => {
    expect(opSanitizerFor('letter_style')).toBe(LETTERING_SANITIZERS[0]);
    expect(opSanitizerFor('line_style')).toBe(LETTERING_SANITIZERS[1]);
  });
});

describe('letter_style', () => {
  const doc = plannedDoc();
  it('accepts presets, style patches (normalized) and the reset', () => {
    expect(run(doc, { op: 'letter_style', patch: { presetId: 'manga' } })).toEqual({ op: 'letter_style', patch: { presetId: 'manga' } });
    expect(run(doc, { op: 'letter_style', patch: null })).toEqual({ op: 'letter_style', patch: null });
    const out = run(doc, {
      op: 'letter_style',
      patch: { base: { textColor: 'Red', sizeScale: 9, evil: '<script>' }, kinds: { sfx: { font: 'ultra' } }, speakers: { c_maya: { shape: 'cloud' } }, safeMargin: 0.05 }
    });
    expect(out).toEqual({
      op: 'letter_style',
      patch: { base: { sizeScale: 3.5, textColor: '#e63946' }, kinds: { sfx: { font: 'ultra' } }, speakers: { c_maya: { shape: 'cloud' } }, safeMargin: 0.05 }
    });
  });
  it('rejects unknown presets, speakers outside the cast, empty and oversized patches', () => {
    rejects(doc, { op: 'letter_style', patch: { presetId: 'comic-sans' } }, /Unknown lettering preset/);
    rejects(doc, { op: 'letter_style', patch: { speakers: { c_ghost: { shape: 'cloud' } } } }, /not in the cast/);
    rejects(doc, { op: 'letter_style', patch: {} }, /nothing valid/);
    rejects(doc, { op: 'letter_style', patch: { base: { font: 'comic-sans', textColor: 'notacolour' } } }, /nothing valid/);
    rejects(doc, { op: 'letter_style', patch: 'manga' });
    rejects(doc, { op: 'letter_style', patch: { base: { textColor: 'x'.repeat(20_000) } } }, /too large/);
  });
});

describe('line_style', () => {
  const doc = plannedDoc();
  it('accepts lines on the page; dedupes ids; keeps the mode; null clears', () => {
    expect(run(doc, { op: 'line_style', pageId: 'pg_1', lineIds: ['ln_1_2', 'ln_1_2'], patch: { shape: 'jagged', textColor: 'navy', junk: 1 }, mode: 'replace' })).toEqual({
      op: 'line_style',
      pageId: 'pg_1',
      lineIds: ['ln_1_2'],
      patch: { textColor: '#1d3557', shape: 'jagged' },
      mode: 'replace'
    });
    expect(run(doc, { op: 'line_style', pageId: 'pg_1', lineIds: ['ln_1_2'], patch: null })).toEqual({ op: 'line_style', pageId: 'pg_1', lineIds: ['ln_1_2'], patch: null });
  });
  it('rejects missing pages, lines from other pages, too many ids, bad modes, empty/oversized styles', () => {
    rejects(doc, { op: 'line_style', pageId: 'nope', lineIds: ['ln_1_2'], patch: { italic: true } }, /no longer in the plan/);
    rejects(doc, { op: 'line_style', pageId: 'pg_1', lineIds: ['ln_2_2'], patch: { italic: true } }, /not on this page/);
    rejects(doc, { op: 'line_style', pageId: 'pg_1', lineIds: [], patch: { italic: true } });
    rejects(doc, { op: 'line_style', pageId: 'pg_1', lineIds: Array.from({ length: LINE_STYLE_MAX_IDS + 1 }, () => 'ln_1_2'), patch: { italic: true } }, /at most 80/);
    rejects(doc, { op: 'line_style', pageId: 'pg_1', lineIds: ['ln_1_2'], patch: { italic: true }, mode: 'clobber' }, /mode/);
    rejects(doc, { op: 'line_style', pageId: 'pg_1', lineIds: ['ln_1_2'], patch: { font: 'wingdings' } }, /nothing valid/);
    rejects(doc, { op: 'line_style', pageId: 'pg_1', lineIds: ['ln_1_2'], patch: { textColor: 'red', pad: 'x'.repeat(3000) } }, /too large/);
  });
  it('the sanitized op applies cleanly (no client-only fields survive)', () => {
    const op = run(doc, { op: 'line_style', pageId: 'pg_2', lineIds: ['ln_2_2'], patch: { fill: 'cream', borderWidth: 2 } });
    const after = applyOps(doc, [op]);
    expect(after.pages[1].panels[1].lines[0].style).toEqual({ fill: '#fff1d6', borderWidth: 2 });
  });
});
