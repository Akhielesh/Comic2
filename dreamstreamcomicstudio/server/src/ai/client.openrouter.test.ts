import { describe, it, expect, vi, beforeEach } from 'vitest';

// The OpenRouter shim calls the gateway's provider; capture what schema it sends.
const generateTextMock = vi.hoisted(() => vi.fn());

vi.mock('./gateway.js', () => ({
  getProvider: () => ({ generateText: generateTextMock }),
  resolveProviderContext: (apiKey: string) => ({ apiKey })
}));
vi.mock('./autoRouter.js', () => ({ TEXT_FALLBACK: 'openai/gpt-4o-mini' }));

import { createClient } from './client.js';
import { Type } from '@google/genai';

const sentSchema = () => generateTextMock.mock.calls[0][0].jsonSchema.schema;

describe('createOpenRouterTextClient — response_format schema root', () => {
  beforeEach(() => generateTextMock.mockReset());

  // Regression: OpenRouter/Azure structured outputs reject a top-level array schema
  // ("schema must be a JSON Schema of 'type: object', got 'type: array'"), which 500'd
  // /api/text/analyze-script. The shim must wrap the array as { items: [...] }.
  it('wraps a top-level ARRAY responseSchema into an object and unwraps the reply', async () => {
    const items = [{ segmentId: 1, rawText: 'x', synopsis: 's', characters: ['a'], setting: 'room' }];
    generateTextMock.mockResolvedValue({ text: JSON.stringify({ items }), json: { items } });

    const ai = createClient('sk-or-test-key') as any;
    const res = await ai.models.generateContent({
      model: 'openai/gpt-4o-mini',
      contents: 'analyze',
      config: {
        responseSchema: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: { segmentId: { type: Type.INTEGER } },
            required: ['segmentId']
          }
        }
      }
    });

    // 1) The schema handed to OpenRouter must have an OBJECT root, never array.
    const schema = sentSchema();
    expect(schema.type).toBe('object');
    expect(schema.type).not.toBe('array');
    expect(schema.properties.items.type).toBe('array');
    expect(schema.required).toContain('items');

    // 2) Callers still receive a bare JSON array in response.text.
    expect(JSON.parse(res.text)).toEqual(items);
  });

  it('passes a top-level OBJECT responseSchema through unchanged', async () => {
    generateTextMock.mockResolvedValue({ text: '{"ok":true}', json: { ok: true } });

    const ai = createClient('sk-or-test-key') as any;
    const res = await ai.models.generateContent({
      model: 'openai/gpt-4o-mini',
      contents: 'x',
      config: { responseSchema: { type: Type.OBJECT, properties: { ok: { type: Type.BOOLEAN } }, required: ['ok'] } }
    });

    const schema = sentSchema();
    expect(schema.type).toBe('object');
    expect(schema.properties.ok).toBeDefined();
    expect(schema.properties.items).toBeUndefined();
    // No array wrapping → text is returned verbatim.
    expect(res.text).toBe('{"ok":true}');
  });
});

describe('createOpenRouterTextClient — array reply resilience', () => {
  beforeEach(() => generateTextMock.mockReset());

  const askForArray = (json: unknown, text: string) => {
    generateTextMock.mockResolvedValue({ text, json });
    const ai = createClient('sk-or-test-key') as any;
    return ai.models.generateContent({
      model: 'openai/gpt-4o-mini',
      contents: 'analyze',
      config: { responseSchema: { type: Type.ARRAY, items: { type: Type.OBJECT, properties: { id: { type: Type.INTEGER } } } } }
    });
  };

  it('unwraps a differently-named single array property (e.g. {scenes:[...]})', async () => {
    const scenes = [{ id: 1 }, { id: 2 }];
    const res = await askForArray({ scenes }, JSON.stringify({ scenes }));
    expect(JSON.parse(res.text)).toEqual(scenes);
  });

  it('unwraps a bare top-level array reply', async () => {
    const arr = [{ id: 9 }];
    const res = await askForArray(arr, JSON.stringify(arr));
    expect(JSON.parse(res.text)).toEqual(arr);
  });
});

describe('createOpenRouterTextClient — usage + model passthrough', () => {
  beforeEach(() => generateTextMock.mockReset());

  it('surfaces real provider cost, tokens, and model so billing settles on exact cost', async () => {
    generateTextMock.mockResolvedValue({
      text: 'hello',
      json: undefined,
      model: 'anthropic/claude-3.5-haiku',
      usage: { promptTokens: 120, completionTokens: 80, totalTokens: 200, costUsd: 0.0123 }
    });

    const ai = createClient('sk-or-test-key') as any;
    const res = await ai.models.generateContent({ model: 'openai/gpt-4o-mini', contents: 'hi' });

    expect(res.usageMetadata).toBeDefined();
    expect(res.usageMetadata.costUsd).toBe(0.0123);
    expect(res.usageMetadata.promptTokenCount).toBe(120);
    expect(res.usageMetadata.candidatesTokenCount).toBe(80);
    expect(res.usageMetadata.totalTokenCount).toBe(200);
    expect(res.model).toBe('anthropic/claude-3.5-haiku');
  });

  it('leaves usageMetadata undefined when the provider reports no usage (estimate fallback kicks in)', async () => {
    generateTextMock.mockResolvedValue({ text: 'hello', json: undefined, model: 'x/y', usage: {} });
    const ai = createClient('sk-or-test-key') as any;
    const res = await ai.models.generateContent({ model: 'openai/gpt-4o-mini', contents: 'hi' });
    expect(res.usageMetadata).toBeUndefined();
  });
});

describe('createOpenRouterTextClient — multi-turn role mapping', () => {
  beforeEach(() => generateTextMock.mockReset());

  it('preserves conversation roles (model→assistant) instead of flattening to one user turn', async () => {
    generateTextMock.mockResolvedValue({ text: 'ok', json: undefined, model: 'x/y', usage: {} });
    const ai = createClient('sk-or-test-key') as any;
    await ai.models.generateContent({
      model: 'openai/gpt-4o-mini',
      contents: [
        { role: 'user', parts: [{ text: 'rules' }] },
        { role: 'model', parts: [{ text: 'prior answer' }] },
        { role: 'user', parts: [{ text: 'next question' }] }
      ]
    });
    const messages = generateTextMock.mock.calls[0][0].messages;
    expect(messages.map((m: any) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(messages[1].content).toBe('prior answer');
  });

  it('maps config.systemInstruction to a leading system message', async () => {
    generateTextMock.mockResolvedValue({ text: 'ok', json: undefined, model: 'x/y', usage: {} });
    const ai = createClient('sk-or-test-key') as any;
    await ai.models.generateContent({
      model: 'openai/gpt-4o-mini',
      contents: 'hello',
      config: { systemInstruction: 'be terse' }
    });
    const messages = generateTextMock.mock.calls[0][0].messages;
    expect(messages[0]).toEqual({ role: 'system', content: 'be terse' });
    expect(messages[1]).toEqual({ role: 'user', content: 'hello' });
  });
});
