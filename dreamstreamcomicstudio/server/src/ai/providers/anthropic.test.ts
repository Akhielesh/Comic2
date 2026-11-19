import { describe, it, expect, vi, afterEach } from 'vitest';
import { anthropicProvider, toAnthropic } from './anthropic.js';
import { reasoningBudget } from './openrouter.js';
import type { ChatMessage } from './types.js';

describe('toAnthropic message mapping', () => {
  it('hoists system messages into the top-level system field', () => {
    const msgs: ChatMessage[] = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'system', content: 'Be concise.' },
      { role: 'user', content: 'Hi' }
    ];
    const out = toAnthropic(msgs);
    expect(out.system).toBe('You are helpful.\n\nBe concise.');
    expect(out.messages).toHaveLength(1);
    expect(out.messages[0]).toEqual({ role: 'user', content: [{ type: 'text', text: 'Hi' }] });
  });

  it('merges consecutive same-role turns and drops a leading non-user turn', () => {
    const msgs: ChatMessage[] = [
      { role: 'assistant', content: 'orphan' }, // no user before it → dropped
      { role: 'user', content: 'a' },
      { role: 'user', content: 'b' }
    ];
    const out = toAnthropic(msgs);
    expect(out.messages).toHaveLength(1);
    expect(out.messages[0].role).toBe('user');
    expect(out.messages[0].content).toEqual([
      { type: 'text', text: 'a' },
      { type: 'text', text: 'b' }
    ]);
  });

  it('maps assistant tool_calls to tool_use and tool results to a user tool_result', () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'weather?' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"NYC"}' } }]
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'sunny' }
    ];
    const out = toAnthropic(msgs);
    const assistant = out.messages.find((m) => m.role === 'assistant')!;
    expect(assistant.content).toEqual([
      { type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'NYC' } }
    ]);
    // the tool result becomes a user turn with a tool_result block
    const lastUser = out.messages[out.messages.length - 1];
    expect(lastUser.role).toBe('user');
    expect(lastUser.content).toEqual([{ type: 'tool_result', tool_use_id: 'call_1', content: 'sunny' }]);
  });

  it('maps multimodal image_url parts to base64 / url image blocks', () => {
    const dataUrl = 'data:image/png;base64,AAAA';
    const msgs: ChatMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'what is this?' },
          { type: 'image_url', image_url: { url: dataUrl } },
          { type: 'image_url', image_url: { url: 'https://example.com/x.png' } }
        ]
      }
    ];
    const out = toAnthropic(msgs);
    expect(out.messages[0].content).toEqual([
      { type: 'text', text: 'what is this?' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
      { type: 'image', source: { type: 'url', url: 'https://example.com/x.png' } }
    ]);
  });
});

describe('Claude thinking budget (generateText only)', () => {
  const bodies: any[] = [];
  const reply = () => new Response(JSON.stringify({ model: 'claude-test', content: [{ type: 'thinking', thinking: 'plan' }, { type: 'text', text: 'done' }] }));
  const own = { apiKey: 'test-own-key-0000', byok: true };
  const base = { model: 'claude-sonnet-5-5', messages: [{ role: 'user' as const, content: 'plan two pages' }], temperature: 0.4, retries: 1 };

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    bodies.length = 0;
  });

  const stub = (...responses: (() => Response)[]) => {
    let i = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        const next = responses[Math.min(i, responses.length - 1)];
        i += 1;
        return next();
      })
    );
  };

  it("reasoningEffort 'medium' sends a bounded thinking budget and no temperature", async () => {
    stub(reply);
    const r = await anthropicProvider.generateText({ ...base, maxTokens: 9000, reasoningEffort: 'medium' }, own);
    expect(r.text).toBe('done');
    expect(r.reasoning).toBe('plan');
    expect(bodies).toHaveLength(1);
    expect(bodies[0].thinking).toEqual({ type: 'enabled', budget_tokens: Math.max(1024, reasoningBudget('medium')) });
    expect(bodies[0]).not.toHaveProperty('temperature');
    expect(bodies[0].max_tokens).toBe(9000);
  });

  it('keeps room for the visible reply when max_tokens would not exceed the budget', async () => {
    stub(reply);
    await anthropicProvider.generateText({ ...base, maxTokens: 800, reasoningEffort: 'low' }, own);
    const budget = Math.max(1024, reasoningBudget('low'));
    expect(bodies[0].thinking.budget_tokens).toBe(budget);
    expect(bodies[0].max_tokens).toBe(800 + budget);
  });

  it('without reasoningEffort nothing changes: temperature kept, no thinking', async () => {
    stub(reply);
    await anthropicProvider.generateText({ ...base, maxTokens: 2000 }, own);
    expect(bodies[0]).not.toHaveProperty('thinking');
    expect(bodies[0].temperature).toBe(0.4);
    expect(bodies[0].max_tokens).toBe(2000);
  });

  it('a 400 that names thinking retries that call once without it, and logs no body', async () => {
    const lines: string[] = [];
    vi.spyOn(console, 'info').mockImplementation((line: string) => {
      lines.push(line);
    });
    const refused = () =>
      new Response(
        JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'thinking is not supported for this model (secret-ish detail)' } }),
        { status: 400, statusText: 'Bad Request' }
      );
    stub(refused, reply);
    const r = await anthropicProvider.generateText({ ...base, maxTokens: 9000, reasoningEffort: 'high' }, own);
    expect(r.text).toBe('done');
    expect(bodies).toHaveLength(2);
    expect(bodies[0].thinking).toBeDefined();
    expect(bodies[1]).not.toHaveProperty('thinking');
    expect(bodies[1].temperature).toBe(0.4);
    const retryLines = lines.filter((l) => l.includes('anthropic_thinking_retry'));
    expect(retryLines).toHaveLength(1);
    expect(retryLines[0]).not.toContain('secret-ish');
  });

  it('a 400 about something else is not retried', async () => {
    stub(() => new Response(JSON.stringify({ error: { type: 'invalid_request_error', message: 'messages: field required' } }), { status: 400 }));
    await expect(anthropicProvider.generateText({ ...base, reasoningEffort: 'medium' }, own)).rejects.toThrow(/failed: 400/);
    expect(bodies).toHaveLength(1);
  });

  it('a JSON repair round after the retry stays without thinking', async () => {
    const refused = () => new Response(JSON.stringify({ error: { type: 'invalid_request_error', message: 'thinking: budget_tokens too large' } }), { status: 400 });
    const notJson = () => new Response(JSON.stringify({ model: 'm', content: [{ type: 'text', text: 'sure, here it is' }] }));
    const json = () => new Response(JSON.stringify({ model: 'm', content: [{ type: 'text', text: '{"ok":true}' }] }));
    stub(refused, notJson, json);
    const r = await anthropicProvider.generateText({ ...base, maxTokens: 9000, reasoningEffort: 'low', jsonMode: true }, own);
    expect(r.json).toEqual({ ok: true });
    expect(bodies).toHaveLength(3);
    expect(bodies[1]).not.toHaveProperty('thinking');
    expect(bodies[2]).not.toHaveProperty('thinking');
  });

  it('generateTextStream never sends thinking (Chat streaming is unchanged)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        return new Response(new TextEncoder().encode('data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n'));
      })
    );
    const r = await anthropicProvider.generateTextStream!({ ...base, maxTokens: 9000, reasoningEffort: 'high' }, own, () => {});
    expect(r.text).toBe('hi');
    expect(bodies[0]).not.toHaveProperty('thinking');
    expect(bodies[0].temperature).toBe(0.4);
    expect(bodies[0].stream).toBe(true);
  });

  it('a refused key gives a short error with the status and no key text', async () => {
    stub(() => new Response(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: `invalid x-api-key sk-ant-${'test0000'.repeat(4)}` } }), { status: 401, statusText: 'Unauthorized' }));
    const err = await anthropicProvider.generateText(base, own).catch((e) => e);
    expect(err.status).toBe(401);
    expect(err.message).toBe('Anthropic /messages failed: 401 Unauthorized (authentication_error) invalid x-api-key [key]');
  });
});
