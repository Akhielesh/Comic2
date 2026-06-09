import { describe, it, expect } from 'vitest';
import { studioModeInfo } from './studioMode';

describe('studioModeInfo', () => {
  it('reports the full agentic loop when the worker is configured', () => {
    const info = studioModeInfo(true);
    expect(info.mode).toBe('agentic');
    expect(info.tone).toBe('live');
    expect(info.summary.toLowerCase()).toContain('runtime errors');
  });

  it('is honest about one-shot mode and points to activation when the worker is NOT configured', () => {
    const info = studioModeInfo(false);
    expect(info.mode).toBe('oneshot');
    expect(info.tone).toBe('fallback');
    expect(info.summary.toLowerCase()).toContain('does not run your app');
    expect(info.summary).toContain('AGENTIC-ACTIVATION.md');
  });

  it('stays unknown (hidden) while the status is undetermined', () => {
    const info = studioModeInfo(undefined);
    expect(info.mode).toBe('unknown');
    expect(info.tone).toBe('neutral');
  });
});
