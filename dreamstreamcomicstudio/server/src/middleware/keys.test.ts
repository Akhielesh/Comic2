import { describe, it, expect } from 'vitest';
import type { Request, Response } from 'express';
import { attachKeys } from './keys.js';

// Minimal case-insensitive Request stub (Express's req.header is case-insensitive).
const makeReq = (headers: Record<string, string>): Request => {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return { header: (name: string) => lower[name.toLowerCase()] } as unknown as Request;
};

const run = (headers: Record<string, string>) => {
  const req = makeReq(headers);
  attachKeys(req, {} as Response, () => {});
  return req.apiKeys!;
};

describe('attachKeys provider resolution', () => {
  it('resolves a BYOK header into the generic provider map for any provider', () => {
    const keys = run({ 'X-OpenAI-Key': 'sk-test', 'X-Anthropic-Key': 'sk-ant-test' });
    expect(keys.providerKeys?.openai).toEqual({ key: 'sk-test', byok: true });
    expect(keys.providerKeys?.anthropic).toEqual({ key: 'sk-ant-test', byok: true });
    // A provider with no header (and no platform env) resolves to no key, not BYOK.
    expect(keys.providerKeys?.deepseek).toEqual({ key: null, byok: false });
  });

  it('mirrors the original providers into both the named fields and the generic map', () => {
    const keys = run({ 'X-OpenRouter-Key': 'sk-or-x', 'X-Nvidia-Key': 'nvapi-x', 'X-Gemini-Key': 'g-x' });
    expect(keys.openRouterKey).toBe('sk-or-x');
    expect(keys.openRouterByok).toBe(true);
    expect(keys.providerKeys?.openrouter).toEqual({ key: 'sk-or-x', byok: true });
    expect(keys.providerKeys?.nvidia).toEqual({ key: 'nvapi-x', byok: true });
    expect(keys.providerKeys?.gemini).toEqual({ key: 'g-x', byok: true });
  });

  it('drops a provider key when governance (X-Allowed-Sources) excludes it', () => {
    const keys = run({ 'X-OpenAI-Key': 'sk-test', 'X-Allowed-Sources': 'openrouter,nvidia' });
    // openai is not in the allow-list → its key is nulled even though the header was sent.
    expect(keys.providerKeys?.openai).toEqual({ key: null, byok: false });
  });

  it('keeps an allowed provider key under governance', () => {
    const keys = run({ 'X-XAI-Key': 'xai-test', 'X-Allowed-Sources': 'xai' });
    expect(keys.providerKeys?.xai).toEqual({ key: 'xai-test', byok: true });
  });
});
