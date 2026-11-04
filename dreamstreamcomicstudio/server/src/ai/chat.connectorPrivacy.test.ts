// @vitest-environment node
// The chat engine's part in connected-account privacy (ai/privacy):
//   - long-term memory: `userMemoryExcludeConnected` reaches the memory lookup as
//     `excludeConnected`, so a free-model turn of a connected user gets only the memory that was
//     not distilled from connected content (services/userMemory.ts);
//   - the connector RAG block: the result says `connectorContextUsed: true` exactly when the block
//     was added to the prompt, which routes/chat.ts reads to mark the reply as connected content.
// No network: the provider is a fake behind the gateway; memory and the connector RAG block are spies.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GenerateTextRequest, GenerateTextResult } from './providers/types.js';

const fake = vi.hoisted(() => ({ requests: [] as GenerateTextRequest[] }));
vi.mock('./gateway.js', () => {
  const answer = (req: GenerateTextRequest): GenerateTextResult => {
    fake.requests.push(req);
    return { text: 'done', model: req.model, usage: {} } as GenerateTextResult;
  };
  const provider = {
    id: 'openrouter',
    generateText: vi.fn(async (req: GenerateTextRequest) => answer(req)),
    generateTextStream: vi.fn(async (req: GenerateTextRequest) => answer(req)),
    generateImage: vi.fn(),
    listModels: vi.fn()
  };
  return { getProvider: () => provider, resolveProviderContext: (key?: string) => ({ apiKey: key || 'platform', byok: false }) };
});

const memory = vi.hoisted(() => ({
  build: vi.fn(async (_userId: string, _query: string, opts?: { excludeConnected?: boolean }) =>
    opts?.excludeConnected ? '\n\nUSER MEMORY:\n- Likes oceanography' : '\n\nUSER MEMORY:\n- Planning the launch with Dana\n- Likes oceanography'
  )
}));
vi.mock('../services/userMemory.js', () => ({ buildUserMemoryBlock: memory.build }));
const rag = vi.hoisted(() => ({ block: null as string | null, calls: 0 }));
vi.mock('../connectors/retrieval.js', () => ({
  buildConnectorContextBlock: async () => {
    rag.calls += 1;
    return rag.block;
  }
}));

const { runChat } = await import('./chat.js');

const base = {
  provider: 'openrouter' as const,
  apiKey: 'k',
  model: 'vendor/chat',
  messages: [{ role: 'user' as const, content: 'What should I read about tides?' }],
  userId: 'user-1',
  userMemory: true
};
const systemOf = (req: GenerateTextRequest) => String(req.messages[0]?.role === 'system' ? req.messages[0].content : '');

beforeEach(() => {
  fake.requests = [];
  memory.build.mockClear();
  rag.block = null;
  rag.calls = 0;
});

describe('runChat: memory without the rows distilled from connected content', () => {
  it('userMemoryExcludeConnected reaches the lookup as excludeConnected, and only that memory is sent', async () => {
    await runChat({ ...base, userMemoryExcludeConnected: true });
    expect(memory.build).toHaveBeenCalledTimes(1);
    expect(memory.build.mock.calls[0][2]).toEqual({ excludeConnected: true });
    const system = systemOf(fake.requests[0]);
    expect(system).toContain('Likes oceanography');
    expect(system).not.toContain('Planning the launch with Dana');
  });

  it('without it the lookup is unfiltered (unchanged)', async () => {
    await runChat(base);
    expect(memory.build.mock.calls[0][2]).toEqual({ excludeConnected: false });
    expect(systemOf(fake.requests[0])).toContain('Planning the launch with Dana');
  });

  it('no memory at all when userMemory is off', async () => {
    await runChat({ ...base, userMemory: false, userMemoryExcludeConnected: true });
    expect(memory.build).not.toHaveBeenCalled();
  });
});

describe('runChat: connectorContextUsed', () => {
  const RAG = '\n\n## Connected account data\n- Gmail: Dana asked to move the launch to Friday';

  it('is true when the connector context block was added to the prompt', async () => {
    rag.block = RAG;
    const r = await runChat({ ...base, userMemory: false, connectorContext: true });
    expect(systemOf(fake.requests[0])).toContain('## Connected account data');
    expect(r.connectorContextUsed).toBe(true);
  });

  it('is absent when the lookup found nothing, or connector context was off', async () => {
    const empty = await runChat({ ...base, userMemory: false, connectorContext: true });
    expect(rag.calls).toBe(1);
    expect(empty).not.toHaveProperty('connectorContextUsed');

    rag.block = RAG;
    const off = await runChat({ ...base, userMemory: false });
    expect(rag.calls).toBe(1);
    expect(off).not.toHaveProperty('connectorContextUsed');
  });

  it('is reported on the JSON tool-protocol path too (non-OpenRouter providers)', async () => {
    rag.block = RAG;
    const r = await runChat({
      ...base,
      provider: 'nvidia',
      userMemory: false,
      connectorContext: true,
      tools: [{ name: 'web_search', description: 'search', parameters: { type: 'object', properties: {} }, execute: async () => ({ content: 'x' }) }]
    });
    expect(r.connectorContextUsed).toBe(true);
  });
});
