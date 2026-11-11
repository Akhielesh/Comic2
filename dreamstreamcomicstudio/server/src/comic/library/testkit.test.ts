// @vitest-environment node
// The library testkit wires the admin spend guard and the call ledger that production always wires (Program 3 ST-A wave
// note 10), so runner tests run the guarded path, and LibraryDeps.spend / calls can become required in a later wave.
// Fakes only: no network, no spend.
import { describe, expect, it } from 'vitest';
import { manifestView, startRun, stepRun } from './runner.js';
import { TEST_MANIFEST, testLibrary } from './testkit.js';

const ADMIN = '00000000-0000-4000-8000-000000000001';

describe('testLibrary: the pass-through spend guard', () => {
  it('wires spend and calls on the deps: the model-test key by name, no app cap, a no-op ledger', async () => {
    const { deps } = testLibrary();
    expect(deps.spend).toBeDefined();
    expect(deps.calls).toBeDefined();
    expect(deps.spend!.key()).toBe('modeltest');
    expect(deps.spend!.monthlyCapUsd()).toBe(Number.POSITIVE_INFINITY);
    expect(await deps.spend!.keyBudget('sk-or-test', 'modeltest')).toEqual({ limitUsd: 1000, remainingUsd: 1000, limitReset: 'monthly', usageMonthlyUsd: 0, budget: null, checkedAt: 0 });
    expect(deps.calls!.record({} as never)).toBeUndefined();
  });

  it('a build starts through the guard: the run records the key name and the preflight, with no warning', async () => {
    const t = testLibrary({ manifest: TEST_MANIFEST.slice(0, 1) });
    const out = await startRun(t.deps, {}, ADMIN);
    expect(out.run).not.toBeNull();
    expect(out.warning).toBeUndefined(); // a limited key with room adds no warning, so message assertions stay as they were
    const row = t.repo.runs.get(out.run!.id)!;
    expect(row.request.key).toBe('modeltest');
    expect(row.request.preflight).toEqual({ limitUsd: 1000, remainingUsd: 1000, budgetRemainingUsd: null, checkedAt: 0 });
    expect(t.images.calls).toHaveLength(0); // starting spends nothing

    const view = await manifestView(t.deps);
    expect(view.billing).toMatchObject({ key: 'modeltest', limitUsd: 1000, remainingUsd: 1000 });
  });

  it('a step under the guard draws on the OpenRouter key only, and the step goes through the ledger', async () => {
    const t = testLibrary({ manifest: TEST_MANIFEST.slice(0, 1), keys: { openrouter: { key: 'sk-or-test', byok: false }, gemini: { key: 'gm-test', byok: false } } });
    const seen: unknown[] = [];
    const images = t.deps.images;
    t.deps = { ...t.deps, images: (keys) => (seen.push(keys), images(keys)) };
    const recorded: unknown[] = [];
    t.deps.calls = { record: (c) => void recorded.push(c) };
    const out = await startRun(t.deps, {}, ADMIN);
    await stepRun(t.deps, out.run!.id, 1, ADMIN);
    expect(seen.length).toBeGreaterThan(0);
    for (const keys of seen) expect(keys).toEqual({ openrouter: { key: 'sk-or-test', byok: false } }); // the Gemini key is dropped
    expect(recorded.length).toBeGreaterThan(0);
  });

  it('no OpenRouter key: the guarded refusal names the model-test key and spends nothing', async () => {
    const t = testLibrary({ keys: { gemini: { key: 'gm-test', byok: false } } });
    await expect(startRun(t.deps, {}, ADMIN)).rejects.toMatchObject({ status: 503, code: 'NOT_AVAILABLE', message: expect.stringMatching(/model-test key \(DREAMSTREAMSTUDIO_MODELTEST\) isn't set/) });
    expect(t.images.calls).toHaveLength(0);
  });
});
