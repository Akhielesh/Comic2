// Chat work that outlives one mounted chat view (CHAT-0, nav V.3-d).
//
// Chat Studio unmounts on every view switch (App.tsx keeps one heavy surface mounted). A reply that
// is still streaming keeps running in the background and must land in IndexedDB, and a chat view
// mounted again meanwhile must (a) know the chat is still busy, so its composer shows Stop instead
// of letting a second send race the first, and (b) see the reply arrive, so its next edit does not
// save a stale copy over it. Component state cannot do either: it dies with the view.
//
// This module is that shared memory, scoped to the page (never persisted, never sent anywhere):
//  - which chats are generating, with the AbortController that stops each one;
//  - the newest in-memory copy of every chat written recently ("hot" sessions), so whichever view is
//    mounted — or none — reads and writes the same copy. Every write in AIChatPlatform goes through
//    here and then to IndexedDB, outside any React updater;
//  - which artifact writes (a calendar Confirm) are in flight, so a remounted card shows "Adding…"
//    instead of offering the write again.
// Subscribers (useSyncExternalStore) are told about every change. Nothing here touches the network
// or a timer.

import type { ChatSession } from './chatStorage';

type Listener = () => void;

/** How many idle (not generating) chats stay hot. Generating chats are always kept. */
export const HOT_SESSION_LIMIT = 8;

const controllers = new Map<string, AbortController>();
/** Insertion order = recency (oldest first). */
const hot = new Map<string, ChatSession>();
const artifactWrites = new Set<string>();
const listeners = new Set<Listener>();

let version = 0;
let streamingSnapshot: ReadonlySet<string> = new Set();

const emit = () => {
  version += 1;
  for (const fn of Array.from(listeners)) {
    try {
      fn();
    } catch {
      /* a listener never breaks a write */
    }
  }
};

const refreshStreaming = () => {
  streamingSnapshot = new Set(controllers.keys());
};

/** Subscribe to every change (busy set, hot sessions, artifact writes). Returns the unsubscribe. */
export const subscribeChatStreams = (fn: Listener): (() => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};

/** A number that changes with every change (a cheap useSyncExternalStore snapshot). */
export const getChatStreamsVersion = (): number => version;

// --- Generating chats ----------------------------------------------------------------------------

/** A generation started for this chat. */
export const beginStream = (sessionId: string, controller: AbortController): void => {
  controllers.set(sessionId, controller);
  refreshStreaming();
  emit();
};

/** The generation driven by `controller` ended (a newer one for the same chat is left alone). */
export const endStream = (sessionId: string, controller: AbortController): void => {
  if (controllers.get(sessionId) !== controller) return;
  controllers.delete(sessionId);
  refreshStreaming();
  trimHot();
  emit();
};

/** True while a reply for this chat is being generated, whichever view started it. */
export const isStreaming = (sessionId: string): boolean => controllers.has(sessionId);

/** The ids of every chat generating now. The same Set until something changes (snapshot-safe). */
export const streamingIds = (): ReadonlySet<string> => streamingSnapshot;

/** Stop this chat's generation (Stop, or the chat was deleted). */
export const abortStream = (sessionId: string): void => {
  const controller = controllers.get(sessionId);
  if (!controller) return;
  controllers.delete(sessionId);
  refreshStreaming();
  try {
    controller.abort();
  } catch {
    /* already aborted */
  }
  emit();
};

// --- Hot sessions --------------------------------------------------------------------------------

const trimHot = () => {
  let idle = 0;
  for (const id of hot.keys()) if (!controllers.has(id)) idle += 1;
  if (idle <= HOT_SESSION_LIMIT) return;
  for (const id of Array.from(hot.keys())) {
    if (idle <= HOT_SESSION_LIMIT) break;
    if (controllers.has(id)) continue;
    hot.delete(id);
    idle -= 1;
  }
};

/** The newest in-memory copy of a chat written this page session, if it is still kept. */
export const getHotSession = (id: string): ChatSession | undefined => hot.get(id);

/** Every kept chat copy (oldest write first). */
export const hotSessions = (): ChatSession[] => Array.from(hot.values());

/**
 * Record the newest copy of a chat and tell every subscriber. `notify: false` records it silently
 * (a view mirroring a change it already shows).
 */
export const putHotSession = (session: ChatSession, opts: { notify?: boolean } = {}): void => {
  const prev = hot.get(session.id);
  if (prev === session && opts.notify === false) return;
  hot.delete(session.id); // re-insert: most recent last
  hot.set(session.id, session);
  trimHot();
  if (opts.notify !== false && prev !== session) emit();
};

/** Forget a chat (it was deleted): no view may bring it back from here. */
export const dropHotSession = (id: string): void => {
  if (!hot.delete(id)) return;
  emit();
};

// --- In-flight artifact writes (calendar Confirm / Add all) --------------------------------------

/** The key of one artifact on one turn: `${sessionId}:${turnId}:${artifactKey}`. */
export const artifactWriteKey = (sessionId: string, turnId: string, artifactKey: string): string =>
  `${sessionId}:${turnId}:${artifactKey}`;

export const beginArtifactWrite = (key: string): void => {
  if (artifactWrites.has(key)) return;
  artifactWrites.add(key);
  emit();
};

export const endArtifactWrite = (key: string): void => {
  if (!artifactWrites.delete(key)) return;
  emit();
};

export const isArtifactWriteInFlight = (key: string): boolean => artifactWrites.has(key);

/** Test-only: forget everything (module state outlives a test file's renders). */
export const __resetChatStreamsForTests = (): void => {
  controllers.clear();
  hot.clear();
  artifactWrites.clear();
  listeners.clear();
  refreshStreaming();
  version = 0;
};
