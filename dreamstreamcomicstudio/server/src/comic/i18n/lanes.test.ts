// @vitest-environment node
// Translation lanes: languages run up to TRANSLATE_CONCURRENCY at once, chunks stay in order inside a
// language, a chunk that hits a provider rate limit or a 5xx gets one retry, and a "no" from the spending
// allowance stops every lane. Fakes only (no network, $0).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { editionProgress, editionReadiness, i18nOf } from '../../../../shared/comic/i18n.js';
import { LANGUAGES } from '../../../../shared/comic/languages.js';
import type { StudioAction } from '../../../../shared/comic/ops.js';
import { chunkTranslation, planTranslation } from '../../../../shared/comic/translationPlan.js';
import { logger } from '../../lib/logger.js';
import { JOB_TIMINGS } from '../jobs.js';
import { fakeBilling, newSession, scriptedLlm, testContext, type FakeBilling, type ScriptStep } from '../orchestrator.fakes.js';
import { StudioError, type LlmRequest } from '../types.js';
import { chunkRetryable, chunkRetryDelayMs, resetTranslationCalibration, runTranslation, TRANSLATE_CONCURRENCY, TRANSLATE_TIMINGS } from './index.js';
import { fakeLinguist, fakeTranslator, requestedIds, sixPageKidsDoc, times } from './testing.js';

type TranslateAction = Extract<StudioAction, { type: 'translate' }>;

/** Seven languages the fake translator writes in the right script (Latin ones get Spanish words). */
const SEVEN = ['te', 'hi', 'ta', 'ja', 'es', 'fr', 'de'];
const DEFAULT_TIMINGS = { ...TRANSLATE_TIMINGS };

let info: ReturnType<typeof vi.spyOn>;
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  JOB_TIMINGS.retryBackoffMs = 0;
  resetTranslationCalibration();
  Object.assign(TRANSLATE_TIMINGS, DEFAULT_TIMINGS, { retryMinMs: 0, retryMaxMs: 0 });
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  info = vi.spyOn(logger, 'info');
  warn = vi.spyOn(logger, 'warn');
});

afterEach(() => {
  Object.assign(TRANSLATE_TIMINGS, DEFAULT_TIMINGS);
  vi.restoreAllMocks();
});

const T = (languages: string[]): TranslateAction => ({ type: 'translate', languages });

/** The language a translator call is for ("… from English into Telugu (తెలుగు, …"). */
const langOf = (req: LlmRequest): string => {
  const sys = String(req.messages[0]?.content ?? '');
  const spec = LANGUAGES.find((l) => sys.includes(`into ${l.english} (`));
  if (!spec) throw new Error('no target language in the translator prompt');
  return spec.code;
};

const rateLimited = () => new StudioError('RATE_LIMIT', 'The translator is busy right now (rate limited). Wait a moment and try again.', { status: 429, retryable: true });
const denied = () => new StudioError('BILLING_DENIED', "You've used this month's included generation allowance.", { status: 402 });

/** The timing line of a finished run. */
const timingLine = (): Record<string, unknown> => {
  const call = info.mock.calls.find((c) => c[0] === 'comic_translate_timing');
  expect(call, 'comic_translate_timing is logged').toBeDefined();
  return call![1] as Record<string, unknown>;
};

interface Held {
  lang: string;
  ids: string[];
  /** Line ids of this language already in the doc when the call was made. */
  committedBefore: string[];
  open: boolean;
  release: (fail?: Error) => void;
}

/**
 * A translator whose every call waits until the test releases it (or fails it). Tracks what is in flight.
 * The linguist answers at once, so a language finishes as soon as its last chunk is released.
 */
function heldRun(languages: string[], opts: { billing?: FakeBilling } = {}) {
  const session = newSession(sixPageKidsDoc());
  const tr = fakeTranslator();
  const held: Held[] = [];
  const state = { inflight: 0, peak: 0 };
  const step = async (req: LlmRequest) => {
    const lang = langOf(req);
    const entry: Held = {
      lang,
      ids: requestedIds(req),
      committedBefore: Object.keys(i18nOf(session.doc).editions[lang]?.lines || {}),
      open: true,
      release: () => undefined
    };
    state.inflight += 1;
    state.peak = Math.max(state.peak, state.inflight);
    try {
      const fail = await new Promise<Error | undefined>((resolve) => {
        entry.release = (err) => {
          entry.open = false;
          resolve(err);
        };
        held.push(entry);
      });
      if (fail) throw fail;
      return tr.step(req);
    } finally {
      state.inflight -= 1;
    }
  };
  const llm = scriptedLlm({ translator: times(40, step), linguist: times(40, fakeLinguist()) });
  const ctx = testContext(session, { llm, ...(opts.billing ? { billing: opts.billing } : {}) });
  const open = () => held.filter((h) => h.open);
  const openFor = (lang: string) => open().find((h) => h.lang === lang);
  return { session, ctx, llm, held, state, open, openFor, start: () => runTranslation(ctx, T(languages), { confirmed: true, origin: 'user' }) };
}

/** Release every open call until the run is done. */
async function drain(run: ReturnType<typeof heldRun>, done: Promise<void>) {
  let finished = false;
  void done.then(() => (finished = true));
  for (let guard = 0; !finished && guard < 400; guard += 1) {
    for (const h of run.open()) h.release();
    await new Promise((r) => setTimeout(r, 1));
  }
  expect(finished).toBe(true);
}

const roleCalls = (llm: ReturnType<typeof scriptedLlm>, role: string) => llm.calls.filter((c) => c.role === role);

describe('lanes', () => {
  it('7 languages: at most 6 in flight; the 7th starts only when a language finishes', async () => {
    expect(TRANSLATE_CONCURRENCY).toBe(6);
    const run = heldRun(SEVEN);
    const started = await run.start();
    expect(started.outcome.status).toBe('started');
    await vi.waitFor(() => expect(run.open()).toHaveLength(6));
    // The pool takes languages in order: the first six are out, German waits.
    expect(run.open().map((h) => h.lang).sort()).toEqual(SEVEN.slice(0, 6).sort());
    expect(run.openFor('de')).toBeUndefined();
    expect(run.state.peak).toBe(6);

    // Telugu's first chunk comes back: its second chunk takes the same lane (still 6 out, German still waits).
    run.openFor('te')!.release();
    await vi.waitFor(() => expect(run.held.filter((h) => h.lang === 'te')).toHaveLength(2));
    expect(run.open()).toHaveLength(6);
    expect(run.held.some((h) => h.lang === 'de')).toBe(false);

    // Telugu's last chunk comes back: the review answers at once, Telugu is done, German starts.
    run.openFor('te')!.release();
    await vi.waitFor(() => expect(run.openFor('de')).toBeDefined());
    expect(editionReadiness(run.session.doc, 'te').publishable).toBe(true);
    expect(run.state.peak).toBe(6);

    await drain(run, started.done);
    await run.ctx.settled();
    expect(run.state.peak).toBe(6);
    for (const lang of SEVEN) expect(editionProgress(run.session.doc, lang)).toMatchObject({ missing: 0, stale: 0 });
    expect(timingLine()).toMatchObject({ langs: 7, lanes: 6, retries: 0, failedLines: 0, stoppedBy: null });
  });

  it('inside one language, chunk 2 starts only after chunk 1 is committed (glossary order)', async () => {
    const run = heldRun(['te']);
    const started = await run.start();
    await vi.waitFor(() => expect(run.open()).toHaveLength(1));
    const first = run.open()[0];
    // Nothing else of Telugu is asked while chunk 1 is out.
    await new Promise((r) => setTimeout(r, 5));
    expect(run.held).toHaveLength(1);
    first.release();
    await vi.waitFor(() => expect(run.held).toHaveLength(2));
    const second = run.held[1];
    const chunk1Lines = first.ids.filter((id) => /^l\d+$/.test(id));
    expect(chunk1Lines.length).toBeGreaterThan(0);
    expect(second.ids.some((id) => chunk1Lines.includes(id))).toBe(false);
    // Every line of chunk 1 was in the doc before chunk 2 was asked.
    for (const id of chunk1Lines) expect(second.committedBefore).toContain(id);
    await drain(run, started.done);
  });

  it('the success path makes exactly the calls the 3-lane run made, with the same result', async () => {
    const once = async (lanes: number) => {
      TRANSLATE_TIMINGS.lanes = lanes;
      const session = newSession(sixPageKidsDoc());
      const billing = fakeBilling();
      const llm = scriptedLlm({ translator: times(40, fakeTranslator().step), linguist: times(40, fakeLinguist()) });
      const ctx = testContext(session, { llm, billing });
      const started = await runTranslation(ctx, T(SEVEN), { confirmed: true, origin: 'user' });
      await started.done;
      await ctx.settled();
      const editions = Object.fromEntries(SEVEN.map((l) => [l, Object.fromEntries(Object.entries(i18nOf(session.doc).editions[l].lines).map(([id, t]) => [id, [t.text, t.status]]))]));
      return { translator: roleCalls(llm, 'translator').length, linguist: roleCalls(llm, 'linguist').length, reserves: billing.reserves.length, editions };
    };
    const three = await once(3);
    const six = await once(6);
    // 2 chunks + 1 review per language, whatever the lanes.
    expect(three.translator).toBe(14);
    expect(three.linguist).toBe(7);
    expect(six).toEqual(three);
  });
});

describe('one retry for a rate limit or a provider 5xx', () => {
  const runTe = async (translator: ScriptStep[]) => {
    const session = newSession(sixPageKidsDoc());
    const llm = scriptedLlm({ translator, linguist: times(4, fakeLinguist()) });
    const ctx = testContext(session, { llm });
    const started = await runTranslation(ctx, T(['te']), { confirmed: true, origin: 'user' });
    await started.done;
    await ctx.settled();
    return { session, ctx, llm };
  };

  it('one 429, then success: the chunk is retried once and its lines are translated', async () => {
    const tr = fakeTranslator();
    const { session, ctx, llm } = await runTe([rateLimited(), ...times(4, tr.step)]);
    // chunk 1 (429) → chunk 1 again → chunk 2
    expect(roleCalls(llm, 'translator')).toHaveLength(3);
    expect(editionProgress(session.doc, 'te')).toMatchObject({ missing: 0, stale: 0, unreviewed: 0 });
    expect(editionReadiness(session.doc, 'te').publishable).toBe(true);
    // The failed attempt held nothing back: released, never charged.
    expect(ctx.billingFake.released).toHaveLength(1);
    expect(timingLine()).toMatchObject({ langs: 1, lanes: 1, retries: 1, failedLines: 0, stoppedBy: null });
    const last = session.doc.conversation[session.doc.conversation.length - 1];
    expect(last.text).toContain('Telugu is translated and reviewed.');
    expect(last.text).not.toContain('busy right now');
  });

  it('a provider 5xx is retried the same way', async () => {
    const tr = fakeTranslator();
    const gateway = new StudioError('PROVIDER_ERROR', 'The AI provider had a temporary problem. Please try again.', { status: 502, retryable: true });
    const { session, llm } = await runTe([gateway, ...times(4, tr.step)]);
    expect(roleCalls(llm, 'translator')).toHaveLength(3);
    expect(editionReadiness(session.doc, 'te').publishable).toBe(true);
    expect(timingLine()).toMatchObject({ retries: 1, failedLines: 0 });
  });

  it('two 429s: the chunk is retried only once and its lines are failed, as today', async () => {
    const doc = sixPageKidsDoc();
    const chunk1 = chunkTranslation(planTranslation(doc, 'te').toTranslate)[0];
    const chunk1Lines = chunk1.reduce((n, g) => n + g.lineIds.length, 0);
    const tr = fakeTranslator();
    const { session, llm } = await runTe([rateLimited(), rateLimited(), ...times(4, tr.step)]);
    // chunk 1, its one retry, then chunk 2 (a failed chunk does not stop the language)
    expect(roleCalls(llm, 'translator')).toHaveLength(3);
    const p = editionProgress(session.doc, 'te');
    expect(p.missing).toBeGreaterThan(0);
    expect(editionReadiness(session.doc, 'te').publishable).toBe(false);
    expect(timingLine()).toMatchObject({ retries: 1, failedLines: chunk1Lines });
    const last = session.doc.conversation[session.doc.conversation.length - 1];
    expect(last.text).toContain('busy right now');
    expect(last.text).toContain('Translate again to retry');
    expect(last.nextSteps?.find((s) => s.label === 'Translate missing lines')?.action).toMatchObject({ type: 'translate', languages: ['te'] });
  });

  it('waits between the attempts (1.5 to 3 s in production, with jitter)', async () => {
    Object.assign(TRANSLATE_TIMINGS, { retryMinMs: 40, retryMaxMs: 40 });
    const at: number[] = [];
    const tr = fakeTranslator();
    const stamp = (req: LlmRequest) => {
      at.push(Date.now());
      return tr.step(req);
    };
    const first = (req: LlmRequest) => {
      at.push(Date.now());
      void req;
      throw rateLimited();
    };
    await runTe([first, ...times(4, stamp)]);
    expect(at.length).toBeGreaterThanOrEqual(2);
    expect(at[1] - at[0]).toBeGreaterThanOrEqual(35);
    Object.assign(TRANSLATE_TIMINGS, DEFAULT_TIMINGS);
    expect(chunkRetryDelayMs(() => 0)).toBe(1500);
    expect(chunkRetryDelayMs(() => 0.5)).toBe(2250);
    expect(chunkRetryDelayMs(() => 0.9999)).toBeLessThanOrEqual(3000);
    for (let i = 0; i < 50; i += 1) {
      const ms = chunkRetryDelayMs();
      expect(ms).toBeGreaterThanOrEqual(1500);
      expect(ms).toBeLessThanOrEqual(3000);
    }
  });

  it('Stop pressed during the wait: no second attempt, the run says it stopped', async () => {
    // A long wait: Stop lands well inside it, and ends it early (the run does not sit out the full wait).
    Object.assign(TRANSLATE_TIMINGS, { retryMinMs: 5000, retryMaxMs: 5000 });
    const session = newSession(sixPageKidsDoc());
    const tr = fakeTranslator();
    const llm = scriptedLlm({ translator: [rateLimited(), ...times(4, tr.step)], linguist: times(4, fakeLinguist()) });
    const ctx = testContext(session, { llm });
    const started = await runTranslation(ctx, T(['te']), { confirmed: true, origin: 'user' });
    await vi.waitFor(() => expect(roleCalls(llm, 'translator')).toHaveLength(1), { interval: 5 });
    const pressed = Date.now();
    session.abort.abort();
    await started.done;
    await ctx.settled();
    expect(Date.now() - pressed).toBeLessThan(2000);
    expect(roleCalls(llm, 'translator')).toHaveLength(1);
    expect(roleCalls(llm, 'linguist')).toHaveLength(0);
    const last = session.doc.conversation[session.doc.conversation.length - 1];
    expect(last.text).toContain('Stopped');
    expect(timingLine()).toMatchObject({ retries: 0, stoppedBy: 'user' });
  });

  it('which failures are retried', () => {
    expect(chunkRetryable(rateLimited())).toBe(true);
    expect(chunkRetryable(new StudioError('PROVIDER_ERROR', 'Temporary problem.', { status: 502, retryable: true }))).toBe(true);
    expect(chunkRetryable(new StudioError('NOT_AVAILABLE', 'Not available right now.', { status: 503 }))).toBe(true);
    expect(chunkRetryable(Object.assign(new Error('OpenRouter /chat/completions failed: 503'), { status: 503 }))).toBe(true);
    expect(chunkRetryable(Object.assign(new Error('Too many requests'), { status: 429 }))).toBe(true);
    // Never retried: Stop, the allowance, no key; a timeout already waited its full time and was billed an estimate.
    expect(chunkRetryable(new StudioError('CANCELLED', 'Cancelled.', { status: 499 }))).toBe(false);
    expect(chunkRetryable(denied())).toBe(false);
    expect(chunkRetryable(new StudioError('NO_TEXT_KEY', 'Connect a key.', { status: 400 }))).toBe(false);
    expect(chunkRetryable(new StudioError('TIMEOUT', 'Took too long.', { status: 504, retryable: true }))).toBe(false);
    // The text client's permanent failures: a rejected key (401 → 502), a key out of credits (402 → 503).
    expect(chunkRetryable(new StudioError('PROVIDER_ERROR', 'Your key was rejected.', { status: 502, retryable: false }))).toBe(false);
    expect(chunkRetryable(new StudioError('PROVIDER_ERROR', 'Your key is out of credits.', { status: 503, retryable: false }))).toBe(false);
    expect(chunkRetryable(new StudioError('SAFETY_BLOCKED', 'Blocked.', { status: 422 }))).toBe(false);
    expect(chunkRetryable(Object.assign(new Error('Bad request'), { status: 400 }))).toBe(false);
    expect(chunkRetryable(new TypeError('x is undefined'))).toBe(false);
    expect(chunkRetryable(undefined)).toBe(false);
  });
});

describe('the allowance says no: every lane stops', () => {
  it('BILLING_DENIED in one lane: no lane starts another chunk, no language starts, no review; the message says so once', async () => {
    const run = heldRun(SEVEN);
    const started = await run.start();
    await vi.waitFor(() => expect(run.open()).toHaveLength(6));
    run.openFor('te')!.release(denied());
    await vi.waitFor(() => expect(warn.mock.calls.some((c) => c[0] === 'comic_translate_chunk_failed' && (c[1] as { lang?: string })?.lang === 'te')).toBe(true));
    // The other five chunks were already out: they finish and are kept.
    for (const h of run.open()) h.release();
    await started.done;
    await run.ctx.settled();
    expect(run.open()).toHaveLength(0);
    // Only the six first chunks were ever asked: no second chunk anywhere, German never started, no review.
    expect(roleCalls(run.llm, 'translator')).toHaveLength(6);
    expect(run.held.some((h) => h.lang === 'de')).toBe(false);
    expect(roleCalls(run.llm, 'linguist')).toHaveLength(0);
    // The kept chunks are committed (machine text, waiting for review).
    for (const lang of ['hi', 'ta', 'ja', 'es', 'fr']) expect(Object.keys(i18nOf(run.session.doc).editions[lang].lines).length).toBeGreaterThan(0);
    const last = run.session.doc.conversation[run.session.doc.conversation.length - 1];
    expect(last.text.split("You've used this month's included generation allowance").length - 1).toBe(1);
    expect(last.text).toContain('Every language stopped there');
    expect(timingLine()).toMatchObject({ langs: 7, lanes: 6, stoppedBy: 'billing' });
  });

  it('a denial from the allowance itself (the reserve) stops every lane the same way', async () => {
    // The first six holds (each language's first chunk) are granted; every later one is refused.
    const billing = fakeBilling(6);
    const run = heldRun(SEVEN, { billing });
    const started = await run.start();
    await vi.waitFor(() => expect(run.open()).toHaveLength(6));
    for (const h of run.open()) h.release();
    await started.done;
    await run.ctx.settled();
    expect(roleCalls(run.llm, 'translator')).toHaveLength(6);
    expect(run.held.some((h) => h.lang === 'de')).toBe(false);
    expect(roleCalls(run.llm, 'linguist')).toHaveLength(0);
    // The six granted holds were settled; at most one refused hold per lane, then nothing more was asked.
    expect(billing.settled).toHaveLength(6);
    expect(billing.reserves.length).toBeLessThanOrEqual(12);
    expect(timingLine()).toMatchObject({ stoppedBy: 'billing' });
    const last = run.session.doc.conversation[run.session.doc.conversation.length - 1];
    expect(last.text.split("You've used this month's included generation allowance").length - 1).toBe(1);
  });

  it('the timing line carries counts and milliseconds only', async () => {
    const run = heldRun(['te', 'hi']);
    const started = await run.start();
    await drain(run, started.done);
    const line = timingLine();
    expect(Object.keys(line).sort()).toEqual(['byok', 'failedLines', 'lanes', 'langs', 'ms', 'perLangMs', 'projectId', 'retries', 'stoppedBy'].sort());
    expect(line.byok).toBe(false);
    expect(typeof line.ms).toBe('number');
    expect(Object.keys(line.perLangMs as object).sort()).toEqual(['hi', 'te']);
    for (const v of Object.values(line.perLangMs as Record<string, unknown>)) expect(typeof v).toBe('number');
    const text = JSON.stringify(line);
    expect(text).not.toMatch(/Milo|moon|Frog/i);
  });
});
