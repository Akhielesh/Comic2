// Escaping for the markup exports write (the print window). Author text — titles, dialogue,
// translations, credits — is never trusted as markup (requirements-addendum §3).

/** Escape for HTML text and double/single-quoted attribute values. */
export const escapeHtml = (value: unknown): string =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

export const escapeAttr = escapeHtml;

/**
 * An image URL that is safe to put in `src`/`href`: http(s), blob: and data:image/* only (never
 * javascript:, data:text/html, file:…). Undefined otherwise.
 */
export function safeImageUrl(url: unknown): string | undefined {
  if (typeof url !== 'string') return undefined;
  const u = url.trim();
  if (!u) return undefined;
  if (/^https?:\/\//i.test(u) || /^blob:/i.test(u)) return u;
  if (/^data:image\/(png|jpe?g|webp|gif|avif);/i.test(u)) return u;
  return undefined;
}
