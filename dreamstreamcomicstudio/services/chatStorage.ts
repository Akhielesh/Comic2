// Client-side persistence for the AI Chat Platform.
//
// Chat sessions live in their own IndexedDB database (isolated from the project
// cache in db.ts) so the feature is self-contained and survives reloads without
// requiring a Supabase migration. Per-user "memory" (durable facts the user wants
// the AI to remember across chats) is kept in localStorage, keyed by user id.
//
// SECURITY — rows are scoped to their owner. The database is shared by everyone who signs in
// on this browser, so every session/project is tagged with `ownerUserId` when saved: the account
// signed in on THIS tab (setChatSessionUser, kept current by contexts/AuthContext), or — when no
// tab account is known — the account that owns this device's data (services/localOwner). Listing
// and loading show only that account's rows; rows from before the tags existed belong to the
// account that claimed this device's unowned data (localOwner.getUnownedDataOwner). Cloud sync
// pushes only rows owned by the signed-in user. After an account switch the previous owner's
// rows stay on the device, hidden and never pushed — they come back when that account signs in
// again. Tagging by the TAB's account matters with "Remember me" off (one session per tab):
// when another tab switches the device to account B, a tab still running as A keeps tagging
// what A writes as A's — never as B's, whose next sync would upload it.

import type { ChatReasoningLevel, ChatToolEvent, ChatToolImage, ChatArtifact, CapabilityNotice } from '../apiTypes';
import type { ModelSourceId } from './modelSelection';
import { pullAll, pushSession, pushProject, removeRemote } from './chatSync';
import { getLocalOwner, getUnownedDataOwner } from './localOwner';

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
  /** The account this project belongs to (set on save while signed in). */
  ownerUserId?: string;
}

export interface ChatAttachment {
  id: string;
  name: string;
  mimeType: string;
  /**
   * 'image'    → sent to vision models.
   * 'document' → viewer-only (PDF/CSV…); read by server tools, not inlined to the model.
   * 'text'     → a long block the user pasted; shown as a compact chip and inlined into
   *              the message so the model reads it without flooding the composer.
   */
  kind?: 'image' | 'document' | 'text';
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
  /** Wall-clock time the model took to produce this answer, in ms (shown as a timer). */
  durationMs?: number;
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
  /** When generation started (ms epoch) — drives the live "thinking" timer. */
  startedAt?: number;
  /** How long the answer took to generate, in ms — shown as a timer on the turn. */
  durationMs?: number;
  /** True when this assistant turn is an error placeholder. */
  error?: boolean;
}

export interface ChatSession {
  id: string;
  title: string;
  /** True while the title was set automatically (deterministic fallback or the AI
   *  auto-title). A manual rename sets it false so the AI title never clobbers it. */
  titleAuto?: boolean;
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
  /** The account this chat belongs to (set on save while signed in). */
  ownerUserId?: string;
}

// Open the IndexedDB. Hardened so it can NEVER hang the caller: a timeout and an
// onblocked handler (fired when another tab holds an older DB version open) reject
// instead of leaving the promise pending forever — which is what froze the chat on
// an eternal loading spinner.
const DB_OPEN_TIMEOUT_MS = 6000;
const openDb = (): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (action: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      action();
    };
    let request: IDBOpenDBRequest;
    try {
      if (typeof indexedDB === 'undefined') {
        reject(new Error('IndexedDB unavailable'));
        return;
      }
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (err) {
      reject(err instanceof Error ? err : new Error('IndexedDB open threw'));
      return;
    }
    timer = setTimeout(() => settle(() => reject(new Error('IndexedDB open timed out'))), DB_OPEN_TIMEOUT_MS);
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
    request.onsuccess = () => settle(() => resolve(request.result));
    request.onerror = () => settle(() => reject(request.error || new Error('IndexedDB open failed')));
    // Fires when an upgrade is needed but another tab holds the DB open — without this
    // handler the request silently waits forever.
    request.onblocked = () => settle(() => reject(new Error('IndexedDB open blocked (another tab is open)')));
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

// --- Ownership ------------------------------------------------------------------

type Owned = { ownerUserId?: string | null };

// The account signed in on THIS tab. contexts/AuthContext sets it with every session change
// (null when signed out). Rows are shown, tagged and pushed for this account rather than for the
// device-wide owner marker, which another tab may have moved to a different account meanwhile.
let chatSessionUser: string | null = null;

/** Record the account signed in on this tab (AuthContext), or null when nobody is. */
export const setChatSessionUser = (userId: string | null | undefined): void => {
  chatSessionUser = typeof userId === 'string' && userId ? userId.toLowerCase() : null;
};

/** Whose rows this tab shows, tags and pushes: its signed-in account, else the device's owner. */
const currentUser = (): string | null => chatSessionUser ?? getLocalOwner();

/** The account a stored row belongs to: its tag, or — untagged, from before tags — the claimant. */
const rowOwner = (row: Owned): string | null =>
  (typeof row.ownerUserId === 'string' && row.ownerUserId ? row.ownerUserId.toLowerCase() : null) ?? getUnownedDataOwner();

/** Rows handed out carry their resolved owner, so a later save never re-tags them. */
const withResolvedOwner = <T extends Owned>(row: T): T => {
  const owner = rowOwner(row);
  return owner && row.ownerUserId !== owner ? { ...row, ownerUserId: owner } : row;
};

/** Shown to this tab's account (or the device's owner; signed out on an unowned device: only rows nobody owns). */
const isVisible = (row: Owned): boolean => rowOwner(row) === currentUser();

/**
 * Tag a row on save: it keeps the owner it was loaded with (rows handed out carry it — a late
 * save after an account switch stays with the old account); a new row belongs to this tab's
 * account. (Never the unowned-data claimant: that only resolves rows already stored untagged.)
 */
const tagForSave = <T extends Owned>(row: T): { row: T; owner: string | null } => {
  const tagged = typeof row.ownerUserId === 'string' && row.ownerUserId ? row.ownerUserId.toLowerCase() : null;
  const owner = tagged ?? currentUser();
  return { row: owner ? { ...row, ownerUserId: owner } : row, owner };
};

/** True when a chat (by its `ownerUserId`) belongs to `userId` — an untagged chat belongs to no one. */
export const isChatOwnedBy = (owner: string | null | undefined, userId: string | null | undefined): boolean =>
  !!owner && !!userId && owner.toLowerCase() === userId.toLowerCase();

/** Only this tab's account's rows ever go up (chatSync re-checks against the session's user). */
const pushable = (owner: string | null): boolean => !!owner && owner === currentUser();

const listAllSessionRows = async (): Promise<ChatSession[]> =>
  (await runTransaction<ChatSession[]>('readonly', (store) => store.getAll())) || [];

const listAllProjectRows = async (): Promise<ChatProject[]> =>
  (await runTransaction<ChatProject[]>('readonly', (store) => store.getAll(), PROJECTS_STORE)) || [];

export const listChatSessions = async (): Promise<ChatSession[]> => {
  try {
    const all = await listAllSessionRows();
    return all.filter(isVisible).map(withResolvedOwner).map(normalizeSession).sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
};

export const getChatSession = async (id: string): Promise<ChatSession | undefined> => {
  try {
    const s = await runTransaction<ChatSession | undefined>('readonly', (store) => store.get(id));
    return s && isVisible(s) ? normalizeSession(withResolvedOwner(s)) : undefined;
  } catch {
    return undefined;
  }
};

export const saveChatSession = async (session: ChatSession): Promise<void> => {
  // Never resurrect a chat the user deleted THIS session. Many saves are fire-and-forget
  // (stream finalize, a late auto-title, background memory updates) and can land AFTER a
  // delete — without this guard that late put re-creates the local row and pushSession then
  // syncs it back to every device. Same tombstone syncFromCloud already trusts; a genuinely
  // new chat gets a fresh uuid, so it can never collide with a deleted id.
  if (deletedThisSession.has(session.id)) return;
  const { row, owner } = tagForSave(session);
  try {
    await runTransaction('readwrite', (store) => store.put(row));
  } catch {
    /* best-effort persistence */
  }
  if (pushable(owner)) void pushSession(row).catch(() => {});
};

// Session-lifetime tombstones: ids deleted in THIS browsing session. Cloud sync now runs
// in the background after the UI is up, so a pull snapshot taken before a delete (or a
// remote delete still in flight) could re-insert the row and "resurrect" the chat — in
// the UI, in IndexedDB, and then back up to the cloud via the local→remote push.
const deletedThisSession = new Set<string>();

/** Ids of sessions/projects deleted during this browsing session (resurrection guard). */
export const wasDeletedThisSession = (id: string): boolean => deletedThisSession.has(id);

export const deleteChatSession = async (id: string): Promise<void> => {
  deletedThisSession.add(id);
  try {
    // Only the current owner's chat (a stale screen after an account switch can't delete another's).
    const existing = await runTransaction<ChatSession | undefined>('readonly', (store) => store.get(id));
    if (!existing || isVisible(existing)) await runTransaction('readwrite', (store) => store.delete(id));
  } catch {
    /* ignore */
  }
  void removeRemote('session', id).catch(() => {});
};

// --- Projects (folders) ------------------------------------------------------

export const listChatProjects = async (): Promise<ChatProject[]> => {
  try {
    const all = await listAllProjectRows();
    return all.filter(isVisible).map(withResolvedOwner).sort((a, b) => a.createdAt - b.createdAt);
  } catch {
    return [];
  }
};

export const saveChatProject = async (project: ChatProject): Promise<void> => {
  // Same resurrection guard as saveChatSession — a late save mustn't re-create a project
  // the user deleted this session (deleteChatProject already tombstones the id).
  if (deletedThisSession.has(project.id)) return;
  const { row, owner } = tagForSave(project);
  try {
    await runTransaction('readwrite', (store) => store.put(row), PROJECTS_STORE);
  } catch {
    /* ignore */
  }
  if (pushable(owner)) void pushProject(row).catch(() => {});
};

/** `{ ownerUserId }` of this tab's account (else the device's owner), or nothing (nobody). */
const currentOwnerTag = (): { ownerUserId?: string } => {
  const owner = currentUser();
  return owner ? { ownerUserId: owner } : {};
};

export const createChatProject = (name: string, icon: string, color: string): ChatProject => {
  const now = Date.now();
  // Owned from birth: a save that lands after an account switch stays with the creator.
  return { id: crypto.randomUUID(), name: name.trim() || 'New project', icon, color, createdAt: now, updatedAt: now, ...currentOwnerTag() };
};

/** Delete a project. Its chats are reassigned to "unfiled" (projectId = null). */
export const deleteChatProject = async (id: string): Promise<void> => {
  deletedThisSession.add(id);
  try {
    const existing = await runTransaction<ChatProject | undefined>('readonly', (store) => store.get(id), PROJECTS_STORE);
    if (existing && !isVisible(existing)) return; // another account's project
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
  const owner = remote.userId.toLowerCase();
  // This device's chat data belongs to whoever owns it now (services/localOwner). If that
  // isn't the signed-in user (mid-switch, another tab's session), touch nothing.
  if (getLocalOwner() !== owner) return;
  let allSessions: ChatSession[] = [];
  let allProjects: ChatProject[] = [];
  try {
    [allSessions, allProjects] = await Promise.all([listAllSessionRows(), listAllProjectRows()]);
  } catch {
    /* IndexedDB unavailable: nothing local to reconcile */
  }
  const rawS = new Map(allSessions.map((s) => [s.id, s]));
  const rawP = new Map(allProjects.map((p) => [p.id, p]));
  const mineS = allSessions.filter((s) => rowOwner(s) === owner);
  const mineP = allProjects.filter((p) => rowOwner(p) === owner);

  // Remote → local: write newer remote rows into IndexedDB (without re-pushing), tagged as
  // this account's. Rows deleted during this browsing session are never re-inserted, even if
  // the pull snapshot predates the delete — otherwise a just-deleted chat resurrects
  // everywhere. A local row with the same id that belongs to another account is left alone.
  // An untagged row nobody claimed (from before ownership tags) is replaced by this account's
  // cloud copy: the cloud proves the chat is this account's, and it already holds the content.
  const unclaimed = (row: Owned) => rowOwner(row) === null;
  for (const rs of remote.sessions) {
    if (deletedThisSession.has(rs.id)) continue;
    const l = rawS.get(rs.id);
    if (l && unclaimed(l)) {
      const row: ChatSession = { ...rs, ownerUserId: owner };
      try { await runTransaction('readwrite', (store) => store.put(row)); } catch { /* ignore */ }
      continue;
    }
    if (l && rowOwner(l) !== owner) continue;
    if (!l || (rs.updatedAt || 0) > (l.updatedAt || 0)) {
      const row: ChatSession = { ...rs, ownerUserId: owner };
      try { await runTransaction('readwrite', (store) => store.put(row)); } catch { /* ignore */ }
    }
  }
  for (const rp of remote.projects) {
    if (deletedThisSession.has(rp.id)) continue;
    const l = rawP.get(rp.id);
    if (l && unclaimed(l)) {
      const row: ChatProject = { ...rp, ownerUserId: owner };
      try { await runTransaction('readwrite', (store) => store.put(row), PROJECTS_STORE); } catch { /* ignore */ }
      continue;
    }
    if (l && rowOwner(l) !== owner) continue;
    if (!l || (rp.updatedAt || 0) > (l.updatedAt || 0)) {
      const row: ChatProject = { ...rp, ownerUserId: owner };
      try { await runTransaction('readwrite', (store) => store.put(row), PROJECTS_STORE); } catch { /* ignore */ }
    }
  }

  // Local → remote: push this account's newer rows up — never another account's.
  const remoteS = new Map(remote.sessions.map((s) => [s.id, s]));
  const remoteP = new Map(remote.projects.map((p) => [p.id, p]));
  for (const ls of mineS) {
    const r = remoteS.get(ls.id);
    if (!r || (ls.updatedAt || 0) > (r.updatedAt || 0)) void pushSession(normalizeSession(withResolvedOwner(ls))).catch(() => {});
  }
  for (const lp of mineP) {
    const r = remoteP.get(lp.id);
    if (!r || (lp.updatedAt || 0) > (r.updatedAt || 0)) void pushProject(withResolvedOwner(lp)).catch(() => {});
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
    // Owned from birth: a chat on screen when another tab switches accounts — still streaming,
    // still editable — keeps saving as its creator's, never the new account's.
    ...currentOwnerTag(),
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
    // A branch belongs to whoever owns the chat it came from (not to whoever is signed in now).
    ...(source.ownerUserId ? { ownerUserId: source.ownerUserId } : {}),
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

// --- Session continuity ---------------------------------------------------------
//
// Which chat was open last. Without this, every reload (F5, Chrome discarding the
// background tab, navigating away and back) dropped the user into the newest session
// instead of the one they were reading — "the chat keeps resetting to the start".

const LAST_SESSION_KEY = 'dreamstream_chat_last_session';

export const getLastActiveChatSessionId = (): string | null => {
  try {
    return localStorage.getItem(LAST_SESSION_KEY);
  } catch {
    return null;
  }
};

export const setLastActiveChatSessionId = (id: string | null): void => {
  try {
    if (id) localStorage.setItem(LAST_SESSION_KEY, id);
    else localStorage.removeItem(LAST_SESSION_KEY);
  } catch {
    /* ignore */
  }
};

// --- Durable per-user memory --------------------------------------------------

const MEMORY_KEY = 'dreamstream_chat_memory';

/** Hard cap for the stored memory text (matches the historical 4000-char limit). */
export const MAX_CHAT_MEMORY_CHARS = 4000;

// Cloud-sync hook: AuthContext registers a listener so memory/agent changes follow
// the account like keys and settings do (they used to silently stay on one device).
let chatDataChangeListener: (() => void) | null = null;
export const setChatDataChangeListener = (fn: (() => void) | null) => { chatDataChangeListener = fn; };
export const notifyChatDataChanged = () => {
  if (chatDataChangeListener) {
    try { chatDataChangeListener(); } catch { /* never break local writes */ }
  }
};

export const getChatMemory = (userId?: string): string => {
  try {
    return localStorage.getItem(`${MEMORY_KEY}:${userId || 'anon'}`) || '';
  } catch {
    return '';
  }
};

export const setChatMemory = (text: string, userId?: string): void => {
  try {
    localStorage.setItem(`${MEMORY_KEY}:${userId || 'anon'}`, text.slice(0, MAX_CHAT_MEMORY_CHARS));
  } catch {
    /* ignore */
  }
  notifyChatDataChanged();
};
