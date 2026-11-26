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

/**
 * My comics' one read for every card's stage and "Needs you" (never a full doc, never one request per card): the saved
 * summary, plus the three scalars comicActivityRow reads "Needs you" from in a doc saved before summaries existed.
 */
export const STAGE_SELECT = [
  'project_id', 'activity:doc->workspaceActivity',
  'gate:doc->gate->>status', 'plan:doc->>planStatus', 'draft:doc->directorDraft->>status', 'lastCard:doc->conversation->-1->cards->0->>type'
].join(',');
export const STAGE_PAGE_SIZE = 200;

/** What a card reads from the summary: its validated stage (absent before stages) and what waits on the person. */
export type ComicStageRow = Pick<ComicActivityRow, 'id' | 'stage' | 'attention' | 'working'>;

/** Every comic's stage row by project id, newest first, paged until the owner's comics run out. */
export async function loadComicStages(accountId: string, signal: AbortSignal): Promise<Map<string, ComicStageRow>> {
  const { data: { session } } = await supabase.auth.getSession();
  if (signal.aborted || session?.user.id !== accountId || !isStoredSession(session)) throw new Error('Account changed');
  const out = new Map<string, ComicStageRow>();
  for (let offset = 0; ; offset += STAGE_PAGE_SIZE) {
    const { data, error } = await supabase.from('comic_docs').select(STAGE_SELECT)
      .eq('user_id', accountId).order('updated_at', { ascending: false }).order('project_id')
      .range(offset, offset + STAGE_PAGE_SIZE - 1).abortSignal(signal);
    if (error || !Array.isArray(data) || signal.aborted) throw new Error('Comic stages unavailable');
    for (const raw of data as unknown as StoredRow[]) {
      if (!raw?.project_id) continue;
      const { id, stage, attention, working } = comicActivityRow(raw);
      out.set(id, { id, ...(stage ? { stage } : {}), attention, working });
    }
    if (data.length < STAGE_PAGE_SIZE) return out;
  }
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
