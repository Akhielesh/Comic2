// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
vi.mock('../jobs/refreshModelCatalog.js', () => ({ refreshModelCatalog: vi.fn() }));
vi.mock('../jobs/probeNvidiaAvailability.js', () => ({ probeNvidiaAvailability: vi.fn() }));
vi.mock('../middleware/rateLimit.js', () => ({ createRateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next() }));
import { createCatalogMaintenanceRouter } from './catalogMaintenance.js';
async function setup(overrides: Record<string, unknown> = {}) {
  const deps = {
    authenticate: vi.fn(async () => ({ runId: '123', attempt: '1' })),
    refresh: vi.fn(async () => [{ source: 'openrouter', count: 123, status: 'refreshed' as const }]),
    probe: vi.fn(async () => ({ callable: 1, downloadOnly: 0, unknown: 0 })),
    now: () => Date.parse('2026-11-14T02:00:00Z'), ...overrides
  };
  const router = createCatalogMaintenanceRouter(deps as any);
  // Exercise the real Express router without binding a network listener.
  const post = (path: string, body?: unknown, authorization = 'Bearer fake-test-token'): Promise<Response> => new Promise((resolve, reject) => {
    let status = 200; const headers = new Headers();
    const req = { method: 'POST', url: path, body, query: Object.fromEntries(new URL(path, 'http://fixture').searchParams),
      header: (name: string) => name === 'authorization' ? authorization : undefined };
    const res = { setHeader: (name: string, value: string) => headers.set(name, value),
      status: (value: number) => { status = value; return res; },
      json: (value: unknown) => resolve(Response.json(value, { status, headers })) };
    (router as any).handle(req, res, (error?: unknown) => error ? reject(error) : resolve(new Response(null, { status: 404 })));
  });
  return { deps, post };
}
describe('fixed catalog maintenance operations', () => {
  it('requires GitHub authentication and rejects arbitrary inputs', async () => {
    const { deps, post } = await setup();
    expect((await post('/refresh', undefined, '')).status).toBe(401);
    expect((await post('/refresh?provider=other')).status).toBe(400);
    expect((await post('/refresh', { model: 'caller-controlled' })).status).toBe(400);
    expect(deps.refresh).not.toHaveBeenCalled();
    deps.authenticate.mockRejectedValueOnce(new Error('token details'));
    const denied = await post('/refresh'); expect(denied.status).toBe(401);
    expect(await denied.json()).toEqual({ ok: false, code: 'MAINTENANCE_UNAUTHORIZED' });
  });
  it('returns completed durable results, no-store, and prevents immediate reruns', async () => {
    const { post } = await setup();
    const response = await post('/refresh');
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.json()).toMatchObject({ ok: true, results: [{ source: 'openrouter', count: 123, status: 'refreshed' }] });
    expect((await post('/refresh')).status).toBe(429);
  });
  it('reports missing credentials and partial refresh as unavailable', async () => {
    const { post } = await setup({
      probe: vi.fn(async () => { throw new Error('NVIDIA_API_KEY_MISSING'); }),
      refresh: vi.fn(async () => [{ source: 'nvidia', count: 0, status: 'unavailable' }])
    });
    const probe = await post('/probe-nvidia'); expect(probe.status).toBe(503);
    expect(await probe.json()).toMatchObject({ ok: false, status: 'unavailable', code: 'NVIDIA_API_KEY_MISSING' });
    expect((await post('/refresh')).status).toBe(503);
  });
  it('does not leak unexpected upstream errors', async () => {
    const { post } = await setup({ refresh: vi.fn(async () => { throw new Error('private upstream response'); }) });
    const response = await post('/refresh');
    expect(await response.json()).toMatchObject({ ok: false, code: 'MAINTENANCE_FAILED' });
  });
  it('runs only one maintenance operation at a time', async () => {
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const { post } = await setup({ refresh: vi.fn(async () => { entered(); await blocked; return []; }) });
    const first = post('/refresh'); await started;
    expect((await post('/probe-nvidia')).status).toBe(409);
    release(); expect((await first).status).toBe(200);
  });
});
