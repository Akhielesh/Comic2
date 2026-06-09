// Durable UI continuity helpers.
//
// The app is a single-page state machine, so any full reload (F5, Chrome Memory-Saver
// tab discard, mobile tab eviction) used to bounce users back to each surface's first
// screen: Settings reopened on Profile, the chat reopened on the newest session, the
// admin console lost its section. These helpers give every surface two layers of
// continuity:
//
//   1. URL query params (?view=settings&tab=admin&section=users) — shareable deep
//      links that survive reloads and restores.
//   2. sessionStorage fallback — survives same-tab reloads even when the URL was
//      stripped (e.g. auth callbacks rewrite it).
//
// Writers use history.replaceState so tab changes never spam browser history.

const memoryFallback = new Map<string, string>();

const safeSessionGet = (key: string): string | null => {
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return memoryFallback.get(key) ?? null;
  }
};

const safeSessionSet = (key: string, value: string) => {
  try {
    window.sessionStorage.setItem(key, value);
  } catch {
    memoryFallback.set(key, value);
  }
};

const safeSessionRemove = (key: string) => {
  try {
    window.sessionStorage.removeItem(key);
  } catch {
    memoryFallback.delete(key);
  }
};

/** Read a query param from the current URL. */
export const getUrlParam = (key: string): string | null => {
  try {
    return new URL(window.location.href).searchParams.get(key);
  } catch {
    return null;
  }
};

/**
 * Merge params into the current URL without touching unrelated ones.
 * Pass `null`/`undefined` to delete a param. Uses replaceState (no history spam).
 */
export const patchUrlParams = (params: Record<string, string | null | undefined>) => {
  try {
    const url = new URL(window.location.href);
    for (const [key, value] of Object.entries(params)) {
      if (value === null || value === undefined || value === '') url.searchParams.delete(key);
      else url.searchParams.set(key, value);
    }
    window.history.replaceState(window.history.state, '', url);
  } catch {
    /* history unavailable; sessionStorage layer still restores */
  }
};

const storageKey = (scope: string) => `dreamstream_ui_state:${scope}`;

/** Remember a small piece of UI state (active tab/section/session id) for this tab. */
export const rememberUiState = (scope: string, value: string | null | undefined) => {
  if (value === null || value === undefined || value === '') safeSessionRemove(storageKey(scope));
  else safeSessionSet(storageKey(scope), value);
};

/** Recall UI state remembered for this tab (or null). */
export const recallUiState = (scope: string): string | null => safeSessionGet(storageKey(scope));

/**
 * Resolve the initial value for a continuity-tracked piece of UI state.
 * Priority: explicit URL param → sessionStorage memory → fallback.
 * `valid` guards against stale/garbage values after deploys change the id set.
 */
export const resolveInitialUiState = <T extends string>(
  scope: string,
  urlKey: string,
  valid: (value: string) => value is T,
  fallback: T
): T => {
  const fromUrl = getUrlParam(urlKey);
  if (fromUrl && valid(fromUrl)) return fromUrl;
  const remembered = recallUiState(scope);
  if (remembered && valid(remembered)) return remembered;
  return fallback;
};

/** Persist both continuity layers (URL param + session memory) in one call. */
export const persistUiState = (scope: string, urlKey: string, value: string | null | undefined) => {
  patchUrlParams({ [urlKey]: value ?? null });
  rememberUiState(scope, value);
};
