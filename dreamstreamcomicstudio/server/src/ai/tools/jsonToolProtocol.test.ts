import { describe, it, expect } from 'vitest';
import { buildJsonToolSystemBlock, extractToolCall, stripToolCallJson } from './jsonToolProtocol.js';
import type { ChatTool } from './types.js';

const tool = (name: string): ChatTool => ({
  name,
  description: `desc for ${name}`,
  parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  execute: async () => ({ content: 'ok' })
});

describe('buildJsonToolSystemBlock', () => {
  it('lists tools with names + schemas and the call format', () => {
    const block = buildJsonToolSystemBlock([tool('web_search'), tool('get_news')]);
    expect(block).toContain('web_search');
    expect(block).toContain('get_news');
    expect(block).toContain('"tool_call"');
    expect(block).toContain('parameters:');
  });

  it('returns empty string when no tools', () => {
    expect(buildJsonToolSystemBlock([])).toBe('');
  });
});

describe('extractToolCall', () => {
  it('parses the strict {"tool_call":{...}} shape', () => {
    const call = extractToolCall('{"tool_call": {"name": "web_search", "arguments": {"query": "ai news"}}}');
    expect(call).toEqual({ name: 'web_search', arguments: { query: 'ai news' } });
  });

  it('parses a bare {name, arguments} object', () => {
    const call = extractToolCall('{"name": "get_stock", "arguments": {"symbol": "AAPL"}}');
    expect(call).toEqual({ name: 'get_stock', arguments: { symbol: 'AAPL' } });
  });

  it('extracts a tool call wrapped in prose or fences', () => {
    const call = extractToolCall('Sure, let me check.\n```json\n{"tool_call":{"name":"get_weather","arguments":{"place":"Tokyo"}}}\n```');
    expect(call?.name).toBe('get_weather');
    expect(call?.arguments).toEqual({ place: 'Tokyo' });
  });

  it('tolerates a missing/!object arguments field', () => {
    expect(extractToolCall('{"name":"get_news"}')).toEqual({ name: 'get_news', arguments: {} });
  });

  it('returns null for a normal prose answer', () => {
    expect(extractToolCall('The capital of France is Paris.')).toBeNull();
    expect(extractToolCall('Here are 3 options: a, b, c.')).toBeNull();
  });

  it('does NOT promote a bare {name} object found mid-prose (false-positive guard)', () => {
    // A normal answer that merely contains JSON with a `name` field must not be mistaken
    // for a tool call — that corrupted real answers on the non-OpenRouter path.
    expect(extractToolCall('Here is an example user record: {"name": "Ada", "role": "admin"}. Hope that helps!')).toBeNull();
    expect(extractToolCall('To define a function: `{"name": "x"}` is just a JSON object.')).toBeNull();
  });

  it('returns null for empty / non-string input', () => {
    expect(extractToolCall('')).toBeNull();
    expect(extractToolCall(undefined as unknown as string)).toBeNull();
  });
});

describe('stripToolCallJson', () => {
  it('removes a trailing tool_call object', () => {
    const out = stripToolCallJson('Let me look that up. {"tool_call":{"name":"web_search","arguments":{"query":"x"}}}');
    expect(out).not.toContain('tool_call');
    expect(out).toContain('Let me look that up.');
  });

  it('leaves a normal answer untouched', () => {
    expect(stripToolCallJson('Paris is the capital of France.')).toBe('Paris is the capital of France.');
  });
});
