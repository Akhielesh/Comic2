export const IMAGE_RATIOS = ['1:1', '4:3', '3:4', '16:9', '9:16'] as const;
export type StandaloneRatio = typeof IMAGE_RATIOS[number];
export type ImageFormatChoice = StandaloneRatio | 'auto';

/** Translate unambiguous format requests. Leave other compositions up to the image model. */
export function suggestedImageRatio(brief: string): StandaloneRatio | undefined {
  const text = brief.toLowerCase();
  const matchedRatios = new Set([...text.matchAll(/\b(\d+)\s*[:×x]\s*(\d+)\b/g)].map(match => `${match[1]}:${match[2]}`));
  if (matchedRatios.size) {
    const explicit = IMAGE_RATIOS.filter(ratio => matchedRatios.has(ratio));
    return matchedRatios.size === 1 && explicit.length === 1 ? explicit[0] : undefined;
  }
  // A negated or conflicting description needs context. Pass it through to the model untouched.
  if (/\b(?:not|avoid|without|instead of)\s+(?:a |an |the )?(?:portrait|landscape|square|wide|tall|vertical|horizontal|panoram)/.test(text)) return undefined;
  const formats: Array<[StandaloneRatio, RegExp]> = [
    ['9:16', /\b(?:(?:phone|mobile|smartphone) (?:wallpaper|background)|(?:vertical|tall) (?:frame|format|composition)|instagram stor(?:y|ies))\b/],
    ['16:9', /\b(?:widescreen|panoram(?:a|ic)|desktop wallpaper|(?:wide|horizontal) (?:banner|frame|format|composition)|youtube thumbnail)\b/],
    ['1:1', /\b(?:album (?:art|cover)|square (?:image|canvas|format|composition))\b/],
    ['3:4', /\b(?:book (?:jacket|cover)|portrait (?:orientation|format|composition))\b/],
    ['4:3', /\blandscape (?:orientation|format|composition)\b/]
  ];
  const matches = formats.filter(([, pattern]) => pattern.test(text));
  return matches.length === 1 ? matches[0][0] : undefined;
}

export const STANDALONE_MODEL = 'gemini-2.5-flash-image';
export const IMAGE_PROMPT_LIMIT = 4000;
export const MAX_IMAGE_REFS = 3;
export const MAX_REF_BYTES = 2 * 1024 * 1024;
export const REF_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

export interface SavedStandaloneImage {
  imageId: string;
  imageUrl: string;
  createdAt: string;
}

export interface StandaloneGallery {
  images: SavedStandaloneImage[];
  hasMore: boolean;
}
