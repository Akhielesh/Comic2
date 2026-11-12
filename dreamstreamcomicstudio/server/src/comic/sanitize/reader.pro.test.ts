// @vitest-environment node
// PE-SERVER (master plan §2.3 "sanitize/reader.ts adds motion"; carry notes PE-0 5; PROGRAM3 bug B19): reader.motion is
// 'on' | 'off' | null. A client sets it only while PRO_EDIT_OPS_PATCHABLE is on (flipped locally here); off it is "an
// unknown reader setting" as before — but the inverse of every reader change re-sends the stored settings whole, so a
// stored reader.motion is always accepted back (re-assert), never a new or different value.
import { afterEach, describe, expect, it, vi } from 'vitest';

const sw = vi.hoisted(() => ({ on: true }));
vi.mock('../../../../shared/comic/ops.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../../shared/comic/ops.js')>();
  return {
    ...real,
    get PRO_EDIT_OPS_PATCHABLE() {
      return sw.on;
    }
  };
});

import { DEFAULT_CAPS } from '../../../../shared/comic/capabilities.js';
import { normalizeDoc, readerOf, type ComicDoc } from '../../../../shared/comic/doc.js';
import { applyOps, type DocOp } from '../../../../shared/comic/ops.js';
import { inverseOps } from '../../../../shared/comic/undo.js';
import type { SanitizeCtx } from '../extensions.js';
import { sanitizePatchOps } from '../jobs.js';
import { plannedDoc } from '../orchestrator.fakes.js';
import { StudioError } from '../types.js';
import { sanitizeReaderPatch } from './reader.js';

afterEach(() => {
  sw.on = true;
});

const sctx = (): SanitizeCtx => ({ userId: 'user-1', caps: DEFAULT_CAPS, rating: 'PG-13', now: 1_800_000_000_000 });
const sanitize = (doc: ComicDoc, ops: unknown[]) => sanitizePatchOps(doc, ops, sctx()) as DocOp[];
const refuses = (fn: () => unknown, message: RegExp) => {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(StudioError);
  expect((caught as StudioError).status).toBe(400);
  expect((caught as StudioError).message).toMatch(message);
};
const withMotion = (motion?: 'on' | 'off'): ComicDoc => {
  const raw = JSON.parse(JSON.stringify(plannedDoc())) as ComicDoc;
  if (motion) raw.reader = { ...readerOf(raw), motion };
  return normalizeDoc(raw);
};

describe('reader.motion with the switch on', () => {
  it("accepts 'on', 'off' and null (clear), refuses anything else", () => {
    const doc = withMotion();
    expect(sanitize(doc, [{ op: 'reader', patch: { motion: 'on' } }])).toEqual([{ op: 'reader', patch: { motion: 'on' } }]);
    expect(applyOps(doc, sanitize(doc, [{ op: 'reader', patch: { motion: 'off', turn: 'fade' } }])).reader).toMatchObject({ motion: 'off', turn: 'fade' });
    const cleared = applyOps(withMotion('on'), sanitize(withMotion('on'), [{ op: 'reader', patch: { motion: null } }])).reader;
    expect(cleared).not.toHaveProperty('motion');
    refuses(() => sanitize(doc, [{ op: 'reader', patch: { motion: 'auto' } }]), /on or off/);
    refuses(() => sanitize(doc, [{ op: 'reader', patch: { motion: true } }]), /on or off/);
  });

  it('the inverse of setting it (and of any reader change once it is set) is accepted and restores the settings exactly', () => {
    for (const [doc, patch] of [
      [withMotion(), { motion: 'on' }],
      [withMotion('on'), { motion: 'off' }],
      [withMotion('on'), { turn: 'slide' }]
    ] as const) {
      const ops = sanitize(doc, [{ op: 'reader', patch }]);
      const after = applyOps(doc, ops);
      const back = applyOps(after, sanitize(after, inverseOps(doc, ops)));
      expect(back.reader, JSON.stringify(patch)).toEqual(doc.reader);
    }
  });
});

describe('reader.motion with the switch off (as before PE-SERVER, except re-asserting what is stored)', () => {
  it('a new value is "an unknown reader setting"', () => {
    sw.on = false;
    refuses(() => sanitize(withMotion(), [{ op: 'reader', patch: { motion: 'on' } }]), /Unknown reader setting: motion/);
    refuses(() => sanitize(withMotion('on'), [{ op: 'reader', patch: { motion: 'off' } }]), /Unknown reader setting: motion/);
    refuses(() => sanitize(withMotion('on'), [{ op: 'reader', patch: { motion: null } }]), /Unknown reader setting: motion/);
    // The director's reader tool passes no stored settings: never motion.
    refuses(() => sanitizeReaderPatch({ motion: 'on' }), /Unknown reader setting: motion/);
  });

  it('a newer build stored it: the undo of a page-turn change (which re-sends it) is accepted and keeps it (bug B19)', () => {
    sw.on = false;
    const doc = withMotion('on');
    const ops = sanitize(doc, [{ op: 'reader', patch: { turn: 'slide' } }]);
    const after = applyOps(doc, ops);
    const inverse = inverseOps(doc, ops);
    expect(inverse).toEqual([{ op: 'reader', patch: expect.objectContaining({ turn: 'paper', motion: 'on' }) }]);
    const undo = sanitize(after, inverse);
    expect(undo[0]).toMatchObject({ patch: { motion: 'on' } });
    expect(applyOps(after, undo).reader).toEqual(doc.reader);
  });
});
