// Minimal Server-Sent Events reader for fetch() streaming responses. Dependency-free + pure
// parser (testable without a network).

export interface ParsedSSE {
  event: string;
  data: string;
}

/** Parse one SSE block (the text between blank lines) into { event, data }. */
export const parseSSEBlock = (block: string): ParsedSSE | null => {
  let event = 'message';
  const dataLines: string[] = [];
  for (const raw of block.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.startsWith(':')) continue; // comment/heartbeat
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
  }
  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join('\n') };
};

/** Read an SSE response body, invoking `onBlock` for each complete event block. */
export const readSSEStream = async (
  body: ReadableStream<Uint8Array> | null,
  onBlock: (e: ParsedSSE) => void
): Promise<void> => {
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const parsed = parseSSEBlock(block);
      if (parsed) onBlock(parsed);
    }
  }
  const tail = parseSSEBlock(buf);
  if (tail) onBlock(tail);
};
