import { describe, expect, it } from 'vitest';
import { toRunResult } from './studioWorker.js';
import { buildObservation } from '../ai/studio/observation.js';

describe('toRunResult', () => {
  it('surfaces an install failure log only when the launch failed at install', () => {
    const ok = toRunResult({ launch: { previewUrl: 'https://p/app' } });
    expect(ok.installLog).toBeUndefined();
    expect(ok.previewUrl).toBe('https://p/app');

    const failed = toRunResult({ launch: { status: 'error', phase: 'install', log: "Cannot find module 'vite'" } });
    expect(failed.installLog).toContain('vite');
  });

  it('passes dev logs, http status, and console errors through to the observation', () => {
    const run = toRunResult({
      logs: { stdout: 'ready', stderr: 'Failed to resolve import "axios" from "a.ts"' },
      httpStatus: 200,
      consoleErrors: ['TypeError: x']
    });
    const obs = buildObservation(run);
    expect(obs.ok).toBe(false);
    // The dev stderr (missing dep) outranks the runtime console error.
    expect(obs.signature).toBe('missing_dependency:axios');
  });

  it('produces a clean observation when the app comes up with no errors', () => {
    const run = toRunResult({ launch: { previewUrl: 'https://p/app' }, logs: { stdout: 'ready in 200ms' }, httpStatus: 200 });
    expect(buildObservation(run).ok).toBe(true);
  });
});
