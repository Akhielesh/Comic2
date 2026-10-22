// Reader deep links (contract §1 "Reader URL params"): `p` (1-based page; 0 = cover), `lang`, `guided=1`,
// `panel` (1-based). Read once on open; written back with history.replaceState (debounced) when the
// reader settles, preserving every other parameter. `page=` / `mode=` are rejected aliases and are
// neither read nor written.

export interface ReaderParams {
  p?: number;
  lang?: string;
  guided?: boolean;
  panel?: number;
}

const LANG_RE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/;

const intParam = (v: string | null, min: number): number | undefined => {
  if (v === null || !/^\d{1,4}$/.test(v.trim())) return undefined;
  const n = Number(v.trim());
  return n >= min ? n : undefined;
};

/** Parse reader params from a query string (`?a=1&p=3` or `a=1&p=3`). Invalid values are ignored. */
export const parseReaderParams = (search: string): ReaderParams => {
  let q: URLSearchParams;
  try {
    q = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  } catch {
    return {};
  }
  const out: ReaderParams = {};
  const p = intParam(q.get('p'), 0);
  if (p !== undefined) out.p = p;
  const lang = q.get('lang');
  if (lang && LANG_RE.test(lang)) out.lang = lang;
  const guided = q.get('guided');
  if (guided === '1' || guided === 'true') out.guided = true;
  const panel = intParam(q.get('panel'), 1);
  if (panel !== undefined) out.panel = panel;
  return out;
};

/** `href` with the reader params set (absent → removed); everything else is preserved. */
export const withReaderParams = (href: string, params: ReaderParams): string => {
  let url: URL;
  try {
    url = new URL(href, 'http://local.invalid');
  } catch {
    return href;
  }
  const q = url.searchParams;
  const set = (k: string, v: string | undefined) => (v === undefined ? q.delete(k) : q.set(k, v));
  set('p', params.p !== undefined && params.p >= 0 ? String(Math.round(params.p)) : undefined);
  set('lang', params.lang && LANG_RE.test(params.lang) ? params.lang : undefined);
  set('guided', params.guided ? '1' : undefined);
  set('panel', params.guided && params.panel !== undefined && params.panel >= 1 ? String(Math.round(params.panel)) : undefined);
  const out = `${url.pathname}${q.toString() ? `?${q.toString()}` : ''}${url.hash}`;
  return url.origin === 'http://local.invalid' && !/^https?:/i.test(href) ? out : `${url.origin}${out}`;
};

/** Debounced replaceState writer (300 ms). Never pushes history entries. */
export const createUrlSync = (debounceMs = 300) => {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let next: ReaderParams | null = null;
  /** The last position scheduled (re-applied after the reader's own history entry is popped). */
  let last: ReaderParams | null = null;
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (!next || typeof window === 'undefined') return;
    try {
      const target = withReaderParams(window.location.href, next);
      const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
      const path = target.replace(/^https?:\/\/[^/]+/i, '');
      if (path !== current) window.history.replaceState(window.history.state, '', path);
    } catch {
      /* sandboxed iframe — the link just doesn't update */
    }
    next = null;
  };
  return {
    schedule(params: ReaderParams) {
      next = params;
      last = params;
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, debounceMs);
    },
    flush,
    /** Write the last scheduled position again, now (e.g. onto the entry under a popped reader entry). */
    reapply() {
      if (!last) return;
      next = last;
      flush();
    },
    cancel() {
      if (timer) clearTimeout(timer);
      timer = null;
      next = null;
    }
  };
};
