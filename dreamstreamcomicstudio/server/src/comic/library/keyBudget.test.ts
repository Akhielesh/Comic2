// @vitest-environment node
// The provider-side cap check (P3-ST1; OpenRouter GET /api/v1/key, documented shape read 2026-11-05) and the app's
// monthly cap. Fail closed everywhere: an answer that can't be read refuses; refusals never carry the key.
import { describe, expect, it } from 'vitest';
import { createOpenRouterKeyBudget, judgeKeyBudget, judgeMonthlyCap, parseKeyBudget, utcMonthStartIso } from './keyBudget.js';

const KEY = 'sk-or-v1-keybudget-FAKE-7f7f';
const NOW = Date.parse('2026-11-05T10:00:00Z');
const doc = (data: Record<string, unknown>) => ({ data: { label: 'x', limit_reset: 'monthly', usage_monthly: 4.5, budgets: [], ...data } });
const respond = (status: number, body: unknown, seen?: Array<{ url: string; init?: RequestInit }>): typeof fetch =>
  (async (url: string, init?: RequestInit) => {
    seen?.push({ url, init });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  }) as unknown as typeof fetch;

describe('parseKeyBudget (the documented /key body)', () => {
  it('reads limit, limit_remaining, usage_monthly and the effective budget', () => {
    const b = parseKeyBudget(doc({ limit: 35, limit_remaining: 30.5, effective_budget: { scope: 'workspace', limit_usd: 50, spend_usd: 12, remaining_usd: 38, reset_interval: 'monthly', resets_at: '2026-12-01T00:00:00Z' } }), NOW);
    expect(b).toEqual({
      limitUsd: 35,
      remainingUsd: 30.5,
      limitReset: 'monthly',
      usageMonthlyUsd: 4.5,
      budget: { scope: 'workspace', limitUsd: 50, remainingUsd: 38, resetsAt: '2026-12-01T00:00:00Z' },
      checkedAt: NOW
    });
  });

  it('an unlimited key (limit null) has no remaining figure', () => {
    expect(parseKeyBudget(doc({ limit: null, limit_remaining: null, effective_budget: null }), NOW)).toMatchObject({ limitUsd: null, remainingUsd: null, budget: null });
  });

  it('anything else is not a budget (the caller refuses)', () => {
    expect(parseKeyBudget(null, NOW)).toBeNull();
    expect(parseKeyBudget({ data: [] }, NOW)).toBeNull();
    expect(parseKeyBudget(doc({}), NOW)).toBeNull(); // no limit field at all
    expect(parseKeyBudget(doc({ limit: 'lots' }), NOW)).toBeNull();
    expect(parseKeyBudget(doc({ limit: 35 }), NOW)).toBeNull(); // limited, but nothing says what is left
    expect(parseKeyBudget(doc({ limit: 35, limit_remaining: 30, effective_budget: { scope: 'workspace' } }), NOW)).toBeNull();
  });
});

describe('createOpenRouterKeyBudget', () => {
  it('one GET {base}/key with the key as a Bearer header', async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = [];
    const check = createOpenRouterKeyBudget({ fetch: respond(200, doc({ limit: 35, limit_remaining: 30 }), seen), baseUrl: 'https://openrouter.test/api/v1/', now: () => NOW });
    expect(await check(KEY)).toMatchObject({ limitUsd: 35, remainingUsd: 30, checkedAt: NOW });
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe('https://openrouter.test/api/v1/key');
    expect(seen[0].init).toMatchObject({ method: 'GET', headers: { Authorization: `Bearer ${KEY}` } });
  });

  it('fails closed with a status-only message: 401, 5xx, unreadable body, no answer — never the key or the body', async () => {
    const cases: Array<[typeof fetch, RegExp]> = [
      [respond(401, { error: { message: `bad key ${KEY}` } }), /didn't accept the model-test key \(HTTP 401\)\. Check DREAMSTREAMSTUDIO_MODELTEST/],
      [respond(502, `upstream says ${KEY}`), /couldn't report the model-test key's limit \(HTTP 502\)/],
      [respond(200, `not json ${KEY}`), /couldn't be read/],
      [respond(200, { data: { label: KEY } }), /couldn't be read/],
      [(async () => Promise.reject(new Error(`ECONNRESET ${KEY}`))) as unknown as typeof fetch, /didn't answer/]
    ];
    for (const [f, re] of cases) {
      const err = await createOpenRouterKeyBudget({ fetch: f })(KEY).then(
        () => null,
        (e: unknown) => e as { status: number; userMessage: string; message: string }
      );
      expect(err).not.toBeNull();
      expect(err!.status).toBe(503);
      expect(err!.userMessage).toMatch(re);
      expect(err!.userMessage).toMatch(/nothing was spent/);
      expect(JSON.stringify(err)).not.toContain(KEY);
      expect(err!.message).not.toContain(KEY);
    }
  });

  it('names the platform key on the escape hatch', async () => {
    await expect(createOpenRouterKeyBudget({ fetch: respond(403, {}) })(KEY, 'platform')).rejects.toMatchObject({ userMessage: expect.stringMatching(/platform OpenRouter key \(HTTP 403\)\. Check DREAMSTREAMSTUDIO_ALL/) });
  });
});

describe('judgeKeyBudget', () => {
  const b = (over: Record<string, unknown> = {}) => ({ limitUsd: 35, remainingUsd: 30, limitReset: 'monthly', usageMonthlyUsd: 5, budget: null, checkedAt: NOW, ...over });
  it('refuses below the run budget, by the key limit or by the budget that blocks first', () => {
    expect(judgeKeyBudget(b(), 15)).toEqual({ ok: true });
    expect(judgeKeyBudget(b({ remainingUsd: 14.99 }), 15)).toMatchObject({ ok: false, message: expect.stringContaining('$14.99 left of its $35.00 OpenRouter limit') });
    expect(judgeKeyBudget(b({ budget: { scope: 'workspace_default_member', limitUsd: 20, remainingUsd: 2, resetsAt: null } }), 5)).toMatchObject({ ok: false, message: expect.stringContaining('workspace default member budget') });
  });
  it('an unlimited key warns but passes', () => {
    expect(judgeKeyBudget(b({ limitUsd: null, remainingUsd: null }), 15, 'modeltest', 20)).toEqual({ ok: true, warning: "The model-test key has no OpenRouter limit, so only the app's $20.00 monthly cap applies. Set a monthly limit on the key in OpenRouter." });
  });
});

describe('judgeMonthlyCap', () => {
  it('this month plus the new budget may not pass the cap', () => {
    expect(judgeMonthlyCap(15, 5, 20, NOW)).toEqual({ ok: true });
    expect(judgeMonthlyCap(15.5, 5, 20, NOW)).toMatchObject({ ok: false, message: expect.stringContaining('Lower the budget to $4.50 or less, or wait until 2026-12-01 (UTC)') });
    expect(judgeMonthlyCap(20, 1, 20, NOW)).toMatchObject({ ok: false, message: expect.stringContaining('is used up ($20.00 spent). It resets on 2026-12-01') });
    expect(judgeMonthlyCap(0, 0.5, 0, NOW).ok).toBe(false); // a cap of 0 stops every build
  });
  it('the month starts at 00:00 UTC on the 1st', () => {
    expect(utcMonthStartIso(Date.parse('2026-11-30T23:59:59Z'))).toBe('2026-11-01T00:00:00.000Z');
    expect(utcMonthStartIso(Date.parse('2026-12-01T00:00:00Z'))).toBe('2026-12-01T00:00:00.000Z');
  });
});
