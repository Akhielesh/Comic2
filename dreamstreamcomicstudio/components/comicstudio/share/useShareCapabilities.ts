// Web Share / clipboard capabilities (sharing.md §7.3): URL share first (richest previews in
// chat apps), an optional image-file share, and an honest fallback (copy + QR + intents) for
// in-app browsers that lack navigator.share. AbortError (the user closed the share sheet) is
// silent; anything else falls back to the copy popover.

import { useCallback, useMemo } from 'react';
import { fileNameFor, isInAppBrowser } from './shareModel';

export type ShareResult = 'shared' | 'cancelled' | 'fallback';

export interface ShareCapabilities {
  canShare: boolean;
  inApp: boolean;
  share(data: { title: string; text?: string; url: string }): Promise<ShareResult>;
  /** Share the preview image as a file (+ the link in the text). 'fallback' when files can't be shared. */
  shareImage(data: { title: string; url: string; imageUrl: string }): Promise<ShareResult>;
  copy(text: string): Promise<boolean>;
}

const nav = (): Navigator | undefined => (typeof navigator === 'undefined' ? undefined : navigator);

export async function copyText(text: string): Promise<boolean> {
  try {
    if (nav()?.clipboard?.writeText) {
      await nav()!.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall back below */
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

export function useShareCapabilities(): ShareCapabilities {
  const canShare = typeof nav()?.share === 'function';
  const inApp = useMemo(() => isInAppBrowser(), []);

  const share = useCallback(async (data: { title: string; text?: string; url: string }): Promise<ShareResult> => {
    const n = nav();
    if (!n || typeof n.share !== 'function') return 'fallback';
    try {
      await n.share({ title: data.title, ...(data.text ? { text: data.text } : {}), url: data.url });
      return 'shared';
    } catch (err) {
      return (err as Error)?.name === 'AbortError' ? 'cancelled' : 'fallback';
    }
  }, []);

  const shareImage = useCallback(async (data: { title: string; url: string; imageUrl: string }): Promise<ShareResult> => {
    const n = nav();
    if (!n || typeof n.share !== 'function' || typeof n.canShare !== 'function' || typeof File === 'undefined') return 'fallback';
    try {
      const res = await fetch(data.imageUrl, { credentials: 'omit' });
      if (!res.ok) return 'fallback';
      const blob = await res.blob();
      const file = new File([blob], fileNameFor(data.title, 'jpg'), { type: blob.type || 'image/jpeg' });
      if (!n.canShare({ files: [file] })) return 'fallback';
      // Some targets drop `url` when files are attached, so the link rides in the text.
      await n.share({ files: [file], text: `${data.title} — ${data.url}` });
      return 'shared';
    } catch (err) {
      return (err as Error)?.name === 'AbortError' ? 'cancelled' : 'fallback';
    }
  }, []);

  return { canShare, inApp, share, shareImage, copy: copyText };
}

export default useShareCapabilities;
