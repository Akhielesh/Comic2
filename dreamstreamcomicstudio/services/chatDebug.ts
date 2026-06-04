// Compact, paste-able debug bundle for a chat session.
//
// Lets the user hand off a conversation for analysis without copying the whole
// transcript by hand: one click copies either the short session ID (resolvable
// from the `chat_sync` Supabase table) or a structured JSON bundle that captures
// what actually happened each turn — which model answered (vs. requested), the
// tools it ran and whether they succeeded, capability notices/errors, citations,
// and the artifacts rendered. That's the signal needed to diagnose "what went wrong".

import type { ChatSession, ChatTurn } from './chatStorage';

const truncate = (s: string, n = 300): string => (s.length > n ? `${s.slice(0, n)}… [+${s.length - n} chars]` : s);
const MAX_TOOLS = 10;
const MAX_NOTICES = 6;

interface TurnDebug {
  i: number;
  role: ChatTurn['role'];
  content: string;
  model?: string;
  requestedModel?: string;
  error?: true;
  tools?: { tool: string; ok: boolean; query?: string; summary?: string }[];
  moreTools?: number;
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

// Collapse repeated notices (e.g. eight identical "no web results") to one, so the
// bundle stays compact and the signal isn't buried.
const dedupeNotices = (notices: NonNullable<ChatTurn['notices']>) => {
  const seen = new Set<string>();
  const out: { level: string; tool?: string; message: string; fix?: string }[] = [];
  for (const n of notices) {
    const k = `${n.level}|${n.tool || ''}|${n.message}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ level: n.level, tool: n.tool, message: truncate(n.message, 160), fix: n.fix });
    if (out.length >= MAX_NOTICES) break;
  }
  return out;
};

const turnDebug = (t: ChatTurn, i: number): TurnDebug => {
  const tools = (t.toolEvents || []).slice(0, MAX_TOOLS).map((e) => ({ tool: e.tool, ok: e.ok, query: e.query, summary: truncate(e.summary || '', 100) || undefined }));
  const moreTools = (t.toolEvents?.length || 0) - tools.length;
  return {
    i,
    role: t.role,
    content: truncate(t.content),
    ...(t.model ? { model: t.model } : {}),
    ...(t.requestedModel && t.requestedModel !== t.model ? { requestedModel: t.requestedModel } : {}),
    ...(t.error ? { error: true as const } : {}),
    ...(tools.length ? { tools, ...(moreTools > 0 ? { moreTools } : {}) } : {}),
    ...(t.notices?.length ? { notices: dedupeNotices(t.notices) } : {}),
    ...(t.artifacts?.length ? { artifacts: t.artifacts.map((a) => a.type) } : {}),
    ...(t.citations?.length ? { citations: t.citations.length } : {}),
    ...(t.reasoning ? { hasReasoning: true as const } : {}),
    ...(t.variants && t.variants.length > 1 ? { variants: t.variants.length } : {})
  };
};

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
