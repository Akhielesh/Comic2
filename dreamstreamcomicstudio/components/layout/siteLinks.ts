/**
 * The site chrome's shared words and addresses: the header, the footer and the legal row read them from
 * here, so every page names the company, the contact address and the legal pages the same way.
 *
 * Addresses are real links (a middle-click, a copied link or a new tab lands on the right page); a plain
 * click is handled inside the app instead (`isPlainClick`), so nothing reloads.
 */

/** The company, as every footer and copyright line names it (never "DreamStream Inc."). */
export const COMPANY_NAME = 'DreamStream Studio';

/** One contact address, on our own domain. */
export const CONTACT_EMAIL = 'contact@dreamstreamstudio.ai';
export const CONTACT_HREF = `mailto:${CONTACT_EMAIL}`;

/** Atlas Studio, the sister product on its own host. */
export const ATLAS_STUDIO_URL = 'https://atlas.dreamstreamstudio.ai';

/**
 * The legal pages. `?view=` is what App restores today on a cold load; the legal suite gives each
 * document its own path (/privacy, /terms) and keeps restoring these addresses, so they stay valid.
 */
export const PRIVACY_HREF = '/?view=privacy';
export const TERMS_HREF = '/?view=terms';

/** The public pages the header links to. */
export const HOME_HREF = '/';
export const HOW_IT_WORKS_HREF = '/?view=how-it-works';
export const LIBRARY_HREF = '/?view=gallery';
export const MODELS_HREF = '/models';
export const CHAT_HREF = '/?view=chat';
export const COMIC_STUDIO_HREF = '/?view=dashboard';

/** "© 2026 DreamStream Studio". */
export const copyrightLine = (year: number = new Date().getFullYear()): string => `© ${year} ${COMPANY_NAME}`;

/**
 * A primary-button click with no modifier: the app opens the page itself. Anything else (a middle-click,
 * ⌘/Ctrl/Shift/Alt) keeps the browser's own behaviour for the link (a new tab or window).
 */
export const isPlainClick = (e: Pick<MouseEvent, 'button' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'defaultPrevented'>): boolean =>
  !e.defaultPrevented && e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
