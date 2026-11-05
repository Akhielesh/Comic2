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
