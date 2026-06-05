import { describe, it, expect } from 'vitest';
import { parseSSEBlock, readSSEStream } from './sse';

describe('parseSSEBlock', () => {
  it('parses event + data', () => {
    expect(parseSSEBlock('event: run\ndata: {"stage":"run"}')).toEqual({ event: 'run', data: '{"stage":"run"}' });
  });

  it('defaults the event name to "message"', () => {
    expect(parseSSEBlock('data: hello')).toEqual({ event: 'message', data: 'hello' });
  });

  it('joins multi-line data and ignores comments/CR', () => {
    expect(parseSSEBlock(': keep-alive\r\nevent: x\r\ndata: a\r\ndata: b')).toEqual({ event: 'x', data: 'a\nb' });
  });

  it('returns null for a block with no data', () => {
    expect(parseSSEBlock('event: ping')).toBeNull();
  });
});

describe('readSSEStream', () => {
  const toStream = (chunks: string[]): ReadableStream<Uint8Array> => {
    const enc = new TextEncoder();
    let i = 0;
    return new ReadableStream({
      pull(controller) {
        if (i < chunks.length) controller.enqueue(enc.encode(chunks[i++]));
        else controller.close();
      },
    });
  };

  it('emits one block per event, across chunk boundaries', async () => {
    const events: string[] = [];
    // an event split across two chunks, then a second event
    await readSSEStream(
      toStream(['event: start\ndata: {"a":1}\n', '\nevent: done\ndata: {"b":2}\n\n']),
      (e) => events.push(`${e.event}:${e.data}`)
    );
    expect(events).toEqual(['start:{"a":1}', 'done:{"b":2}']);
  });
});
