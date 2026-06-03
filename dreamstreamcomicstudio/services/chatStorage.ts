// Client-side persistence for the AI Chat Platform.
//
// Chat sessions live in their own IndexedDB database (isolated from the project
// cache in db.ts) so the feature is self-contained and survives reloads without
// requiring a Supabase migration. Per-user "memory" (durable facts the user wants
// the AI to remember across chats) is kept in localStorage, keyed by user id.

import type { ChatReasoningLevel } from '../apiTypes';
import type { ModelSourceId } from './modelSelection';

const DB_NAME = 'dreamstream_chat';
const DB_VERSION = 1;
const SESSIONS_STORE = 'sessions';

export type ChatRole = 'user' | 'assistant';

export interface ChatAttachment {
  id: string;
  name: string;
  mimeType: string;
  /** data:...;base64,... — sent to vision models as an image_url part. */
  dataUrl: string;
}

export interface ChatTurn {
  id: string;
  role: ChatRole;
  content: string;
  attachments?: ChatAttachment[];
  /** Model that produced an assistant turn (for the "answered by" label). */
  model?: string;
  reasoningLevel?: ChatReasoningLevel;
  webSearch?: boolean;
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
  /** When on, the chat may use the user's sanitized DreamStream workspace context. Off by default. */
  dreamstreamAccess: boolean;
  systemPrompt?: string;
  turns: ChatTurn[];
  createdAt: number;
  updatedAt: number;
  /** Set when this session was branched from another conversation. */
  parentSessionId?: string;
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
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

const runTransaction = async <T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> => {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(SESSIONS_STORE, mode);
    const store = tx.objectStore(SESSIONS_STORE);
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

export const listChatSessions = async (): Promise<ChatSession[]> => {
  try {
    const all = await runTransaction<ChatSession[]>('readonly', (store) => store.getAll());
    return (all || []).sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
};

export const getChatSession = async (id: string): Promise<ChatSession | undefined> => {
  try {
    return await runTransaction<ChatSession | undefined>('readonly', (store) => store.get(id));
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
};

export const deleteChatSession = async (id: string): Promise<void> => {
  try {
    await runTransaction('readwrite', (store) => store.delete(id));
  } catch {
    /* ignore */
  }
};

export const createEmptySession = (overrides: Partial<ChatSession> = {}): ChatSession => {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    title: 'New chat',
    modelId: null,
    modelName: undefined,
    source: null,
    reasoningLevel: 'none',
    webSearch: false,
    dreamstreamAccess: false,
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
