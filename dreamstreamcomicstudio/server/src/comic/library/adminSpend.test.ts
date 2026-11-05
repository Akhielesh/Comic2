// @vitest-environment node
// Program 3 ST-A (bug B7): admin image spend runs on the model-test key, OpenRouter only, and fails closed when it
// is unset; startRun — and only startRun — enforces the monthly cap and checks the key's own OpenRouter limit;
// every attempt writes a comic_image_calls row under the admin's user_id (kind 'library'); every published image
// carries its provenance and the public index never carries a run id, an admin id or a cost.
// Fake env values and fakes only: no network, no spend, no production.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LIBRARY_MONTHLY_CAP_DEFAULT_USD, isAdminSpendCallKind, labCallKind } from '../../../../shared/comic/library.js';
import { StudioError, type ImageResult, type StudioKeys } from '../types.js';
import { adminSpendKeys } from '../keys.js';
import { adminSpendKeyMissing, adminSpendMode, createLibraryCallLedger, libraryImageCallRecord, libraryMonthlyCapUsd, type LibraryImageCall } from './adminSpend.js';
import { judgeKeyBudget, type ProviderKeyBudget } from './keyBudget.js';
import { manifestView, planQuote, provenanceOf, publicIndex, startRun, stepRun, getRunView, type LibrarySpendGuard } from './runner.js';
import { fakeLibraryImages, fakeLibraryLlm, testLibrary, TEST_MANIFEST, type TestLibrary } from './testkit.js';

const ADMIN = '00000000-0000-4000-8000-000000000001';
const MODELTEST = 'sk-or-v1-modeltest-FAKE-0123456789';
const ALL = 'sk-or-v1-platform-all-FAKE-9876543210';
const GEMINI = 'AIza-platform-gemini-FAKE';

const budget = (over: Partial<ProviderKeyBudget> = {}): ProviderKeyBudget => ({
  limitUsd: 35,
  remainingUsd: 30,
  limitReset: 'monthly',
  usageMonthlyUsd: 5,
  budget: null,
  checkedAt: Date.parse('2026-11-05T10:00:00Z'),
  ...over
});

interface Guarded extends TestLibrary {
  checks: Array<{ key: string; label?: string }>;
  calls: LibraryImageCall[];
  keysSeen: StudioKeys[];
}

/** testLibrary + the production-shaped guard: keys from adminSpendKeys(env), a fake provider check, a capturing ledger. */
const guarded = (opts: { env?: Record<string, string | undefined>; provider?: ProviderKeyBudget | Error; cap?: number; images?: ReturnType<typeof fakeLibraryImages>; llm?: ReturnType<typeof fakeLibraryLlm>; keys?: () => StudioKeys | null } = {}): Guarded => {
  const t = testLibrary({ images: opts.images, llm: opts.llm }) as Guarded;
  const env = opts.env ?? { DREAMSTREAMSTUDIO_MODELTEST: MODELTEST, DREAMSTREAMSTUDIO_ALL: ALL, GEMINI_API_KEY: GEMINI };
  t.checks = [];
  t.calls = [];
  t.keysSeen = [];
  const spend: LibrarySpendGuard = {
    key: () => adminSpendMode(env),
    monthlyCapUsd: () => opts.cap ?? libraryMonthlyCapUsd(env),
    keyBudget: async (key, label) => {
      t.checks.push({ key, label });
      if (opts.provider instanceof Error) throw opts.provider;
      return opts.provider ?? budget();
    }
  };
  const images = t.deps.images;
  t.deps = {
    ...t.deps,
    keys: opts.keys ?? (() => adminSpendKeys(env)),
    images: (keys) => {
      t.keysSeen.push(keys);
      return images(keys);
    },
    spend,
    calls: { record: (c) => t.calls.push(c) }
  };
  return t;
};

const drain = async (t: TestLibrary, runId: string) => {
  for (let i = 0; i < 20; i++) {
    const v = await stepRun(t.deps, runId, 3, ADMIN);
    if (v.status !== 'running') return v;
  }
  throw new Error('run did not finish');
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('adminSpendKeys: the model-test key, OpenRouter only, fail closed', () => {
  it('returns only the model-test key as a non-BYOK OpenRouter key — never the platform ALL or Gemini key', () => {
    expect(adminSpendKeys({ DREAMSTREAMSTUDIO_MODELTEST: ` ${MODELTEST} `, DREAMSTREAMSTUDIO_ALL: ALL, OPENROUTER_API_KEY: ALL, GEMINI_API_KEY: GEMINI })).toEqual({
      openrouter: { key: MODELTEST, byok: false }
    });
  });

  it('is null when the model-test key is unset, even with platform keys present (fail closed)', () => {
    expect(adminSpendKeys({ DREAMSTREAMSTUDIO_ALL: ALL, OPENROUTER_API_KEY: ALL, GEMINI_API_KEY: GEMINI })).toBeNull();
    expect(adminSpendKeys({ DREAMSTREAMSTUDIO_MODELTEST: '   ' })).toBeNull();
    expect(adminSpendKeyMissing('modeltest')).toBe("The model-test key (DREAMSTREAMSTUDIO_MODELTEST) isn't set on this server.");
  });

  it('uses the platform OpenRouter key only on the explicit COMIC_ADMIN_SPEND_KEY=platform escape hatch (still no Gemini)', () => {
    expect(adminSpendKeys({ COMIC_ADMIN_SPEND_KEY: ' Platform ', DREAMSTREAMSTUDIO_ALL: ALL, GEMINI_API_KEY: GEMINI, DREAMSTREAMSTUDIO_MODELTEST: MODELTEST })).toEqual({ openrouter: { key: ALL, byok: false } });
    expect(adminSpendKeys({ COMIC_ADMIN_SPEND_KEY: 'platform', OPENROUTER_API_KEY: ALL })).toEqual({ openrouter: { key: ALL, byok: false } });
    // Anything else (a typo, 'modeltest', unset) means the model-test key.
    expect(adminSpendMode({ COMIC_ADMIN_SPEND_KEY: 'platfrom' })).toBe('modeltest');
    expect(adminSpendKeys({ COMIC_ADMIN_SPEND_KEY: 'platfrom', DREAMSTREAMSTUDIO_ALL: ALL })).toBeNull();
  });

  it('the monthly cap defaults to $20 and accepts any finite amount ≥ 0', () => {
    expect(LIBRARY_MONTHLY_CAP_DEFAULT_USD).toBe(20);
    expect(libraryMonthlyCapUsd({})).toBe(20);
    expect(libraryMonthlyCapUsd({ COMIC_LIBRARY_MONTHLY_CAP_USD: '7.5' })).toBe(7.5);
    expect(libraryMonthlyCapUsd({ COMIC_LIBRARY_MONTHLY_CAP_USD: '0' })).toBe(0);
    expect(libraryMonthlyCapUsd({ COMIC_LIBRARY_MONTHLY_CAP_USD: '-1' })).toBe(20);
    expect(libraryMonthlyCapUsd({ COMIC_LIBRARY_MONTHLY_CAP_USD: 'lots' })).toBe(20);
  });
});

describe('production wiring: the library runner and Model Lab spend on the model-test key', () => {
  it('createDefaultLibraryDeps: keys come from DREAMSTREAMSTUDIO_MODELTEST (OpenRouter only), with the guard and the ledger wired', async () => {
    vi.stubEnv('DREAMSTREAMSTUDIO_MODELTEST', MODELTEST);
    vi.stubEnv('GEMINI_API_KEY', GEMINI);
    vi.stubEnv('DREAMSTREAMSTUDIO_ALL', ALL);
    vi.stubEnv('COMIC_ADMIN_SPEND_KEY', '');
    const { createDefaultLibraryDeps } = await import('./index.js');
    const deps = createDefaultLibraryDeps();
    expect(deps.keys()).toEqual({ openrouter: { key: MODELTEST, byok: false } });
    expect(deps.spend?.key()).toBe('modeltest');
    expect(deps.spend?.monthlyCapUsd()).toBe(20);
    expect(typeof deps.spend?.keyBudget).toBe('function');
    expect(typeof deps.calls?.record).toBe('function');
    vi.stubEnv('DREAMSTREAMSTUDIO_MODELTEST', '');
    expect(deps.keys()).toBeNull(); // read per call: unsetting it closes the door at once
  });

  it('createDefaultLabDeps: the Model Lab uses the model-test key too, and refuses without it', async () => {
    vi.stubEnv('DREAMSTREAMSTUDIO_MODELTEST', MODELTEST);
    vi.stubEnv('GEMINI_API_KEY', GEMINI);
    const { createDefaultLabDeps } = await import('../models/lab.js');
    const deps = createDefaultLabDeps();
    expect(deps.keys()).toEqual({ openrouter: { key: MODELTEST, byok: false } });
    vi.stubEnv('DREAMSTREAMSTUDIO_MODELTEST', '');
    expect(deps.keys()).toBeNull();
  });
});

describe('startRun: monthly cap and the provider preflight (only here)', () => {
  it('checks the key once per build start, with the model-test key; quote, manifest and steps never check', async () => {
    const t = guarded();
    await planQuote(t.deps, {});
    await manifestView(t.deps);
    expect(t.checks).toEqual([]);
    const out = await startRun(t.deps, { ids: ['style.test-one'] }, ADMIN);
    expect(t.checks).toEqual([{ key: MODELTEST, label: 'modeltest' }]);
    await drain(t, out.run!.id);
    await getRunView(t.deps, out.run!.id);
    await manifestView(t.deps);
    expect(t.checks).toHaveLength(1);
    // The run records which key and what the provider said (names and dollars only).
    const row = t.repo.runs.get(out.run!.id)!;
    expect(row.request.key).toBe('modeltest');
    expect(row.request.preflight).toMatchObject({ limitUsd: 35, remainingUsd: 30, budgetRemainingUsd: null });
    expect(JSON.stringify(row)).not.toContain(MODELTEST);
  });

  it('refuses when limit_remaining is below the budget: no run, no image, nothing spent', async () => {
    const t = guarded({ provider: budget({ remainingUsd: 4.2 }) });
    await expect(startRun(t.deps, { budgetUsd: 5 }, ADMIN)).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED', status: 409, userMessage: expect.stringMatching(/\$4\.20 left of its \$35\.00 OpenRouter limit.*\$5\.00 budget/) });
    expect(t.repo.runs.size).toBe(0);
    expect(t.images.calls).toHaveLength(0);
    // The same key with room for it goes ahead.
    const ok = guarded({ provider: budget({ remainingUsd: 5 }) });
    expect((await startRun(ok.deps, { budgetUsd: 5 }, ADMIN)).run).not.toBeNull();
  });

  it('refuses when the effective budget (a workspace budget that blocks first) is below the budget', async () => {
    const t = guarded({ provider: budget({ remainingUsd: 30, budget: { scope: 'workspace', limitUsd: 10, remainingUsd: 1.5, resetsAt: null } }) });
    await expect(startRun(t.deps, { budgetUsd: 5 }, ADMIN)).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED', userMessage: expect.stringMatching(/workspace budget .* \$1\.50 left/) });
    expect(t.repo.runs.size).toBe(0);
  });

  it('refuses a build that could pass the monthly cap, before asking OpenRouter anything', async () => {
    const t = guarded({ cap: 20 });
    // Earlier builds this UTC month spent $17.40 (a run from last month does not count).
    const prior = (id: string, startedAt: string, spent: number) =>
      t.repo.runs.set(id, { id, manifest_version: 1, started_by: ADMIN, status: 'completed', budget_usd: 25, spent_usd: spent, request: { maxRetries: 2 }, quote: {}, asset_ids: [], counts: {}, lease_until: null, steps: 1, error: null, started_at: startedAt, updated_at: startedAt, finished_at: startedAt });
    t.clock.now = Date.parse('2026-11-20T10:00:00Z');
    prior('r-oct', '2026-10-30T10:00:00.000Z', 19);
    prior('r-nov-1', '2026-11-02T10:00:00.000Z', 10);
    prior('r-nov-2', '2026-11-09T10:00:00.000Z', 7.4);
    await expect(startRun(t.deps, { budgetUsd: 5 }, ADMIN)).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED', userMessage: expect.stringMatching(/cap of \$20\.00 \(\$17\.40 already spent\)\. Lower the budget to \$2\.60 or less/) });
    expect(t.checks).toEqual([]);
    expect((await startRun(t.deps, { budgetUsd: 2.6, ids: ['style.test-one'] }, ADMIN)).run).not.toBeNull();
    expect(t.checks).toHaveLength(1);
  });

  it('fails closed when the provider check fails: the refusal stands, nothing is created', async () => {
    const t = guarded({ provider: new StudioError('NOT_AVAILABLE', "OpenRouter didn't answer the check on the model-test key's limit.", { status: 503 }) });
    await expect(startRun(t.deps, {}, ADMIN)).rejects.toMatchObject({ status: 503 });
    expect(t.repo.runs.size).toBe(0);
    expect(t.repo.assets.size).toBe(0);
  });

  it('an unlimited key is not refused but the start message says only the app cap applies', async () => {
    const t = guarded({ provider: budget({ limitUsd: null, remainingUsd: null }) });
    const out = await startRun(t.deps, { ids: ['style.test-one'] }, ADMIN);
    expect(out.message).toMatch(/model-test key has no OpenRouter limit, so only the app's \$20\.00 monthly cap applies/);
  });
});

describe('fail closed without the key; OpenRouter only', () => {
  it('no model-test key: the manifest says so, startRun refuses with the key NAME, nothing is drawn', async () => {
    const t = guarded({ env: { DREAMSTREAMSTUDIO_ALL: ALL, OPENROUTER_API_KEY: ALL, GEMINI_API_KEY: GEMINI } });
    const view = await manifestView(t.deps);
    expect(view.platformKey).toBe(false);
    expect(view.billing).toMatchObject({ key: null, monthCapUsd: 20 });
    await expect(startRun(t.deps, {}, ADMIN)).rejects.toMatchObject({ code: 'NOT_AVAILABLE', status: 503, userMessage: expect.stringContaining("The model-test key (DREAMSTREAMSTUDIO_MODELTEST) isn't set") });
    expect(t.checks).toEqual([]);
    expect(t.images.calls).toHaveLength(0);
  });

  it('a Gemini key handed to the runner is dropped: images are drawn with the OpenRouter key alone', async () => {
    const t = guarded({ keys: () => ({ openrouter: { key: MODELTEST, byok: false }, gemini: { key: GEMINI, byok: false } }) });
    const out = await startRun(t.deps, { ids: ['style.test-one'] }, ADMIN);
    await drain(t, out.run!.id);
    expect(t.keysSeen.length).toBeGreaterThan(0);
    expect(t.keysSeen.every((k) => !k.gemini && k.openrouter?.key === MODELTEST)).toBe(true);
    // Only an OpenRouter key: a Gemini-only set is no key at all.
    const geminiOnly = guarded({ keys: () => ({ gemini: { key: GEMINI, byok: false } }) });
    await expect(startRun(geminiOnly.deps, {}, ADMIN)).rejects.toMatchObject({ status: 503 });
  });
});

describe('ledger: one comic_image_calls row per attempt, under the admin', () => {
  it('each attempt (refines included) writes a row with the admin user_id, kind library, billed 0', async () => {
    // First draw scores 0.6 (refine), the second passes.
    const t = guarded({ llm: fakeLibraryLlm([{ score: 0.6 }, { score: 0.9 }]) });
    const out = await startRun(t.deps, { ids: ['style.test-one'] }, ADMIN);
    await drain(t, out.run!.id);
    expect(t.images.calls).toHaveLength(2);
    expect(t.calls).toHaveLength(2);
    for (const c of t.calls) expect(c).toMatchObject({ userId: ADMIN, modelId: 'nano-banana-2.1', res: '1K', aspect: '1:1', outcome: 'ok', providerCostUsd: 0.0336 });
    const row = libraryImageCallRecord(t.calls[0]);
    expect(row).toMatchObject({ userId: ADMIN, kind: 'library', route: 'openrouter', billedUsd: 0, byok: false });
    expect(isAdminSpendCallKind(row.kind)).toBe(true);
  });

  it('a provider failure is a failed row; a refusal before any call writes none', async () => {
    const failing = guarded({ images: fakeLibraryImages(() => new StudioError('PROVIDER_ERROR', 'The provider failed.', { status: 502 })) });
    const out = await startRun(failing.deps, { ids: ['style.test-one'], maxRetries: 0 }, ADMIN);
    await drain(failing, out.run!.id);
    expect(failing.calls).toEqual([expect.objectContaining({ userId: ADMIN, outcome: 'failed', errorCode: 'PROVIDER_ERROR', providerCostUsd: null })]);
    const denied = guarded({ images: fakeLibraryImages(() => new StudioError('BILLING_DENIED', 'Billing refused.', { status: 402 })) });
    const run2 = await startRun(denied.deps, { ids: ['style.test-one'] }, ADMIN);
    await stepRun(denied.deps, run2.run!.id, 1, ADMIN);
    expect(denied.calls).toEqual([]);
  });

  it('the production ledger writes through the recorder with the model_usage_monthly bump turned off', () => {
    const recorded: unknown[] = [];
    let bumpSeen: unknown = 'unset';
    const ledger = createLibraryCallLedger((deps) => {
      bumpSeen = deps.bumpUsage;
      return { record: (r) => recorded.push(r) };
    });
    ledger.record({ userId: ADMIN, modelId: 'nano-banana-2.1', res: '1K', aspect: '4:5', refs: 0, outcome: 'ok', providerCostUsd: 0.0336 });
    expect(recorded).toEqual([expect.objectContaining({ userId: ADMIN, kind: 'library', billedUsd: 0, byok: false })]);
    expect(typeof bumpSeen).toBe('function');
    expect((bumpSeen as () => unknown)()).toBeUndefined();
  });

  it('library and lab kinds are admin spend; studio kinds are not', () => {
    expect(labCallKind('page')).toBe('lab_page');
    for (const k of ['library', 'lab_page', 'lab_sheet']) expect(isAdminSpendCallKind(k)).toBe(true);
    for (const k of ['page', 'sheet', 'cover', 'panel', 'qc', 'unknown', '']) expect(isAdminSpendCallKind(k)).toBe(false);
  });
});

describe('billing line (manifest): names and dollars only, no provider call', () => {
  it('shows the key, this month against the cap, and the limit the last build start saw', async () => {
    const t = guarded({ provider: budget({ limitUsd: 35, remainingUsd: 31.9, budget: { scope: 'member', limitUsd: 50, remainingUsd: 40, resetsAt: null } }) });
    const before = await manifestView(t.deps);
    expect(before.billing).toEqual({ key: 'modeltest', monthSpentUsd: 0, monthCapUsd: 20 });
    const out = await startRun(t.deps, { ids: ['style.test-one'] }, ADMIN);
    await drain(t, out.run!.id);
    const after = await manifestView(t.deps);
    expect(after.billing).toMatchObject({ key: 'modeltest', monthCapUsd: 20, limitUsd: 35, remainingUsd: 31.9, checkedAt: budget().checkedAt });
    expect(after.billing!.monthSpentUsd).toBeGreaterThan(0);
    expect(t.checks).toHaveLength(1);
    expect(JSON.stringify(after)).not.toContain(MODELTEST);
  });
});

describe('provenance (P3-ST2) and the public index', () => {
  it('a published image carries its provenance; the index never has a run id, an admin id, a cost or the key', async () => {
    const t = guarded();
    const out = await startRun(t.deps, { ids: ['style.test-one'] }, ADMIN);
    await drain(t, out.run!.id);
    const { index } = await publicIndex(t.deps);
    expect(index.assets).toHaveLength(1);
    const a = index.assets[0];
    expect(a.provenance).toMatchObject({
      model: 'nano-banana-2.1',
      modelLabel: 'Gemini Nano Banana 2.1',
      nickname: 'Nano Banana 2.1',
      providerModel: 'nano-banana-2.1',
      route: 'openrouter',
      key: 'modeltest',
      prompt: t.images.calls[0].prompt,
      seed: null,
      seedSupported: false,
      resolution: '1K',
      aspect: '1:1',
      score: 0.9,
      attempts: 1,
      strategy: 'first'
    });
    expect(a.provenance!.promptHash).toMatch(/\S/);
    expect(a.provenance!.factsAsOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(a.lqip).toMatch(/^data:image\/webp;base64,/);
    expect(a.lqip!.length).toBeLessThanOrEqual(1200);
    const json = JSON.stringify(index);
    for (const banned of ['runId', 'adminId', 'costUsd', 'cost_usd', 'run_id', ADMIN, out.run!.id, MODELTEST]) expect(json).not.toContain(banned);
  });

  it('the index allow-lists the stored snapshot: smuggled fields never leave the server', async () => {
    const t = guarded();
    const out = await startRun(t.deps, { ids: ['style.test-one'] }, ADMIN);
    await drain(t, out.run!.id);
    const key = [...t.repo.assets.keys()][0];
    const row = t.repo.assets.get(key)!;
    const published = { ...row.published!, runId: out.run!.id, adminId: ADMIN, costUsd: 0.04, provenance: { ...row.published!.provenance!, runId: out.run!.id, adminId: ADMIN, costUsd: 0.04, apiKey: MODELTEST } } as typeof row.published;
    t.repo.assets.set(key, { ...row, published });
    const { index } = await publicIndex(t.deps);
    expect(index.assets[0].provenance).toBeDefined();
    const json = JSON.stringify(index);
    for (const banned of ['runId', 'adminId', 'costUsd', 'apiKey', ADMIN, MODELTEST]) expect(json).not.toContain(banned);
  });

  it('a refined image counts its attempts and names the strategy that drew it; old candidates without a prompt get none', async () => {
    const t = guarded({ llm: fakeLibraryLlm([{ score: 0.6 }, { score: 0.9 }]) });
    const out = await startRun(t.deps, { ids: ['style.test-one'] }, ADMIN);
    await drain(t, out.run!.id);
    const { index } = await publicIndex(t.deps);
    expect(index.assets[0].provenance).toMatchObject({ attempts: 2, score: 0.9 });
    expect(index.assets[0].provenance!.strategy).not.toBe('first');
    const entry = TEST_MANIFEST[0];
    expect(provenanceOf(entry, { rev: 1, path: 'library/v1/x/1.webp', thumbs: {}, w: 1, h: 1, bytes: 1, score: 0.9, issues: [], codes: [], strategy: 'first', hash: 'h', at: 1 }, [])).toBeUndefined();
  });
});

describe('judgeKeyBudget edge cases', () => {
  it('exactly enough passes; a limited key with room passes without a warning', () => {
    expect(judgeKeyBudget(budget({ remainingUsd: 5 }), 5)).toEqual({ ok: true });
    expect(judgeKeyBudget(budget({ remainingUsd: 4.99 }), 5).ok).toBe(false);
  });
});

describe('no timer and no fetch at import or idle (the preflight runs only inside startRun)', () => {
  it('importing the library, the keys and the lab schedules nothing and fetches nothing; only a build start asks OpenRouter', async () => {
    vi.useFakeTimers();
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ data: { limit: 35, limit_remaining: 30, limit_reset: 'monthly', usage_monthly: 5, effective_budget: null } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    vi.resetModules();
    // billing.ts's existing usage flushers (unref'd, silent when idle) are not ST-A's: count from after them.
    await import('../billing.js');
    const baseline = vi.getTimerCount();
    const lib = await import('./index.js');
    await import('../keys.js');
    await import('./keyBudget.js');
    await import('./adminSpend.js');
    await import('../models/lab.js');
    expect(vi.getTimerCount()).toBe(baseline);
    vi.advanceTimersByTime(24 * 3_600_000);
    expect(fetchSpy).not.toHaveBeenCalled();

    const t = testLibrary();
    t.deps = { ...t.deps, keys: () => adminSpendKeys({ DREAMSTREAMSTUDIO_MODELTEST: MODELTEST }), spend: { key: () => 'modeltest', monthlyCapUsd: () => 20, keyBudget: lib.createOpenRouterKeyBudget({ baseUrl: 'https://openrouter.test/api/v1' }) } };
    await lib.manifestView(t.deps);
    await lib.planQuote(t.deps, {});
    vi.advanceTimersByTime(3_600_000);
    expect(fetchSpy).not.toHaveBeenCalled();

    const beforeStart = vi.getTimerCount();
    const out = await lib.startRun(t.deps, { ids: ['style.test-one'] }, ADMIN);
    expect(out.run).not.toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://openrouter.test/api/v1/key');
    expect(init.method).toBe('GET');
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${MODELTEST}`);
    // The request-scoped deadline was cleared: nothing of ours is left scheduled.
    expect(vi.getTimerCount()).toBe(beforeStart);
    vi.unstubAllGlobals();
  });
});

describe('the image fake carries what the ledger needs', () => {
  it('reports cost and latency (so a row has a provider cost)', async () => {
    const r: ImageResult = await fakeLibraryImages().generate({ spec: { id: 'nano-banana-2.1' } as never, resolution: '1K', aspect: '1:1', prompt: 'p', references: [] });
    expect(r).toMatchObject({ costUsd: 0.0336, latencyMs: 5 });
  });
});
