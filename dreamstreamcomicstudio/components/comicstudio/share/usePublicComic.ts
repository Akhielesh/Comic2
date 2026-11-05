// Public reader data for /c/<slug> (sharing.md §7.2): the inline boot card for an instant first
// paint, the frozen snapshot from the edge, and fire-and-forget analytics. Consumed by the public
// reader (P2-READER-PUBLIC). Read-only: only GETs the snapshot and posts anonymous events.
//
// States: loading → ready | not_found (unknown, revoked, unpublished and suspended look identical:
// "This link isn't active") | error (network; "Couldn't open — Try again").

import { useCallback, useEffect, useRef, useState } from 'react';
import { parseShareParams, SHARE_PATH, SLUG_RE, type PublicComicPayload, type ShareChannel } from '../../../shared/comic/publication';
import { loadPublicComicBySlug, trackPublicEvent, type PublicEventType } from '../studioApi';

export interface ShareBoot {
  slug: string;
  lang?: string;
  page?: number;
  embed?: boolean;
  visibility?: 'unlisted' | 'public';
  languages?: string[];
  allowDownload?: boolean;
  card: { title: string; description?: string; coverUrl?: string; aspect?: string; pageCount?: number; kindLabel?: string; themeColor?: string; creator?: string };
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : undefined);

/** The server-injected boot card (#ds-share-boot), shape-checked; null when absent or for another slug. */
export function readShareBoot(slug?: string, root: Document | undefined = typeof document === 'undefined' ? undefined : document): ShareBoot | null {
  const el = root?.getElementById('ds-share-boot');
  if (!el?.textContent) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(el.textContent);
  } catch {
    return null;
  }
  if (!isRecord(raw) || typeof raw.slug !== 'string' || !SLUG_RE.test(raw.slug) || (slug && raw.slug !== slug) || !isRecord(raw.card)) return null;
  const c = raw.card;
  const coverUrl = str(c.coverUrl, 600);
  return {
    slug: raw.slug,
    ...(str(raw.lang, 35) ? { lang: str(raw.lang, 35) } : {}),
    ...(typeof raw.page === 'number' && Number.isInteger(raw.page) && raw.page >= 0 && raw.page <= 500 ? { page: raw.page } : {}),
    ...(raw.embed === true ? { embed: true } : {}),
    ...(raw.visibility === 'public' || raw.visibility === 'unlisted' ? { visibility: raw.visibility } : {}),
    ...(Array.isArray(raw.languages) ? { languages: raw.languages.filter((l): l is string => typeof l === 'string').slice(0, 12) } : {}),
    ...(typeof raw.allowDownload === 'boolean' ? { allowDownload: raw.allowDownload } : {}),
    card: {
      title: str(c.title, 120) || 'Comic',
      ...(str(c.description, 240) ? { description: str(c.description, 240) } : {}),
      ...(coverUrl && /^https:\/\//.test(coverUrl) ? { coverUrl } : {}),
      ...(str(c.aspect, 8) ? { aspect: str(c.aspect, 8) } : {}),
      ...(typeof c.pageCount === 'number' ? { pageCount: c.pageCount } : {}),
      ...(str(c.kindLabel, 40) ? { kindLabel: str(c.kindLabel, 40) } : {}),
      ...(typeof c.themeColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(c.themeColor) ? { themeColor: c.themeColor } : {}),
      ...(str(c.creator, 40) ? { creator: str(c.creator, 40) } : {})
    }
  };
}

/**
 * The Pages Function's dead-link boot (`{"notFound":true}`, functions/_shared/shareHead.ts notFoundHead): it
 * serves it for unknown, revoked, unpublished and suspended links, and for /embed when the author turned
 * embedding off. Honoured only when this document was served for the slug's own address, so a boot
 * left in the page can never kill another comic's reader; the API is not asked at all.
 */
export function readShareBootNotFound(
  slug: string,
  root: Document | undefined = typeof document === 'undefined' ? undefined : document,
  path: string = typeof window === 'undefined' ? '' : window.location.pathname
): boolean {
  const el = root?.getElementById('ds-share-boot');
  if (!el?.textContent || !SLUG_RE.test(slug)) return false;
  let raw: unknown;
  try {
    raw = JSON.parse(el.textContent);
  } catch {
    return false;
  }
  const own = SHARE_PATH(slug);
  return isRecord(raw) && raw.notFound === true && (path === own || path.startsWith(`${own}/`));
}

/**
 * The share channel this page was opened from (`?via=<channel>`, sharing.md: analytics only), read once
 * per page load and allow-listed to SHARE_CHANNELS — the same set the edge accepts. Anything else
 * (`via=webdriver`, a typo) counts as direct.
 */
export function readShareVia(search: string = typeof window === 'undefined' ? '' : window.location.search): ShareChannel | undefined {
  return parseShareParams(search).via;
}

/** Drops `via` from the address bar, so a reader who re-shares the bar URL does not pass the channel on. */
function stripViaFromAddress(): void {
  if (typeof window === 'undefined') return;
  try {
    const url = new URL(window.location.href);
    if (!url.searchParams.has('via')) return;
    url.searchParams.delete('via');
    window.history.replaceState(window.history.state, '', url.toString());
  } catch {
    /* sandboxed frames may refuse replaceState */
  }
}

export type PublicComicStatus = 'loading' | 'ready' | 'not_found' | 'error';

export interface UsePublicComic {
  status: PublicComicStatus;
  boot: ShareBoot | null;
  data: PublicComicPayload | null;
  error: string | null;
  retry(): void;
  /** view (once per mount; channel from `?via=` unless given), complete (once), share (every time). Never for the owner. */
  track(type: PublicEventType, channel?: ShareChannel, lang?: string): void;
}

export function usePublicComic(slug: string, opts: { isOwner?: boolean } = {}): UsePublicComic {
  const [boot] = useState(() => readShareBoot(slug));
  const [dead] = useState(() => readShareBootNotFound(slug));
  const [via] = useState(() => readShareVia());
  const [state, setState] = useState<{ status: PublicComicStatus; data: PublicComicPayload | null; error: string | null }>({ status: dead ? 'not_found' : 'loading', data: null, error: null });
  const [attempt, setAttempt] = useState(0);
  const sent = useRef(new Set<string>());

  // The channel is kept in state; the address bar loses it at once (before any reader URL sync).
  useEffect(() => stripViaFromAddress(), []);

  useEffect(() => {
    // A malformed slug, or the server already said the link is not active: no round-trip.
    if (!SLUG_RE.test(slug) || dead) {
      setState({ status: 'not_found', data: null, error: null });
      return;
    }
    const controller = new AbortController();
    setState((s) => ({ ...s, status: 'loading', error: null }));
    loadPublicComicBySlug(slug, { signal: controller.signal })
      .then((data) => !controller.signal.aborted && setState({ status: 'ready', data, error: null }))
      .catch((err: { status?: number; kind?: string; message?: string; name?: string }) => {
        if (controller.signal.aborted || err?.name === 'AbortError') return;
        const gone = err?.status === 404 || err?.kind === 'not_found';
        setState({ status: gone ? 'not_found' : 'error', data: null, error: gone ? null : err?.message || "Couldn't open this comic." });
      });
    return () => controller.abort();
  }, [slug, attempt, dead]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  const track = useCallback(
    (type: PublicEventType, channel?: ShareChannel, lang?: string) => {
      if (opts.isOwner || !SLUG_RE.test(slug)) return;
      if (type !== 'share') {
        if (sent.current.has(type)) return;
        sent.current.add(type);
      }
      const ch = channel ?? (type === 'view' ? via : undefined);
      void trackPublicEvent(slug, { type, ...(ch ? { channel: ch } : {}), ...(lang ? { lang } : {}) });
    },
    [slug, opts.isOwner, via]
  );

  return { status: state.status, boot, data: state.data, error: state.error, retry, track };
}

export default usePublicComic;
