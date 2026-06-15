// YouTube Data API video search — the reliable path for `video_search` when a
// YOUTUBE_API_KEY is configured (the keyless DuckDuckGo scraper is the fallback).
// Returns the same VideoSearchResult shape the video card renders.

import { YOUTUBE_API_KEY } from '../../config.js';
import type { VideoSearchResult } from './duckduckgo.js';

const YT_SEARCH = 'https://www.googleapis.com/youtube/v3/search';

interface YtSearchItem {
  id?: { videoId?: string };
  snippet?: {
    title?: string;
    channelTitle?: string;
    thumbnails?: Record<string, { url?: string } | undefined>;
  };
}

/** True when the YouTube Data API key is configured (so we can prefer it). */
export const youtubeSearchEnabled = (): boolean => Boolean(YOUTUBE_API_KEY);

/** Search YouTube for videos. Returns [] when no key is set (caller falls back to DDG). */
export const youtubeVideoSearch = async (query: string, signal?: AbortSignal, limit = 8): Promise<VideoSearchResult[]> => {
  if (!YOUTUBE_API_KEY) return [];
  const url =
    `${YT_SEARCH}?part=snippet&type=video&safeSearch=none&maxResults=${Math.min(12, Math.max(1, limit))}` +
    `&q=${encodeURIComponent(query)}&key=${encodeURIComponent(YOUTUBE_API_KEY)}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' }, signal });
  if (!res.ok) throw new Error(`YouTube search returned ${res.status}`);
  const json = (await res.json()) as { items?: YtSearchItem[] };
  const items = Array.isArray(json.items) ? json.items : [];
  return items
    .map((it): VideoSearchResult | null => {
      const id = it?.id?.videoId;
      const sn = it?.snippet || {};
      if (!id) return null;
      const thumbs = sn.thumbnails || {};
      return {
        title: sn.title || '(untitled)',
        url: `https://www.youtube.com/watch?v=${id}`,
        thumbnail: thumbs.medium?.url || thumbs.high?.url || thumbs.default?.url || undefined,
        publisher: sn.channelTitle || undefined
      };
    })
    .filter((r): r is VideoSearchResult => r !== null);
};
