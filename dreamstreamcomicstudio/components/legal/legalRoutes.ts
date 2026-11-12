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
 * A legal document is on screen, or an old ?view=privacy link names one that App's view hasn't
 * caught up with yet. App's automatic moves (the stream-only accounts' hand-off to Stream Studio,
 * the date-of-birth prompt that opens Settings) wait while this is true, so they never pull someone
 * off a document they opened, and run once the reader leaves it. A document's own path needs no
 * check of its own: App derives the view from it before the first paint, and while App leaves a
 * document the path is still /privacy for a moment (until the address sync rewrites it), which must
 * not hold the move back. On the paths that own their address (a share link, the public reader, the
 * model catalog, a sign-in link) App never restores or rewrites ?view=, so a ?view=terms there would
 * hold both moves for as long as the page stays open: it is ignored.
 */
export const isOnLegalPage = (view: string): boolean => {
  if (isLegalDocId(view)) return true;
  try {
    const path = window.location.pathname.replace(/\/+$/, '');
    if (path.startsWith('/share/') || /^\/c(?:\/|$)/.test(path) || path === '/models' || path === '/auth/callback') return false;
    return isLegalDocId(new URLSearchParams(window.location.search).get('view'));
  } catch {
    return false;
  }
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

/** The id of a legal document's title (LegalDocument's <h1>): a move to the top of a document leaves keyboard focus there. */
export const LEGAL_TITLE_ID = 'legal-document-title';

/**
 * Scroll to a section and move keyboard focus there, as the browser's own fragment navigation
 * would: Tab carries on from the section, and a screen reader starts reading it. Used for a jump
 * on the page shown (LegalDocument showSection, pushLegalPath) and for a section of another document
 * once it opens (LegalDocument useLandOnFragment), so every kind of section link leaves focus in the
 * same place.
 */
export const landOn = (target: HTMLElement): void => {
  target.scrollIntoView?.();
  if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
  target.focus?.({ preventScroll: true });
};

/**
 * Start at the top of the document shown, with keyboard focus on the document's title after any move
 * inside the app: focus left on a control that is still on the page (the shared footer's link that
 * was used, or a link further down the document) moves there, so the next Tab carries on from the top
 * instead of scrolling back down to that control; and so does focus on <body> after a move whose link
 * is gone (the legal navigation's pills and the links in a document's text: the next document replaces
 * the page, link and all), so a screen reader announces the document as it does a section a link
 * lands on (landOn). A page loaded cold, or an entry no move in this visit marked
 * (legalBackGoesBack), leaves focus on <body> as the browser put it.
 */
export const landOnTop = (): void => {
  (document.scrollingElement ?? document.documentElement)?.scrollTo?.({ top: 0 });
  const title = document.getElementById(LEGAL_TITLE_ID);
  const active = document.activeElement;
  if (!title || !active || active === title) return;
  if (active === document.body && !legalBackGoesBack()) return;
  title.focus?.({ preventScroll: true });
};

/**
 * The history-state key under which the comic reader's back stack records its layers
 * (components/comicstudio/mobile/backStack.ts HISTORY_LAYERS_KEY; legalRoutes.test.ts keeps the two equal).
 */
export const BACK_LAYERS_STATE_KEY = 'csLayers';

/**
 * The history-state key that marks an entry this visit pushed for a legal document from another page
 * of the app (pushLegalPath, and App's handleNavigate). The entry under a marked one is that page, so
 * the document's own Back button can go back to it exactly as the browser's Back would
 * (legalBackGoesBack). App's address sync keeps the mark when it rewrites the entry
 * (keepLegalEntryMark); everything else in the state is the sync's to replace, as before.
 */
export const LEGAL_ENTRY_STATE_KEY = 'dsLegalEntry';

/** The state an in-app move to a legal document pushes with its new entry. */
export const legalEntryState = (): Record<string, unknown> => ({ [LEGAL_ENTRY_STATE_KEY]: true });

const isLegalEntry = (state: unknown): boolean =>
  !!state && typeof state === 'object' && (state as Record<string, unknown>)[LEGAL_ENTRY_STATE_KEY] === true;

/** The state App's address sync writes back: the mark (if the entry has it), nothing else. */
export const keepLegalEntryMark = (state: unknown): Record<string, unknown> => (isLegalEntry(state) ? legalEntryState() : {});

/**
 * The legal page's own Back button goes back in history (to the page that opened the document, or
 * the document before it) when the current entry was pushed by a move inside this visit; otherwise
 * (a cold load of /privacy, a link from another site, an entry nobody marked) it falls back to the
 * page's onBack, so the button never leaves DreamStream.
 */
export const legalBackGoesBack = (): boolean => {
  try {
    return isLegalEntry(window.history.state);
  } catch {
    return false;
  }
};

/** The current history entry belongs to an open back-stack layer (the comic reader, a sheet). */
const entryHasBackLayers = (): boolean => {
  const state = window.history.state as Record<string, unknown> | null;
  const layers = state && typeof state === 'object' ? state[BACK_LAYERS_STATE_KEY] : undefined;
  return Array.isArray(layers) && layers.length > 0;
};

/**
 * Give an in-app move to a legal document its own history entry (App's address sync only replaces
 * the current one), so the browser's or the phone's Back returns to the page the reader came from
 * instead of leaving the site. Back onto another document's entry opens that document; Back onto any
 * other entry shows the view that entry names (App's restoreViewFromHistory, via
 * viewForHistoryEntry below: Gallery for /?view=gallery, Settings on its tab, a /share/<token> link,
 * /models, a comic in the reader, the project open in a workspace), and only an entry that names no
 * view App can show falls back to Dashboard or Home. The entry is marked (legalEntryState), so the
 * page's own Back button does the same as the browser's Back. The new entry carries no #fragment, so
 * the document starts at its top, unless `section` names one to land on (a link to a section of
 * another document: LegalDocument lands on it once that page is in the DOM). Back and Forward onto it
 * reopen the document (followLegalHistory).
 *
 * Not on an entry a back-stack layer owns: the reader leaves its layer first, which pops that
 * layer's entry, and App's address sync then puts the document's path on the entry under it. A new
 * entry here would hide the layer's entry from that leave and strand it in the history.
 */
export const pushLegalPath = (id: LegalDocId, section?: string): void => {
  try {
    if (entryHasBackLayers()) return;
    const path = legalPath(id);
    const fragment = section ? `#${section}` : '';
    if (window.location.pathname === path && !window.location.search) {
      // The document is already shown, maybe at a #section after a table-of-contents jump: a new
      // entry would be one Back only returns to the same page from. The current entry takes the
      // fragment asked for, with its state (so its mark), and the page goes where the link points,
      // focus included (landOn, landOnTop), since the view doesn't change and the document doesn't
      // land anywhere by itself.
      if (window.location.hash !== fragment) window.history.replaceState(window.history.state, '', `${path}${fragment}`);
      const target = section ? document.getElementById(section) : null;
      if (target) landOn(target);
      else if (!section) landOnTop();
      return;
    }
    window.history.pushState(legalEntryState(), '', `${path}${fragment}`);
  } catch {
    clearFragment();
  }
};

/**
 * A move to a #section of the document already shown puts that fragment on the CURRENT history
 * entry, with the entry's state as it is. The browser's own fragment navigation (a plain
 * <a href="#id">) would add an entry with no state: that loses the mark (legalEntryState), so the
 * page's Back button would no longer know this visit opened the document and would leave for the
 * Dashboard instead of the page the reader came from, and it and the browser's Back would disagree.
 * Returns false when history can't be written (the caller then lets the browser move).
 */
export const replaceLegalFragment = (section: string): boolean => {
  try {
    window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}#${section}`);
    return true;
  } catch {
    return false;
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

/** What a history entry's address names: a view, its ?id= (a comic or a project), and for /share/<token> the token. */
export interface HistoryEntryView {
  view: string;
  id?: string;
  shareToken?: string;
}

/**
 * The view a history entry's address names, read the way App restores one from the address on load
 * (App.tsx: /share/<token>, /models, a ?view= in its RESTORABLE_VIEWS, ?view=read&id= for the
 * reader, ?view=<workspace>&id= for a project). This is what Back or Forward from a legal page onto
 * that entry shows; a ?view= keeps its other parameters on the entry (?view=settings&tab=legal
 * reopens Settings on that tab, which AccountSettings reads from ?tab=). "/" without a ?view= is the
 * home page. `restorable` decides which ?view= values (with their ?id=, if any) App can show. Any
 * other value or path names no view (null): the caller falls back to Dashboard or Home.
 */
export const viewForHistoryEntry = (
  location: { pathname: string; search: string },
  restorable: (view: string, id: string | null) => boolean
): HistoryEntryView | null => {
  const share = /^\/share\/([^/]+)$/.exec(location.pathname);
  if (share) return { view: 'shared', shareToken: share[1] };
  if (location.pathname === '/models') return { view: 'models' };
  if (location.pathname !== '/') return null;
  const params = new URLSearchParams(location.search);
  const view = params.get('view');
  if (!view) return { view: 'home' };
  const id = params.get('id')?.trim() || null;
  if (!restorable(view, id)) return null;
  return id ? { view, id } : { view };
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
