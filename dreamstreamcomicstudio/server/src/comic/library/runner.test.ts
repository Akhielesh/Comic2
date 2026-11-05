// @vitest-environment node
// Library runner (assets.md §4.5–§4.6 + decisions-final #4): client-driven steps that advance at most
// n assets, resume after a simulated container sleep, never double-spend, respect the budget, and
// auto-publish at the threshold (review queue below it). Fakes only: no network, no spend.
import { describe, expect, it } from 'vitest';
import { LIBRARY_STUCK_MS } from '../../../../shared/comic/library.js';
import { StudioError } from '../types.js';
import { fakeLibraryImages, fakeLibraryLlm, testLibrary, TEST_MANIFEST } from './testkit.js';
import { LIBRARY_LEASE_MS, cancelRun, manifestView, planQuote, publicIndex, publishAsset, purgeCandidates, regenerateAsset, rejectAsset, startRun, stepRun } from './runner.js';
import { promptHash } from './manifest.js';

const ADMIN = '00000000-0000-4000-8000-000000000001';
const start = async (t: ReturnType<typeof testLibrary>, req: Parameters<typeof startRun>[1] = {}) => {
  const out = await startRun(t.deps, req, ADMIN);
  expect(out.run).not.toBeNull();
  return out.run!.id;
};

describe('quote (no spend, no writes)', () => {
  it('quotes every core entry and skips published, up-to-date rows unless forced', async () => {
    const t = testLibrary();
    const q1 = await planQuote(t.deps, {});
    expect(q1.quote.images).toBe(5);
    expect(q1.quote.usd).toBeCloseTo(5 * (0.0336 + 0.003), 4);
    expect(q1.quote.worstCaseUsd).toBeGreaterThan(q1.quote.usd * 2.9);
    expect(t.images.calls).toHaveLength(0);
    expect(t.repo.assets.size).toBe(0);

    const runId = await start(t, { ids: ['style.test-one'] });
    await stepRun(t.deps, runId, 1, ADMIN);
    const q2 = await planQuote(t.deps, {});
    expect(q2.quote.images).toBe(4);
    expect(q2.quote.skipped).toEqual([{ id: 'style.test-one', reason: 'Published and up to date' }]);
    expect((await planQuote(t.deps, { force: true })).quote.images).toBe(5);
  });

  it('a changed prompt is rebuilt; unknown ids are a 400', async () => {
    const t = testLibrary();
    const runId = await start(t, { ids: ['style.test-one'] });
    await stepRun(t.deps, runId, 1, ADMIN);
    t.deps.manifest = TEST_MANIFEST.map((e) => (e.id === 'style.test-one' ? { ...e, prompt: `${e.prompt} Now at dawn.` } : e));
    expect((await planQuote(t.deps, { ids: ['style.test-one'] })).quote.images).toBe(1);
    await expect(planQuote(t.deps, { ids: ['style.nope'] })).rejects.toMatchObject({ status: 400 });
  });

  it('tolerates the tables not existing yet (console still quotes)', async () => {
    const t = testLibrary();
    t.repo.missing = true;
    const plan = await planQuote(t.deps, {});
    expect(plan.tableReady).toBe(false);
    expect(plan.quote.images).toBe(5);
    const view = await manifestView(t.deps);
    expect(view.tableReady).toBe(false);
    expect(view.platformKey).toBe(true);
    expect(view.entries).toHaveLength(5);
  });
});

describe('runs', () => {
  it('needs the platform key (503) and allows one running run (409)', async () => {
    const none = testLibrary({ keys: null });
    await expect(startRun(none.deps, {}, ADMIN)).rejects.toMatchObject({ status: 503, code: 'NOT_AVAILABLE' });

    const t = testLibrary();
    await start(t);
    await expect(startRun(t.deps, {}, ADMIN)).rejects.toMatchObject({ status: 409 });
    expect(t.images.calls).toHaveLength(0); // creating a run spends nothing
  });

  it('a step advances at most n assets, one attempt each, and publishes at the threshold', async () => {
    const t = testLibrary();
    const runId = await start(t);
    const s1 = await stepRun(t.deps, runId, 2, ADMIN);
    expect(t.images.calls).toHaveLength(2);
    expect(s1.counts).toMatchObject({ total: 5, published: 2, pending: 3, done: 2 });
    expect(s1.status).toBe('running');
    expect(s1.waitMs).toBe(0);
    // n is clamped to 3.
    await stepRun(t.deps, runId, 99, ADMIN);
    expect(t.images.calls).toHaveLength(5);
    const s3 = await stepRun(t.deps, runId, 3, ADMIN);
    expect(t.images.calls).toHaveLength(5);
    expect(s3.status).toBe('completed');
    expect(s3.counts.published).toBe(5);
    expect(t.published).toBe(5);
    // Thumbnails + full image stored on the library lane only.
    expect([...t.storage.objects.keys()].every((p) => p.startsWith('library/v1/'))).toBe(true);
    expect([...t.storage.objects.keys()]).toContain('library/v1/style.test-one/1@320.webp');
    // Ledger: one image + one vision row per attempt, platform-paid.
    expect(t.repo.costs.filter((c) => c.stage === 'library_image')).toHaveLength(5);
    expect(t.repo.costs.filter((c) => c.stage === 'library_vision')).toHaveLength(5);
    expect(t.repo.costs.every((c) => c.userId === ADMIN)).toBe(true);
    expect(s3.spentUsd).toBeCloseTo(5 * (0.0336 + 0.002), 4);
    // Public index serves only published snapshots.
    const { index, etag } = await publicIndex(t.deps);
    expect(index.assets.map((a) => a.id)).toEqual(TEST_MANIFEST.map((e) => e.id));
    expect(index.assets[0].thumbs[320]).toMatch(/@320\.webp$/);
    expect(etag).toMatch(/\w+/);
  });

  it('a finished run answers its final view without spending', async () => {
    const t = testLibrary();
    const runId = await start(t, { ids: ['style.test-one'] });
    await stepRun(t.deps, runId, 3, ADMIN);
    const again = await stepRun(t.deps, runId, 3, ADMIN);
    expect(again.status).toBe('completed');
    expect(t.images.calls).toHaveLength(1);
  });

  it('a concurrent second step is told to wait (busy) and draws nothing', async () => {
    const t = testLibrary();
    const runId = await start(t);
    await t.repo.acquireLease(runId, new Date(t.clock.now).toISOString(), new Date(t.clock.now + LIBRARY_LEASE_MS).toISOString());
    const busy = await stepRun(t.deps, runId, 3, ADMIN);
    expect(busy.busy).toBe(true);
    expect(busy.waitMs).toBeGreaterThan(0);
    expect(t.images.calls).toHaveLength(0);
  });

  it('resumes after a simulated container sleep: the dead step’s rows reset, nothing is drawn twice', async () => {
    // Step 1 dies mid-way: the image call never returns (the container slept / was killed).
    let hang = true;
    const images = fakeLibraryImages(() => (hang ? new Promise<never>(() => undefined) : undefined));
    const t = testLibrary({ images });
    const runId = await start(t);
    void stepRun(t.deps, runId, 2, ADMIN); // never settles
    await new Promise((r) => setTimeout(r, 20));
    expect(images.calls).toHaveLength(2);
    expect([...t.repo.assets.values()].filter((r) => r.status === 'generating')).toHaveLength(2);

    // A retry right away is busy (the lease is held).
    hang = false;
    expect((await stepRun(t.deps, runId, 3, ADMIN)).busy).toBe(true);

    // After the lease expires the next step continues with the rest; the stuck rows wait their 10 minutes.
    t.clock.now += LIBRARY_LEASE_MS + 1000;
    const s2 = await stepRun(t.deps, runId, 3, ADMIN);
    expect(s2.busy).toBeUndefined();
    expect(images.calls).toHaveLength(5); // 2 hung + 3 new
    expect(s2.counts.published).toBe(3);
    const idle = await stepRun(t.deps, runId, 3, ADMIN);
    expect(idle.waitMs).toBeGreaterThan(0);
    expect(idle.message).toMatch(/interrupted step/i);
    expect(images.calls).toHaveLength(5);

    // Once they're older than LIBRARY_STUCK_MS they are reset and finished.
    t.clock.now += LIBRARY_STUCK_MS;
    const s3 = await stepRun(t.deps, runId, 3, ADMIN);
    expect(s3.message).toMatch(/Resumed 2 interrupted images/);
    expect(images.calls).toHaveLength(7);
    expect(s3.status).toBe('completed');
    expect(s3.counts.published).toBe(5);
    // Each resumed attempt got a fresh revision (a dead step's object is never overwritten).
    const one = t.repo.assets.get('1:style.test-one')!;
    expect(one.rev).toBe(2);
    expect(one.attempts).toBe(2);
  });

  it('never starts an attempt over the budget and ends budget_exhausted', async () => {
    const t = testLibrary();
    const runId = await start(t, { budgetUsd: 0.05 });
    const s1 = await stepRun(t.deps, runId, 3, ADMIN);
    expect(t.images.calls).toHaveLength(1); // 0.0366 fits, a second would exceed $0.05
    expect(s1.status).toBe('running');
    const s2 = await stepRun(t.deps, runId, 3, ADMIN);
    expect(t.images.calls).toHaveLength(1);
    expect(s2.status).toBe('budget_exhausted');
    expect(s2.spentUsd).toBeLessThanOrEqual(0.05);
    expect(t.repo.runs.get(runId)!.error).toMatch(/budget/i);
  });

  it('clamps the budget to the $25 hard maximum', async () => {
    const t = testLibrary();
    const runId = await start(t, { budgetUsd: 500 });
    expect(t.repo.runs.get(runId)!.budget_usd).toBe(25);
  });

  it('cancel stops new work; the next run picks the rest up', async () => {
    const t = testLibrary();
    const runId = await start(t);
    await stepRun(t.deps, runId, 1, ADMIN);
    const view = await cancelRun(t.deps, runId, ADMIN);
    expect(view.status).toBe('cancelled');
    await stepRun(t.deps, runId, 3, ADMIN);
    expect(t.images.calls).toHaveLength(1);
    const next = await start(t);
    expect(t.repo.runs.get(next)!.asset_ids).toHaveLength(4);
  });
});

describe('refine and review', () => {
  it('below the threshold: refines up to 1 + maxRetries attempts, keeps the best, queues it for review', async () => {
    const llm = fakeLibraryLlm([{ score: 0.5 }, { score: 0.62, briefMatch: 0.55 }, { score: 0.4 }]);
    const t = testLibrary({ llm, manifest: TEST_MANIFEST.slice(0, 1) });
    const runId = await start(t);
    await stepRun(t.deps, runId, 3, ADMIN);
    await stepRun(t.deps, runId, 3, ADMIN);
    const last = await stepRun(t.deps, runId, 3, ADMIN);
    expect(t.images.calls).toHaveLength(3);
    expect(last.status).toBe('completed');
    expect(last.counts.review).toBe(1);
    const row = t.repo.assets.get('1:style.test-one')!;
    expect(row.status).toBe('needs_review');
    expect(row.candidates).toHaveLength(3);
    expect(row.score).toBeCloseTo(0.592, 3); // the best (attempt 2), not the last
    expect(row.rev).toBe(2);
    expect(row.published).toBeNull();
    expect((await publicIndex(t.deps)).index.assets).toHaveLength(0);
    // Attempt 2 is a corrected prompt; attempt 3 (weak brief) gets one LLM rewrite.
    expect(t.images.calls[1].prompt).toMatch(/Corrections:/);
    expect(llm.calls.filter((c) => c.role === 'writer')).toHaveLength(1);
    expect(t.repo.costs.filter((c) => c.stage === 'library_rewrite')).toHaveLength(1);
    // Never above 1 + maxRetries attempts.
    await stepRun(t.deps, runId, 3, ADMIN);
    expect(t.images.calls).toHaveLength(3);

    // The admin publishes a candidate by hand.
    const published = await publishAsset(t.deps, 'style.test-one', 1, ADMIN);
    expect(published.row?.published?.rev).toBe(1);
    expect((await publicIndex(t.deps)).index.assets.map((a) => a.rev)).toEqual([1]);
    // Rejecting the live revision takes it down.
    await publishAsset(t.deps, 'style.test-one', 2, ADMIN);
    const rejected = await rejectAsset(t.deps, 'style.test-one', 'too dark', ADMIN);
    expect(rejected.row?.status).toBe('rejected');
    expect((await publicIndex(t.deps)).index.assets).toHaveLength(0);
  });

  it('stray text on a text-free asset → an edit pass on the same image (the only reference is the library candidate)', async () => {
    const llm = fakeLibraryLlm([{ score: 0.9, textFound: ['BAKERY'] }, { score: 0.9 }]);
    const t = testLibrary({ llm, manifest: TEST_MANIFEST.slice(0, 1) });
    const runId = await start(t);
    await stepRun(t.deps, runId, 1, ADMIN);
    expect(t.repo.assets.get('1:style.test-one')!.status).toBe('pending');
    await stepRun(t.deps, runId, 1, ADMIN);
    const second = t.images.calls[1];
    expect(second.references).toHaveLength(1);
    expect(second.references[0].label).toBe('CURRENT IMAGE');
    expect(t.storage.loads).toEqual(['library/v1/style.test-one/1.webp']);
    expect(second.prompt).toMatch(/Remove all lettering/);
    expect(t.repo.assets.get('1:style.test-one')!.status).toBe('published');
    // First attempts never carry references (fresh generation, no user images).
    expect(t.images.calls[0].references).toEqual([]);
  });

  it('an abandoned timeout is billed and not retried; a safety block fails with an honest note', async () => {
    const abandoned = Object.assign(new StudioError('TIMEOUT', 'took too long', { status: 504, retryable: true }), { abandoned: true });
    const images = fakeLibraryImages((req) => (req.prompt.includes('one') ? abandoned : new StudioError('SAFETY_BLOCKED', 'blocked', { status: 422 })));
    const t = testLibrary({ images, manifest: TEST_MANIFEST.slice(0, 2) });
    const runId = await start(t);
    const s = await stepRun(t.deps, runId, 2, ADMIN);
    expect(images.calls).toHaveLength(2);
    expect(s.counts.failed).toBe(2);
    expect(s.status).toBe('completed');
    const one = t.repo.assets.get('1:style.test-one')!;
    expect(one.error).toMatch(/billed/);
    expect(t.repo.costs.find((c) => c.metadata.assetId === 'style.test-one')?.costUsd).toBeCloseTo(0.0336, 4);
    expect(t.repo.assets.get('1:style.test-two')!.error).toMatch(/declined this prompt/);
  });

  it('unusable analysis JSON goes to review with an honest issue (never auto-published, never redrawn)', async () => {
    const t = testLibrary({ llm: fakeLibraryLlm(['garbage']), manifest: TEST_MANIFEST.slice(0, 1) });
    const runId = await start(t);
    const s = await stepRun(t.deps, runId, 1, ADMIN);
    expect(s.counts.review).toBe(1);
    expect(t.images.calls).toHaveLength(1);
    expect(s.assets[0].lastIssue).toMatch(/couldn't read/i);
  });

  it('regenerate runs one asset with the admin note; notes naming brands are refused', async () => {
    const t = testLibrary();
    const first = await start(t, { ids: ['style.test-two'] });
    await stepRun(t.deps, first, 1, ADMIN);
    await expect(regenerateAsset(t.deps, 'style.test-two', { note: 'make it look like Disney' }, ADMIN)).rejects.toMatchObject({ status: 400 });
    const out = await regenerateAsset(t.deps, 'style.test-two', { note: 'warmer lamp light' }, ADMIN);
    expect(out.run?.counts.total).toBe(1);
    await stepRun(t.deps, out.run!.id, 3, ADMIN);
    expect(t.images.calls.at(-1)!.prompt).toMatch(/Art director note: warmer lamp light/);
  });

  it('purge removes losing candidates only (dry run first)', async () => {
    const llm = fakeLibraryLlm([{ score: 0.5 }, { score: 0.95 }]);
    const t = testLibrary({ llm, manifest: TEST_MANIFEST.slice(0, 1) });
    const runId = await start(t);
    await stepRun(t.deps, runId, 1, ADMIN);
    await stepRun(t.deps, runId, 1, ADMIN);
    const dry = await purgeCandidates(t.deps, true, ADMIN);
    expect(dry.objects).toBe(3);
    expect(t.storage.removed).toHaveLength(0);
    const real = await purgeCandidates(t.deps, false, ADMIN);
    expect(real.objects).toBe(3);
    expect(t.storage.removed.every((p) => p.includes('/1'))).toBe(true);
    expect(t.repo.assets.get('1:style.test-one')!.candidates.map((c) => c.rev)).toEqual([2]);
  });

  it('a rebuild keeps the published snapshot live until a better candidate replaces it', async () => {
    const llm = fakeLibraryLlm([{ score: 0.9 }, { score: 0.3 }]);
    const t = testLibrary({ llm, manifest: TEST_MANIFEST.slice(0, 1) });
    await stepRun(t.deps, await start(t), 1, ADMIN);
    const forced = await start(t, { force: true, maxRetries: 0 });
    expect((await publicIndex(t.deps)).index.assets).toHaveLength(1); // still live while pending
    await stepRun(t.deps, forced, 1, ADMIN);
    const row = t.repo.assets.get('1:style.test-one')!;
    expect(row.status).toBe('needs_review');
    expect(row.published?.rev).toBe(1);
    expect((await publicIndex(t.deps)).index.assets[0].rev).toBe(1);
    expect(row.prompt_hash).toBe(promptHash(TEST_MANIFEST[0]));
    // Rejecting the weaker new candidate keeps the earlier published image live.
    await rejectAsset(t.deps, 'style.test-one', undefined, ADMIN);
    expect((await publicIndex(t.deps)).index.assets.map((a) => a.rev)).toEqual([1]);
    // A takedown removes the live image too (every screen falls back to procedural art).
    const before = t.published;
    await rejectAsset(t.deps, 'style.test-one', 'takedown', ADMIN, { unpublish: true });
    expect((await publicIndex(t.deps)).index.assets).toEqual([]);
    expect(t.repo.assets.get('1:style.test-one')!.published).toBeNull();
    expect(t.published).toBe(before + 1);
  });

  it('a Cancel that lands mid-step is never overwritten by "completed"; what was drawn is kept', async () => {
    const base = fakeLibraryImages();
    let runId = '';
    let t: ReturnType<typeof testLibrary>;
    const images = {
      calls: base.calls,
      generate: async (req: Parameters<typeof base.generate>[0]) => {
        await cancelRun(t.deps, runId, ADMIN); // the admin clicks Cancel while this image is drawing
        return base.generate(req);
      }
    };
    t = testLibrary({ images, manifest: TEST_MANIFEST.slice(0, 1) });
    runId = await start(t);
    const view = await stepRun(t.deps, runId, 1, ADMIN);
    expect(view.status).toBe('cancelled');
    expect(view.message).toMatch(/cancelled/i);
    expect(t.repo.runs.get(runId)!.status).toBe('cancelled');
    expect(t.repo.runs.get(runId)!.spent_usd).toBeGreaterThan(0); // real spend is still recorded
    expect(t.repo.assets.get('1:style.test-one')!.status).toBe('published');
  });

  it('a row left mid-attempt by a cancelled build becomes reviewable once no step can hold it', async () => {
    const images = fakeLibraryImages(() => new Promise<never>(() => undefined));
    const t = testLibrary({ images, manifest: TEST_MANIFEST.slice(0, 1) });
    const runId = await start(t);
    void stepRun(t.deps, runId, 1, ADMIN); // the container dies mid-draw
    await new Promise((r) => setTimeout(r, 20));
    expect(t.repo.assets.get('1:style.test-one')!.status).toBe('generating');
    await expect(rejectAsset(t.deps, 'style.test-one', undefined, ADMIN)).rejects.toMatchObject({ status: 409 });
    await cancelRun(t.deps, runId, ADMIN);
    await expect(rejectAsset(t.deps, 'style.test-one', undefined, ADMIN)).rejects.toMatchObject({ status: 409 });
    t.clock.now += LIBRARY_LEASE_MS + 1000;
    const view = await rejectAsset(t.deps, 'style.test-one', 'stuck', ADMIN);
    expect(view.row?.status).toBe('rejected');
  });
});
