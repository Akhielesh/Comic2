// Public reader data for /c/<slug> (sharing.md §7.2): the inline boot card for an instant first
// paint, the frozen snapshot from the edge, and fire-and-forget analytics. Consumed by the public
// reader (P2-READER-PUBLIC). Read-only: only GETs the snapshot and posts anonymous events.
//
// States: loading → ready | not_found (unknown, revoked, unpublished and suspended look identical:
// "This link isn't active") | error (network; "Couldn't open — Try again").

import { useCallback, useEffect, useRef, useState } from 'react';
import { SLUG_RE, type PublicComicPayload, type ShareChannel } from '../../../shared/comic/publication';
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

export type PublicComicStatus = 'loading' | 'ready' | 'not_found' | 'error';

export interface UsePublicComic {
  status: PublicComicStatus;
  boot: ShareBoot | null;
  data: PublicComicPayload | null;
  error: string | null;
  retry(): void;
  /** view (once per mount), complete (once), share (every time). Never for the owner. */
  track(type: PublicEventType, channel?: ShareChannel, lang?: string): void;
}

export function usePublicComic(slug: string, opts: { isOwner?: boolean } = {}): UsePublicComic {
  const [boot] = useState(() => readShareBoot(slug));
  const [state, setState] = useState<{ status: PublicComicStatus; data: PublicComicPayload | null; error: string | null }>({ status: 'loading', data: null, error: null });
  const [attempt, setAttempt] = useState(0);
  const sent = useRef(new Set<string>());

  useEffect(() => {
    if (!SLUG_RE.test(slug)) {
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
  }, [slug, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  const track = useCallback(
    (type: PublicEventType, channel?: ShareChannel, lang?: string) => {
      if (opts.isOwner || !SLUG_RE.test(slug)) return;
      if (type !== 'share') {
        if (sent.current.has(type)) return;
        sent.current.add(type);
      }
      void trackPublicEvent(slug, { type, ...(channel ? { channel } : {}), ...(lang ? { lang } : {}) });
    },
    [slug, opts.isOwner]
  );

  return { status: state.status, boot, data: state.data, error: state.error, retry, track };
}

export default usePublicComic;
