// Per-build chat history (one chat per build/project).
//
// Persists each project's Code Studio conversation thread keyed by projectId so reopening a build
// restores its chat. Device-local (localStorage) for now — cheap and instant; a DB-synced version
// can layer on later. Bounded so it never grows without limit.

import type { StudioMessage } from '../components/studio/workspace/conversationStore';

const STORAGE = 'dreamstream_studio_chat_v1';
const MAX_PROJECTS = 40; // keep the most recently-touched projects' chats
const MAX_MESSAGES = 200; // per project

type ChatMap = Record<string, { messages: StudioMessage[]; at: number }>;

const read = (): ChatMap => {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(STORAGE);
    return raw ? (JSON.parse(raw) as ChatMap) : {};
  } catch {
    return {};
  }
};

const write = (map: ChatMap) => {
  if (typeof window === 'undefined') return;
  try {
    // Evict the oldest projects beyond the cap.
    const entries = Object.entries(map).sort((a, b) => (b[1].at || 0) - (a[1].at || 0));
    const trimmed: ChatMap = {};
    for (const [id, v] of entries.slice(0, MAX_PROJECTS)) trimmed[id] = v;
    window.localStorage.setItem(STORAGE, JSON.stringify(trimmed));
  } catch {
    /* ignore quota / serialization errors */
  }
};

/** Save (or update) a project's chat thread. No-op without a projectId. */
export const saveStudioChat = (projectId: string | null | undefined, messages: StudioMessage[]): void => {
  if (!projectId) return;
  const map = read();
  map[projectId] = { messages: messages.slice(-MAX_MESSAGES), at: Date.now() };
  write(map);
};

/** Load a project's saved chat thread, or null when there is none. */
export const loadStudioChat = (projectId: string | null | undefined): StudioMessage[] | null => {
  if (!projectId) return null;
  const entry = read()[projectId];
  return entry && Array.isArray(entry.messages) ? entry.messages : null;
};

/** Forget a project's chat (e.g. when the project is deleted). */
export const deleteStudioChat = (projectId: string | null | undefined): void => {
  if (!projectId) return;
  const map = read();
  if (map[projectId]) {
    delete map[projectId];
    write(map);
  }
};
