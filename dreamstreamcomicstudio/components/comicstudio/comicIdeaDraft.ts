import { useEffect, useRef, useState } from 'react';

const PREFIX = 'comicstudio.new-idea.';
let activeAccount: string | null | undefined;
type Draft = { name: string; idea: string };
const empty = (): Draft => ({ name: '', idea: '' });
const read = (accountId?: string): Draft => {
  try {
    const value = accountId ? JSON.parse(sessionStorage.getItem(PREFIX + accountId) || 'null') : null;
    return { name: typeof value?.name === 'string' ? value.name.slice(0, 200) : '', idea: typeof value?.idea === 'string' ? value.idea.slice(0, 200000) : '' };
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
  return { ...draft, setName: (name: string) => change({ name }), setIdea: (idea: string) => change({ idea }), clear: () => { change(empty()); flush(); } };
}
