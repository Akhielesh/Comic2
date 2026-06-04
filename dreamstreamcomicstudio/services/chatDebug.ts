// Compact, paste-able debug bundle for a chat session.
//
// Lets the user hand off a conversation for analysis without copying the whole
// transcript by hand: one click copies either the short session ID (resolvable
// from the `chat_sync` Supabase table) or a structured JSON bundle that captures
// what actually happened each turn — which model answered (vs. requested), the
// tools it ran and whether they succeeded, capability notices/errors, citations,
// and the artifacts rendered. That's the signal needed to diagnose "what went wrong".

import type { ChatSession, ChatTurn } from './chatStorage';

const truncate = (s: string, n = 700): string => (s.length > n ? `${s.slice(0, n)}… [+${s.length - n} chars]` : s);

interface TurnDebug {
  i: number;
  role: ChatTurn['role'];
  content: string;
  model?: string;
  requestedModel?: string;
  error?: true;
  tools?: { tool: string; ok: boolean; query?: string; summary?: string }[];
  notices?: { level: string; tool?: string; message: string; fix?: string }[];
  artifacts?: string[];
  citations?: number;
  hasReasoning?: true;
  variants?: number;
}

export interface ChatDebugBundle {
  _kind: 'dreamstream.chat.debug';
  v: 1;
  id: string;
  title: string;
  model: {
    modelId: string | null;
    modelName?: string;
    source: ChatSession['source'];
    reasoningLevel: ChatSession['reasoningLevel'];
    webSearch: boolean;
    swarm?: boolean;
    autoMode?: boolean;
    lockedSource?: ChatSession['lockedSource'];
  };
  tools: string[];
  mcpServers?: string[];
  createdAt: string;
  updatedAt: string;
  turnCount: number;
  turns: TurnDebug[];
}

const turnDebug = (t: ChatTurn, i: number): TurnDebug => ({
  i,
  role: t.role,
  content: truncate(t.content),
  ...(t.model ? { model: t.model } : {}),
  ...(t.requestedModel && t.requestedModel !== t.model ? { requestedModel: t.requestedModel } : {}),
  ...(t.error ? { error: true as const } : {}),
  ...(t.toolEvents?.length ? { tools: t.toolEvents.map((e) => ({ tool: e.tool, ok: e.ok, query: e.query, summary: e.summary })) } : {}),
  ...(t.notices?.length ? { notices: t.notices.map((n) => ({ level: n.level, tool: n.tool, message: n.message, fix: n.fix })) } : {}),
  ...(t.artifacts?.length ? { artifacts: t.artifacts.map((a) => a.type) } : {}),
  ...(t.citations?.length ? { citations: t.citations.length } : {}),
  ...(t.reasoning ? { hasReasoning: true as const } : {}),
  ...(t.variants && t.variants.length > 1 ? { variants: t.variants.length } : {})
});

export const buildDebugBundle = (session: ChatSession): ChatDebugBundle => ({
  _kind: 'dreamstream.chat.debug',
  v: 1,
  id: session.id,
  title: session.title,
  model: {
    modelId: session.modelId,
    modelName: session.modelName,
    source: session.source,
    reasoningLevel: session.reasoningLevel,
    webSearch: session.webSearch,
    swarm: session.swarm,
    autoMode: session.autoMode,
    lockedSource: session.lockedSource
  },
  tools: session.tools,
  mcpServers: session.mcpServers,
  createdAt: new Date(session.createdAt).toISOString(),
  updatedAt: new Date(session.updatedAt).toISOString(),
  turnCount: session.turns.length,
  turns: session.turns.map(turnDebug)
});

export const serializeDebugBundle = (session: ChatSession): string => JSON.stringify(buildDebugBundle(session), null, 2);
