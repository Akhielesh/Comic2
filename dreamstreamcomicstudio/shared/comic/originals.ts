/** Public editorial identifiers follow the reader's ordinary seventeen-character share format. */
export const ORIGINAL_SLUGS = {
  tide: 'DSOriginalTide001',
  orchard: 'DSOriginalTree001',
  fox: 'DSOriginalFox0001',
  'table-nine': 'DSOriginalNine001',
  harbor: 'DSOriginalPort001'
} as const;
export type OriginalKey = keyof typeof ORIGINAL_SLUGS;
export const ORIGINAL_KEYS = Object.keys(ORIGINAL_SLUGS) as OriginalKey[];
/** A held edition keeps its original identifier and private audit history. Only current books enter the publisher. */
export const PUBLISHABLE_ORIGINAL_KEYS = ['orchard', 'fox', 'table-nine', 'harbor'] as const satisfies readonly OriginalKey[];
const publishableKeys: ReadonlySet<string> = new Set(PUBLISHABLE_ORIGINAL_KEYS);
export const isPublishableOriginal = (key: string): boolean => publishableKeys.has(key);

const slugs: ReadonlySet<string> = new Set(Object.values(ORIGINAL_SLUGS));
export const isOriginalSlug = (slug: string): boolean => slugs.has(slug);
