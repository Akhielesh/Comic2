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

import { coerceJsonOrNull } from '../jsonCoerce.js';
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

/**
 * Detect a tool call in a model reply. Accepts the strict `{"tool_call":{...}}` shape, a
 * bare `{"name":...,"arguments":...}` object, and JSON wrapped in prose or ```fences```
 * (via the shared JSON coercer). Returns null when the reply is a normal answer.
 */
export const extractToolCall = (text: string): ParsedToolCall | null => {
  if (!text || typeof text !== 'string') return null;
  // Fast path: no JSON-looking braces at all.
  if (!text.includes('{')) return null;

  const parsed = coerceJsonOrNull(text);
  const candidate =
    parsed && typeof parsed === 'object'
      ? ((parsed as Record<string, unknown>).tool_call ?? parsed)
      : null;
  if (!candidate || typeof candidate !== 'object') return null;

  const c = candidate as Record<string, unknown>;
  const name = typeof c.name === 'string' ? c.name.trim() : '';
  if (!name) return null;
  const rawArgs = c.arguments ?? c.args ?? c.parameters ?? {};
  const args =
    rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
      ? (rawArgs as Record<string, unknown>)
      : {};
  return { name, arguments: args };
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
