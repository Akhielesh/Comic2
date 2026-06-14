import { describe, it, expect } from 'vitest';
import { toAnthropic } from './anthropic.js';
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
