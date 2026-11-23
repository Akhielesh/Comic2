/** Public editorial identifiers follow the reader's ordinary seventeen-character share format. */
export const ORIGINAL_SLUGS = {
  tide: 'DSOriginalTide001',
  orchard: 'DSOriginalTree001',
  fox: 'DSOriginalFox0001',
  'table-nine': 'DSOriginalNine001'
} as const;
export type OriginalKey = keyof typeof ORIGINAL_SLUGS;
export const ORIGINAL_KEYS = Object.keys(ORIGINAL_SLUGS) as OriginalKey[];
const slugs: ReadonlySet<string> = new Set(Object.values(ORIGINAL_SLUGS));
export const isOriginalSlug = (slug: string): boolean => slugs.has(slug);
