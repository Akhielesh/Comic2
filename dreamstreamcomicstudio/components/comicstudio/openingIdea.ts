import { seedComposerDraft } from '../../services/composerDrafts';

export interface OpeningIdea { id: string; text: string }
const PREFIX = 'comicstudio.opening.v1.';
const memory = new Map<string, OpeningIdea & { attempted: boolean }>();
const keyOf = (accountId: string, projectId: string) => PREFIX + JSON.stringify([accountId, projectId]);
export function prepareOpeningIdea(accountId: string, projectId: string, idea: OpeningIdea) {
  const key = keyOf(accountId, projectId);
  const record = { ...idea, attempted: false };
  memory.set(key, record);
  try { sessionStorage.setItem(key, JSON.stringify(record)); } catch { /* session memory remains */ }
  seedComposerDraft({ accountId, surface: 'director', conversationId: projectId }, idea.text);
}
export function readOpeningIdea(accountId?: string, projectId?: string): OpeningIdea | undefined {
  if (!accountId || !projectId) return;
  const key = keyOf(accountId, projectId);
  try {
    const value = memory.get(key) ?? JSON.parse(sessionStorage.getItem(key) || 'null');
    if (value && typeof value.id === 'string' && typeof value.text === 'string' && !value.attempted) return value;
  } catch { /* no stored handoff */ }
}
/** Claim before the first request, including StrictMode and remounts. An uncertain request is never replayed. */
export function claimOpeningIdea(accountId: string, projectId: string, idea: OpeningIdea): boolean {
  const key = keyOf(accountId, projectId);
  let prior = memory.get(key);
  try { prior ??= JSON.parse(sessionStorage.getItem(key) || 'null'); } catch { /* memory only */ }
  if (prior?.id === idea.id && prior.attempted) return false;
  const record = { ...idea, attempted: true };
  memory.set(key, record);
  try { sessionStorage.setItem(key, JSON.stringify(record)); } catch { /* memory still prevents replay */ }
  return true;
}
export function clearOtherOpeningIdeas(accountId: string | null) {
  const keep = (key: string) => { try { return JSON.parse(key.slice(PREFIX.length))[0] === accountId; } catch { return false; } };
  for (const key of memory.keys()) if (!keep(key)) memory.delete(key);
  try { for (let i = sessionStorage.length - 1; i >= 0; i--) { const key = sessionStorage.key(i); if (key?.startsWith(PREFIX) && !keep(key)) sessionStorage.removeItem(key); } } catch { /* unavailable */ }
}
