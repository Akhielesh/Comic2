// Client-side persistence for the AI Chat Platform.
//
// Chat sessions live in their own IndexedDB database (isolated from the project
// cache in db.ts) so the feature is self-contained and survives reloads without
// requiring a Supabase migration. Per-user "memory" (durable facts the user wants
// the AI to remember across chats) is kept in localStorage, keyed by user id.

import type { ChatReasoningLevel, ChatToolEvent, ChatToolImage, ChatArtifact, CapabilityNotice } from '../apiTypes';
import type { ModelSourceId } from './modelSelection';
import { pullAll, pushSession, pushProject, removeRemote } from './chatSync';

const DB_NAME = 'dreamstream_chat';
const DB_VERSION = 2;
const SESSIONS_STORE = 'sessions';
const PROJECTS_STORE = 'projects';

export type ChatRole = 'user' | 'assistant';

/** A folder that groups chat sessions. */
export interface ChatProject {
  id: string;
  name: string;
  /** Lucide icon name (see chatProjectStyle.ts). */
  icon: string;
  /** Color token key (see chatProjectStyle.ts). */
  color: string;
  createdAt: number;
  updatedAt: number;
}

export interface ChatAttachment {
  id: string;
  name: string;
  mimeType: string;
  /** 'image' is sent to vision models; 'document' (e.g. PDF) is viewer-only. */
  kind?: 'image' | 'document';
  /** data:...;base64,... — images go to vision models; documents open in the viewer. */
  dataUrl: string;
}

/**
 * A snapshot of one generated assistant answer. Regenerating keeps prior answers
 * here so the user can flip between versions (‹ 1/3 ›) without losing any.
 */
export interface ChatTurnVariant {
  content: string;
  model?: string;
  requestedModel?: string;
  reasoningLevel?: ChatReasoningLevel;
  webSearch?: boolean;
  reasoning?: string;
  citations?: { url: string; title?: string }[];
  toolEvents?: ChatToolEvent[];
  images?: ChatToolImage[];
  artifacts?: ChatArtifact[];
  notices?: CapabilityNotice[];
  createdAt: number;
  error?: boolean;
}

export interface ChatTurn {
  id: string;
  role: ChatRole;
  content: string;
  attachments?: ChatAttachment[];
  /** All generated answers for this assistant turn (regenerate history). */
  variants?: ChatTurnVariant[];
  /** Index of the variant currently shown (defaults to the last). */
  activeVariant?: number;
  /** Model that produced an assistant turn (for the "answered by" label). */
  model?: string;
  /** Model the user/app asked for; shown when it differs from `model` (coercion/fallback). */
  requestedModel?: string;
  /** Typed rich-output artifacts (weather, etc.) rendered as components. */
  artifacts?: ChatArtifact[];
  reasoningLevel?: ChatReasoningLevel;
  webSearch?: boolean;
  /** Step-by-step reasoning trace, shown in the "thinking" dropdown. */
  reasoning?: string;
  /** Web sources cited when web search was on. */
  citations?: { url: string; title?: string }[];
  /** Tools the agent ran (DuckDuckGo etc.). */
  toolEvents?: ChatToolEvent[];
  /** Images surfaced by an image-search tool. */
  images?: ChatToolImage[];
  /** Capability gaps surfaced this turn (degraded/failed/missing tools). */
  notices?: CapabilityNotice[];
  createdAt: number;
  /** True when this assistant turn is an error placeholder. */
  error?: boolean;
}

export interface ChatSession {
  id: string;
  title: string;
  modelId: string | null;
  modelName?: string;
  source: ModelSourceId | null;
  reasoningLevel: ChatReasoningLevel;
  webSearch: boolean;
  /** When on, turns are routed through the multi-agent swarm orchestrator. Off by default. */
  swarm?: boolean;
  /** When on, the chat may use the user's sanitized DreamStream workspace context. Off by default. */
  dreamstreamAccess: boolean;
  /** Enabled agentic tool names (DuckDuckGo etc.). Empty = no tools. */
  tools: string[];
  /** Enabled custom MCP server ids (configs resolved from the local registry at send). */
  mcpServers?: string[];
  /** Auto mode: the app picks the best model + tools per message. */
  autoMode?: boolean;
  /** In Auto mode, restrict picks to this source (null = any allowed source). */
  lockedSource?: ModelSourceId | null;
  systemPrompt?: string;
  turns: ChatTurn[];
  createdAt: number;
  updatedAt: number;
  /** Set when this session was branched from another conversation. */
  parentSessionId?: string;
  /** Project (folder) this chat belongs to; null/undefined = unfiled. */
  projectId?: string | null;
}

const openDb = (): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(SESSIONS_STORE)) {
        const store = db.createObjectStore(SESSIONS_STORE, { keyPath: 'id' });
        store.createIndex('updatedAt', 'updatedAt', { unique: false });
      }
      if (!db.objectStoreNames.contains(PROJECTS_STORE)) {
        db.createObjectStore(PROJECTS_STORE, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

const runTransaction = async <T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
  storeName: string = SESSIONS_STORE
): Promise<T> => {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    const request = fn(store);
    let result: T;
    request.onsuccess = () => {
      result = request.result;
    };
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error || request.error);
  });
};

// Backfill defaults for sessions saved before newer fields existed.
const normalizeSession = (s: ChatSession): ChatSession => ({
  ...s,
  reasoningLevel: s.reasoningLevel || 'none',
  webSearch: Boolean(s.webSearch),
  swarm: Boolean(s.swarm),
  dreamstreamAccess: Boolean(s.dreamstreamAccess),
  tools: Array.isArray(s.tools) ? s.tools : [],
  mcpServers: Array.isArray(s.mcpServers) ? s.mcpServers : [],
  turns: Array.isArray(s.turns) ? s.turns : []
});

export const listChatSessions = async (): Promise<ChatSession[]> => {
  try {
    const all = await runTransaction<ChatSession[]>('readonly', (store) => store.getAll());
    return (all || []).map(normalizeSession).sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
};

export const getChatSession = async (id: string): Promise<ChatSession | undefined> => {
  try {
    const s = await runTransaction<ChatSession | undefined>('readonly', (store) => store.get(id));
    return s ? normalizeSession(s) : undefined;
  } catch {
    return undefined;
  }
};

export const saveChatSession = async (session: ChatSession): Promise<void> => {
  try {
    await runTransaction('readwrite', (store) => store.put(session));
  } catch {
    /* best-effort persistence */
  }
  void pushSession(session).catch(() => {});
};

export const deleteChatSession = async (id: string): Promise<void> => {
  try {
    await runTransaction('readwrite', (store) => store.delete(id));
  } catch {
    /* ignore */
  }
  void removeRemote('session', id).catch(() => {});
};

// --- Projects (folders) ------------------------------------------------------

export const listChatProjects = async (): Promise<ChatProject[]> => {
  try {
    const all = await runTransaction<ChatProject[]>('readonly', (store) => store.getAll(), PROJECTS_STORE);
    return (all || []).sort((a, b) => a.createdAt - b.createdAt);
  } catch {
    return [];
  }
};

export const saveChatProject = async (project: ChatProject): Promise<void> => {
  try {
    await runTransaction('readwrite', (store) => store.put(project), PROJECTS_STORE);
  } catch {
    /* ignore */
  }
  void pushProject(project).catch(() => {});
};

export const createChatProject = (name: string, icon: string, color: string): ChatProject => {
  const now = Date.now();
  return { id: crypto.randomUUID(), name: name.trim() || 'New project', icon, color, createdAt: now, updatedAt: now };
};

/** Delete a project. Its chats are reassigned to "unfiled" (projectId = null). */
export const deleteChatProject = async (id: string): Promise<void> => {
  try {
    await runTransaction('readwrite', (store) => store.delete(id), PROJECTS_STORE);
    const sessions = await listChatSessions();
    await Promise.all(
      sessions
        .filter((s) => s.projectId === id)
        .map((s) => saveChatSession({ ...s, projectId: null, updatedAt: Date.now() }))
    );
  } catch {
    /* ignore */
  }
  void removeRemote('project', id).catch(() => {});
};

/**
 * Two-way last-write-wins sync with Supabase (no-op until the chat_sync table exists
 * or while signed out). Call on startup before listing.
 */
export const syncFromCloud = async (): Promise<void> => {
  const remote = await pullAll();
  if (!remote) return;
  const [localSessions, localProjects] = await Promise.all([listChatSessions(), listChatProjects()]);
  const localS = new Map(localSessions.map((s) => [s.id, s]));
  const localP = new Map(localProjects.map((p) => [p.id, p]));

  // Remote → local: write newer remote rows into IndexedDB (without re-pushing).
  for (const rs of remote.sessions) {
    const l = localS.get(rs.id);
    if (!l || (rs.updatedAt || 0) > (l.updatedAt || 0)) {
      try { await runTransaction('readwrite', (store) => store.put(rs)); } catch { /* ignore */ }
    }
  }
  for (const rp of remote.projects) {
    const l = localP.get(rp.id);
    if (!l || (rp.updatedAt || 0) > (l.updatedAt || 0)) {
      try { await runTransaction('readwrite', (store) => store.put(rp), PROJECTS_STORE); } catch { /* ignore */ }
    }
  }

  // Local → remote: push newer local rows up.
  const remoteS = new Map(remote.sessions.map((s) => [s.id, s]));
  const remoteP = new Map(remote.projects.map((p) => [p.id, p]));
  for (const ls of localSessions) {
    const r = remoteS.get(ls.id);
    if (!r || (ls.updatedAt || 0) > (r.updatedAt || 0)) void pushSession(ls).catch(() => {});
  }
  for (const lp of localProjects) {
    const r = remoteP.get(lp.id);
    if (!r || (lp.updatedAt || 0) > (r.updatedAt || 0)) void pushProject(lp).catch(() => {});
  }
};

export const createEmptySession = (overrides: Partial<ChatSession> = {}): ChatSession => {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    title: 'New chat',
    modelId: null,
    source: null,
    reasoningLevel: 'none',
    webSearch: false,
    swarm: false,
    dreamstreamAccess: false,
    tools: [],
    // Auto mode ON by default: the app picks a model AND auto-enables the right live
    // tools (web/news/weather/places/maps/stocks) per message — so a fresh chat
    // actually searches and shows rich results instead of answering from memory.
    autoMode: true,
    modelName: 'Auto',
    turns: [],
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
};

/** A short, human title derived from the first user message. */
export const deriveSessionTitle = (text: string): string => {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return 'New chat';
  return clean.length > 48 ? `${clean.slice(0, 48)}…` : clean;
};

// --- Branching ---------------------------------------------------------------

/** Create a new session containing the turns up to (and including) the given turn. */
export const branchSession = (source: ChatSession, throughTurnId: string): ChatSession => {
  const idx = source.turns.findIndex((t) => t.id === throughTurnId);
  const turns = (idx >= 0 ? source.turns.slice(0, idx + 1) : source.turns).map((t) => ({
    ...t,
    id: crypto.randomUUID()
  }));
  const now = Date.now();
  return {
    ...createEmptySession(),
    title: source.title === 'New chat' ? 'New chat' : `${source.title} (branch)`,
    modelId: source.modelId,
    modelName: source.modelName,
    source: source.source,
    reasoningLevel: source.reasoningLevel,
    webSearch: source.webSearch,
    dreamstreamAccess: source.dreamstreamAccess,
    tools: [...source.tools],
    mcpServers: [...(source.mcpServers || [])],
    systemPrompt: source.systemPrompt,
    turns,
    parentSessionId: source.id,
    createdAt: now,
    updatedAt: now
  };
};

// --- Cross-navigation handoff (e.g. "Chat with this model" in the Library) ----

const PENDING_MODEL_KEY = 'dreamstream_chat_pending_model';

export interface PendingChatModel {
  id: string;
  name: string;
  source: ModelSourceId;
}

export const setPendingChatModel = (model: PendingChatModel | null): void => {
  try {
    if (model) sessionStorage.setItem(PENDING_MODEL_KEY, JSON.stringify(model));
    else sessionStorage.removeItem(PENDING_MODEL_KEY);
  } catch {
    /* ignore */
  }
};

export const consumePendingChatModel = (): PendingChatModel | null => {
  try {
    const raw = sessionStorage.getItem(PENDING_MODEL_KEY);
    if (!raw) return null;
    sessionStorage.removeItem(PENDING_MODEL_KEY);
    const parsed = JSON.parse(raw) as PendingChatModel;
    if (parsed && typeof parsed.id === 'string' && typeof parsed.source === 'string') return parsed;
    return null;
  } catch {
    return null;
  }
};

// --- Durable per-user memory --------------------------------------------------

const MEMORY_KEY = 'dreamstream_chat_memory';

export const getChatMemory = (userId?: string): string => {
  try {
    return localStorage.getItem(`${MEMORY_KEY}:${userId || 'anon'}`) || '';
  } catch {
    return '';
  }
};

export const setChatMemory = (text: string, userId?: string): void => {
  try {
    localStorage.setItem(`${MEMORY_KEY}:${userId || 'anon'}`, text.slice(0, 4000));
  } catch {
    /* ignore */
  }
};
