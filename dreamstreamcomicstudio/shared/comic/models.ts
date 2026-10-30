// Image-model capability registry for Comic Studio (v4).
//
// Every image job is routed by CAPABILITY, not by a hard-coded id: the prompt
// compiler reads `refs` caps to decide how many character sheets / places / style
// anchors fit, `aspects`/`resolutions` to validate the request, `text` to decide if
// in-art lettering is safe, and `priceUsd` to estimate spend before anything runs.
// Adding a new model = adding one entry here (or letting the server's live sync from
// OpenRouter's /api/v1/images/models refresh caps for an existing one).
//
// Facts below were verified 2026-10-21 against Google's Gemini API docs + pricing page
// and OpenRouter's live /api/v1/images/models listing, and re-checked 2026-10-22 (models.md §1,
// `factsAsOf` per entry). Prices are provider list prices in USD per output image (before markup).
// Quality grades cite a public board (`gradeSources`) or say "our judgement" — never a guess
// dressed as a fact. Entries are never deleted (a comic may be locked to one); they are hidden
// with `pickable: false`.

import type { AspectRatio, ImageModelLock, LetteringMode, QualityTier, Resolution } from './doc.js';

export type ImageRoute = 'openrouter' | 'gemini';
export type Quality4 = 'none' | 'basic' | 'good' | 'excellent';

export interface ImageModelSpec {
  /** Registry id (stable, ours). */
  id: string;
  label: string;
  /** Friendly name users see. */
  nickname: string;
  vendor: 'google' | 'openai' | 'bfl' | 'bytedance';
  /** Provider-specific model ids per transport. */
  routes: Partial<Record<ImageRoute, string>>;
  lifecycle: 'ga' | 'preview' | 'deprecated' | 'experimental';
  replacement?: string;
  /** Reference-image caps (Gemini docs table). style=0 means style refs are not a distinct class — send as objects. */
  refs: { total: number; characters: number; objects: number; style: number };
  aspects: AspectRatio[];
  /** Empty = the transport does not take a resolution parameter (fixed output size). */
  resolutions: Resolution[];
  /** In-image lettering quality. */
  text: Quality4;
  /** How well it composes a full multi-panel comic page in one image. */
  pages: Quality4;
  /** Instruction editing of an existing image passed as reference 1. */
  edit: Quality4;
  priceUsd: Partial<Record<Resolution, number>>;
  /** Typical seconds per image (for progress UI). */
  latencySec: number;
  /** Hard timeout per call. */
  timeoutMs: number;
  /** Request parameters the model rejects — stripped before sending. */
  unsupported?: string[];
  blurb: string;
  // ── models.md §3.3 (2026-10-22) ──
  /** Shown in the picker. Hidden entries stay resolvable for comics locked to them. */
  pickable: boolean;
  /** Transport per route; absent = 'chat' (today's /chat/completions path). 'images' = OpenRouter's Images API. */
  api?: Partial<Record<ImageRoute, 'chat' | 'images'>>;
  /** Models billed per quality level are pinned to the level the boards measured. */
  fixedQuality?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** Vendor charge per reference image sent (USD). Absent = unpublished / UNVERIFIED (never 0 by assumption). */
  perRefUsd?: number;
  /** What `priceUsd` is: a published per-image price, a vendor tokens-per-image table × token price, derived
   *  from megapixels, or unverified (shown as "price list from {factsAsOf}"). */
  priceBasis: 'per_image' | 'per_token_table' | 'per_megapixel' | 'unverified';
  /** ISO date the prices and caps were last checked against the vendor / OpenRouter. */
  factsAsOf: string;
  /** Where each quality grade comes from (a board + rank, or "our judgement"). */
  gradeSources?: Partial<Record<'text' | 'pages' | 'edit', string>>;
}

const GEMINI_ASPECTS_FULL: AspectRatio[] = ['1:1', '1:4', '1:8', '2:3', '3:2', '3:4', '4:1', '4:3', '4:5', '5:4', '8:1', '9:16', '16:9', '21:9'];
const GEMINI_ASPECTS_PRO: AspectRatio[] = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];

export const IMAGE_MODELS: ImageModelSpec[] = [
  {
    id: 'nano-banana-2.1',
    label: 'Gemini Nano Banana 2.1',
    nickname: 'Nano Banana 2.1',
    vendor: 'google',
    routes: { openrouter: 'google/gemini-nano-banana-2.1', gemini: 'gemini-nano-banana-2.1' },
    lifecycle: 'ga',
    refs: { total: 14, characters: 4, objects: 10, style: 0 },
    aspects: GEMINI_ASPECTS_FULL,
    resolutions: ['1K', '2K', '4K'],
    // AA text rendering #5, AA Edit #4, LMArena edit #5 (2026-10-22). Pages: no board measures page composition.
    text: 'good',
    pages: 'good',
    edit: 'excellent',
    gradeSources: { text: 'AA text rendering #5 (2026-10-22)', pages: 'our judgement', edit: 'AA Edit #4 · LMArena edit #5 (2026-10-22)' },
    // Google pricing page: 1120 / 1680 tokens × $30/M. 4K is $0.113 on one Google page and $0.076 on another; we
    // quote the higher (models.md §1.6). Reference input is billed per token; tokens per reference UNVERIFIED.
    priceUsd: { '1K': 0.0336, '2K': 0.0504, '4K': 0.113 },
    priceBasis: 'per_token_table',
    factsAsOf: '2026-10-22',
    pickable: true,
    api: { openrouter: 'chat', gemini: 'chat' },
    latencySec: 20,
    timeoutMs: 150_000,
    unsupported: ['seed', 'temperature'],
    blurb: 'Fast, sharp and consistent — keeps up to 4 characters on model. The everyday default.'
  },
  {
    id: 'nano-banana-pro',
    label: 'Gemini 3 Pro Image',
    nickname: 'Nano Banana Pro',
    vendor: 'google',
    routes: { openrouter: 'google/gemini-3-pro-image', gemini: 'gemini-3-pro-image' },
    lifecycle: 'ga',
    refs: { total: 14, characters: 5, objects: 6, style: 3 },
    aspects: GEMINI_ASPECTS_PRO,
    resolutions: ['1K', '2K', '4K'],
    // Ranks below Nano Banana 2.1 on every board in models.md §1.2 (AA text rendering #12 vs #5), so it is no
    // longer rated above it. Its edge is capacity: 5 characters + a separate style-reference class.
    text: 'good',
    pages: 'good',
    edit: 'good',
    gradeSources: { text: 'AA text rendering #12 (2026-10-22)', pages: 'our judgement', edit: 'AA Edit #16 · LMArena edit #13 (2026-10-22)' },
    // Google pricing page: 1120 tokens × $120/M = $0.1344 at 1K and 2K (models.md §1.1 #2); observed
    // $0.134–0.138 (§1.3). The list figure is stored unrounded so a quote never under-reads it (§2.3).
    priceUsd: { '1K': 0.1344, '2K': 0.1344, '4K': 0.24 },
    priceBasis: 'per_token_table',
    perRefUsd: 0.0011, // 560 tokens per reference image [G]
    factsAsOf: '2026-10-22',
    pickable: true,
    api: { openrouter: 'chat', gemini: 'chat' },
    latencySec: 35,
    timeoutMs: 210_000,
    unsupported: ['seed', 'temperature'],
    blurb: 'Holds 5 characters per image, plus style references. 2K at the 1K price; about 2.7× the cost of Nano Banana 2.1.'
  },
  {
    id: 'nano-banana-2',
    label: 'Gemini 3.1 Flash Image',
    nickname: 'Nano Banana 2',
    vendor: 'google',
    routes: { openrouter: 'google/gemini-3.1-flash-image', gemini: 'gemini-3.1-flash-image' },
    lifecycle: 'deprecated',
    replacement: 'nano-banana-2.1',
    refs: { total: 14, characters: 4, objects: 10, style: 0 },
    aspects: GEMINI_ASPECTS_FULL,
    resolutions: ['512', '1K', '2K', '4K'],
    text: 'good',
    pages: 'good',
    edit: 'good',
    gradeSources: { text: 'AA text rendering #11 (2026-10-22)', pages: 'our judgement', edit: 'AA Edit #12 · LMArena edit #14 (2026-10-22)' },
    priceUsd: { '512': 0.045, '1K': 0.067, '2K': 0.101, '4K': 0.151 },
    priceBasis: 'per_token_table',
    factsAsOf: '2026-10-21',
    pickable: false, // existing comics only
    latencySec: 20,
    timeoutMs: 150_000,
    unsupported: ['seed', 'temperature'],
    blurb: 'Previous Flash image model (deprecated Oct 2026 — superseded by 2.1).'
  },
  {
    id: 'nano-banana-lite',
    label: 'Gemini 3.1 Flash Lite Image',
    nickname: 'Nano Banana Lite',
    vendor: 'google',
    routes: { openrouter: 'google/gemini-3.1-flash-lite-image', gemini: 'gemini-3.1-flash-lite-image' },
    lifecycle: 'ga',
    // No character-resemblance support — fine for style swatches, not for cast.
    refs: { total: 14, characters: 0, objects: 14, style: 0 },
    aspects: GEMINI_ASPECTS_FULL,
    resolutions: ['1K'],
    text: 'basic',
    pages: 'basic',
    edit: 'basic',
    gradeSources: { text: 'AA text rendering #14 (2026-10-22)', pages: 'our judgement', edit: 'AA Edit #32 (2026-10-22)' },
    priceUsd: { '1K': 0.0336 },
    priceBasis: 'per_token_table',
    factsAsOf: '2026-10-21',
    pickable: false, // not used by any default
    latencySec: 10,
    timeoutMs: 90_000,
    unsupported: ['seed', 'temperature'],
    blurb: 'Fastest/cheapest; cannot hold character identity — used only for style swatches.'
  },
  {
    id: 'gpt-image-2.5',
    label: 'OpenAI GPT Image 2.5 Sunburst',
    nickname: 'GPT Image 2.5',
    vendor: 'openai',
    routes: { openrouter: 'openai/gpt-image-2.5-sunburst' },
    lifecycle: 'experimental',
    refs: { total: 16, characters: 4, objects: 12, style: 0 },
    // No 4:5 through OpenRouter (models.md §1.1 #5).
    aspects: ['1:1', '3:2', '2:3', '4:3', '3:4', '16:9', '9:16', '21:9'],
    // The transport takes no resolution parameter: output is a fixed size per aspect (1024² / 1024×1536).
    resolutions: [],
    text: 'excellent',
    pages: 'good',
    edit: 'excellent',
    gradeSources: { text: 'AA text rendering #2 (2026-10-22)', pages: 'our judgement', edit: 'AA Edit #1 · LMArena edit #1 (2026-10-22)' },
    // Pinned to quality 'max' — the level the boards measured. $0.2107 per 1024² image in output tokens (OpenAI
    // calculator, matched by AA's $210.72/1k). 2:3 at 1024×1536 is ≈$0.1646 (output only; reference input unpriced).
    // Basis: OpenAI calculator token factor (max = 96) × $30/M output tokens — a token table, not a published
    // per-image price; reference input is unpriced, so totals are estimates (models.md §1.6 #1, §3.5 ex. 3, §3.6 C).
    priceUsd: { '1K': 0.2107 },
    priceBasis: 'per_token_table',
    fixedQuality: 'max',
    factsAsOf: '2026-10-22',
    // Hidden until the Images-API transport exists and the owner's smoke test (models.md §2.6 D2) passes.
    pickable: false,
    api: { openrouter: 'images' },
    latencySec: 24,
    timeoutMs: 240_000,
    blurb: 'Quality leader on every public board. Slow, about 6× the price, and no 4:5 pages. Experimental in Comic Studio.'
  },
  {
    id: 'gpt-image-2.5-flare',
    label: 'OpenAI GPT Image 2.5 Flare',
    nickname: 'GPT Image 2.5 Flare',
    vendor: 'openai',
    routes: { openrouter: 'openai/gpt-image-2.5-flare' },
    lifecycle: 'experimental',
    refs: { total: 16, characters: 4, objects: 12, style: 0 },
    aspects: ['1:1', '3:2', '2:3', '4:3', '3:4', '16:9', '9:16', '21:9'],
    resolutions: [],
    text: 'excellent',
    pages: 'good',
    edit: 'excellent',
    gradeSources: { text: 'AA text rendering #3 (2026-10-22)', pages: 'our judgement', edit: 'AA Edit #2 · LMArena edit #2 (2026-10-22)' },
    // Same basis as Sunburst: OpenAI calculator, output tokens only; reference input unpriced → totals are estimates.
    priceUsd: { '1K': 0.2107 },
    priceBasis: 'per_token_table',
    fixedQuality: 'max',
    factsAsOf: '2026-10-22',
    pickable: false, // same gating as Sunburst (D2)
    api: { openrouter: 'images' },
    latencySec: 15,
    timeoutMs: 240_000,
    blurb: '#2 on every public board and faster than Sunburst (p50 15 s). Same price and limits. Experimental in Comic Studio.'
  },
  {
    id: 'flux-3',
    label: 'FLUX.3 Image',
    nickname: 'FLUX.3',
    vendor: 'bfl',
    routes: { openrouter: 'black-forest-labs/flux-3-image' },
    lifecycle: 'experimental',
    refs: { total: 10, characters: 4, objects: 6, style: 0 },
    aspects: ['21:9', '16:9', '3:2', '4:3', '5:4', '1:1', '4:5', '3:4', '2:3', '9:16'],
    // No 4K: the provider caps output at 4,194,304 px whenever references are sent (models.md §1.4 #16/17, §1.6 #7),
    // and every comic image carries references. nearestResolution snaps a 4K tier request to 2K instead of failing.
    resolutions: ['1K', '2K'],
    text: 'good',
    pages: 'basic',
    edit: 'good',
    gradeSources: { text: 'AA text rendering #10 (2026-10-22)', pages: 'our judgement', edit: 'our judgement (not on an edit board, 2026-10-22)' },
    priceUsd: { '1K': 0.048, '2K': 0.1 },
    priceBasis: 'per_image',
    factsAsOf: '2026-10-22',
    // Removed from the picker (models.md §2.2): unpinnable `latest`, ≤ 4 MP with references, and BFL's service
    // terms allow training on inputs and outputs. The entry stays so any comic drawn with it still resolves.
    pickable: false,
    latencySec: 25,
    timeoutMs: 150_000,
    blurb: 'Painterly, cinematic frames. Weaker at multi-panel pages. Experimental.'
  },
  {
    id: 'seedream-5-pro',
    label: 'Seedream 5.0 Pro',
    nickname: 'Seedream 5 Pro',
    vendor: 'bytedance',
    routes: { openrouter: 'bytedance-seed/seedream-5-0-pro' },
    lifecycle: 'experimental',
    refs: { total: 10, characters: 4, objects: 6, style: 0 }, // vendor cap 10 (models.md §1.1 #13)
    aspects: ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'],
    resolutions: ['1K', '2K'],
    text: 'basic',
    pages: 'good',
    edit: 'good',
    gradeSources: { text: 'AA text rendering #17 (2026-10-22)', pages: 'our judgement', edit: 'AA Edit #8 · LMArena multi-image edit #6 (2026-10-22)' },
    // OpenRouter endpoint price: $0.045 at 1K. 2K is omitted until the "high_resolution" variant mapping is verified
    // (quotes for 2K have no number). Hidden until the watermark check (models.md §2.6 D3) passes.
    priceUsd: { '1K': 0.045 },
    priceBasis: 'per_image',
    perRefUsd: 0.003,
    factsAsOf: '2026-10-22',
    pickable: false,
    latencySec: 58,
    timeoutMs: 150_000,
    blurb: 'Strong manga/anime rendering and multi-reference. Slow (p50 58 s). Experimental.'
  },
  {
    id: 'nano-banana-legacy',
    label: 'Gemini 2.5 Flash Image',
    nickname: 'Nano Banana (legacy)',
    vendor: 'google',
    routes: { openrouter: 'google/gemini-2.5-flash-image', gemini: 'gemini-2.5-flash-image' },
    lifecycle: 'deprecated',
    // Google names Lite as the replacement, but Lite cannot hold characters. `replacement` is DISPLAY-ONLY: no
    // code path may resolve a locked id to its replacement (models.md §3.4 item 7.2).
    replacement: 'nano-banana-2.1',
    refs: { total: 3, characters: 2, objects: 1, style: 0 },
    aspects: GEMINI_ASPECTS_PRO,
    resolutions: [],
    text: 'basic',
    pages: 'basic',
    edit: 'good',
    gradeSources: { text: 'AA text rendering #56 (2026-10-22)', pages: 'our judgement', edit: 'our judgement (AA Edit #53; edits of old projects still work)' },
    priceUsd: { '1K': 0.039 },
    priceBasis: 'per_token_table',
    factsAsOf: '2026-10-21',
    pickable: false, // existing comics only
    latencySec: 12,
    timeoutMs: 90_000,
    blurb: 'Legacy model (3 references max). Kept only so old projects can be re-edited.'
  }
];

/** Models a user may pick (hidden entries stay resolvable for the comics locked to them). */
export const pickableImageModels = (): ImageModelSpec[] => IMAGE_MODELS.filter((m) => m.pickable);

export const getImageModel = (id?: string): ImageModelSpec | undefined =>
  id ? IMAGE_MODELS.find((m) => m.id === id || Object.values(m.routes).includes(id)) : undefined;

// ── Quality tiers ─────────────────────────────────────────────────────────────

export interface TierPreset {
  tier: QualityTier;
  label: string;
  blurb: string;
  model: string;
  pageRes: Resolution;
  sheetRes: Resolution;
  coverModel: string;
  coverRes: Resolution;
  /** Lettering the tier recommends when the user hasn't chosen. */
  lettering: LetteringMode;
}

/**
 * Owner decision 2026-10-22 (models.md §2.1): the Pro tier becomes Nano Banana 2.1 at 4K for pages and the cover
 * (2K sheets) — it ranks above Nano Banana Pro on every board and costs less. Off until the owner's real 4K check
 * (§2.6 D1: cost, pixel size, latency, storage) passes; while off, Pro stays Nano Banana Pro at 2K as today.
 * Flip here only (PROD STEPS); tierPresetsFor() exists so both shapes stay tested.
 */
export const PRO_TIER_4K = false;

export const tierPresetsFor = (pro4k: boolean): Record<QualityTier, TierPreset> => ({
  draft: {
    tier: 'draft',
    label: 'Draft',
    blurb: 'Quick 1K pages to test the story. Re-render the keepers later.',
    model: 'nano-banana-2.1',
    pageRes: '1K',
    sheetRes: '1K',
    coverModel: 'nano-banana-2.1',
    coverRes: '1K',
    lettering: 'overlay'
  },
  standard: {
    tier: 'standard',
    label: 'Standard',
    blurb: 'Crisp 2K pages with consistent characters — the sweet spot.',
    model: 'nano-banana-2.1',
    pageRes: '2K',
    sheetRes: '2K',
    coverModel: 'nano-banana-2.1',
    coverRes: '2K',
    lettering: 'overlay'
  },
  pro: pro4k
    ? {
        tier: 'pro',
        label: 'Pro',
        blurb: 'Nano Banana 2.1 at 4K for pages and the cover (2K character sheets) — the same model, the sharpest print size.',
        model: 'nano-banana-2.1',
        pageRes: '4K',
        sheetRes: '2K',
        coverModel: 'nano-banana-2.1',
        coverRes: '4K',
        lettering: 'overlay'
      }
    : {
        tier: 'pro',
        label: 'Pro',
        // Honest copy: Pro holds 5 characters and a style-reference class; the boards rank Nano Banana 2.1 above it.
        blurb: 'Nano Banana Pro: holds up to 5 characters per page plus style references, at about 2.7× the price.',
        model: 'nano-banana-pro',
        pageRes: '2K',
        sheetRes: '2K',
        coverModel: 'nano-banana-pro',
        coverRes: '2K',
        // v5: overlay by default (in_art is an explicit opt-in). Existing docs keep their own format.lettering.
        lettering: 'overlay'
      }
});

export const TIER_PRESETS: Record<QualityTier, TierPreset> = tierPresetsFor(PRO_TIER_4K);

/** Style exploration is always cheap: small swatch boards on the everyday model. */
export const STYLE_OPTION_MODEL = 'nano-banana-2.1';
export const STYLE_OPTION_RES: Resolution = '1K';

/**
 * Ship 2 (pro plan §5.2 "ImageJobKind += 'panel'"): 'panel' is one panel of a page redrawn or drawn (fix_panel) — the
 * lock's model at the page tier one step down (PANEL_RES_STEP), with one QC run in the quote. K2a kept it in a separate
 * union until the server's exhaustive map (jobs.ts imageOperation) listed it; K2b folded it in.
 */
export type ImageJobKind = 'style_option' | 'sheet' | 'place' | 'page' | 'edit' | 'cover' | 'panel';
/** Alias kept for K2a's callers (every image job kind, 'panel' included). */
export type AnyImageJobKind = ImageJobKind;
export const PANEL_JOB_KIND = 'panel' as const;
/** A panel draws one resolution step below its page (2K → 1K, 4K → 2K; 1K and 512 stay). */
export const PANEL_RES_STEP: Readonly<Record<Resolution, Resolution>> = { '512': '512', '1K': '1K', '2K': '1K', '4K': '2K' };

export interface ResolvedImageJob {
  spec: ImageModelSpec;
  resolution: Resolution;
}

export const nearestResolution = (spec: ImageModelSpec, want: Resolution): Resolution => {
  if (!spec.resolutions.length) return want;
  if (spec.resolutions.includes(want)) return want;
  const order: Resolution[] = ['512', '1K', '2K', '4K'];
  const wantIdx = order.indexOf(want);
  return spec.resolutions.reduce((best, r) =>
    Math.abs(order.indexOf(r) - wantIdx) < Math.abs(order.indexOf(best) - wantIdx) ? r : best
  );
};

/**
 * Which model + resolution a job runs on for a tier (an explicit override wins when it is usable).
 * With a lock (models.md §3.4 item 1) the spec is the locked model for EVERY kind, style swatches included;
 * the tier and the override only pick the resolution. A lock whose id the registry no longer knows falls
 * through to the unlocked resolution — the server's invariant (spec.id === doc.imageModel.modelId) then
 * refuses the job with MODEL_LOCKED before any provider call, so nothing is ever drawn on another model.
 */
export const resolveImageJob = (kind: AnyImageJobKind, tier: QualityTier, override?: string, lock?: ImageModelLock): ResolvedImageJob => {
  const preset = TIER_PRESETS[tier] || TIER_PRESETS.standard;
  const overrideSpec = getImageModel(override);
  const locked = lock ? getImageModel(lock.modelId) : undefined;
  if (locked) {
    const want: Resolution =
      kind === 'style_option'
        ? STYLE_OPTION_RES
        : kind === 'cover'
          ? preset.coverRes
          : kind === 'page' || kind === 'edit'
            ? preset.pageRes
            : kind === 'panel'
              ? PANEL_RES_STEP[preset.pageRes]
              : preset.sheetRes;
    return { spec: locked, resolution: nearestResolution(locked, want) };
  }
  if (kind === 'panel') {
    // Ship 2: the page's model (as a page job resolves it) one resolution step down.
    const spec = overrideSpec || getImageModel(preset.model)!;
    return { spec, resolution: nearestResolution(spec, PANEL_RES_STEP[preset.pageRes]) };
  }
  if (kind === 'style_option') {
    const spec = getImageModel(STYLE_OPTION_MODEL)!;
    return { spec, resolution: nearestResolution(spec, STYLE_OPTION_RES) };
  }
  if (kind === 'cover') {
    const spec = overrideSpec || getImageModel(preset.coverModel)!;
    return { spec, resolution: nearestResolution(spec, preset.coverRes) };
  }
  const spec = overrideSpec || getImageModel(preset.model)!;
  const want = kind === 'page' || kind === 'edit' ? preset.pageRes : preset.sheetRes;
  return { spec, resolution: nearestResolution(spec, want) };
};

/** Closest supported aspect ratio to the requested one (by numeric ratio). */
export const nearestAspect = (spec: ImageModelSpec, want: AspectRatio): AspectRatio => {
  if (spec.aspects.includes(want)) return want;
  const value = (a: string) => {
    const [w, h] = a.split(':').map(Number);
    return w / h;
  };
  const target = Math.log(value(want));
  return spec.aspects.reduce((best, a) =>
    Math.abs(Math.log(value(a)) - target) < Math.abs(Math.log(value(best)) - target) ? a : best
  );
};

// ── Cost ─────────────────────────────────────────────────────────────────────

/** DreamStream's platform markup over provider cost (matches server pricingCatalog DEFAULT_MARKUP). */
export const PLATFORM_MARKUP = 1.3;
/** Vision QC pass per page (Flash-class model, one image in, small JSON out). */
export const QC_USD_PER_PAGE = 0.003;
/** Writer/director text spend for planning a page (strong model). */
export const PLAN_USD_PER_PAGE = 0.012;
/** Writer call that proposes style directions when render_style_options has none (provider cost; P2-AMEND —
 *  single source for jobs.ts and the StylePanel quote). */
export const STYLE_DIRECTIONS_USD = 0.015;
/** The style-directions writer line as quoted to this user (markup unless BYOK), rounded like estimateJobs. */
export const styleDirectionsUsd = (byok = false): number => Math.round(STYLE_DIRECTIONS_USD * (byok ? 1 : PLATFORM_MARKUP) * 10000) / 10000;

export const imagePriceUsd = (spec: ImageModelSpec, resolution: Resolution): number => {
  const direct = spec.priceUsd[resolution];
  if (typeof direct === 'number') return direct;
  const values = Object.values(spec.priceUsd).filter((v): v is number => typeof v === 'number');
  return values.length ? Math.max(...values) : 0.1;
};

export interface SpendEstimate {
  usd: number;
  imageCount: number;
  model: string;
  lines: { label: string; count: number; usd: number }[];
}

export const estimateJobs = (
  jobs: { kind: AnyImageJobKind; count: number; label?: string }[],
  tier: QualityTier,
  opts: { override?: string; byok?: boolean; lock?: ImageModelLock } = {}
): SpendEstimate => {
  const markup = opts.byok ? 1 : PLATFORM_MARKUP;
  const lines = jobs
    .filter((j) => j.count > 0)
    .map((j) => {
      const { spec, resolution } = resolveImageJob(j.kind, tier, opts.override, opts.lock);
      // Page, edit and (Ship 2) panel jobs carry one QC run each.
      const per = imagePriceUsd(spec, resolution) + (j.kind === 'page' || j.kind === 'edit' || j.kind === 'panel' ? QC_USD_PER_PAGE : 0);
      return {
        label: j.label || j.kind,
        count: j.count,
        usd: Math.round(per * j.count * markup * 10000) / 10000,
        model: spec.nickname
      };
    });
  const usd = Math.round(lines.reduce((s, l) => s + l.usd, 0) * 10000) / 10000;
  const imageCount = lines.reduce((s, l) => s + l.count, 0);
  const primary = lines.find((l) => l.label.includes('page')) || lines[0];
  return {
    usd,
    imageCount,
    model: (primary as { model?: string } | undefined)?.model || resolveImageJob('page', tier, opts.override, opts.lock).spec.nickname,
    lines: lines.map(({ label, count, usd: u }) => ({ label, count, usd: u }))
  };
};

/** "≈ $0.42" style display (two decimals, at least $0.01 when non-zero). */
export const formatUsd = (usd: number): string => {
  if (!Number.isFinite(usd) || usd <= 0) return '$0.00';
  if (usd < 0.01) return '<$0.01';
  return `$${usd.toFixed(2)}`;
};

/** Per-page display price for a tier (with markup unless BYOK). */
// ── Aspect checks (one definition for the server check, the badges and the library) ──

/** |ln(actual w/h) − ln(target)| tolerance. */
export const ASPECT_TOLERANCE = 0.03;
const ASPECTS: AspectRatio[] = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9', '1:4', '4:1', '1:8', '8:1'];
/** '4:5' → 0.8 */
export const aspectRatioOf = (a: AspectRatio): number => {
  const [w, h] = String(a).split(':').map(Number);
  return w > 0 && h > 0 ? w / h : 1;
};
/** Unknown dimensions ⇒ true (never flag what we cannot measure). */
export const aspectMatches = (want: AspectRatio, w?: number, h?: number, tol = ASPECT_TOLERANCE): boolean => {
  if (!w || !h || !Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return true;
  return Math.abs(Math.log(w / h) - Math.log(aspectRatioOf(want))) <= tol;
};
/** Nearest known ratio for a size (old assets, badges: "came back 1:1"). */
export const aspectFromSize = (w: number, h: number): AspectRatio => {
  if (!(w > 0) || !(h > 0)) return '1:1';
  const target = Math.log(w / h);
  return ASPECTS.reduce((best, a) =>
    Math.abs(Math.log(aspectRatioOf(a)) - target) < Math.abs(Math.log(aspectRatioOf(best)) - target) ? a : best
  );
};

// ── Platform / safety cost constants ──

/** relayout_balloons {useVision:true} quote (one vision call; QC-priced). */
export const RELAYOUT_VISION_USD = QC_USD_PER_PAGE;
/** Platform-paid safety check estimates (never billed to the user; for logs/admin cost tiles). */
export const SAFETY_CHECK_USD = 0.0012; // ≤768 px image check
export const SAFETY_TEXT_USD = 0.0002; // text classifier, short input
/** Platform-owned library spend (no markup): image + analysis per asset. 0.15 when the model is unknown. */
export const libraryAssetCostUsd = (modelId: string, res: Resolution): number => {
  const spec = getImageModel(modelId);
  return spec ? Math.round((imagePriceUsd(spec, res) + QC_USD_PER_PAGE) * 10000) / 10000 : 0.15;
};

export const tierPagePrice = (tier: QualityTier, byok = false): number => {
  const { spec, resolution } = resolveImageJob('page', tier);
  return (imagePriceUsd(spec, resolution) + QC_USD_PER_PAGE) * (byok ? 1 : PLATFORM_MARKUP);
};

/** Ship 2: per-panel display price for a tier (one panel one resolution step down + its QC; markup unless BYOK). */
export const tierPanelPrice = (tier: QualityTier, byok = false): number => {
  const { spec, resolution } = resolveImageJob('panel', tier);
  return (imagePriceUsd(spec, resolution) + QC_USD_PER_PAGE) * (byok ? 1 : PLATFORM_MARKUP);
};
