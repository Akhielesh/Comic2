// @vitest-environment node
// P2-PLATFORM: every chat reserve prices the WHOLE model chain it may be billed for.
// A `:free` primary with the paid TEXT_FALLBACK retry used to reserve $0, so an exhausted
// governed user passed the usage gate and OpenRouter could fall back to the paid model.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { chatPricedModels } from './chat.js';
import { TEXT_FALLBACK } from '../ai/autoRouter.js';

describe('chatPricedModels', () => {
  it('prices a pinned :free OpenRouter model together with the paid fallback', () => {
    const priced = chatPricedModels({
      resolved: { provider: 'openrouter' },
      model: 'meta-llama/llama-3.3-70b-instruct:free',
      fallbackModels: ['meta-llama/llama-3.3-70b-instruct:free', TEXT_FALLBACK]
    });
    expect(priced).toEqual(['meta-llama/llama-3.3-70b-instruct:free', TEXT_FALLBACK]);
  });

  it('adds the provider-level paid retry even after a free-only chain', () => {
    // runChatParams always sends fallbackModel: TEXT_FALLBACK on OpenRouter, and the provider
    // retries on it when the free chain 404s/429s — so it can be billed and must be priced.
    const priced = chatPricedModels({
      resolved: { provider: 'openrouter' },
      model: 'a/free-one:free',
      fallbackModels: ['a/free-one:free', 'b/free-two:free']
    });
    expect(priced).toEqual(['a/free-one:free', 'b/free-two:free', TEXT_FALLBACK]);
  });

  it('keeps the primary when there is no chain and de-duplicates', () => {
    expect(chatPricedModels({ resolved: { provider: 'openrouter' }, model: TEXT_FALLBACK })).toEqual([TEXT_FALLBACK]);
    expect(
      chatPricedModels({ resolved: { provider: 'openrouter' }, model: ' x/y ', fallbackModels: ['x/y', '', 'x/y'] })
    ).toEqual(['x/y', TEXT_FALLBACK]);
  });

  it('adds nothing for direct providers (no OpenRouter chain or paid retry)', () => {
    expect(chatPricedModels({ resolved: { provider: 'nvidia' }, model: 'meta/llama-3.1-8b-instruct' })).toBeUndefined();
    expect(chatPricedModels({ resolved: { provider: 'anthropic' }, model: 'claude-x', fallbackModels: [] })).toBeUndefined();
  });
});

describe('chat routes reserve the whole chain', () => {
  const source = readFileSync(fileURLToPath(new URL('./chat.ts', import.meta.url)), 'utf8');
  const reserveCalls = source.split('reserveForOperation({').slice(1).map((chunk) => chunk.slice(0, chunk.indexOf('})')));

  it('passes pricedModels at every reserve site (/, /stream, /swarm)', () => {
    expect(reserveCalls).toHaveLength(3);
    for (const call of reserveCalls) {
      expect(call).toContain('pricedModels: chatPricedModels(p)');
    }
  });
});
