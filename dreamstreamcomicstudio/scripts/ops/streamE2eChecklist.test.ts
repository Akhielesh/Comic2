import { describe, expect, it } from 'vitest';
import {
  buildStreamE2eChecklist,
  CANONICAL_HOST,
  formatChecklist,
  parseReadinessTrack,
  STEP_KEYS,
  TEMPORARY_BETA_HOST,
} from './streamE2eChecklist';
import { EXPECTED_LIVE_WORKER_BASE } from './liveSmoke';

describe('stream e2e readiness hosts', () => {
  it('points the temporary beta track at the Pages fallback host + workers.dev live API', () => {
    expect(TEMPORARY_BETA_HOST.hostname).toBe('comic2.pages.dev');
    expect(TEMPORARY_BETA_HOST.liveUrl).toBe('https://comic2.pages.dev/live.html');
    // Derived from the real live/config routing, so it cannot drift from the deployed bundle contract.
    expect(TEMPORARY_BETA_HOST.expectedWorkerBase).toContain(EXPECTED_LIVE_WORKER_BASE);
    expect(TEMPORARY_BETA_HOST.smokeCommand).toBe('npm run ops:live-smoke:temporary');
  });

  it('keeps the canonical track same-origin and clearly NOT launch-ready', () => {
    expect(CANONICAL_HOST.expectedWorkerBase).toBe('https://dreamstreamstudio.ai/live-api');
    expect(CANONICAL_HOST.expectedWorkerBase).not.toContain(EXPECTED_LIVE_WORKER_BASE);
    expect(CANONICAL_HOST.note.toLowerCase()).toContain('not launch-ready');
  });

  it('maps CLI flags to a readiness track, defaulting to temporary beta', () => {
    expect(parseReadinessTrack([])).toBe('temporary-beta');
    expect(parseReadinessTrack(['--canonical'])).toBe('canonical');
  });
});

describe('buildStreamE2eChecklist', () => {
  it('produces the full first-session loop in order with no gaps', () => {
    const steps = buildStreamE2eChecklist();
    expect(steps.map((s) => s.key)).toEqual([...STEP_KEYS]);
    expect(steps.map((s) => s.order)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('derives fragment-safe host-studio and query-only viewer URLs from the live nav contract', () => {
    const steps = buildStreamE2eChecklist(TEMPORARY_BETA_HOST);
    const studio = steps.find((s) => s.key === 'open-studio');
    const viewer = steps.find((s) => s.key === 'open-viewer');
    const summary = steps.find((s) => s.key === 'verify-summary-replay');

    expect(studio?.url).toBe('https://comic2.pages.dev/live.html?e={eventId}#/studio?k={hostKey}');
    expect(viewer?.url).toBe('https://comic2.pages.dev/live.html?e={eventId}');
    expect(summary?.url).toBe('https://comic2.pages.dev/live.html?e={eventId}#/summary?k={hostKey}');
  });

  it('threads the selected host base through every step URL', () => {
    const steps = buildStreamE2eChecklist(CANONICAL_HOST);
    expect(steps.every((s) => s.url.startsWith('https://dreamstreamstudio.ai/live.html'))).toBe(true);
  });

  it('is deterministic — same input yields identical output', () => {
    expect(buildStreamE2eChecklist(TEMPORARY_BETA_HOST)).toEqual(
      buildStreamE2eChecklist(TEMPORARY_BETA_HOST)
    );
  });
});

describe('formatChecklist', () => {
  it('names the prerequisite smoke command and distinguishes temporary from canonical readiness', () => {
    const tmp = formatChecklist(TEMPORARY_BETA_HOST, buildStreamE2eChecklist(TEMPORARY_BETA_HOST));
    expect(tmp).toContain('npm run ops:live-smoke:temporary');
    expect(tmp).toContain('temporary beta readiness only');
    expect(tmp).toContain(EXPECTED_LIVE_WORKER_BASE);

    const canon = formatChecklist(CANONICAL_HOST, buildStreamE2eChecklist(CANONICAL_HOST));
    expect(canon).toContain('canonical custom-domain readiness');
  });

  it('renders every step with do/expect/url lines and warns that browser event creation is the only write', () => {
    const out = formatChecklist(TEMPORARY_BETA_HOST, buildStreamE2eChecklist(TEMPORARY_BETA_HOST));
    expect(out.match(/do:/g) ?? []).toHaveLength(STEP_KEYS.length);
    expect(out.match(/expect:/g) ?? []).toHaveLength(STEP_KEYS.length);
    expect(out).toContain('ONLY writes are the live event you create in the browser');
  });
});
