import { collectionEdition, originalKeyForSlug, originalStoryPages, type OriginalKey } from '../../../shared/comic/originals';

const techniques: Partial<Record<OriginalKey, [string, string]>> = {
  orchard: ['Ligne claire', 'Fine, unbroken ink contours, flat turquoise and ochre colours, three cinematic tiers per page.'],
  fox: ['Ink and wash', 'Brush ink on warm paper, loose watercolour washes, generous pauses between scenes.'],
  'table-nine': ['Gouache cartoon', 'Mid-century gouache, bold halftone shadows and expressive comic timing.'],
  harbor: ['Coastal risograph', 'Ultramarine and marigold risograph layers, two panoramic panels on each page.'],
  margin: ['Black-and-white manga', 'Black ink and screentone, expressive close-ups and right-to-left panel order.'],
  parrots: ['Indian illustrated folktale', 'Fine ink and mineral watercolour with woven border motifs and captions beneath the artwork.'],
  bubble: ['Speech-bubble comedy', 'Bright cel-cartoon colour, elastic silhouettes and expressive balloon lettering.'],
  'glass-hills': ['Western travel poster', 'Cartographic details, cut-block silhouettes and broad panoramic views in an ochre and indigo palette.'],
  'night-atlas': ['Botanical cut paper', 'Layered hand-cut silhouettes and cyanotype botanical prints, using indigo, black and ivory.']
};

export function originalLook(slug: string) {
  const key = originalKeyForSlug(slug);
  if (!key) return;
  const technique = techniques[key];
  if (!technique) return;
  const edition = collectionEdition(key);
  const orientation = edition?.orientation ?? 'portrait';
  const rtl = edition?.readingDirection === 'rtl';
  const format = rtl ? 'Portrait · Right to left' : orientation === 'landscape' ? 'Landscape' : 'Portrait';
  return {
    label: technique[0], format, landscape: orientation === 'landscape',
    brief: `Format: ${originalStoryPages(key)}-page ${rtl ? 'manga' : 'comic'}, ${orientation}, ${rtl ? 'right to left' : 'left to right'}.\nArt direction: ${technique[0]}. ${technique[1]}`
  };
}

const pendingKey = 'comicstudio.library-look.v1';
/** Only the public edition identifier crosses the sign-in round trip in this tab. */
export function rememberOriginalLook(slug?: string) {
  try {
    if (slug && originalLook(slug)) sessionStorage.setItem(pendingKey, JSON.stringify({ slug, at: Date.now() }));
    else sessionStorage.removeItem(pendingKey);
  } catch { /* The current page still holds the selection in memory. */ }
}
export function pendingOriginalLook(): string | undefined {
  const url = new URL(window.location.href);
  const incoming = url.pathname === '/' && url.searchParams.get('view') === 'dashboard' ? url.searchParams.get('look') : null;
  if (incoming && originalLook(incoming)) return incoming;
  try {
    const saved = JSON.parse(sessionStorage.getItem(pendingKey) ?? 'null');
    const age = Date.now() - saved?.at;
    if (typeof saved?.slug === 'string' && originalLook(saved.slug) && age >= 0 && age < 30 * 60_000) return saved.slug;
    sessionStorage.removeItem(pendingKey);
  } catch { /* An unavailable or expired selection simply opens the ordinary form. */ }
}
