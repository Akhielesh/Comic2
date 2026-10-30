// Reader URL entries (?view=read&id=<id>) for the classic and v4 readers.
//
// Opening a comic adds one history entry for it, except when the URL already is that comic's reader URL (a shared
// link opened cold): then the entry is rewritten, so there is never a duplicate ?view=read entry behind the reader.
// Closing rewrites the reader's entry instead of pushing a new one, so the next Back never lands on a URL that says
// "read" (and that a reload would reopen) while the reader is closed.

type HistoryLike = Pick<History, 'pushState' | 'replaceState' | 'state'>;

export function setReaderUrlParams(id: string, loc: Pick<Location, 'href'> = window.location, history: HistoryLike = window.history): void {
  const url = new URL(loc.href);
  const already = url.searchParams.get('view') === 'read' && url.searchParams.get('id') === id;
  url.searchParams.set('view', 'read');
  url.searchParams.set('id', id);
  url.searchParams.delete('board');
  if (already) history.replaceState(history.state, '', url);
  else history.pushState({}, '', url);
}

export function clearReaderUrlParams(opts?: { replace?: boolean }, loc: Pick<Location, 'href'> = window.location, history: HistoryLike = window.history): void {
  const url = new URL(loc.href);
  url.searchParams.delete('view');
  url.searchParams.delete('id');
  if (opts?.replace) history.replaceState({}, '', url);
  else history.pushState({}, '', url);
}

/**
 * The comic id of a shared reader link (?view=read&id=<id>) in `search`, else null. App reads it once at startup:
 * until the reader deep-link effect (which waits for auth) has opened that link, nothing may rewrite the URL —
 * otherwise a cold shared link loses its ?view=read&id before it is read and the visitor lands on the home page.
 */
export function readerDeepLinkId(search: string): string | null {
  const params = new URLSearchParams(search);
  const id = params.get('id');
  return params.get('view') === 'read' && id ? id : null;
}
