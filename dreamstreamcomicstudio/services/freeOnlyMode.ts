// Free-only mode — client-side setting.
//
// When on, every /api/* call attaches `X-Free-Only: true`. The server's autoRouter
// then refuses to fall back to a paid model and returns HTTP 402 NO_FREE_MODEL_AVAILABLE
// instead. UI surfaces (model pickers, generation buttons, background generation status)
// must consume this and show a "Block + explain" message when free-only blocks a stage.
//
// DEFAULT: ON. "Free" should mean free — so unless the user has explicitly opted into paid
// (persisted as '0'), every request is free-only and the server blocks rather than silently
// charging a paid fallback. Absence of the flag = on; only an explicit '0' turns it off.
//
// Persistence: localStorage today (per-browser). Phase 1's verification system migration
// will add a server-side profile flag so the setting follows the user across devices.

const KEY = 'dreamstream:freeOnly';
const EVENT = 'dreamstream:freeOnly:changed';

export const isFreeOnly = (): boolean => {
  if (typeof window === 'undefined') return false;
  try {
    // Default ON: only an explicit opt-into-paid ('0') disables it.
    return window.localStorage.getItem(KEY) !== '0';
  } catch {
    return true;
  }
};

export const setFreeOnly = (on: boolean): void => {
  if (typeof window === 'undefined') return;
  try {
    // Persist the OFF choice explicitly ('0') so opting into paid survives the default-on.
    window.localStorage.setItem(KEY, on ? '1' : '0');
    window.dispatchEvent(new CustomEvent(EVENT, { detail: { on } }));
  } catch {
    /* best-effort; storage may be blocked */
  }
};

/** Subscribe to changes. Returns an unsubscribe function. */
export const onFreeOnlyChanged = (handler: (on: boolean) => void): (() => void) => {
  if (typeof window === 'undefined') return () => undefined;
  const wrapped = (event: Event) => {
    const detail = (event as CustomEvent).detail;
    handler(Boolean(detail?.on));
  };
  window.addEventListener(EVENT, wrapped as EventListener);
  return () => window.removeEventListener(EVENT, wrapped as EventListener);
};

/** Recognises the typed server error so callers can render Block + explain. */
export const isNoFreeModelError = (err: unknown): boolean => {
  if (!err || typeof err !== 'object') return false;
  const candidate = err as { status?: number; details?: { code?: string }; message?: string };
  if (candidate.status === 402) return true;
  const code = candidate.details?.code;
  return code === 'NO_FREE_MODEL_AVAILABLE';
};
