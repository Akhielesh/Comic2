// Turn a public video URL into an embeddable player URL so videos play *inside*
// the chat's side panel instead of bouncing the user out to another tab. Today we
// support YouTube (incl. youtu.be / shorts / embed, with start offsets) and Vimeo;
// anything else returns null and the UI falls back to opening the original link.

export interface VideoEmbed {
  provider: 'youtube' | 'vimeo';
  /** Privacy-friendly, autoplay-enabled embed URL for an <iframe>. */
  embedUrl: string;
  id: string;
}

const parseStart = (u: URL): number => {
  // Support ?t=90, ?t=1m30s, ?start=90.
  const raw = u.searchParams.get('start') || u.searchParams.get('t') || '';
  if (!raw) return 0;
  if (/^\d+$/.test(raw)) return Number(raw);
  const m = raw.match(/(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/);
  if (!m) return 0;
  return (Number(m[1] || 0) * 3600) + (Number(m[2] || 0) * 60) + Number(m[3] || 0);
};

const youtubeId = (u: URL): string | null => {
  const host = u.hostname.replace(/^www\.|^m\./, '');
  if (host === 'youtu.be') return u.pathname.slice(1).split('/')[0] || null;
  if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    if (u.pathname === '/watch') return u.searchParams.get('v');
    const m = u.pathname.match(/^\/(?:embed|shorts|v|live)\/([^/?#]+)/);
    if (m) return m[1];
  }
  return null;
};

export const toVideoEmbed = (url: string): VideoEmbed | null => {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const yt = youtubeId(u);
  if (yt && /^[\w-]{6,}$/.test(yt)) {
    const start = parseStart(u);
    const qs = new URLSearchParams({ autoplay: '1', rel: '0', modestbranding: '1' });
    if (start > 0) qs.set('start', String(start));
    return { provider: 'youtube', id: yt, embedUrl: `https://www.youtube-nocookie.com/embed/${yt}?${qs.toString()}` };
  }
  const host = u.hostname.replace(/^www\./, '');
  if (host === 'vimeo.com') {
    const id = u.pathname.split('/').filter(Boolean)[0];
    if (id && /^\d+$/.test(id)) {
      return { provider: 'vimeo', id, embedUrl: `https://player.vimeo.com/video/${id}?autoplay=1` };
    }
  }
  return null;
};

/** Whether a URL can be played inline (vs. only opened in a new tab). */
export const isEmbeddableVideo = (url: string): boolean => toVideoEmbed(url) !== null;
