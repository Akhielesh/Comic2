// @vitest-environment node
// Program 3 ST-A over HTTP: no response body of the admin console or the public index ever contains the admin
// spend key — not the manifest, the quote, a build start, a step, a refusal (even when OpenRouter echoes the key
// back), the run list nor the public index. Fake env values, a fake OpenRouter and the library fakes only.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { adminSpendKeys } from '../keys.js';
import { createLibraryAdminRouter, createLibraryPublicRouter } from './index.js';
import { createOpenRouterKeyBudget } from './keyBudget.js';
import type { LibraryDeps } from './runner.js';
import { testLibrary, type TestLibrary } from './testkit.js';

const ADMIN = '00000000-0000-4000-8000-000000000001';
const MODELTEST = 'sk-or-v1-modeltest-ROUTE-FAKE-55aa';

/** A fake OpenRouter /key that echoes the key in its label (the server must never pass it on). */
let providerStatus = 200;
const openRouter: typeof fetch = async (_url, init) => {
  const auth = String((init?.headers as Record<string, string> | undefined)?.Authorization || '');
  const body =
    providerStatus === 200
      ? { data: { label: auth, limit: 35, limit_remaining: 30, limit_reset: 'monthly', usage_monthly: 5, effective_budget: null } }
      : { error: { message: `Invalid key ${auth}` } };
  return new Response(JSON.stringify(body), { status: providerStatus, headers: { 'content-type': 'application/json' } });
};

let t: TestLibrary;
let deps: LibraryDeps;
let server: http.Server;
let base = '';
const bodies: string[] = [];

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as typeof req & { user?: { id: string } }).user = { id: ADMIN };
    next();
  });
  app.use('/admin', createLibraryAdminRouter(() => deps));
  app.use('/public', createLibraryPublicRouter(() => deps));
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  providerStatus = 200;
  bodies.length = 0;
  t = testLibrary();
  deps = {
    ...t.deps,
    keys: () => adminSpendKeys({ DREAMSTREAMSTUDIO_MODELTEST: MODELTEST }),
    spend: { key: () => 'modeltest', monthlyCapUsd: () => 20, keyBudget: createOpenRouterKeyBudget({ fetch: openRouter, baseUrl: 'https://openrouter.test/api/v1' }) },
    calls: { record: () => undefined }
  };
});

const call = async (path: string, init?: { method?: string; body?: unknown }) => {
  const res = await fetch(`${base}${path}`, {
    method: init?.method || 'GET',
    headers: { 'content-type': 'application/json' },
    ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {})
  });
  const text = await res.text();
  bodies.push(text);
  return { status: res.status, json: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
};

describe('no response body contains the admin spend key', () => {
  it('manifest, quote, build, steps, runs, run view and the public index', async () => {
    expect((await call('/admin/manifest')).json.billing).toEqual({ key: 'modeltest', monthSpentUsd: 0, monthCapUsd: 20 });
    expect((await call('/admin/quote', { method: 'POST', body: {} })).status).toBe(200);
    const started = await call('/admin/runs', { method: 'POST', body: { confirm: true, ids: ['style.test-one', 'style.test-two'] } });
    expect(started.status).toBe(201);
    const runId = (started.json.run as { id: string }).id;
    for (let i = 0; i < 6; i++) {
      const step = await call(`/admin/runs/${runId}/step`, { method: 'POST', body: { n: 3 } });
      if ((step.json as { status?: string }).status !== 'running') break;
    }
    await call(`/admin/runs/${runId}`);
    await call('/admin/runs');
    const manifest = await call('/admin/manifest');
    expect(manifest.json.billing).toMatchObject({ key: 'modeltest', limitUsd: 35, remainingUsd: 30 });
    const pub = await call('/public');
    expect((pub.json.assets as unknown[]).length).toBe(2);
    for (const b of bodies) {
      expect(b).not.toContain(MODELTEST);
      expect(b).not.toContain('Bearer');
    }
    // The public index carries no run id, admin id or cost.
    expect(bodies.at(-1)).not.toMatch(/runId|adminId|costUsd|cost_usd/);
    expect(bodies.at(-1)).not.toContain(runId);
    expect(bodies.at(-1)).not.toContain(ADMIN);
  });

  it('a refusal from OpenRouter (it echoes the key back) answers with the status only', async () => {
    providerStatus = 401;
    const refused = await call('/admin/runs', { method: 'POST', body: { confirm: true } });
    expect(refused.status).toBe(503);
    expect((refused.json.error as { message: string }).message).toMatch(/OpenRouter didn't accept the model-test key \(HTTP 401\)\. Check DREAMSTREAMSTUDIO_MODELTEST/);
    expect(t.repo.runs.size).toBe(0);
    for (const b of bodies) expect(b).not.toContain(MODELTEST);
  });

  it('without the key: an honest 503 naming the env var, never a value', async () => {
    deps = { ...deps, keys: () => adminSpendKeys({}) };
    expect((await call('/admin/manifest')).json).toMatchObject({ platformKey: false, billing: { key: null } });
    const refused = await call('/admin/runs', { method: 'POST', body: { confirm: true } });
    expect(refused.status).toBe(503);
    expect((refused.json.error as { message: string }).message).toContain("The model-test key (DREAMSTREAMSTUDIO_MODELTEST) isn't set on this server.");
  });
});
