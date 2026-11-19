import { describe, it, expect, vi, afterEach } from 'vitest';
import { anthropicProvider, claudeUsesAdaptiveThinking, toAnthropic } from './anthropic.js';
import { reasoningBudget } from '../reasoning.js';
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


describe('Claude request shape by model generation', () => {
  it.each([
    ['claude-sonnet-5-5', true],
    ['claude-sonnet-5.5', true],
    ['claude-opus-5-5', true],
    ['claude-sonnet-5', true],
    ['claude-fable-5-2', true],
    ['claude-haiku-5-5', true],
    ['claude-opus-4-8', true],
    ['claude-opus-4-7', true],
    ['claude-opus-4-6', true],
    ['claude-sonnet-4-6', true],
    ['claude-sonnet-4-5-20250929', false],
    ['claude-haiku-4-5', false],
    ['claude-haiku-4-5-20251001', false],
    ['claude-opus-4-1-20250805', false],
    ['claude-sonnet-4-20250514', false],
    ['claude-3-7-sonnet-20250219', false],
    ['claude-3-5-haiku-20241022', false]
  ])('%s uses adaptive thinking: %s', (model, adaptive) => {
    expect(claudeUsesAdaptiveThinking(model)).toBe(adaptive);
  });
});

describe('Claude thinking (generateText only)', () => {
  const bodies: any[] = [];
  const reply = () => new Response(JSON.stringify({ model: 'claude-test', content: [{ type: 'thinking', thinking: 'plan' }, { type: 'text', text: 'done' }] }));
  const own = { apiKey: 'test-own-key-0000', byok: true };
  const CURRENT = 'claude-sonnet-5-5';
  const OLDER = 'claude-haiku-4-5';
  const base = { model: CURRENT, messages: [{ role: 'user' as const, content: 'plan two pages' }], temperature: 0.8, retries: 1 };

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

  it("claude-sonnet-5-5 with reasoningEffort 'medium' sends adaptive thinking with that effort and no temperature", async () => {
    stub(reply);
    const r = await anthropicProvider.generateText({ ...base, maxTokens: 9000, reasoningEffort: 'medium' }, own);
    expect(r.text).toBe('done');
    expect(r.reasoning).toBe('plan');
    expect(bodies).toHaveLength(1);
    expect(bodies[0].thinking).toEqual({ type: 'adaptive' });
    expect(bodies[0].output_config).toEqual({ effort: 'medium' });
    expect(bodies[0]).not.toHaveProperty('temperature');
    expect(bodies[0]).not.toHaveProperty('top_p');
    expect(bodies[0]).not.toHaveProperty('top_k');
    expect(bodies[0].max_tokens).toBe(9000);
  });

  it('claude-sonnet-5-5 without reasoningEffort sends neither thinking nor a temperature', async () => {
    stub(reply);
    await anthropicProvider.generateText({ ...base, maxTokens: 2000 }, own);
    expect(bodies[0]).not.toHaveProperty('thinking');
    expect(bodies[0]).not.toHaveProperty('output_config');
    expect(bodies[0]).not.toHaveProperty('temperature');
    expect(bodies[0].max_tokens).toBe(2000);
  });

  it('claude-haiku-4-5 keeps a bounded thinking budget, no temperature while thinking', async () => {
    stub(reply);
    await anthropicProvider.generateText({ ...base, model: OLDER, maxTokens: 9000, reasoningEffort: 'medium' }, own);
    expect(bodies[0].thinking).toEqual({ type: 'enabled', budget_tokens: Math.max(1024, reasoningBudget('medium')) });
    expect(bodies[0]).not.toHaveProperty('output_config');
    expect(bodies[0]).not.toHaveProperty('temperature');
    expect(bodies[0].max_tokens).toBe(9000);
  });

  it('claude-haiku-4-5 keeps room for the visible reply when max_tokens would not exceed the budget', async () => {
    stub(reply);
    await anthropicProvider.generateText({ ...base, model: OLDER, maxTokens: 800, reasoningEffort: 'low' }, own);
    const budget = Math.max(1024, reasoningBudget('low'));
    expect(bodies[0].thinking.budget_tokens).toBe(budget);
    expect(bodies[0].max_tokens).toBe(800 + budget);
  });

  it('claude-haiku-4-5 without reasoningEffort keeps its temperature and no thinking', async () => {
    stub(reply);
    await anthropicProvider.generateText({ ...base, model: OLDER, maxTokens: 2000 }, own);
    expect(bodies[0]).not.toHaveProperty('thinking');
    expect(bodies[0].temperature).toBe(0.8);
  });

  it('claude-haiku-4-5 sends no thinking budget once the history holds a tool call (thinking blocks are not sent back)', async () => {
    stub(reply);
    const messages = [
      { role: 'user' as const, content: 'weather?' },
      { role: 'assistant' as const, content: '', tool_calls: [{ id: 'call_1', type: 'function' as const, function: { name: 'get_weather', arguments: '{}' } }] },
      { role: 'tool' as const, tool_call_id: 'call_1', content: 'sunny' }
    ];
    await anthropicProvider.generateText({ ...base, model: OLDER, messages, maxTokens: 2000, reasoningEffort: 'medium' }, own);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).not.toHaveProperty('thinking');
    expect(bodies[0].max_tokens).toBe(2000);
  });

  it('a 400 that names thinking retries that call once with the plain body (no thinking, no effort, no temperature), and logs no body', async () => {
    const lines: string[] = [];
    vi.spyOn(console, 'info').mockImplementation((line: string) => {
      lines.push(line);
    });
    const refused = () =>
      new Response(
        JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'thinking is not supported for this model (secret-ish detail)' } }),
        { status: 400, statusText: 'Bad Request' }
      );
    for (const model of [CURRENT, OLDER]) {
      lines.length = 0;
      bodies.length = 0;
      stub(refused, reply);
      const r = await anthropicProvider.generateText({ ...base, model, maxTokens: 9000, reasoningEffort: 'high' }, own);
      expect(r.text).toBe('done');
      expect(bodies).toHaveLength(2);
      expect(bodies[0].thinking).toBeDefined();
      for (const key of ['thinking', 'output_config', 'temperature']) expect(bodies[1]).not.toHaveProperty(key);
      const retryLines = lines.filter((l) => l.includes('anthropic_thinking_retry'));
      expect(retryLines).toHaveLength(1);
      expect(retryLines[0]).not.toContain('secret-ish');
    }
  });

  it('a 400 that names temperature is retried once with the plain body too', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const refused = () =>
      new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'temperature: only the default value is supported' } }), { status: 400 });
    stub(refused, reply);
    const r = await anthropicProvider.generateText({ ...base, model: OLDER, maxTokens: 2000 }, own);
    expect(r.text).toBe('done');
    expect(bodies).toHaveLength(2);
    expect(bodies[0].temperature).toBe(0.8);
    expect(bodies[1]).not.toHaveProperty('temperature');
  });

  it('a 400 about something else is not retried', async () => {
    stub(() => new Response(JSON.stringify({ error: { type: 'invalid_request_error', message: 'messages: field required' } }), { status: 400 }));
    await expect(anthropicProvider.generateText({ ...base, reasoningEffort: 'medium' }, own)).rejects.toThrow(/failed: 400/);
    expect(bodies).toHaveLength(1);
  });

  it('a JSON repair round after the retry stays on the plain body', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const refused = () => new Response(JSON.stringify({ error: { type: 'invalid_request_error', message: 'thinking: budget_tokens too large' } }), { status: 400 });
    const notJson = () => new Response(JSON.stringify({ model: 'm', content: [{ type: 'text', text: 'sure, here it is' }] }));
    const json = () => new Response(JSON.stringify({ model: 'm', content: [{ type: 'text', text: '{"ok":true}' }] }));
    stub(refused, notJson, json);
    const r = await anthropicProvider.generateText({ ...base, model: OLDER, maxTokens: 9000, reasoningEffort: 'low', jsonMode: true }, own);
    expect(r.json).toEqual({ ok: true });
    expect(bodies).toHaveLength(3);
    for (const body of [bodies[1], bodies[2]]) {
      expect(body).not.toHaveProperty('thinking');
      expect(body).not.toHaveProperty('temperature');
    }
  });

  const streamOnce = () =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        return new Response(new TextEncoder().encode('data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n'));
      })
    );

  it('generateTextStream on claude-sonnet-5-5 sends no thinking and no temperature (Chat streaming)', async () => {
    streamOnce();
    const r = await anthropicProvider.generateTextStream!({ ...base, maxTokens: 9000, reasoningEffort: 'high', temperature: 0.7 }, own, () => {});
    expect(r.text).toBe('hi');
    expect(bodies[0]).not.toHaveProperty('thinking');
    expect(bodies[0]).not.toHaveProperty('output_config');
    expect(bodies[0]).not.toHaveProperty('temperature');
    expect(bodies[0].stream).toBe(true);
  });

  it('generateTextStream on claude-haiku-4-5 keeps its temperature and sends no thinking', async () => {
    streamOnce();
    await anthropicProvider.generateTextStream!({ ...base, model: OLDER, maxTokens: 9000, reasoningEffort: 'high', temperature: 0.7 }, own, () => {});
    expect(bodies[0]).not.toHaveProperty('thinking');
    expect(bodies[0].temperature).toBe(0.7);
  });

  it('a refused key gives a short error with the vendor status, our 502 and no key text', async () => {
    stub(() => new Response(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: `invalid x-api-key sk-ant-${'test0000'.repeat(4)}` } }), { status: 401, statusText: 'Unauthorized' }));
    const err = await anthropicProvider.generateText(base, own).catch((e) => e);
    expect(err.vendorStatus).toBe(401);
    expect(err.status).toBe(502);
    expect(err.publicCode).toBe('PROVIDER_KEY_REJECTED');
    expect(err.publicMessage).toContain('Anthropic key');
    expect(err.message).toBe('Anthropic /messages failed: 401 Unauthorized (authentication_error) invalid x-api-key [key]');
  });
});
