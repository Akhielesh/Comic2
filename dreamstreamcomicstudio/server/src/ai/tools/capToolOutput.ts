// Bound a tool/MCP result before it re-enters the model conversation.
//
// Every tool's `content` string is pushed back into the message array as a `tool`/`user`
// turn and then RE-SENT on every subsequent model⇄tool round. A single chatty tool or
// MCP server (a verbose `read_url`, a giant `structuredContent` JSON, a noisy sandbox
// stdout) can therefore blow the model's context window — which fails the WHOLE turn with
// a provider 400 — and inflates cost/latency on each round even when it doesn't overflow.
//
// We cap with a HEAD+TAIL keep (not a head-only truncation) so both the schema/intro AND
// the tail (totals, closing rows, error trailers) survive, with a visible marker telling
// the model the middle was elided so it can ask the user to narrow or page the result.
// The cap only ever fires on pathological output — every built-in tool already self-caps
// far below these limits — so normal results pass through byte-for-byte unchanged.

/** Default cap for built-in tools (~6k tokens — generous for legitimate results). */
export const CHAT_TOOL_OUTPUT_MAX = 24_000;
/** Tighter cap for MCP tools (third-party, least-trusted, most likely to be verbose). */
export const MCP_TOOL_OUTPUT_MAX = 12_000;

export const capToolOutput = (
  content: string,
  opts: { max?: number; toolName?: string } = {}
): string => {
  const max = opts.max ?? CHAT_TOOL_OUTPUT_MAX;
  if (typeof content !== 'string' || content.length <= max) return content;
  // Keep more of the head (where the answer usually leads) than the tail.
  const head = Math.floor(max * 0.7);
  const tail = max - head;
  const dropped = content.length - max;
  const marker = `\n\n…[${opts.toolName ?? 'tool'} output truncated — ${dropped.toLocaleString()} of ${content.length.toLocaleString()} chars elided; ask to narrow or page the result]…\n\n`;
  return content.slice(0, head) + marker + content.slice(content.length - tail);
};
