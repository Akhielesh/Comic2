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
