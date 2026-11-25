import type { ComicWorkSummary, FinishedWork, WorkAttention } from '../shared/comic/workspaceActivity';
import { readStageFacts } from '../shared/comic/stage';
import { isStoredSession, supabase } from './supabase';

const PAGE_SIZE = 25;
/** Scalar JSON selectors keep historical documents cheap even when their script is several MB. */
export const WORK_SELECT = [
  'project_id', 'updated_at', 'title:doc->brief->>title', 'activity:doc->workspaceActivity',
  'gate:doc->gate->>status', 'plan:doc->>planStatus', 'draft:doc->directorDraft->>status',
  'publication:doc->publication->>status', 'publishedAt:doc->publication->>publishedAt',
  'lastRole:doc->conversation->-1->>role', 'lastAt:doc->conversation->-1->>at',
  'priorRole:doc->conversation->-2->>role', 'lastCard:doc->conversation->-1->cards->0->>type',
  'runAt:doc->conversation->-1->>runAt', 'listing:projects(rendered:state->>studioRendered)'
].join(',');

export interface ComicActivityRow extends ComicWorkSummary { id: string; title: string; updatedAt?: number }
interface StoredRow {
  project_id: string; updated_at?: string; title?: string; activity?: ComicWorkSummary;
  gate?: string; plan?: string; draft?: string; publication?: string; publishedAt?: string;
  lastRole?: string; lastAt?: string; priorRole?: string; runAt?: string; lastCard?: string;
  listing?: { rendered?: string };
}

export function comicActivityRow(row: StoredRow): ComicActivityRow {
  const updatedAt = Date.parse(row.updated_at ?? '');
  const base = { id: row.project_id, title: row.title?.trim() || 'Untitled comic', ...(Number.isFinite(updatedAt) ? { updatedAt } : {}) };
  if (row.activity?.v === 1 && Array.isArray(row.activity.finished)) {
    // The stored stage is used only when it reads as a whole, consistent stage (stage.ts readStageFacts); a list
    // shows "Open to see" for a comic without one, never a guess.
    const { stage, ...activity } = row.activity;
    const facts = readStageFacts(stage);
    return { ...activity, ...(facts ? { stage: facts } : {}), ...base };
  }
  const finished: FinishedWork[] = [];
  const rendered = Number(row.listing?.rendered);
  // The old listing records the count but no render timestamp. Never use an edit or rename as a new completion.
  if (Number.isSafeInteger(rendered) && rendered > 0) finished.push({ kind: 'pages', count: rendered, at: 0 });
  if (row.publication === 'live' && Number(row.publishedAt) > 0) finished.push({ kind: 'published', at: Number(row.publishedAt) });
  if (row.lastRole === 'assistant' && row.priorRole && !row.lastCard && !row.runAt && Number(row.lastAt) > 0) finished.push({ kind: 'reply', at: Number(row.lastAt) });
  let attention: WorkAttention | null = null;
  if (row.gate === 'open') attention = 'approval';
  else if (row.draft === 'interrupted') attention = 'interrupted';
  else if (row.plan === 'draft' && (row.lastCard === 'plan' || row.lastCard === 'breakdown' || row.draft === 'review')) attention = 'plan';
  return { ...base, v: 1, attention, working: row.draft === 'planning', finished };
}

export async function loadComicActivity(accountId: string, offset: number, signal: AbortSignal) {
  const { data: { session } } = await supabase.auth.getSession();
  if (signal.aborted || session?.user.id !== accountId || !isStoredSession(session)) throw new Error('Account changed');
  const { data, error } = await supabase.from('comic_docs').select(WORK_SELECT)
    .eq('user_id', accountId).order('updated_at', { ascending: false }).order('project_id')
    .range(offset, offset + PAGE_SIZE).abortSignal(signal);
  if (error || !data || signal.aborted) throw new Error('Comic activity unavailable');
  const rows = data as unknown as StoredRow[];
  return { rows: rows.slice(0, PAGE_SIZE).map(comicActivityRow), hasMore: rows.length > PAGE_SIZE, next: offset + PAGE_SIZE };
}
