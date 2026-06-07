// JSON tool-protocol fallback (Phase 10).
//
// Native function-calling (OpenAI-style `tools` + `tool_calls`) is OpenRouter-only here.
// Models reached through other providers (NVIDIA, and any non-tool-calling free model)
// otherwise can't use ANY of our live tools. This is the bridge: we describe the tools in
// the system prompt and ask the model to emit a small JSON object when it wants to call
// one; we parse it, run the tool, feed the result back as text, and loop — the same
// observe→act cycle as the native loop, just over plain text.
//
// This module is the dependency-free, fully-testable core: build the instruction block,
// detect a tool call in a model reply, and strip it back out of the final answer. The
// actual loop is driven by `runChat` when the protocol is enabled for a non-OpenRouter
// provider.

import type { ChatTool } from './types.js';

export interface ParsedToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

/**
 * The system-prompt block that teaches a non-tool-calling model the protocol. Lists every
 * available tool with its description and JSON parameter schema, and specifies the exact
 * shape to emit for a call vs. a final answer.
 */
export const buildJsonToolSystemBlock = (tools: ChatTool[]): string => {
  if (!tools.length) return '';
  const catalog = tools
    .map((t) => {
      const schema = JSON.stringify(t.parameters?.properties ? t.parameters : { type: 'object', properties: {} });
      return `- ${t.name}: ${t.description}\n  parameters: ${schema}`;
    })
    .join('\n');

  return `LIVE TOOLS ARE AVAILABLE to you this turn through a JSON protocol (your provider has no native function-calling, so use this format instead). You DO have internet access through these tools.

Available tools:
${catalog}

HOW TO CALL A TOOL — when you need live/factual/current data, reply with ONLY a single JSON object on its own, nothing else:
{"tool_call": {"name": "<tool_name>", "arguments": { ... }}}
You will then receive a message beginning with "TOOL_RESULT" containing what the tool returned. You may call tools several times in sequence. Call a tool whenever the answer depends on current, factual, numeric, or post-training information — do not answer such questions from memory.

HOW TO ANSWER — when you have enough information (or no tool is needed), reply normally in prose/Markdown with NO JSON tool_call object. Never fabricate data: if a tool failed or returned nothing useful, say so plainly and answer from your own knowledge with a clear "not from a live source" caveat.`;
};

// Walk a balanced, string-aware JSON object starting at `start` ('{') and return the
// substring through its matching '}'. Used to pull out an explicit {"tool_call":…} wrapper
// without tripping over braces inside string values.
const extractBalanced = (s: string, start: number): string | null => {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i += 1) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
};

const toCall = (obj: unknown): ParsedToolCall | null => {
  if (!obj || typeof obj !== 'object') return null;
  const root = obj as Record<string, unknown>;
  const candidate = (root.tool_call ?? root) as Record<string, unknown>;
  if (!candidate || typeof candidate !== 'object') return null;
  const name = typeof candidate.name === 'string' ? candidate.name.trim() : '';
  if (!name) return null;
  const rawArgs = candidate.arguments ?? candidate.args ?? candidate.parameters ?? {};
  const args =
    rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
      ? (rawArgs as Record<string, unknown>)
      : {};
  return { name, arguments: args };
};

/**
 * Detect a tool call in a model reply. STRICT by design: a call is recognized only when
 * (1) the WHOLE reply is a JSON object (the instructed shape), or (2) the reply contains an
 * explicit `{"tool_call": {...}}` wrapper. A bare `{"name":...}` found mid-prose is NOT
 * promoted — that produced false positives (normal answers that merely contained JSON were
 * mistaken for tool calls, corrupting the reply). Returns null for a normal answer.
 */
export const extractToolCall = (text: string): ParsedToolCall | null => {
  if (!text || typeof text !== 'string') return null;
  if (!text.includes('{')) return null;

  // Unwrap a reply that is entirely a single ```json fenced block.
  let body = text.trim();
  const fence = body.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) body = fence[1].trim();

  // 1) The whole reply is a JSON object (what the protocol asks the model to emit).
  if (body.startsWith('{') && body.endsWith('}')) {
    try {
      const call = toCall(JSON.parse(body));
      if (call) return call;
    } catch {
      /* fall through to the explicit-wrapper scan */
    }
  }

  // 2) An explicit {"tool_call": {...}} wrapper anywhere in the reply.
  const idx = body.indexOf('"tool_call"');
  if (idx !== -1) {
    const objStart = body.lastIndexOf('{', idx);
    if (objStart !== -1) {
      const slice = extractBalanced(body, objStart);
      if (slice) {
        try {
          const call = toCall(JSON.parse(slice));
          if (call) return call;
        } catch {
          /* not a valid wrapper */
        }
      }
    }
  }
  return null;
};

/**
 * Remove a tool-call JSON object from a reply so a model that bundled prose around its
 * call (it shouldn't, but they do) doesn't leak raw JSON into the final answer.
 */
export const stripToolCallJson = (text: string): string => {
  if (!text) return '';
  // Drop a leading/standalone {"tool_call": …} or {"name": …,"arguments": …} object.
  return text
    .replace(/\{[\s\S]*?"tool_call"[\s\S]*?\}\s*$/m, '')
    .replace(/^\s*\{[\s\S]*?"(?:name|arguments)"[\s\S]*?\}\s*/m, '')
    .trim();
};

/** Format a tool's text output as the message fed back to the model. */
export const formatToolResult = (toolName: string, content: string): string =>
  `TOOL_RESULT (${toolName}):\n${content}`;
