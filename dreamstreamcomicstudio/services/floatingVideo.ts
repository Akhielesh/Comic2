// Tiny global store for the floating mini-player: send a video here and the
// FloatingVideoDock (mounted once at the studio root) plays it in a draggable
// always-on-top window that survives view switches (chat ⇄ dashboards ⇄ settings).

export interface FloatingVideo {
  url: string;
  title: string;
}

const EVT = 'dreamstream:floating-video-changed';
let current: FloatingVideo | null = null;

export const getFloatingVideo = (): FloatingVideo | null => current;

export const setFloatingVideo = (video: FloatingVideo | null): void => {
  current = video;
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(EVT));
};

export const onFloatingVideoChanged = (handler: () => void): (() => void) => {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener(EVT, handler);
  return () => window.removeEventListener(EVT, handler);
};
