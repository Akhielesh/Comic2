import { describe, it, expect, beforeEach } from 'vitest';
import {
  getStudioModelSelection,
  setStudioModel,
  setStudioAuto,
  setStudioSource,
  setStudioCostPref,
  setStudioCreativity,
  setStudioMaxIterations,
  resetStudioModelSelection,
  studioModelRequest,
  STUDIO_DEFAULT_CREATIVITY,
  STUDIO_DEFAULT_MAX_ITERATIONS
} from './studioModelSelection';

describe('studioModelSelection (independent Code Studio coding model)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetStudioModelSelection();
  });

  it('defaults to seamless auto mode with no model override', () => {
    const sel = getStudioModelSelection();
    expect(sel.mode).toBe('auto');
    expect(sel.model).toBeNull();
    // Default is 'quality' now — weak free coders can't build real apps (server picks the strongest).
    expect(sel.costPref).toBe('quality');
    expect(sel.designPreset ?? null).toBeNull(); // Auto design system by default
    expect(sel.maxIterations).toBe(STUDIO_DEFAULT_MAX_ITERATIONS);
    // Auto sends no model id, so the server auto-picks the strongest available coder.
    expect(studioModelRequest().model).toBeUndefined();
    // Temperature is owned by the server now (the client no longer sends one).
    expect(studioModelRequest().temperature).toBeUndefined();
  });

  it('pins a specific model + source and surfaces it in the request', () => {
    setStudioModel('qwen/qwen3-coder', 'openrouter');
    const sel = getStudioModelSelection();
    expect(sel.mode).toBe('specific');
    expect(sel.model).toBe('qwen/qwen3-coder');
    expect(sel.source).toBe('openrouter');
    const req = studioModelRequest();
    expect(req.model).toBe('qwen/qwen3-coder');
    expect(req.source).toBe('openrouter');
  });

  it('does not leak the comics/chat selection (separate storage key)', () => {
    window.localStorage.setItem('dreamstream_model_selection', JSON.stringify({ textModel: 'openai/gpt-4o', mode: 'specific' }));
    // Studio is unaffected by the global selection.
    expect(getStudioModelSelection().model).toBeNull();
    expect(getStudioModelSelection().mode).toBe('auto');
  });

  it('setStudioAuto reverts to auto but keeps build knobs', () => {
    setStudioModel('deepseek/deepseek-chat-v3.1', 'nvidia');
    setStudioCreativity(0.8);
    setStudioMaxIterations(6);
    setStudioAuto();
    const sel = getStudioModelSelection();
    expect(sel.mode).toBe('auto');
    expect(sel.model).toBeNull();
    expect(sel.creativity).toBe(0.8);
    expect(sel.maxIterations).toBe(6);
  });

  it('keeps a standing source preference even in auto mode', () => {
    setStudioSource('nvidia');
    const req = studioModelRequest();
    expect(req.model).toBeUndefined();
    expect(req.source).toBe('nvidia');
  });

  it('clamps creativity to 0–1 and iterations to 1–6', () => {
    setStudioCreativity(5);
    setStudioMaxIterations(99);
    expect(getStudioModelSelection().creativity).toBe(1);
    expect(getStudioModelSelection().maxIterations).toBe(6);
    setStudioCreativity(-2);
    setStudioMaxIterations(0);
    expect(getStudioModelSelection().creativity).toBe(0);
    expect(getStudioModelSelection().maxIterations).toBe(1);
  });

  it('carries cost preference through to the request', () => {
    setStudioCostPref('quality');
    expect(studioModelRequest().costPref).toBe('quality');
  });
});
