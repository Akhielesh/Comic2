import { useEffect, useRef, useState } from 'react';

const PREFIX = 'comicstudio.new-idea.';
let activeAccount: string | null | undefined;
type Draft = { name: string; idea: string; creationId?: string };
const empty = (): Draft => ({ name: '', idea: '' });
const read = (accountId?: string): Draft => {
  try {
    const value = accountId ? JSON.parse(sessionStorage.getItem(PREFIX + accountId) || 'null') : null;
    const creationId = typeof value?.creationId === 'string' && /^[a-f0-9-]{36}$/i.test(value.creationId) ? value.creationId : undefined;
    return { creationId, name: typeof value?.name === 'string' ? value.name.slice(0, 200) : '', idea: typeof value?.idea === 'string' ? value.idea.slice(0, 200000) : '' };
  } catch { return empty(); }
};

/** Keep only the current identity's local idea. Never write story text to the URL or localStorage. */
export function clearOtherComicIdeaDrafts(accountId: string | null) {
  activeAccount = accountId;
  try {
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const key = sessionStorage.key(i);
      if (key?.startsWith(PREFIX) && key !== (accountId ? PREFIX + accountId : null)) sessionStorage.removeItem(key);
    }
  } catch { /* Storage can be disabled. The in-memory draft still works. */ }
}

/** Flush on leaving, backgrounding or reload; a large pasted script never serializes per keystroke. */
export function useComicIdeaDraft(accountId?: string) {
  const [draft, setDraft] = useState(() => read(accountId));
  const latest = useRef(draft);
  const change = (patch: Partial<Draft>) => {
    latest.current = { ...latest.current, ...patch };
    setDraft(latest.current);
  };
  const flush = () => {
    if (!accountId || (activeAccount !== undefined && activeAccount !== accountId)) return;
    try {
      if (latest.current.name || latest.current.idea) sessionStorage.setItem(PREFIX + accountId, JSON.stringify(latest.current));
      else sessionStorage.removeItem(PREFIX + accountId);
    } catch { /* Keep editing if browser storage is full or unavailable. */ }
  };
  useEffect(() => {
    const hidden = () => { if (document.visibilityState === 'hidden') flush(); };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      flush();
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', hidden);
    };
  }, [accountId]);
  // Keep the same project id when the server saved a request but the browser lost its response.
  const directorCreationId = (): string => {
    if (latest.current.creationId) return latest.current.creationId;
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    const creationId = [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
    change({ creationId });
    flush();
    return creationId;
  };
  return { ...draft, directorCreationId, setName: (name: string) => change({ name, creationId: undefined }), setIdea: (idea: string) => change({ idea, creationId: undefined }), clear: () => { change({ ...empty(), creationId: undefined }); flush(); } };
}
