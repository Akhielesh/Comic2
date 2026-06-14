// Library aggregation — a single, cross-session view of every file & image that has
// passed through Chat Studio. Two sources feed it:
//   • user uploads      — `turn.attachments` on user turns (images + documents), stored
//                          as base64 data URLs.
//   • generated content — `turn.images` on assistant turns (image generation / search
//                          results), referenced by URL. Variant (regenerate) history is
//                          included so nothing the model made is lost.
//
// Nothing new is persisted here: the Library is a derived, read-only index over the
// chat sessions that already live in IndexedDB. This keeps it always in sync and avoids
// a second copy of every asset.

import type { ChatSession } from './chatStorage';
import { listChatSessions } from './chatStorage';

/** Coarse media class used by the All / Images / Files tabs. */
export type LibraryItemKind = 'image' | 'file';

/** Where the asset came from — drives the "Uploaded by you" vs "Generated" filter. */
export type LibraryItemOrigin = 'upload' | 'generated';

export interface LibraryItem {
  /** Stable, de-duplicating id (prefixed by source so uploads and URLs never collide). */
  id: string;
  kind: LibraryItemKind;
  origin: LibraryItemOrigin;
  /** Human file name / title. */
  name: string;
  /** Renderable source — a data URL (uploads) or a remote URL (generated/searched). */
  url: string;
  /** Smaller preview URL when the source provides one (image search results). */
  thumbnail?: string;
  mimeType?: string;
  /** Approx byte size when it can be derived from a data URL. */
  bytes?: number;
  /** When the asset entered the chat (the owning turn's timestamp). */
  createdAt: number;
  /** Originating conversation, so the user can jump back to its context. */
  sessionId: string;
  sessionTitle: string;
}

// Approx decoded byte length of a `data:...;base64,...` URL's payload. Remote URLs
// (generated images) have no knowable size client-side and return undefined.
const dataUrlBytes = (url: string): number | undefined => {
  if (!url.startsWith('data:')) return undefined;
  const comma = url.indexOf(',');
  if (comma < 0) return undefined;
  const payload = url.slice(comma + 1);
  // Non-base64 data URLs (rare) aren't worth sizing.
  if (!url.slice(0, comma).includes('base64')) return undefined;
  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((payload.length * 3) / 4) - padding);
};

/**
 * Flatten every session's turns into a newest-first list of library items.
 * Pure and synchronous so the view can `useMemo` it straight off the in-memory
 * session list (which already updates live as chats stream).
 */
export const collectLibraryItems = (sessions: ChatSession[]): LibraryItem[] => {
  const items: LibraryItem[] = [];
  const seen = new Set<string>();

  const push = (item: LibraryItem) => {
    if (seen.has(item.id)) return;
    seen.add(item.id);
    items.push(item);
  };

  for (const session of sessions) {
    for (const turn of session.turns) {
      // 1) Files the user attached (images + documents).
      if (turn.attachments) {
        for (const att of turn.attachments) {
          push({
            id: `att:${att.id}`,
            kind: att.kind === 'document' ? 'file' : 'image',
            origin: 'upload',
            name: att.name || (att.kind === 'document' ? 'Document' : 'Image'),
            url: att.dataUrl,
            mimeType: att.mimeType,
            bytes: dataUrlBytes(att.dataUrl),
            createdAt: turn.createdAt,
            sessionId: session.id,
            sessionTitle: session.title
          });
        }
      }

      // 2) Images the model produced / surfaced — current answer plus regenerate history.
      const imageLists = [turn.images, ...((turn.variants || []).map((v) => v.images))];
      for (const list of imageLists) {
        if (!list) continue;
        for (const img of list) {
          if (!img.url) continue;
          push({
            id: `img:${img.url}`,
            kind: 'image',
            origin: 'generated',
            name: img.title || 'Generated image',
            url: img.url,
            thumbnail: img.thumbnail,
            mimeType: 'image/*',
            bytes: dataUrlBytes(img.url),
            createdAt: turn.createdAt,
            sessionId: session.id,
            sessionTitle: session.title
          });
        }
      }
    }
  }

  return items.sort((a, b) => b.createdAt - a.createdAt);
};

/** Convenience async loader for callers that don't already hold the session list. */
export const loadLibraryItems = async (): Promise<LibraryItem[]> =>
  collectLibraryItems(await listChatSessions());

/** Compact, human file size for the Size column. */
export const formatBytes = (bytes?: number): string => {
  if (bytes === undefined) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const DAY_MS = 86_400_000;

/** Relative "Modified" label — Today / Yesterday / weekday / date, matching the recents feel. */
export const formatModified = (ts: number): string => {
  if (!ts) return '—';
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (ts >= startOfToday) return 'Today';
  if (ts >= startOfToday - DAY_MS) return 'Yesterday';
  if (ts >= startOfToday - 6 * DAY_MS) return new Date(ts).toLocaleDateString(undefined, { weekday: 'long' });
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
};
