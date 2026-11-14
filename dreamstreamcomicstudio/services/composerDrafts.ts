import { createContext, useCallback, useEffect, useRef, useSyncExternalStore } from 'react';

// Private, tab-local drafts survive route unmounts and reloads, but are never synced or put in URLs.
const PREFIX = 'ds.composer-draft.v1.';
export const ComposerDraftAccountContext = createContext<string | undefined>(undefined);
export interface DraftScope { accountId: string; surface: string; conversationId: string }
export interface DraftSnapshot { text: string; revision: number }
const entries = new Map<string, DraftSnapshot>();
const listeners = new Map<string, Set<() => void>>();
let activeAccount: string | null | undefined;
let localSequence = 0;
const keyOf = (scope: DraftScope) => PREFIX + JSON.stringify([scope.accountId, scope.surface, scope.conversationId]);
const empty = (): DraftSnapshot => ({ text: '', revision: 0 });
const read = (key: string): DraftSnapshot => {
  const cached = entries.get(key);
  if (cached) return cached;
  let value = empty();
  try {
    const stored = key.startsWith(PREFIX) ? JSON.parse(sessionStorage.getItem(key) || 'null') : null;
    if (typeof stored?.text === 'string') value = { text: stored.text.slice(0, 1000000), revision: Number.isSafeInteger(stored.revision) ? stored.revision : 0 };
  } catch { /* Storage may be unavailable. In-memory continuity still works. */ }
  entries.set(key, value);
  return value;
};
const allowed = (key: string) => !key.startsWith(PREFIX) || activeAccount === undefined || JSON.parse(key.slice(PREFIX.length))[0] === activeAccount;
const write = (key: string, text: string) => {
  if (!allowed(key)) return;
  const next = { text: text.slice(0, 1000000), revision: read(key).revision + 1 };
  entries.set(key, next);
  try {
    if (key.startsWith(PREFIX)) {
      if (next.text) sessionStorage.setItem(key, JSON.stringify(next));
      else sessionStorage.removeItem(key);
    }
  } catch { /* A full/private browser must never stop editing. */ }
  listeners.get(key)?.forEach((notify) => notify());
};

/** An old account's async completion can never repopulate its drafts after sign-out. */
export function setComposerDraftAccount(accountId: string | null) {
  activeAccount = accountId;
  const keep = (key: string) => {
    try { return JSON.parse(key.slice(PREFIX.length))[0] === accountId; } catch { return false; }
  };
  for (const key of entries.keys()) if (key.startsWith(PREFIX) && !keep(key)) {
    entries.set(key, { text: '', revision: read(key).revision + 1 });
    listeners.get(key)?.forEach((notify) => notify());
  }
  try {
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const key = sessionStorage.key(i);
      if (key?.startsWith(PREFIX) && !keep(key)) sessionStorage.removeItem(key);
    }
  } catch { /* unavailable */ }
}

export function seedComposerDraft(scope: DraftScope, text: string) {
  const key = keyOf(scope);
  if (!read(key).text) write(key, text);
}

/** Share a draft between dock/sheet; read the new scope synchronously when an identity changes. */
export function useComposerDraft(scope?: DraftScope) {
  const local = useRef(`local:${++localSequence}`);
  const key = scope ? keyOf(scope) : local.current;
  const subscribe = useCallback((notify: () => void) => {
    const set = listeners.get(key) ?? new Set();
    set.add(notify); listeners.set(key, set);
    return () => { set.delete(notify); if (!set.size) listeners.delete(key); };
  }, [key]);
  const snapshot = useSyncExternalStore(subscribe, useCallback(() => read(key), [key]), useCallback(() => read(key), [key]));
  const setText = useCallback((value: string | ((previous: string) => string)) => write(key, typeof value === 'function' ? value(read(key).text) : value), [key]);
  const capture = useCallback(() => read(key), [key]);
  // Revision rather than string equality protects an edit-away-and-back while a send is in flight.
  const clearIfCurrent = useCallback((sent: DraftSnapshot) => { if (read(key).revision === sent.revision) write(key, ''); }, [key]);
  const replaceIfCurrent = useCallback((previous: DraftSnapshot, text: string) => {
    if (read(key).revision !== previous.revision || !allowed(key)) return false;
    write(key, text); return true;
  }, [key]);
  useEffect(() => () => { if (!scope) queueMicrotask(() => { if (!listeners.has(key)) entries.delete(key); }); }, [key, !!scope]);
  return { text: snapshot.text, setText, capture, clearIfCurrent, replaceIfCurrent };
}
