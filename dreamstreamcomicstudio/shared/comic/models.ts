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
// and OpenRouter's live /api/v1/images/models listing (see docs/features/comic-studio-v4.md
// §Models). Prices are provider list prices in USD per output image (before markup).

import type { AspectRatio, LetteringMode, QualityTier, Resolution } from './doc.js';

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
    text: 'good',
    pages: 'good',
    edit: 'excellent',
    priceUsd: { '1K': 0.0336, '2K': 0.0504, '4K': 0.113 },
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
    text: 'excellent',
    pages: 'excellent',
    edit: 'excellent',
    priceUsd: { '1K': 0.134, '2K': 0.134, '4K': 0.24 },
    latencySec: 35,
    timeoutMs: 210_000,
    unsupported: ['seed', 'temperature'],
    blurb: 'Best page composition and lettering, 5 characters on model, 2K at the 1K price.'
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
    priceUsd: { '512': 0.045, '1K': 0.067, '2K': 0.101, '4K': 0.151 },
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
    priceUsd: { '1K': 0.0336 },
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
    aspects: ['1:1', '3:2', '2:3', '4:3', '3:4', '16:9', '9:16', '21:9'],
    resolutions: [],
    text: 'excellent',
    pages: 'good',
    edit: 'good',
    priceUsd: { '1K': 0.06, '2K': 0.06 },
    latencySec: 70,
    timeoutMs: 240_000,
    blurb: 'Excellent lettering, slow (up to 2 min per page). Experimental in Comic Studio.'
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
    resolutions: ['1K', '2K', '4K'],
    text: 'good',
    pages: 'basic',
    edit: 'good',
    priceUsd: { '1K': 0.048, '2K': 0.1, '4K': 0.607 },
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
    refs: { total: 14, characters: 4, objects: 10, style: 0 },
    aspects: ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'],
    resolutions: ['1K', '2K'],
    text: 'good',
    pages: 'good',
    edit: 'good',
    priceUsd: { '1K': 0.05, '2K': 0.06 },
    latencySec: 25,
    timeoutMs: 150_000,
    blurb: 'Strong manga/anime rendering and multi-reference. Experimental.'
  },
  {
    id: 'nano-banana-legacy',
    label: 'Gemini 2.5 Flash Image',
    nickname: 'Nano Banana (legacy)',
    vendor: 'google',
    routes: { openrouter: 'google/gemini-2.5-flash-image', gemini: 'gemini-2.5-flash-image' },
    lifecycle: 'deprecated',
    replacement: 'nano-banana-2.1',
    refs: { total: 3, characters: 2, objects: 1, style: 0 },
    aspects: GEMINI_ASPECTS_PRO,
    resolutions: [],
    text: 'basic',
    pages: 'basic',
    edit: 'good',
    priceUsd: { '1K': 0.039 },
    latencySec: 12,
    timeoutMs: 90_000,
    blurb: 'Legacy model (3 references max). Kept only so old projects can be re-edited.'
  }
];

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

export const TIER_PRESETS: Record<QualityTier, TierPreset> = {
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
  pro: {
    tier: 'pro',
    label: 'Pro',
    blurb: 'Nano Banana Pro: best composition and in-art lettering, up to 5 characters per page.',
    model: 'nano-banana-pro',
    pageRes: '2K',
    sheetRes: '2K',
    coverModel: 'nano-banana-pro',
    coverRes: '2K',
    // v5: overlay by default (in_art is an explicit opt-in). Existing docs keep their own format.lettering.
    lettering: 'overlay'
  }
};

/** Style exploration is always cheap: small swatch boards on the everyday model. */
export const STYLE_OPTION_MODEL = 'nano-banana-2.1';
export const STYLE_OPTION_RES: Resolution = '1K';

export type ImageJobKind = 'style_option' | 'sheet' | 'place' | 'page' | 'edit' | 'cover';

export interface ResolvedImageJob {
  spec: ImageModelSpec;
  resolution: Resolution;
}

const nearestResolution = (spec: ImageModelSpec, want: Resolution): Resolution => {
  if (!spec.resolutions.length) return want;
  if (spec.resolutions.includes(want)) return want;
  const order: Resolution[] = ['512', '1K', '2K', '4K'];
  const wantIdx = order.indexOf(want);
  return spec.resolutions.reduce((best, r) =>
    Math.abs(order.indexOf(r) - wantIdx) < Math.abs(order.indexOf(best) - wantIdx) ? r : best
  );
};

/** Which model + resolution a job runs on for a tier (an explicit override wins when it is usable). */
export const resolveImageJob = (kind: ImageJobKind, tier: QualityTier, override?: string): ResolvedImageJob => {
  const preset = TIER_PRESETS[tier] || TIER_PRESETS.standard;
  const overrideSpec = getImageModel(override);
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
  jobs: { kind: ImageJobKind; count: number; label?: string }[],
  tier: QualityTier,
  opts: { override?: string; byok?: boolean } = {}
): SpendEstimate => {
  const markup = opts.byok ? 1 : PLATFORM_MARKUP;
  const lines = jobs
    .filter((j) => j.count > 0)
    .map((j) => {
      const { spec, resolution } = resolveImageJob(j.kind, tier, opts.override);
      const per = imagePriceUsd(spec, resolution) + (j.kind === 'page' || j.kind === 'edit' ? QC_USD_PER_PAGE : 0);
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
    model: (primary as { model?: string } | undefined)?.model || resolveImageJob('page', tier, opts.override).spec.nickname,
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
