// Gate L7: the classic editor's stream view (ComicStreamView) shows REAL prices only when the run goes on the
// user's own provider key — ComicEditor now tells it so (`byok`). Everyone else keeps usage terms: a governed
// user never reads dollars, and an unknown / platform-key run stays in usage terms (fail closed).
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '../types';

const stream = vi.hoisted(() => ({ props: [] as Array<Record<string, unknown>> }));
vi.mock('./studio/comic/ComicStreamView', () => ({
  ComicStreamView: (props: Record<string, unknown>) => {
    stream.props.push(props);
    return <div data-testid="stream-view" />;
  }
}));
vi.mock('./studio/comic/AgentSettingsPanel', () => ({ AgentSettingsPanel: () => null }));
vi.mock('../services/geminiService', () => ({
  analyzeScriptDetailed: vi.fn(),
  checkDeploymentParity: vi.fn(async () => null)
}));

import { ComicEditor, legacyRunUsesOwnKey } from './ComicEditor';
import { addKey, clearAllKeys, replaceAllKeys } from '../services/apiKeys';
import { setProviderEnabled } from '../services/sourceGovernance';
import { setPreferredSource } from '../services/modelSelection';

const project = (): Project =>
  ({
    id: 'proj_classic',
    name: 'Classic comic',
    createdAt: 1,
    updatedAt: 1,
    state: { step: 0, maxStepReached: 0, panels: [], scenes: [], characters: [], items: [], locations: [], versions: [] }
  }) as unknown as Project;

const renderStream = () =>
  render(<ComicEditor project={project()} onUpdate={() => undefined} onStartGeneration={() => undefined} onStopGeneration={() => undefined} onBack={() => undefined} />);

const lastByok = () => stream.props[stream.props.length - 1]?.byok;

beforeEach(() => {
  window.localStorage.clear();
  stream.props = [];
  vi.stubEnv('VITE_COMIC_AGENT_ENABLED', 'true');
});

afterEach(() => {
  clearAllKeys();
  window.localStorage.clear();
  vi.unstubAllEnvs();
});

describe('ComicEditor → ComicStreamView byok', () => {
  it('no own key: the stream keeps usage terms (byok false)', async () => {
    renderStream();
    await act(async () => undefined);
    expect(stream.props.length).toBeGreaterThan(0);
    expect(lastByok()).toBe(false);
  });

  it('an active OpenRouter key on this device: the run is on their key, so real prices (byok true)', async () => {
    addKey({ provider: 'openrouter', key: 'sk-or-test-not-a-real-key' });
    renderStream();
    await act(async () => undefined);
    expect(lastByok()).toBe(true);
  });

  it('follows key changes without a reload (event-driven, never polled)', async () => {
    renderStream();
    await act(async () => undefined);
    expect(lastByok()).toBe(false);
    await act(async () => {
      addKey({ provider: 'openrouter', key: 'sk-or-test-not-a-real-key' });
    });
    expect(lastByok()).toBe(true);
    await act(async () => {
      clearAllKeys();
    });
    expect(lastByok()).toBe(false);
  });
});

describe('legacyRunUsesOwnKey', () => {
  it('a provider switched off in source governance sends no key: the platform pays, so usage terms', () => {
    addKey({ provider: 'openrouter', key: 'sk-or-test-not-a-real-key' });
    expect(legacyRunUsesOwnKey()).toBe(true);
    setProviderEnabled('openrouter', false);
    expect(legacyRunUsesOwnKey()).toBe(false);
  });

  it('NVIDIA counts only when it is the picked image source and has a key', () => {
    addKey({ provider: 'nvidia', key: 'nvapi-test-not-a-real-key' });
    expect(legacyRunUsesOwnKey()).toBe(false);
    setPreferredSource('image', 'nvidia');
    expect(legacyRunUsesOwnKey()).toBe(true);
  });

  it('an active key entry with a blank value sends no key header: the platform pays, so usage terms', () => {
    const now = new Date().toISOString();
    const blank = (provider: 'openrouter' | 'nvidia') => ({ id: `k_${provider}`, provider, label: 'Synced key', key: '   ', active: true, limitUsd: null, usedUsd: 0, periodStart: now, createdAt: now });
    replaceAllKeys([blank('openrouter')]);
    expect(legacyRunUsesOwnKey()).toBe(false);
    replaceAllKeys([blank('nvidia')]);
    setPreferredSource('image', 'nvidia');
    expect(legacyRunUsesOwnKey()).toBe(false);
  });

  it('the Gemini fallback is treated as the platform’s (fail closed: never dollars by guess)', () => {
    window.localStorage.setItem('dreamstream_api_key', 'gemini-test-not-a-real-key');
    expect(legacyRunUsesOwnKey()).toBe(false);
  });
});
