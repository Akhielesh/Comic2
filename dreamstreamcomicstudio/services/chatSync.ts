// Optional Supabase-backed sync for chat sessions + projects.
//
// Table-optional + graceful: if the `chat_sync` table doesn't exist (migration not
// applied) or the user is signed out, every call is a safe no-op and the chat keeps
// working from local IndexedDB. Once the table exists, sessions/projects follow the
// user across devices (last-write-wins by updatedAt).

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

export const pullAll = async (): Promise<{ sessions: ChatSession[]; projects: ChatProject[] } | null> => {
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
  return { sessions, projects };
};

const push = async (kind: 'session' | 'project', id: string, data: unknown, updatedAt?: number): Promise<void> => {
  if (!available) return;
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return;
  const { error } = await supabase.from(TABLE).upsert(
    {
      key: keyFor(kind, id),
      user_id: user.id,
      kind,
      data,
      updated_at: new Date(updatedAt || Date.now()).toISOString()
    },
    { onConflict: 'key' }
  );
  if (error && isMissingTable(error)) available = false;
};

export const pushSession = (s: ChatSession): Promise<void> => push('session', s.id, s, s.updatedAt);
export const pushProject = (p: ChatProject): Promise<void> => push('project', p.id, p, p.updatedAt);

export const removeRemote = async (kind: 'session' | 'project', id: string): Promise<void> => {
  if (!available) return;
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return;
  const { error } = await supabase.from(TABLE).delete().eq('key', keyFor(kind, id)).eq('user_id', user.id);
  if (error && isMissingTable(error)) available = false;
};
