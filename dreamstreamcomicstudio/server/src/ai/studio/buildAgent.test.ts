import { describe, expect, it, vi } from 'vitest';
import { runBuildAgent, type RunResult, type BuildAgentDeps } from './buildAgent.js';

// A fake `run` that returns a queued sequence of results (last one repeats).
const queuedRun = (results: RunResult[]) => {
  let i = 0;
  return vi.fn(async () => results[Math.min(i++, results.length - 1)]);
};

const CLEAN: RunResult = { httpStatus: 200, previewUrl: 'https://p.example/app' };
const MISSING_AXIOS: RunResult = { stderr: 'Failed to resolve import "axios" from "src/api.ts"' };

describe('runBuildAgent', () => {
  it('succeeds immediately when the first build is clean (no fix called)', async () => {
    const deps: BuildAgentDeps = { run: queuedRun([CLEAN]), fix: vi.fn() };
    const res = await runBuildAgent({ '/App.tsx': 'ok' }, deps);
    expect(res.ok).toBe(true);
    expect(res.reason).toBe('ok');
    expect(res.iterations).toBe(0);
    expect(res.previewUrl).toBe('https://p.example/app');
    expect(deps.fix).not.toHaveBeenCalled();
  });

  it('fixes a missing dependency then reaches a clean build', async () => {
    const fix = vi.fn(async () => ({ files: { '/package.json': '{"dependencies":{"axios":"^1"}}' }, note: 'add axios' }));
    const deps: BuildAgentDeps = { run: queuedRun([MISSING_AXIOS, CLEAN]), fix };
    const res = await runBuildAgent({ '/src/api.ts': 'import axios from "axios"' }, deps);
    expect(res.ok).toBe(true);
    expect(res.iterations).toBe(1);
    expect(fix).toHaveBeenCalledTimes(1);
    // The fix's files were merged into the project.
    expect(res.files['/package.json']).toContain('axios');
  });

  it('stops as "stuck" when the same error persists despite fixes', async () => {
    const fix = vi.fn(async () => ({ files: {} })); // fix never actually changes anything
    const deps: BuildAgentDeps = { run: queuedRun([MISSING_AXIOS]), fix };
    const res = await runBuildAgent({ '/src/api.ts': 'x' }, deps, { maxIterations: 10 });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('stuck');
  });

  it('stops at the iteration cap when errors keep changing', async () => {
    let n = 0;
    const run = vi.fn(async () => ({ stderr: `Failed to resolve import "pkg-${n++}" from "a.ts"` }));
    const fix = vi.fn(async () => ({ files: { '/x': String(Math.random()) } }));
    const res = await runBuildAgent({ '/a.ts': 'x' }, { run, fix }, { maxIterations: 3 });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('max_iterations');
    expect(res.iterations).toBe(3);
    expect(fix).toHaveBeenCalledTimes(3);
  });

  it('emits a coherent event trace (plan → run → observe → fix → … → done)', async () => {
    const events: string[] = [];
    const deps: BuildAgentDeps = {
      run: queuedRun([MISSING_AXIOS, CLEAN]),
      fix: vi.fn(async () => ({ files: { '/package.json': '{}' } })),
      onEvent: (e) => events.push(e.stage)
    };
    await runBuildAgent({ '/a.ts': 'x' }, deps);
    expect(events[0]).toBe('plan');
    expect(events).toContain('fix');
    expect(events[events.length - 1]).toBe('done');
    // Order sanity: a run is always followed by an observe.
    for (let i = 0; i < events.length; i++) {
      if (events[i] === 'run') expect(events[i + 1]).toBe('observe');
    }
  });
});
