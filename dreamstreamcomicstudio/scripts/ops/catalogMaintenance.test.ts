// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { AUDIENCE, runMaintenance } from './catalogMaintenance.mjs';
const env = { ACTIONS_ID_TOKEN_REQUEST_URL: 'https://run-actions-1.actions.githubusercontent.com/idtoken', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'runner-secret' };
describe('catalog maintenance workflow runner', () => {
  it('uses a scoped identity token only against the fixed operational endpoint', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ value: 'short-lived-token' }))
      .mockResolvedValueOnce(Response.json({ ok: true, completedAt: '2026-11-14T02:00:00.000Z', unexpected: 'private-value', results: [{ source: 'nvidia', count: 84, status: 'refreshed' }] }));
    const report = await runMaintenance('refresh', env, fetcher);
    expect(fetcher.mock.calls[0][0].searchParams.get('audience')).toBe(AUDIENCE);
    expect(fetcher.mock.calls[1][0]).toBe('https://dreamstream-api.akhieleshsrirangam.workers.dev/api/internal/catalog/refresh');
    expect(fetcher.mock.calls[1][1].headers.Authorization).toBe('Bearer short-lived-token');
    expect(JSON.stringify(report)).not.toMatch(/private-value|short-lived-token|runner-secret/);
    expect(report.ok).toBe(true);
  });
  it('preserves unavailable status and accepts no arbitrary operation or token URL', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ value: 'token' }))
      .mockResolvedValueOnce(Response.json({ ok: false, code: 'NVIDIA_API_KEY_MISSING' }, { status: 503 }));
    expect(await runMaintenance('probe-nvidia', env, fetcher)).toMatchObject({ ok: false, code: 'NVIDIA_API_KEY_MISSING' });
    await expect(runMaintenance('generate', env, fetcher)).rejects.toThrow();
    await expect(runMaintenance('refresh', { ...env, ACTIONS_ID_TOKEN_REQUEST_URL: 'https://attacker.invalid/token' }, fetcher)).rejects.toThrow();
  });
});
