import { describe, expect, it, vi } from 'vitest';
import { createWorkerRun, createStudioFix, filesRecordToArray, probePreview } from './studioBuildService.js';
import { runBuildAgent } from '../ai/studio/buildAgent.js';
import { buildObservation } from '../ai/studio/observation.js';

describe('filesRecordToArray', () => {
  it('maps a record to the worker file array, ensuring leading slashes', () => {
    expect(filesRecordToArray({ 'App.tsx': 'x', '/pkg.json': 'y' })).toEqual([
      { path: '/App.tsx', content: 'x' },
      { path: '/pkg.json', content: 'y' }
    ]);
  });
});

describe('probePreview', () => {
  it('returns the HTTP status from the fetch', async () => {
    const fetchImpl = vi.fn(async () => ({ status: 200 }) as Response);
    expect(await probePreview('https://p/app', 1000, fetchImpl)).toBe(200);
  });
  it('returns 0 when the fetch throws (no response)', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('refused');
    });
    expect(await probePreview('https://p/app', 1000, fetchImpl as any)).toBe(0);
  });
  it('returns 0 for an empty url without calling fetch', async () => {
    const fetchImpl = vi.fn();
    expect(await probePreview('', 1000, fetchImpl as any)).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('createWorkerRun', () => {
  it('launches, fetches logs, probes, and yields a clean RunResult', async () => {
    const call = vi.fn(async (p: any) =>
      p.action === 'launch'
        ? { ok: true, status: 200, json: { previewUrl: 'https://p/app' } }
        : { ok: true, status: 200, json: { stdout: 'ready in 200ms', stderr: '' } }
    );
    const run = createWorkerRun({ sandboxId: 's1', call: call as any, probe: async () => 200 });
    const result = await run({ '/App.tsx': 'ok' });
    expect(result.previewUrl).toBe('https://p/app');
    expect(result.httpStatus).toBe(200);
    expect(call).toHaveBeenCalledTimes(2); // launch + logs
  });

  it('short-circuits on a launch install failure (no logs call)', async () => {
    const call = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: { status: 'error', phase: 'install', log: "Cannot find module 'vite'" }
    }));
    const run = createWorkerRun({ sandboxId: 's1', call: call as any, probe: async () => 0 });
    const result = await run({ '/App.tsx': 'x' });
    expect(result.installLog).toContain('vite');
    expect(call).toHaveBeenCalledTimes(1); // launch only
  });

  it('drives runBuildAgent end-to-end with an injected fix (missing dep → clean)', async () => {
    let launches = 0;
    const call = vi.fn(async (p: any) => {
      if (p.action === 'launch') {
        launches++;
        return launches === 1
          ? { ok: true, status: 200, json: { previewUrl: 'https://p/app' } } // first: dev error via logs
          : { ok: true, status: 200, json: { previewUrl: 'https://p/app' } };
      }
      // logs: first run reports a missing dep, second run is clean
      return launches === 1
        ? { ok: true, status: 200, json: { stderr: 'Failed to resolve import "axios" from "a.ts"' } }
        : { ok: true, status: 200, json: { stdout: 'ready' } };
    });
    const run = createWorkerRun({ sandboxId: 's1', call: call as any, probe: async () => 200 });
    const fix = vi.fn(async () => ({ files: { '/package.json': '{"dependencies":{"axios":"^1"}}' } }));

    const res = await runBuildAgent({ '/a.ts': 'import "axios"' }, { run, fix });
    expect(res.ok).toBe(true);
    expect(res.iterations).toBe(1);
    expect(fix).toHaveBeenCalledTimes(1);
  });
});

describe('createStudioFix', () => {
  const obs = buildObservation({ stderr: 'Failed to resolve import "axios" from "a.ts"' });

  it('returns guard-railed fixes (drops unsafe paths from model output)', async () => {
    const complete = vi.fn(async (_prompt: string) =>
      JSON.stringify({
        note: 'add dep',
        files: [
          { path: '/package.json', content: '{"dependencies":{"axios":"^1"}}' },
          { path: '../escape.ts', content: 'malicious' }
        ]
      })
    );
    const fix = createStudioFix(complete);
    const out = await fix({ '/a.ts': 'x' }, obs);
    expect(out.files['/package.json']).toContain('axios');
    expect(out.files['/../escape.ts']).toBeUndefined();
    expect(Object.keys(out.files)).toEqual(['/package.json']);
    expect(out.note).toBe('add dep');
  });

  it('passes the observation-driven prompt to the model', async () => {
    const complete = vi.fn(async (_prompt: string) => '{"files":[]}');
    await createStudioFix(complete)({ '/a.ts': 'x' }, obs);
    expect(complete.mock.calls[0][0]).toContain('OBSERVED ERRORS');
  });
});
