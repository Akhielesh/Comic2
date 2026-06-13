// Curated ranking of IMAGE models for comic generation.
//
// There's no clean public leaderboard for image models the way LMArena covers text, so this is a
// hand-curated, comic-relevant snapshot from public model cards + provider docs. For COMICS the
// decisive axis is reference / identity consistency (keeping a character on-model across panels),
// then prompt adherence, in-image text, and price. Figures are approximate and point-in-time —
// every entry carries a source link; verify pricing/size there. Keep entries ordered by `rank`.

export type ImageTier = 'flagship' | 'strong' | 'budget';

export interface RankedImageModel {
  rank: number;
  id: string;
  name: string;
  /** Maps to services/modelVendors VENDOR_META for the brand badge. */
  vendorId: string;
  tier: ImageTier;
  /** Native multi-image reference / identity consistency — the key trait for on-model characters. */
  referenceCapable: boolean;
  /** A recommended default for this app's comic flow. */
  preferred: boolean;
  /** Selectable in this app today (exists in services/imageModels.ts IMAGE_MODELS). */
  usableInApp: boolean;
  /** Rough public price per image (USD); varies by resolution/quality. */
  approxUsdPerImage?: number;
  /** Size note where the maker discloses it (most closed models don't). */
  size?: string;
  strengths: string[];
  note: string;
  source: string;
  sourceUrl: string;
  asOf: string;
}

export const IMAGE_MODEL_RANKING: RankedImageModel[] = [
  {
    rank: 1,
    id: 'gemini-3-pro-image-preview',
    name: 'Gemini 3 Pro Image (Nano Banana Pro)',
    vendorId: 'google',
    tier: 'flagship',
    referenceCapable: true,
    preferred: true,
    usableInApp: true,
    approxUsdPerImage: 0.13,
    strengths: ['Best-in-class character consistency', 'Legible in-image text', 'Strong multi-reference editing'],
    note: 'Top choice when on-model character consistency across panels matters most. Pro tier.',
    source: 'Google DeepMind — Gemini image generation', sourceUrl: 'https://ai.google.dev/gemini-api/docs/image-generation', asOf: '2026-Q1'
  },
  {
    rank: 2,
    id: 'gemini-2.5-flash-image-preview',
    name: 'Gemini 2.5 Flash Image (Nano Banana)',
    vendorId: 'google',
    tier: 'flagship',
    referenceCapable: true,
    preferred: true,
    usableInApp: true,
    approxUsdPerImage: 0.039,
    strengths: ['Excellent consistency for the price', 'Fast', 'Reference + edit in one call'],
    note: "The app's recommended workhorse — keeps characters on-model panel to panel, cheaply.",
    source: 'Google DeepMind — Gemini 2.5 Flash Image', sourceUrl: 'https://deepmind.google/models/gemini/', asOf: '2026-Q1'
  },
  {
    rank: 3,
    id: 'gpt-image-1',
    name: 'GPT-Image-1',
    vendorId: 'openai',
    tier: 'flagship',
    referenceCapable: true,
    preferred: false,
    usableInApp: false,
    approxUsdPerImage: 0.07,
    strengths: ['Strong instruction following', 'Reference + edit / inpaint', 'Good in-image text'],
    note: 'Excellent editing + reference support; direct OpenAI model id, not currently selectable through the app image router.',
    source: 'OpenAI — image generation', sourceUrl: 'https://platform.openai.com/docs/guides/image-generation', asOf: '2026-Q1'
  },
  {
    rank: 4,
    id: 'black-forest-labs/flux-1-kontext',
    name: 'FLUX.1 Kontext',
    vendorId: 'black-forest-labs',
    tier: 'strong',
    referenceCapable: true,
    preferred: false,
    usableInApp: false,
    approxUsdPerImage: 0.04,
    size: '12B (FLUX.1 family)',
    strengths: ['In-context editing', 'Character/style carry-over', 'Sharp linework'],
    note: 'Open-weight reference/editing model — good for consistent characters without a closed API.',
    source: 'Black Forest Labs — FLUX.1 Kontext', sourceUrl: 'https://bfl.ai/', asOf: '2026-Q1'
  },
  {
    rank: 5,
    id: 'bytedance/seedream-4',
    name: 'Seedream 4.0',
    vendorId: 'other',
    tier: 'flagship',
    referenceCapable: true,
    preferred: false,
    usableInApp: false,
    approxUsdPerImage: 0.03,
    strengths: ['High quality at low cost', 'Good consistency', 'Strong aesthetics'],
    note: 'Very competitive quality-per-dollar; strong on stylized art.',
    source: 'ByteDance Seedream', sourceUrl: 'https://www.volcengine.com/', asOf: '2026-Q1'
  },
  {
    rank: 6,
    id: 'ideogram/ideogram-v3',
    name: 'Ideogram v3',
    vendorId: 'ideogram',
    tier: 'strong',
    referenceCapable: false,
    preferred: false,
    usableInApp: false,
    approxUsdPerImage: 0.07,
    strengths: ['Best-in-class in-image text/typography', 'Posters & logos', 'Style references'],
    note: 'Unmatched for legible lettering and title/cover typography.',
    source: 'Ideogram', sourceUrl: 'https://about.ideogram.ai/', asOf: '2026-Q1'
  },
  {
    rank: 7,
    id: 'black-forest-labs/flux-1.1-pro',
    name: 'FLUX 1.1 Pro',
    vendorId: 'black-forest-labs',
    tier: 'strong',
    referenceCapable: false,
    preferred: false,
    usableInApp: false,
    approxUsdPerImage: 0.04,
    size: '12B (FLUX.1 family)',
    strengths: ['Excellent prompt adherence', 'Crisp detail', 'Fast'],
    note: 'Great single-image quality, but no native multi-panel character reference.',
    source: 'Black Forest Labs — FLUX 1.1 Pro', sourceUrl: 'https://bfl.ai/', asOf: '2026-Q1'
  },
  {
    rank: 8,
    id: 'qwen/qwen-image',
    name: 'Qwen-Image',
    vendorId: 'qwen',
    tier: 'strong',
    referenceCapable: false,
    preferred: false,
    usableInApp: false,
    approxUsdPerImage: 0.02,
    size: '20B MMDiT',
    strengths: ['Open weights', 'Strong in-image text (incl. CJK)', 'Cheap'],
    note: 'Best open-weight option for text-in-image; no native identity reference.',
    source: 'Qwen-Image', sourceUrl: 'https://qwenlm.github.io/blog/qwen-image/', asOf: '2026-Q1'
  },
  {
    rank: 9,
    id: 'ideogram/ideogram-v2-turbo',
    name: 'Ideogram 2.0 Turbo',
    vendorId: 'ideogram',
    tier: 'budget',
    referenceCapable: false,
    preferred: false,
    usableInApp: true,
    approxUsdPerImage: 0.05,
    strengths: ['Fast', 'Good text rendering', 'Cheaper than v3'],
    note: 'Budget Ideogram for quick text-forward panels/covers.',
    source: 'Ideogram', sourceUrl: 'https://about.ideogram.ai/', asOf: '2025-Q4'
  },
  {
    rank: 10,
    id: 'pixazo/flux-1-schnell',
    name: 'Flux Schnell (free)',
    vendorId: 'black-forest-labs',
    tier: 'budget',
    referenceCapable: false,
    preferred: true,
    usableInApp: true,
    approxUsdPerImage: 0,
    size: '12B distilled (4-step)',
    strengths: ['Free via Pixazo', 'Fast 4-step', 'Decent quality'],
    note: 'Recommended free/budget default when character reference is not required.',
    source: 'Black Forest Labs — FLUX.1 [schnell]', sourceUrl: 'https://huggingface.co/black-forest-labs/FLUX.1-schnell', asOf: '2026-Q1'
  },
];

/** Models flagged as recommended defaults for this app's comic flow. */
export const preferredImageModels = (): RankedImageModel[] => IMAGE_MODEL_RANKING.filter((m) => m.preferred);

/** Reference / identity-consistent models — the ones that keep a character on-model across panels. */
export const referenceCapableImageModels = (): RankedImageModel[] => IMAGE_MODEL_RANKING.filter((m) => m.referenceCapable);

export const formatImagePrice = (m: RankedImageModel): string =>
  m.approxUsdPerImage === undefined ? '—' : m.approxUsdPerImage === 0 ? 'Free' : `~$${m.approxUsdPerImage.toFixed(3)}/img`;
