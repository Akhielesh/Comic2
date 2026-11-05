// Optional Supabase-backed sync for chat sessions + projects.
//
// Table-optional + graceful: if the `chat_sync` table doesn't exist (migration not
// applied) or the user is signed out, every call is a safe no-op and the chat keeps
// working from local IndexedDB. Once the table exists, sessions/projects follow the
// user across devices.
//
// LIGHT SYNC (CHAT-0, nav V.3-a). A chat mount used to pull every chat's full body (6.3 MB for the
// heaviest account) and re-upload any row it thought newer. Now a mount pulls a MANIFEST — `key,
// updated_at` only, about 100 B a row — and fetches bodies only for the keys that changed
// (`pullBodies`, `.in('key', …)`). Which side changed is decided against the SYNC BASE: per account,
// the `updated_at` this device last saw agree with its own copy (`readSyncBase`). `chat_sync.updated_at`
// is written from the writer's clock, so "newer timestamp wins" alone drops edits from a device whose
// clock runs behind; with the base, a remote row that moved while the local copy did not is taken
// whatever its timestamp says. Without a base entry (the first sync on a device), the newer timestamp
// wins, as before. The base lives in localStorage; when that is unavailable sync still works, it just
// falls back to the timestamp rule.
//
// SECURITY: a row goes up only into the account that owns it. chatStorage tags every row with
// `ownerUserId`; push() refuses a row whose owner isn't the signed-in user (or that has no
// owner at all), so one account's chats can never be uploaded with another account's session.

import { supabase } from './supabase';
import type { ChatSession, ChatProject } from './chatStorage';

const TABLE = 'chat_sync';
let available = true; // flips off if the table is missing, so we stop hitting it.

const isMissingTable = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') return false;
  const e = error as { code?: string; message?: string };
  const code = String(e.code || '').toLowerCase();
  const message = String(e.message || '').toLowerCase();
  return code === '42p01' || (message.includes('chat_sync') && message.includes('does not exist'));
};

const keyFor = (kind: 'session' | 'project', id: string) => `${kind}:${id}`;

export const isChatSyncAvailable = (): boolean => available;

/**
 * Every row in full. Kept for callers that need the whole set; Chat Studio's mount uses the
 * manifest (`pullManifest` + `pullBodies`) instead.
 */
export const pullAll = async (): Promise<{ userId: string; sessions: ChatSession[]; projects: ChatProject[] } | null> => {
  if (!available) return null;
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  const { data, error } = await supabase.from(TABLE).select('kind, data').eq('user_id', user.id);
  if (error) {
    if (isMissingTable(error)) available = false;
    return null;
  }
  const sessions: ChatSession[] = [];
  const projects: ChatProject[] = [];
  for (const row of data || []) {
    if (row.kind === 'session' && row.data) sessions.push(row.data as ChatSession);
    else if (row.kind === 'project' && row.data) projects.push(row.data as ChatProject);
  }
  return { userId: user.id, sessions, projects };
};

// --- Manifest -------------------------------------------------------------------------------------

/** One remote row, without its body. */
export interface ChatSyncManifestEntry {
  key: string;
  kind: 'session' | 'project';
  id: string;
  /** `updated_at` in ms (the writer's clock). */
  updatedAt: number;
}

/** Rows per manifest page when the server capped the first answer (PostgREST max-rows). */
export const MANIFEST_PAGE = 1000;
const MANIFEST_MAX_PAGES = 50;
/** Keys per body request (keeps the `in.(…)` filter well inside URL limits). */
export const BODY_CHUNK = 50;

const parseKey = (key: unknown): { kind: 'session' | 'project'; id: string } | null => {
  if (typeof key !== 'string') return null;
  const at = key.indexOf(':');
  if (at <= 0) return null;
  const kind = key.slice(0, at);
  const id = key.slice(at + 1);
  if ((kind !== 'session' && kind !== 'project') || !id) return null;
  return { kind, id };
};

const msOf = (value: unknown): number => {
  const t = typeof value === 'string' ? Date.parse(value) : typeof value === 'number' ? value : NaN;
  return Number.isFinite(t) ? t : 0;
};

/**
 * The signed-in user's rows as `key, updated_at` only — no bodies. Null when signed out, when the
 * table is missing, or on any error (the caller then leaves local data exactly as it is).
 */
export const pullManifest = async (): Promise<{ userId: string; entries: ChatSyncManifestEntry[] } | null> => {
  if (!available) return null;
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const toEntries = (rows: { key?: unknown; updated_at?: unknown }[]): ChatSyncManifestEntry[] => {
    const out: ChatSyncManifestEntry[] = [];
    for (const row of rows) {
      const parsed = parseKey(row.key);
      if (parsed) out.push({ key: row.key as string, ...parsed, updatedAt: msOf(row.updated_at) });
    }
    return out;
  };
  // One request in the common case. `count` says whether the server capped the answer (PostgREST
  // returns at most its max-rows); if it did, read it again in key order, page by page, so no row is
  // ever mistaken for missing.
  const first = await supabase.from(TABLE).select('key, updated_at', { count: 'exact' }).eq('user_id', user.id);
  if (first.error) {
    if (isMissingTable(first.error)) available = false;
    return null;
  }
  const firstRows = (first.data || []) as { key?: unknown; updated_at?: unknown }[];
  const total = typeof first.count === 'number' ? first.count : firstRows.length;
  if (total <= firstRows.length) return { userId: user.id, entries: toEntries(firstRows) };

  const entries: ChatSyncManifestEntry[] = [];
  for (let page = 0; page < MANIFEST_MAX_PAGES; page++) {
    const from = page * MANIFEST_PAGE;
    const { data, error } = await supabase
      .from(TABLE)
      .select('key, updated_at')
      .eq('user_id', user.id)
      .order('key', { ascending: true })
      .range(from, from + MANIFEST_PAGE - 1);
    if (error) {
      if (isMissingTable(error)) available = false;
      return null;
    }
    const rows = (data || []) as { key?: unknown; updated_at?: unknown }[];
    entries.push(...toEntries(rows));
    if (rows.length === 0 || from + rows.length >= total) break;
  }
  return { userId: user.id, entries };
};

/**
 * The bodies of just these keys (the signed-in user's own rows only). Null on any error: nothing
 * is pulled, so the caller must not treat the missing rows as gone.
 */
export const pullBodies = async (
  userId: string,
  keys: string[]
): Promise<{ sessions: ChatSession[]; projects: ChatProject[]; updatedAt: Map<string, number> } | null> => {
  const sessions: ChatSession[] = [];
  const projects: ChatProject[] = [];
  const updatedAt = new Map<string, number>();
  if (!available) return null;
  for (let i = 0; i < keys.length; i += BODY_CHUNK) {
    const chunk = keys.slice(i, i + BODY_CHUNK);
    const { data, error } = await supabase
      .from(TABLE)
      .select('key, kind, data, updated_at')
      .eq('user_id', userId)
      .in('key', chunk);
    if (error) {
      if (isMissingTable(error)) available = false;
      return null;
    }
    for (const row of (data || []) as { key?: unknown; kind?: unknown; data?: unknown; updated_at?: unknown }[]) {
      if (!row.data || typeof row.data !== 'object') continue;
      if (typeof row.key === 'string') updatedAt.set(row.key, msOf(row.updated_at));
      if (row.kind === 'session') sessions.push(row.data as ChatSession);
      else if (row.kind === 'project') projects.push(row.data as ChatProject);
    }
  }
  return { sessions, projects, updatedAt };
};

// --- Sync base (per account, per device) -----------------------------------------------------------

const BASE_KEY = 'dreamstream_chat_sync_base';
const baseKeyFor = (userId: string) => `${BASE_KEY}:${userId.toLowerCase()}`;

/** `key → updated_at (ms)` this device last saw agree with its own copy. Empty when unreadable. */
export const readSyncBase = (userId: string): Record<string, number> => {
  try {
    const raw = localStorage.getItem(baseKeyFor(userId));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
};

/** Replace this account's base (best effort: storage may be full or blocked). */
export const writeSyncBase = (userId: string, base: Record<string, number>): void => {
  try {
    localStorage.setItem(baseKeyFor(userId), JSON.stringify(base));
  } catch {
    /* sync falls back to the timestamp rule */
  }
};

const patchSyncBase = (userId: string, key: string, updatedAt: number | null): void => {
  const base = readSyncBase(userId);
  if (updatedAt === null) {
    if (!(key in base)) return;
    delete base[key];
  } else {
    if (base[key] === updatedAt) return;
    base[key] = updatedAt;
  }
  writeSyncBase(userId, base);
};

/**
 * What one sync does with a row both sides have: `same` (nothing), `pull` (take the remote body) or
 * `push` (send the local copy). `base` is the `updated_at` both sides last agreed on (undefined when
 * unknown): a side that still equals it did not change, so the other side's change wins even when
 * its writer's clock was behind. When both changed, or nothing is known, the later timestamp wins.
 */
export const syncDecision = (localAt: number, remoteAt: number, base: number | undefined): 'same' | 'pull' | 'push' => {
  if (localAt === remoteAt) return 'same';
  if (base !== undefined) {
    const localChanged = localAt !== base;
    const remoteChanged = remoteAt !== base;
    if (remoteChanged && !localChanged) return 'pull';
    if (localChanged && !remoteChanged) return 'push';
  }
  return remoteAt > localAt ? 'pull' : 'push';
};

// --- Writes ---------------------------------------------------------------------------------------

/** The account a local row belongs to (chatStorage tags rows on save). */
const ownerOf = (data: unknown): string | null => {
  const owner = data && typeof data === 'object' ? (data as { ownerUserId?: unknown }).ownerUserId : null;
  return typeof owner === 'string' && owner ? owner.toLowerCase() : null;
};

const push = async (kind: 'session' | 'project', id: string, data: unknown, updatedAt?: number): Promise<void> => {
  if (!available) return;
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return;
  if (ownerOf(data) !== user.id.toLowerCase()) return; // another account's row (or untagged): never pushed
  const at = updatedAt || Date.now();
  const { error } = await supabase.from(TABLE).upsert(
    {
      key: keyFor(kind, id),
      user_id: user.id,
      kind,
      data,
      updated_at: new Date(at).toISOString()
    },
    { onConflict: 'key' }
  );
  if (error) {
    if (isMissingTable(error)) available = false;
    return;
  }
  // The cloud now holds exactly this copy: the next sync has nothing to move for this row.
  patchSyncBase(user.id, keyFor(kind, id), at);
};

export const pushSession = (s: ChatSession): Promise<void> => push('session', s.id, s, s.updatedAt);
export const pushProject = (p: ChatProject): Promise<void> => push('project', p.id, p, p.updatedAt);

export const removeRemote = async (kind: 'session' | 'project', id: string): Promise<void> => {
  if (!available) return;
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return;
  const { error } = await supabase.from(TABLE).delete().eq('key', keyFor(kind, id)).eq('user_id', user.id);
  if (error) {
    if (isMissingTable(error)) available = false;
    return;
  }
  patchSyncBase(user.id, keyFor(kind, id), null);
};
