/**
 * The legal pages' addresses. Each document has a real path on the main site (/terms, /privacy, …),
 * served by the SPA fallback in public/_redirects and picked up by App.tsx, and the original
 * ?view=terms / ?view=privacy links (the Google OAuth consent screen, old emails) keep working: App
 * restores the view from ?view= and then rewrites the address to the document's path.
 *
 * Dependency-free on purpose: App.tsx, the footers and Stream Studio import it.
 */

export type LegalDocId = 'terms' | 'privacy' | 'acceptable-use' | 'copyright' | 'cookies' | 'subprocessors';

export interface LegalDoc {
  id: LegalDocId;
  /** The canonical path on the main site. */
  path: string;
  /** The document's full title (page heading and browser tab). */
  title: string;
  /** The short label footers use. */
  label: string;
}

/** Order = reading order in the legal navigation and footers. */
export const LEGAL_DOCS: readonly LegalDoc[] = [
  { id: 'terms', path: '/terms', title: 'Terms of Service', label: 'Terms of Service' },
  { id: 'privacy', path: '/privacy', title: 'Privacy Policy', label: 'Privacy Policy' },
  { id: 'acceptable-use', path: '/acceptable-use', title: 'Acceptable Use Policy', label: 'Acceptable Use' },
  { id: 'copyright', path: '/copyright', title: 'Copyright & DMCA Policy', label: 'Copyright' },
  { id: 'cookies', path: '/cookies', title: 'Cookies & Local Storage', label: 'Cookies' },
  { id: 'subprocessors', path: '/subprocessors', title: 'Subprocessors', label: 'Subprocessors' }
];

/** Other spellings people type or link to; they land on the canonical path. */
const ALIASES: Readonly<Record<string, LegalDocId>> = {
  '/tos': 'terms',
  '/terms-of-service': 'terms',
  '/privacy-policy': 'privacy',
  '/aup': 'acceptable-use',
  '/acceptable-use-policy': 'acceptable-use',
  '/dmca': 'copyright',
  '/cookie-policy': 'cookies',
  '/sub-processors': 'subprocessors'
};

const BY_ID = new Map<LegalDocId, LegalDoc>(LEGAL_DOCS.map((d) => [d.id, d]));
const BY_PATH = new Map<string, LegalDocId>([...LEGAL_DOCS.map((d) => [d.path, d.id] as const), ...Object.entries(ALIASES)]);

export const LEGAL_DOC_IDS: readonly LegalDocId[] = LEGAL_DOCS.map((d) => d.id);

export const isLegalDocId = (value: unknown): value is LegalDocId => typeof value === 'string' && BY_ID.has(value as LegalDocId);

export const legalDoc = (id: LegalDocId): LegalDoc => BY_ID.get(id) as LegalDoc;

export const legalPath = (id: LegalDocId): string => legalDoc(id).path;

/** The document a pathname names (trailing slashes and letter case ignored), or null. */
export const legalDocForPath = (pathname: string | null | undefined): LegalDocId | null => {
  if (!pathname) return null;
  const p = pathname.replace(/\/+$/, '').toLowerCase();
  return BY_PATH.get(p) ?? null;
};

/**
 * Drop the #fragment before opening another document in the app, so the next page starts at its
 * top instead of jumping to a same-named section (#contact, #changes) of the page you left.
 */
export const clearFragment = (): void => {
  try {
    if (window.location.hash) window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}`);
  } catch {
    /* history unavailable: the page still opens */
  }
};

/**
 * The history-state key under which the comic reader's back stack records its layers
 * (components/comicstudio/mobile/backStack.ts HISTORY_LAYERS_KEY; legalRoutes.test.ts keeps the two equal).
 */
export const BACK_LAYERS_STATE_KEY = 'csLayers';

/** The current history entry belongs to an open back-stack layer (the comic reader, a sheet). */
const entryHasBackLayers = (): boolean => {
  const state = window.history.state as Record<string, unknown> | null;
  const layers = state && typeof state === 'object' ? state[BACK_LAYERS_STATE_KEY] : undefined;
  return Array.isArray(layers) && layers.length > 0;
};

/**
 * Give an in-app move to a legal document its own history entry (App's address sync only replaces
 * the current one), so the browser's or the phone's Back leaves the document instead of leaving the
 * site. Back onto another document's entry opens that document; Back onto any other entry goes where
 * the page's own Back button goes (App's onBack: Dashboard when signed in, else Home), because App
 * doesn't yet restore a view from a popped address. That is the page the reader came from only when
 * they came from Dashboard or Home (restoring any view is an App.tsx change, proposed for review).
 * The new entry carries no #fragment, so the document starts at its top. Back and Forward onto it
 * reopen the document (followLegalHistory).
 *
 * Not on an entry a back-stack layer owns: the reader leaves its layer first, which pops that
 * layer's entry, and App's address sync then puts the document's path on the entry under it. A new
 * entry here would hide the layer's entry from that leave and strand it in the history.
 */
export const pushLegalPath = (id: LegalDocId): void => {
  try {
    if (entryHasBackLayers()) return;
    const path = legalPath(id);
    if (window.location.pathname === path && !window.location.hash && !window.location.search) return;
    window.history.pushState({}, '', path);
  } catch {
    clearFragment();
  }
};

let openDoc: ((id: LegalDocId) => void) | null = null;
let shownDoc: LegalDocId | null = null;
let followingHistory = false;

const onLegalPopState = () => {
  const target = legalDocForPath(window.location.pathname);
  if (target && target !== shownDoc && openDoc) openDoc(target);
};

/**
 * Back and Forward onto a legal document's address open that document, also after it was closed:
 * Back from /privacy to the dashboard, then Forward, lands on /privacy again, and the view has to
 * follow (App has no history listener of its own). LegalDocument calls this while a document is
 * shown, with App's view setter; the one listener stays for the rest of the visit and does nothing
 * on other addresses or on a move between sections of the document already shown. Returns the
 * cleanup for when the document closes.
 */
export const followLegalHistory = (doc: LegalDocId, open: (id: LegalDocId) => void): (() => void) => {
  openDoc = open;
  shownDoc = doc;
  if (!followingHistory && typeof window !== 'undefined') {
    window.addEventListener('popstate', onLegalPopState);
    followingHistory = true;
  }
  return () => {
    if (shownDoc === doc) shownDoc = null;
  };
};

/**
 * Keep the address bar in step with the view App shows (its ?view= sync effect calls this).
 * A legal view gets its document's path and no ?view=; leaving a legal page for another view puts
 * the path back to "/" so a refresh doesn't reopen the document. Returns true when it handled the
 * view (the caller then leaves ?view= alone).
 */
export const syncLegalPath = (url: URL, view: string): boolean => {
  if (isLegalDocId(view)) {
    url.pathname = legalPath(view);
    url.searchParams.delete('view');
    return true;
  }
  if (legalDocForPath(url.pathname)) url.pathname = '/';
  return false;
};
