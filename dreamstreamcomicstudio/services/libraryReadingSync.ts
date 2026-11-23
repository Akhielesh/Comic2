import { SLUG_RE } from '../shared/comic/publication';
import { READ_PAGE_MAX } from '../shared/comic/reading';
import type { LibraryRead } from './libraryDiscovery';

export type ReadingSettingAction = 'get' | 'enable' | 'clear' | 'disable';
export interface SyncedReadingState {
  enabled: boolean;
  epoch: string | null;
  reads: (LibraryRead & { revision: number })[];
}

async function request(owner: string, action: ReadingSettingAction | 'save', args: Record<string, unknown> = {}) {
  // The RPC compares p_owner to auth.uid() again at the database so an auth change in flight fails closed.
  const { supabase } = await import('./supabase');
  const { data, error } = await supabase.rpc('comic_reader_library', {
    p_owner: owner,
    p_action: action,
    ...args
  });
  if (error) throw new Error('Could not reach your reading settings.');
  return data;
}

export async function readingSettings(
  owner: string,
  action: ReadingSettingAction = 'get',
  epoch: string | null = null
): Promise<SyncedReadingState> {
  const result = await request(owner, action, { p_epoch: epoch });
  if (
    !result ||
    typeof result.enabled !== 'boolean' ||
    !Array.isArray(result.reads) ||
    !(typeof result.epoch === 'string' || (result.epoch === null && !result.enabled))
  ) {
    throw new Error('Could not load your reading settings.');
  }
  const reads: SyncedReadingState['reads'] = [];
  for (const row of result.reads.slice(0, 24)) {
    if (
      result.enabled &&
      row &&
      typeof row.slug === 'string' &&
      SLUG_RE.test(row.slug) &&
      Number.isSafeInteger(row.page) &&
      Number.isSafeInteger(row.lastPage) &&
      row.page > 0 &&
      row.page <= row.lastPage &&
      row.lastPage <= READ_PAGE_MAX &&
      Number.isSafeInteger(row.revision) &&
      row.revision > 0 &&
      Number.isSafeInteger(row.at) &&
      row.at > 0
    ) {
      reads.push({ slug: row.slug, page: row.page, lastPage: row.lastPage, revision: row.revision, at: row.at });
    }
  }
  return { enabled: result.enabled, epoch: result.epoch, reads };
}

/** Each open reader stays bound to its initial consent epoch and per-book revision. Another tab's clear, opt-out
 * or newer position wins. No offline queue is kept and a newly mounted reader takes a fresh snapshot. */
export function createReadingRecorder(owner: string, slug: string) {
  let state: SyncedReadingState | undefined;
  let revision = 0;
  let savedPage = 0;
  let stopped = false;
  let working = false;
  let pending: { page: number; lastPage: number } | undefined;

  async function record(page: number, lastPage: number) {
    if (
      stopped ||
      !SLUG_RE.test(slug) ||
      !Number.isInteger(page) ||
      !Number.isInteger(lastPage) ||
      page < 1 ||
      page > lastPage ||
      lastPage > READ_PAGE_MAX
    )
      return;
    pending = { page, lastPage };
    if (working) return;
    working = true;
    try {
      if (!state) {
        state = await readingSettings(owner);
        if (!state.enabled || !state.epoch) {
          stopped = true;
          return;
        }
        const existing = state.reads.find((read) => read.slug === slug);
        revision = existing?.revision ?? 0;
        savedPage = existing?.page ?? 0;
      }
      while (!stopped && pending) {
        const next = pending;
        pending = undefined;
        if (next.page === savedPage) continue;
        const reply = await request(owner, 'save', {
          p_epoch: state.epoch,
          p_slug: slug,
          p_page: next.page,
          p_last_page: next.lastPage,
          p_revision: revision
        });
        if (
          !reply?.saved ||
          !Number.isSafeInteger(reply.revision) ||
          reply.revision < revision ||
          reply.revision < 1
        ) {
          stopped = true;
          return;
        }
        revision = reply.revision;
        savedPage = next.page;
      }
    } catch {
      // The next actual page turn may retry. A lost response still cannot overwrite another reader's position.
    } finally {
      pending = undefined;
      working = false;
    }
  }
  return {
    record,
    close() {
      stopped = true;
      pending = undefined;
    }
  };
}
