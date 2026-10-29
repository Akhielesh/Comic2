// Model Lab — the owner-approved paid checks D1–D4 (models.md §2.6; wm-plan M1-MODEL-LAB). Admin-only.
//
// The owner approved about $1 of real generations to settle four decisions. Builders never make a paid call; this
// module is how the OWNER makes them, one at a time, from Admin → Model Lab:
//   D1  Pro tier → Nano Banana 2.1 at 4K       one 4K 2:3 page with 4 references: cost, pixels, latency, file size
//   D2  GPT Image 2.5 Sunburst / Flare          one 2:3 page each through OpenRouter's Images API, 4 references
//   D3  Reveal Seedream 5.0 Pro                 one 2K page through OpenRouter: watermark visible? does 2K bill $0.09?
//   D4  Blind bake-off (optional)               Seedream 5.0 Flash vs Qwen Image 2.1 Turbo: 4 sheets + 2 pages each,
//                                               shown side by side as A / B with the names hidden until the owner votes
//
// Money rules (each one is a test in lab.test.ts):
//   * Costs first. Every check is listed with its quote: the live PriceBook (createPriceBook — OpenRouter's live price,
//     the owner's own observed costs, else the registry's dated list "price list from {factsAsOf}"), or, for models
//     outside the registry, the dated number from models.md §1.1 / §2.6 with that label. No quote → no run.
//   * Nothing runs without an explicit click whose request carries `ack: true` and the quote it showed; a changed
//     price answers QUOTE_CHANGED with the new number instead of spending.
//   * One provider call per click. The studio's own transport (imageClient.ts, unchanged) normally retries a 429 and
//     nudges a text-only answer (an Images-API model never falls back to chat: models.md §3.4 item 8); here its
//     network is wrapped so the first provider POST goes out and any second one is stopped before it leaves the
//     server. The result says so.
//   * One idempotency key per click: a repeated submit returns the stored result and never calls again.
//   * A hard cap of $2 per UTC day, enforced on the server before any call: the quote is reserved atomically with the
//     key (server/sql/comic_model_lab.sql comic_model_lab_reserve), a running call holds its quote, a finished one
//     counts the provider-reported cost (or the quote when none was reported).
//   * The platform key only (platformStudioKeys, OpenRouter), never a user's. No timers: nothing here runs unless an
//     admin asked. Honest refusals (missing key, storage off, cap reached, provider down per the health module) say
//     why and that nothing was charged.
// Every call is recorded twice: a comic_image_calls row (same column meanings as the studio's own calls, so the
// PriceBook's observed costs learn from it) and a lab run row whose JSON holds every fact (pixel size, file size,
// latency, provider-reported model version, what the transport actually sent, watermark yes/no).

import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import type { AspectRatio, Resolution } from '../../../../shared/comic/doc.js';
import type { HealthState, ModelHealth } from '../../../../shared/comic/modelHealth.js';
import { getImageModel, type ImageModelSpec } from '../../../../shared/comic/models.js';
import { OPENROUTER_BASE_URL } from '../../config.js';
import { logger } from '../../lib/logger.js';
import { recordAudit, type AuditInput } from '../../observability/auditLog.js';
import { getSupabaseAdmin, getSupabaseCapabilityStatus } from '../../services/supabase.js';
import { createSupabaseAssetStore, decodeImageDataUrl, previewImage } from '../assets.js';
import {
  IMAGES_API_GONE_REASON,
  classifyImageError,
  createImageGenerator,
  imageFailureInfo,
  modelUnavailableReason,
  providerDetail,
  type ImageClientDeps
} from '../imageClient.js';
import { measureImage, withSharpSlot } from '../imageMeasure.js';
import { platformStudioKeys } from '../keys.js';
import { buildRefPath } from '../storagePaths.js';
import { StudioError, type ImageReference, type StudioKeys } from '../types.js';
import { modelHealth, type ModelHealthPort } from './health.js';
import { createPriceBook } from './index.js';
import type { ServerPriceBook } from './pricing.js';

// ── Constants ────────────────────────────────────────────────────────────────

/** Hard cap on lab spend per UTC day (provider cost, the platform pays). The SQL function also caps at $2. */
export const LAB_DAILY_CAP_USD = 2;
/** When the research numbers below were checked (models.md §1, §2.6). */
export const LAB_FACTS_AS_OF = '2026-10-22';
/** A run still 'running' after this long is shown as interrupted (its quote keeps counting against the cap). */
export const LAB_STALE_RUN_MS = 15 * 60_000;
/** One click = one id: letters, digits, '_' and '-', 16–80 long (the client sends a random UUID per click). */
export const LAB_KEY_RE = /^[A-Za-z0-9_-]{16,80}$/;
/** Lab previews live in the PRIVATE bucket under this pseudo-project of the admin who ran them. */
export const LAB_STORAGE_PROJECT = 'model-lab';
/** Long edge of the stored preview (the original's pixel size and file size are measured before downscaling). */
export const LAB_PREVIEW_EDGE = 2048;
/** How many of the newest runs the overview reads. */
export const LAB_RECENT_LIMIT = 200;
/** How many D1–D3 results the overview lists. */
export const LAB_RESULTS_SHOWN = 30;
/** Quotes equal within this many dollars are the same quote (rounding between JSON and numeric(12,6)). */
const QUOTE_EPSILON = 0.000_05;

export type LabCheckId = 'D1' | 'D2' | 'D3' | 'D4';
export type LabKind = 'page' | 'sheet';
export type LabRefsSource = 'fixture' | 'own_sheets' | 'none';
export type LabPromptKey = 'page-1' | 'page-2' | 'sheet-1' | 'sheet-2' | 'sheet-3' | 'sheet-4';
export type BlindPick = 'A' | 'B' | 'tie';

const round6 = (n: number) => Math.round(n * 1_000_000) / 1_000_000;
const money = (n: number) => `$${Math.round(n * 10_000) / 10_000}`;
const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const str = (v: unknown, max = 160): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);

// ── Models outside the registry (D4 watch-list candidates; models.md §1.1 #14 and #18) ────────────────────────────
// Lab-only specs so the studio's own transport can draw them. They are never added to the picker or the registry.
// Prices, reference caps, aspects and latency are the dated §1.1 numbers; the quality grades are placeholders the
// lab never reads (quality is exactly what the blind test measures).

const labOnlySpec = (s: Pick<ImageModelSpec, 'id' | 'label' | 'nickname' | 'vendor' | 'priceUsd' | 'perRefUsd' | 'latencySec'> & { refsTotal: number }): ImageModelSpec => ({
  id: s.id,
  label: s.label,
  nickname: s.nickname,
  vendor: s.vendor,
  routes: { openrouter: s.id },
  lifecycle: 'experimental',
  refs: { total: s.refsTotal, characters: Math.min(4, s.refsTotal), objects: Math.max(0, s.refsTotal - 4), style: 0 },
  // Only the comic ratios §1.1 verified for both candidates; sheets are drawn 3:4 so the two get the same frame.
  aspects: ['2:3', '3:4', '4:5'],
  resolutions: ['1K', '2K'],
  text: 'basic',
  pages: 'basic',
  edit: 'basic',
  priceUsd: s.priceUsd,
  priceBasis: 'per_image',
  perRefUsd: s.perRefUsd,
  factsAsOf: LAB_FACTS_AS_OF,
  pickable: false,
  api: { openrouter: 'images' },
  latencySec: s.latencySec,
  timeoutMs: 150_000,
  blurb: 'Model Lab candidate (not in the studio).'
});

export const LAB_ONLY_MODELS: readonly ImageModelSpec[] = [
  // #14: $0.018 at 1K and 2K, $0 per reference, 14 refs on OpenRouter / 10 by the vendor, p50 12.1 s.
  labOnlySpec({ id: 'bytedance-seed/seedream-5-0-flash', label: 'Seedream 5.0 Flash', nickname: 'Seedream 5 Flash', vendor: 'bytedance', priceUsd: { '1K': 0.018, '2K': 0.018 }, perRefUsd: 0, latencySec: 12, refsTotal: 10 }),
  // #18: $0.0184 at 1K and 2K, $0 per reference, 4 refs on OpenRouter, p50 30 s. Vendor 'bytedance' is the closest
  // union member the spec type allows; it is never shown.
  labOnlySpec({ id: 'qwen/qwen-image-2.1-turbo', label: 'Qwen Image 2.1 Turbo', nickname: 'Qwen 2.1 Turbo', vendor: 'bytedance', priceUsd: { '1K': 0.0184, '2K': 0.0184 }, perRefUsd: 0, latencySec: 30, refsTotal: 4 })
];

/** A registry model, else a lab-only candidate. */
export const labModel = (id: string): ImageModelSpec | undefined => getImageModel(id) ?? LAB_ONLY_MODELS.find((m) => m.id === id);

// ── The checks (models.md §2.6) ───────────────────────────────────────────────

export interface LabItem {
  id: string;
  check: LabCheckId;
  title: string;
  modelId: string;
  kind: LabKind;
  res: Resolution;
  aspect: AspectRatio;
  references: LabRefsSource;
  prompt: LabPromptKey;
  /** D4: the blind pair this item is one side of. */
  pair?: { id: string; label: string };
  /** The one provider endpoint this check tests (D2: OpenRouter's Images API). A click whose transport would send
   *  its only call anywhere else is stopped before it leaves the server, so it is never paid through the wrong path. */
  transport?: '/images';
  /** A dated number from models.md §1 / §2.6, used ONLY when the PriceBook has none (models outside the registry,
   *  or a resolution the registry cannot price). */
  research?: { baseUsd: number; perRefUsd?: number; label: string };
  /** Shown under the item (facts the owner should see with the quote). */
  note?: string;
  /** Listed but not runnable, with the honest reason. */
  unavailable?: string;
}

export interface LabCheck {
  id: LabCheckId;
  title: string;
  /** What the owner decides with the answer. */
  decision: string;
  /** What one run records. */
  answers: string;
  note?: string;
  items: LabItem[];
}

/** The fixture comic the prompts draw (synthetic: an original story, no real person, no user data). */
export const LAB_CAST: readonly { slot: 1 | 2 | 3 | 4; name: string; label: string; sheet: 'character' | 'creature' | 'place'; look: string }[] = [
  { slot: 1, name: 'Maya', label: 'CHARACTER SHEET: MAYA', sheet: 'character', look: 'a young woman in her twenties with a short black bob and warm brown skin, a bright yellow raincoat over a red scarf, green rubber boots' },
  { slot: 2, name: 'Tomas', label: 'CHARACTER SHEET: TOMAS', sheet: 'character', look: 'an old fisherman with a full white beard and a weathered face, a green knit cap and a navy wool coat, carrying a wooden oar' },
  { slot: 3, name: 'Pip', label: 'CREATURE SHEET: PIP', sheet: 'creature', look: 'a small grey heron with a long yellow beak, thin yellow legs and a single white plume on its head' },
  { slot: 4, name: 'the boathouse', label: 'PLACE SHEET: THE BOATHOUSE', sheet: 'place', look: 'a weathered wooden boathouse on stilts at the edge of a misty lake, with a small red rowing boat tied to its dock' }
];

const D4_MODELS = ['bytedance-seed/seedream-5-0-flash', 'qwen/qwen-image-2.1-turbo'] as const;
const D4_RESEARCH_LABEL = `OpenRouter list price checked ${LAB_FACTS_AS_OF} (models.md §1.1) · not in our registry, so there is no live quote`;

const d4Items = (): LabItem[] => {
  const slots: { prompt: LabPromptKey; kind: LabKind; aspect: AspectRatio; refs: LabRefsSource; label: string }[] = [
    ...LAB_CAST.map((c) => ({ prompt: `sheet-${c.slot}` as LabPromptKey, kind: 'sheet' as const, aspect: '3:4' as const, refs: 'none' as const, label: `Sheet ${c.slot} · ${c.name[0].toUpperCase()}${c.name.slice(1)}` })),
    { prompt: 'page-1', kind: 'page', aspect: '2:3', refs: 'own_sheets', label: 'Page 1 · the dock' },
    { prompt: 'page-2', kind: 'page', aspect: '2:3', refs: 'own_sheets', label: 'Page 2 · on the water' }
  ];
  const items: LabItem[] = [];
  for (const slot of slots) {
    for (const modelId of D4_MODELS) {
      const spec = labModel(modelId)!;
      items.push({
        id: `d4-${spec.id.split('/')[1]}-${slot.prompt}`,
        check: 'D4',
        title: `${spec.nickname} · ${slot.label}`,
        modelId,
        kind: slot.kind,
        res: '2K',
        aspect: slot.aspect,
        references: slot.refs,
        prompt: slot.prompt,
        pair: { id: `d4-${slot.prompt}`, label: slot.label },
        research: { baseUsd: spec.priceUsd['2K'] as number, perRefUsd: spec.perRefUsd, label: D4_RESEARCH_LABEL }
      });
    }
  }
  return items;
};

export const LAB_CHECKS: readonly LabCheck[] = [
  {
    id: 'D1',
    title: 'Pro tier → Nano Banana 2.1 at 4K',
    decision: 'Turn on PRO_TIER_4K (Pro = Nano Banana 2.1 at 4K pages and cover) only if a real 4K page checks out.',
    answers: 'What a real 4K 2:3 page with 4 references costs (usage.cost), its pixel size, latency and file size.',
    note: 'Google lists 4K as $0.076 in one place and $0.113 in another (models.md §1.6); this run settles it.',
    items: [
      { id: 'd1-nano-banana-2.1-4k', check: 'D1', title: 'Nano Banana 2.1 · 4K page', modelId: 'nano-banana-2.1', kind: 'page', res: '4K', aspect: '2:3', references: 'fixture', prompt: 'page-1' }
    ]
  },
  {
    id: 'D2',
    title: 'GPT Image 2.5 Sunburst and Flare as Experimental',
    decision: 'Offer both as Experimental only if a page comes back through our Images-API transport.',
    answers: 'Whether one 2:3 page with 4 references comes back through OpenRouter, what it costs, and what our transport actually sent (quality, references).',
    note: '2:3 at 1024×1536 is ≈ $0.1646 in output tokens at quality max (OpenAI calculator, models.md §1.1); reference input is unpublished. The lab reserves the higher 1024² price so the cap never under-counts. The studio’s Images-API transport sends quality max; the result’s “Sent” line shows the quality that went out.',
    items: [
      { id: 'd2-gpt-image-2.5-sunburst', check: 'D2', title: 'GPT Image 2.5 Sunburst · 2:3 page', modelId: 'gpt-image-2.5', kind: 'page', res: '1K', aspect: '2:3', references: 'fixture', prompt: 'page-1', transport: '/images' },
      { id: 'd2-gpt-image-2.5-flare', check: 'D2', title: 'GPT Image 2.5 Flare · 2:3 page', modelId: 'gpt-image-2.5-flare', kind: 'page', res: '1K', aspect: '2:3', references: 'fixture', prompt: 'page-1', transport: '/images' }
    ]
  },
  {
    id: 'D3',
    title: 'Reveal Seedream 5.0 Pro',
    decision: 'Show it in the picker only if OpenRouter’s output carries no “AI-generated” watermark.',
    answers: 'Whether the watermark is visible (tick it on the result) and whether a 2K page bills $0.09.',
    items: [
      {
        id: 'd3-seedream-5-pro-2k',
        check: 'D3',
        title: 'Seedream 5.0 Pro · 2K page',
        modelId: 'seedream-5-pro',
        kind: 'page',
        res: '2K',
        aspect: '2:3',
        references: 'fixture',
        prompt: 'page-1',
        research: {
          baseUsd: 0.09,
          perRefUsd: 0.003,
          label: `upper estimate from models.md §2.6 (${LAB_FACTS_AS_OF}): 2K may bill as OpenRouter’s “high_resolution” at $0.09 (unverified) + $0.003 per reference · our registry has no 2K price yet`
        }
      }
    ]
  },
  {
    id: 'D4',
    title: 'Blind bake-off (optional)',
    decision: 'Put a cheap, unranked model on the watch list only if it holds up, judged blind on the same comic.',
    answers: 'Each model draws 4 sheets, then 2 pages using its own sheets. Every pair is shown as A and B; the names appear after you vote.',
    note: 'FLUX 3 Klein is left out because of its training clause (models.md §1.4) unless you accept it.',
    items: [
      ...d4Items(),
      {
        id: 'd4-gpt-image-2.5-flare-medium',
        check: 'D4',
        title: 'Add-on · GPT Image 2.5 Flare at medium',
        modelId: 'gpt-image-2.5-flare',
        kind: 'page',
        res: '1K',
        aspect: '2:3',
        references: 'fixture',
        prompt: 'page-1',
        note: '≈ $0.0103 per 1024×1536 image at medium, output tokens (OpenAI calculator, models.md §1.1) + reference input.',
        unavailable:
          "Needs a per-request quality setting (medium). The lab runs the studio's own transport, which draws Flare at its registry quality, so it can't run this add-on honestly yet."
      }
    ]
  }
];

export const labItems = (): LabItem[] => LAB_CHECKS.flatMap((c) => c.items);
export const labItem = (id: string): LabItem | undefined => labItems().find((i) => i.id === id);

// ── Prompts and the fixture references (synthetic) ───────────────────────────

const LAB_STYLE =
  'Art style: clean modern comic-book art, confident inks with varied line weight, flat cel colors with soft shading, ' +
  'expressive faces, cool misty dawn light. Family-friendly.';

const sheetPrompt = (slot: 1 | 2 | 3 | 4): string => {
  const c = LAB_CAST[slot - 1];
  const what =
    c.sheet === 'place'
      ? `A location design sheet of ${c.name.toUpperCase()}: one wide establishing view and two closer views from other angles, on a plain light border. ${c.look}.`
      : c.sheet === 'creature'
        ? `A creature model sheet of ${c.name.toUpperCase()}: front, side and back views plus two poses (standing, taking off), on a plain light background. ${c.look}.`
        : `A character model sheet of ${c.name.toUpperCase()}: front, three-quarter and back views plus three expressions (calm, surprised, determined), full body, on a plain light background. ${c.name} is ${c.look}.`;
  return `${what}\n\n${LAB_STYLE}\nNo captions, labels or text in the image.`;
};

const castLines = (): string => LAB_CAST.map((c) => `- ${c.name.toUpperCase()}: ${c.look}.`).join('\n');

const PAGE_PANELS: Record<'page-1' | 'page-2', string> = {
  'page-1': [
    'One finished comic page as a single image, 4 panels in a 2×2 grid with clean gutters.',
    'Panel 1: wide shot of THE BOATHOUSE at dawn, mist drifting over the lake.',
    'Panel 2: MAYA walks onto the dock, her yellow coat bright against the grey morning.',
    'Panel 3: TOMAS hands MAYA a wooden oar. Speech balloon from TOMAS: "You came back."',
    'Panel 4: PIP lands on the prow of the red rowing boat; MAYA smiles.'
  ].join('\n'),
  'page-2': [
    'One finished comic page as a single image, 3 panels: one wide panel across the top half, two panels side by side below.',
    'Panel 1: MAYA rows the red boat out onto the misty lake, TOMAS in the stern, PIP on the prow.',
    'Panel 2: a huge dark shape glides under the water beside the boat.',
    'Panel 3: close-up of MAYA and TOMAS exchanging a look. Caption box: "Something old was waking."'
  ].join('\n')
};

/** The prompt for an item, with a legend of exactly the references that are sent (in order). */
export const labPrompt = (item: Pick<LabItem, 'prompt'>, refLabels: readonly string[]): string => {
  if (item.prompt.startsWith('sheet-')) return sheetPrompt(Number(item.prompt.slice(6)) as 1 | 2 | 3 | 4);
  const legend = refLabels.length
    ? `REFERENCE IMAGES, in order (use them for identity, colors and design only; redraw everything in the art style below):\n${refLabels.map((l, i) => `Image ${i + 1}: ${l}`).join('\n')}`
    : '';
  return [PAGE_PANELS[item.prompt as 'page-1' | 'page-2'], `CAST:\n${castLines()}`, legend, LAB_STYLE, 'Letter the balloon and caption text exactly as written.']
    .filter(Boolean)
    .join('\n\n');
};

// Four flat color-block cards (no text, so no font is needed on the server): a stand-in for real sheets that lets
// D1–D3 send exactly 4 references. They are synthetic shapes, never anyone's image.
const FIXTURE_SVGS: readonly string[] = [
  // Maya: yellow raincoat, red scarf, green boots.
  `<svg xmlns="http://www.w3.org/2000/svg" width="768" height="1024"><rect width="768" height="1024" fill="#f3efe6"/><circle cx="384" cy="250" r="96" fill="#8d5a3b"/><path d="M288 240 Q384 110 480 240 L480 200 Q384 120 288 200 Z" fill="#15151a"/><rect x="250" y="360" width="268" height="440" rx="60" fill="#f2c230"/><rect x="270" y="350" width="228" height="50" rx="22" fill="#c8372d"/><rect x="282" y="800" width="80" height="150" rx="20" fill="#2f7d4a"/><rect x="406" y="800" width="80" height="150" rx="20" fill="#2f7d4a"/></svg>`,
  // Tomas: white beard, green cap, navy coat, oar.
  `<svg xmlns="http://www.w3.org/2000/svg" width="768" height="1024"><rect width="768" height="1024" fill="#eef0f2"/><rect x="560" y="140" width="26" height="820" rx="10" fill="#8a5a33"/><circle cx="384" cy="260" r="92" fill="#e0b391"/><ellipse cx="384" cy="330" rx="88" ry="70" fill="#f7f7f5"/><rect x="292" y="150" width="184" height="70" rx="30" fill="#3b6b3b"/><rect x="240" y="390" width="288" height="460" rx="50" fill="#1f2f57"/><rect x="290" y="850" width="80" height="110" fill="#2b2b2b"/><rect x="398" y="850" width="80" height="110" fill="#2b2b2b"/></svg>`,
  // Pip: grey heron, yellow beak, white plume.
  `<svg xmlns="http://www.w3.org/2000/svg" width="768" height="1024"><rect width="768" height="1024" fill="#e9eef0"/><ellipse cx="400" cy="560" rx="170" ry="110" fill="#8a939b"/><rect x="330" y="300" width="36" height="230" rx="16" fill="#8a939b"/><circle cx="348" cy="290" r="48" fill="#9aa3ab"/><polygon points="390,282 560,300 390,310" fill="#e5b62e"/><path d="M340 245 Q300 170 260 200" stroke="#ffffff" stroke-width="12" fill="none"/><rect x="360" y="660" width="10" height="240" fill="#e5b62e"/><rect x="430" y="660" width="10" height="240" fill="#e5b62e"/></svg>`,
  // The boathouse: misty sky, lake, boathouse on stilts, red boat.
  `<svg xmlns="http://www.w3.org/2000/svg" width="768" height="1024"><rect width="768" height="620" fill="#c9d2d8"/><rect y="620" width="768" height="404" fill="#5d7f99"/><polygon points="160,330 400,210 640,330" fill="#4a3424"/><rect x="190" y="330" width="420" height="250" fill="#6b4a2f"/><rect x="340" y="420" width="120" height="160" fill="#2e2018"/><rect x="200" y="580" width="18" height="120" fill="#4a3424"/><rect x="582" y="580" width="18" height="120" fill="#4a3424"/><path d="M420 760 Q520 800 640 760 L620 800 Q520 830 440 800 Z" fill="#b83a2e"/></svg>`
];

let fixtureRefs: Promise<ImageReference[]> | null = null;
/** The 4 fixture references (rendered once, on first use — never at import). */
export const labFixtureReferences = (): Promise<ImageReference[]> =>
  (fixtureRefs ??= withSharpSlot(async () => {
    const out: ImageReference[] = [];
    for (let i = 0; i < FIXTURE_SVGS.length; i += 1) {
      const png = await sharp(Buffer.from(FIXTURE_SVGS[i])).png().toBuffer();
      out.push({ label: LAB_CAST[i].label, dataUrl: `data:image/png;base64,${png.toString('base64')}` });
    }
    return out;
  }).catch((err) => {
    fixtureRefs = null;
    throw err;
  }));

// ── Quotes ───────────────────────────────────────────────────────────────────

export interface LabQuote {
  /** Provider price of this one call (the platform pays it; no markup) — what is reserved against the cap. */
  usd: number;
  source: 'pricebook' | 'research';
  /** Where the number comes from (admin view: dollars are fine here). */
  basis: string;
  /** References are sent but their price is unpublished, so the true total can be higher. */
  refsUnpriced: boolean;
}

/** The quote for one click: the live PriceBook for registry models, else the item's dated research number. */
export const quoteLabItem = (item: LabItem, prices: Pick<ServerPriceBook, 'quote'> | null, refs: number): LabQuote | null => {
  const spec = getImageModel(item.modelId);
  if (spec && prices) {
    const q = prices.quote(spec.id, item.res, item.kind, refs);
    if (isFiniteNumber(q.usd) && q.usd > 0) return { usd: round6(q.usd), source: 'pricebook', basis: q.basis, refsUnpriced: q.refsUnpriced };
  }
  if (item.research) {
    const perRef = item.research.perRefUsd;
    const refsUsd = refs > 0 && isFiniteNumber(perRef) ? perRef * refs : 0;
    const refsText = refs > 0 ? (isFiniteNumber(perRef) ? ` + ${refs} × ${money(perRef)} references` : ' · reference cost unpublished') : '';
    return { usd: round6(item.research.baseUsd + refsUsd), source: 'research', basis: `${item.research.label}${refsText}`, refsUnpriced: refs > 0 && !isFiniteNumber(perRef) };
  }
  return null;
};

// ── One provider call per click (wraps the studio transport's network) ───────

export const ONE_CALL_MARK = 'labOneCall' as const;

/** What the single provider call sent (never the prompt or an image). */
export interface LabSentFacts {
  model?: string;
  aspect?: string | null;
  resolution?: string | null;
  quality?: string | null;
  references: number;
  /** OpenRouter provider routing, when the transport sent it (models.md §2.4). */
  providerOnly?: string[] | null;
  allowFallbacks?: boolean | null;
}

export interface ProviderCapture {
  /** Provider POSTs that went out (0 or 1). */
  calls: number;
  /** Further provider attempts the transport made and the lab stopped before they left the server. */
  stopped: number;
  endpoint?: string;
  status?: number;
  ms?: number;
  sent?: LabSentFacts;
  /** From a 2xx answer: the model version, provider and generation id the provider reported, and usage.cost. */
  reportedModel?: string;
  providerName?: string;
  generationId?: string;
  costUsd?: number;
  /** A non-2xx answer: what the provider said (sanitized), or the network error. */
  said?: string;
  networkError?: string;
  /** Downloading an image the provider hosted (a GET, not a provider call) failed after a paid answer. */
  downloadFailed?: boolean;
  /** The check requires one endpoint, and the transport's first POST was headed elsewhere: that endpoint. Nothing was
   *  sent (`calls` stays 0). A guard only: the studio never sends an Images-API model anywhere but /images
   *  (models.md §3.4 item 8), and inside its 15-minute skip after a 404/405 it sends nothing at all. */
  skippedTransport?: string;
}

export interface OneCallOptions {
  /** The only endpoint (relative to OpenRouter's API base, e.g. '/images') the one call may go to. */
  requirePath?: string;
}

const oneCallStop = (): StudioError =>
  Object.assign(new StudioError('CANCELLED', 'The Model Lab makes one provider call per click and never retries.', { status: 499 }), { [ONE_CALL_MARK]: true });

export const isOneCallStop = (err: unknown): boolean => !!err && typeof err === 'object' && (err as Record<string, unknown>)[ONE_CALL_MARK] === true;

const describeSent = (body: unknown): LabSentFacts | undefined => {
  if (typeof body !== 'string') return undefined;
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const config = ((json.image_config ?? json.imageConfig) || {}) as Record<string, unknown>;
  let references = Array.isArray(json.input_references) ? json.input_references.length : 0;
  if (!references && Array.isArray(json.messages)) {
    for (const m of json.messages as { content?: unknown }[]) {
      if (Array.isArray(m?.content)) references += (m.content as { type?: unknown }[]).filter((p) => p?.type === 'image_url').length;
    }
  }
  const provider = (json.provider || {}) as Record<string, unknown>;
  return {
    model: str(json.model),
    aspect: str(json.aspect_ratio ?? config.aspect_ratio) ?? null,
    resolution: str(json.resolution ?? config.image_size) ?? null,
    quality: str(json.quality ?? config.quality) ?? null,
    references,
    providerOnly: Array.isArray(provider.only) ? (provider.only as unknown[]).filter((p): p is string => typeof p === 'string').slice(0, 10) : null,
    allowFallbacks: typeof provider.allow_fallbacks === 'boolean' ? provider.allow_fallbacks : null
  };
};

const requestUrl = (input: RequestInfo | URL): string => (typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url);

/** '/images' for `${OPENROUTER_BASE_URL}/images?x`; the bare path for any other host. */
const endpointOf = (url: string): string =>
  (url.startsWith(OPENROUTER_BASE_URL) ? url.slice(OPENROUTER_BASE_URL.length) : url.replace(/^[a-z]+:\/\/[^/]+/i, '')).split('?')[0] || '/';

/**
 * Wrap the network the image transport uses so exactly ONE provider call leaves the server. The first POST goes out
 * (its answer is read once and handed back, so nothing is fetched twice); any later POST — a 429 retry, the
 * text-only nudge, the other route — is stopped with a marked error before it is sent. Every POST counts, whatever its host: the image transport only ever POSTs to a provider. GETs (downloading
 * an image the provider hosted) are not provider calls and pass through.
 * With `requirePath`, a first POST to any other endpoint is stopped unsent too (and so is everything after it): a
 * check that tests one transport is never paid through another.
 */
export const oneCallTransport = (
  network: typeof fetch,
  now: () => number = Date.now,
  opts: OneCallOptions = {}
): { fetch: typeof fetch; capture: ProviderCapture } => {
  const capture: ProviderCapture = { calls: 0, stopped: 0 };
  const guarded = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = requestUrl(input);
    const isProviderCall = (init?.method || (typeof input === 'object' && 'method' in input ? (input as Request).method : 'GET')).toUpperCase() !== 'GET';
    if (!isProviderCall) {
      try {
        const res = await network(input, init);
        if (!res.ok) capture.downloadFailed = true;
        return res;
      } catch (err) {
        capture.downloadFailed = true;
        throw err;
      }
    }
    if (capture.calls >= 1 || capture.skippedTransport !== undefined) {
      capture.stopped += 1;
      throw oneCallStop();
    }
    const endpoint = endpointOf(url);
    if (opts.requirePath && endpoint !== opts.requirePath) {
      capture.stopped += 1;
      capture.skippedTransport = endpoint;
      throw oneCallStop();
    }
    capture.calls = 1;
    capture.endpoint = endpoint;
    capture.sent = describeSent(init?.body);
    const started = now();
    let res: Response;
    try {
      res = await network(input, init);
    } catch (err) {
      capture.ms = Math.max(0, now() - started);
      capture.networkError = String((err as Error)?.message || err).slice(0, 200);
      throw err;
    }
    const text = await res.text();
    capture.ms = Math.max(0, now() - started);
    capture.status = res.status;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    if (res.ok && parsed && typeof parsed === 'object') {
      const j = parsed as { model?: unknown; provider?: unknown; id?: unknown; usage?: { cost?: unknown } };
      capture.reportedModel = str(j.model);
      capture.providerName = str(j.provider, 80);
      capture.generationId = str(j.id, 120);
      const cost = j.usage?.cost;
      if (isFiniteNumber(cost) && cost >= 0) capture.costUsd = cost;
    } else if (!res.ok) {
      capture.said = providerDetail(text) || undefined;
    }
    // Hand the same answer back without a second parse (a 4K image is tens of MB of base64): a parsed 2xx body is
    // served from the parsed object and its text is let go; anything else keeps its text for the transport to read.
    const kept = res.ok && parsed !== undefined ? '' : text;
    return {
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
      url: res.url,
      text: async () => (kept || JSON.stringify(parsed ?? null)),
      json: async () => (parsed !== undefined ? parsed : JSON.parse(kept))
    } as unknown as Response;
  }) as typeof fetch;
  return { fetch: guarded, capture };
};

// ── Records ──────────────────────────────────────────────────────────────────

export interface LabResultFacts {
  /** A request reached the provider (false: refused or failed before any call). */
  callMade: boolean;
  endpoint?: string | null;
  httpStatus?: number | null;
  errorCode?: string | null;
  /** Short, honest, safe to show. */
  message?: string | null;
  /** What the provider said on a failure (sanitized, never a key). */
  providerSaid?: string | null;
  /** The provider reported usage.cost for this call. */
  costReported?: boolean;
  width?: number;
  height?: number;
  /** File size of the image the provider returned (before our preview downscale). */
  bytes?: number;
  mediaType?: string;
  aspectOk?: boolean;
  blank?: boolean;
  /** End to end through the studio transport (what a user waits). */
  latencyMs?: number;
  /** The provider round trip alone. */
  providerMs?: number;
  /** models.md §2.5: the model version the provider reported (OpenRouter `model`). */
  providerModelVersion?: string | null;
  providerName?: string | null;
  generationId?: string | null;
  sent?: LabSentFacts | null;
  refsSent: number;
  /** Private preview (≤ LAB_PREVIEW_EDGE). Its object id is random, never the run id (blind test). */
  imagePath?: string | null;
  stored?: boolean;
  /** The comic_image_calls row was written. */
  recordedCall?: boolean;
  /** The studio transport tried a second provider call (retry / nudge / fallback) and the lab stopped it. */
  stoppedSecondCall?: boolean;
  /** Owner's checkbox (D3, and Seedream in D4): is the "AI-generated" watermark visible? null = not checked. */
  watermark?: { visible: boolean | null; at: string; by: string | null } | null;
  quoteBasis?: string;
  quoteSource?: 'pricebook' | 'research';
}

export interface LabRunRow {
  id: string;
  key: string;
  adminId: string | null;
  checkId: LabCheckId;
  itemId: string;
  modelId: string;
  providerModel: string | null;
  kind: string;
  res: string | null;
  aspect: string | null;
  refs: number;
  status: 'running' | 'ok' | 'failed';
  quotedUsd: number;
  /** Provider-reported cost; null = not reported (the cap keeps counting the quote). */
  costUsd: number | null;
  result: LabResultFacts;
  day: string;
  createdAt: string;
  finishedAt: string | null;
}

export interface LabVoteRow {
  pairId: string;
  adminId: string | null;
  pick: BlindPick;
  aRunId: string;
  bRunId: string;
  createdAt: string;
}

export interface LabReserveInput {
  key: string;
  adminId: string;
  checkId: LabCheckId;
  itemId: string;
  modelId: string;
  providerModel: string | null;
  kind: string;
  res: string;
  aspect: string;
  refs: number;
  quotedUsd: number;
  capUsd: number;
}

export type LabReserveOutcome = { outcome: 'reserved' | 'existing'; row: LabRunRow } | { outcome: 'cap'; spentUsd: number };

/** A comic_image_calls row (server/sql/comic_image_calls.sql; column meanings as M1-CATALOG documents them). */
export interface ImageCallInsert {
  user_id: string;
  project_id: null;
  model_id: string;
  provider_model: string | null;
  route: 'openrouter';
  provider_name: string | null;
  kind: string;
  res: string;
  aspect: string;
  refs: number;
  outcome: 'ok' | 'failed';
  http_status: number | null;
  error_code: string | null;
  provider_cost_usd: number | null;
  billed_usd: number;
  byok: false;
  latency_ms: number | null;
}

export interface LabStore {
  byKey(key: string): Promise<LabRunRow | null>;
  byId(id: string): Promise<LabRunRow | null>;
  /** Atomically: the existing row for this key, or 'cap', or a new 'running' row holding the quote. */
  reserve(input: LabReserveInput): Promise<LabReserveOutcome>;
  finish(id: string, patch: { status: 'ok' | 'failed'; costUsd: number | null; providerModel: string | null; result: LabResultFacts; finishedAt: string }): Promise<LabRunRow>;
  updateResult(id: string, result: LabResultFacts): Promise<LabRunRow>;
  recent(limit: number): Promise<LabRunRow[]>;
  /** Spend counted against the cap on a UTC day (running → quote; finished → reported cost, else the quote). */
  spent(day: string): Promise<number>;
  votes(): Promise<LabVoteRow[]>;
  addVote(vote: Omit<LabVoteRow, 'createdAt'>): Promise<'recorded' | 'exists'>;
  recordImageCall(row: ImageCallInsert): Promise<void>;
}

/** Where lab previews are kept (the private bucket in production). */
export interface LabStorage {
  put(path: string, buffer: Buffer, contentType: string): Promise<void>;
  loadDataUrl(path: string): Promise<string>;
  signUrls(paths: string[]): Promise<Record<string, string>>;
}

const spendOf = (r: Pick<LabRunRow, 'status' | 'quotedUsd' | 'costUsd'>): number => (r.status === 'running' ? r.quotedUsd : r.costUsd ?? r.quotedUsd);

/** In-memory store with the SQL function's exact semantics (tests; never used to spend in production). */
export function createMemoryLabStore(opts: { now?: () => number; newId?: () => string } = {}): LabStore & { runs: LabRunRow[]; voteRows: LabVoteRow[]; imageCalls: ImageCallInsert[] } {
  const now = opts.now ?? Date.now;
  const newId = opts.newId ?? randomUUID;
  const runs: LabRunRow[] = [];
  const voteRows: LabVoteRow[] = [];
  const imageCalls: ImageCallInsert[] = [];
  const copy = (r: LabRunRow): LabRunRow => JSON.parse(JSON.stringify(r)) as LabRunRow;
  const find = (id: string) => runs.find((r) => r.id === id);
  return {
    runs,
    voteRows,
    imageCalls,
    async byKey(key) {
      const r = runs.find((x) => x.key === key);
      return r ? copy(r) : null;
    },
    async byId(id) {
      const r = find(id);
      return r ? copy(r) : null;
    },
    async reserve(input) {
      if (!LAB_KEY_RE.test(input.key) || !(input.quotedUsd > 0)) throw new Error('comic_model_lab_reserve: bad input');
      const existing = runs.find((x) => x.key === input.key);
      if (existing) return { outcome: 'existing', row: copy(existing) };
      const day = utcDay(now());
      const spent = runs.filter((r) => r.day === day).reduce((s, r) => s + spendOf(r), 0);
      if (spent + input.quotedUsd > Math.min(input.capUsd, LAB_DAILY_CAP_USD) + 1e-9) return { outcome: 'cap', spentUsd: round6(spent) };
      const row: LabRunRow = {
        id: newId(),
        key: input.key,
        adminId: input.adminId,
        checkId: input.checkId,
        itemId: input.itemId,
        modelId: input.modelId,
        providerModel: input.providerModel,
        kind: input.kind,
        res: input.res,
        aspect: input.aspect,
        refs: input.refs,
        status: 'running',
        quotedUsd: input.quotedUsd,
        costUsd: null,
        result: { callMade: false, refsSent: 0 },
        day,
        createdAt: new Date(now()).toISOString(),
        finishedAt: null
      };
      runs.push(row);
      return { outcome: 'reserved', row: copy(row) };
    },
    async finish(id, patch) {
      const r = find(id);
      if (!r) throw new Error('lab run not found');
      Object.assign(r, { status: patch.status, costUsd: patch.costUsd, providerModel: patch.providerModel, result: patch.result, finishedAt: patch.finishedAt });
      return copy(r);
    },
    async updateResult(id, result) {
      const r = find(id);
      if (!r) throw new Error('lab run not found');
      r.result = result;
      return copy(r);
    },
    async recent(limit) {
      return [...runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit).map(copy);
    },
    async spent(day) {
      return round6(runs.filter((r) => r.day === day).reduce((s, r) => s + spendOf(r), 0));
    },
    async votes() {
      return voteRows.map((v) => ({ ...v }));
    },
    async addVote(vote) {
      if (voteRows.some((v) => v.pairId === vote.pairId)) return 'exists';
      voteRows.push({ ...vote, createdAt: new Date(now()).toISOString() });
      return 'recorded';
    },
    async recordImageCall(row) {
      imageCalls.push({ ...row });
    }
  };
}

// ── Supabase store (service role; server/sql/comic_model_lab.sql) ───────────

export const LAB_TABLES = { runs: 'comic_model_lab_runs', votes: 'comic_model_lab_votes', imageCalls: 'comic_image_calls' } as const;
const LAB_DB_TIMEOUT_MS = 8_000;
const RUN_COLUMNS = 'id, idempotency_key, admin_id, check_id, item_id, model_id, provider_model, kind, res, aspect, refs, status, quoted_usd, cost_usd, result, day, created_at, finished_at';
const CHECK_IDS: ReadonlySet<string> = new Set(['D1', 'D2', 'D3', 'D4']);
const STATUSES: ReadonlySet<string> = new Set(['running', 'ok', 'failed']);
const numOrNull = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

export const labRunFromDb = (r: Record<string, unknown>): LabRunRow | null => {
  const id = str(r.id, 64);
  const checkId = str(r.check_id, 4);
  const status = str(r.status, 16);
  const quoted = numOrNull(r.quoted_usd);
  if (!id || !checkId || !CHECK_IDS.has(checkId) || !status || !STATUSES.has(status) || quoted === null) return null;
  const result = r.result && typeof r.result === 'object' && !Array.isArray(r.result) ? (r.result as LabResultFacts) : { callMade: false, refsSent: 0 };
  return {
    id,
    key: String(r.idempotency_key ?? ''),
    adminId: str(r.admin_id, 64) ?? null,
    checkId: checkId as LabCheckId,
    itemId: String(r.item_id ?? ''),
    modelId: String(r.model_id ?? ''),
    providerModel: str(r.provider_model) ?? null,
    kind: String(r.kind ?? ''),
    res: str(r.res, 8) ?? null,
    aspect: str(r.aspect, 8) ?? null,
    refs: numOrNull(r.refs) ?? 0,
    status: status as LabRunRow['status'],
    quotedUsd: quoted,
    costUsd: numOrNull(r.cost_usd),
    result: { ...result, refsSent: isFiniteNumber(result.refsSent) ? result.refsSent : 0, callMade: result.callMade === true },
    day: String(r.day ?? '').slice(0, 10),
    createdAt: r.created_at ? new Date(String(r.created_at)).toISOString() : new Date(0).toISOString(),
    finishedAt: r.finished_at ? new Date(String(r.finished_at)).toISOString() : null
  };
};

/** The lab's persistence on Supabase (service role). Null when storage is not configured on this server. */
export function createSupabaseLabStore(): LabStore | null {
  if (!getSupabaseCapabilityStatus().storagePersistenceEnabled) return null;
  const db = () => getSupabaseAdmin();
  const signal = () => AbortSignal.timeout(LAB_DB_TIMEOUT_MS);
  const one = (data: unknown): LabRunRow => {
    const row = labRunFromDb((data ?? {}) as Record<string, unknown>);
    if (!row) throw new Error('lab run row unreadable');
    return row;
  };
  const byId = async (id: string) => {
    const { data, error } = await db().from(LAB_TABLES.runs).select(RUN_COLUMNS).eq('id', id).abortSignal(signal()).maybeSingle();
    if (error) throw new Error(error.message);
    return data ? labRunFromDb(data as Record<string, unknown>) : null;
  };
  return {
    async byKey(key) {
      const { data, error } = await db().from(LAB_TABLES.runs).select(RUN_COLUMNS).eq('idempotency_key', key).abortSignal(signal()).maybeSingle();
      if (error) throw new Error(error.message);
      return data ? labRunFromDb(data as Record<string, unknown>) : null;
    },
    byId,
    async reserve(input) {
      const { data, error } = await db()
        .rpc('comic_model_lab_reserve', {
          p_key: input.key,
          p_admin: input.adminId,
          p_check: input.checkId,
          p_item: input.itemId,
          p_model: input.modelId,
          p_provider_model: input.providerModel,
          p_kind: input.kind,
          p_res: input.res,
          p_aspect: input.aspect,
          p_refs: input.refs,
          p_quoted: input.quotedUsd,
          p_cap: input.capUsd
        })
        .abortSignal(signal());
      if (error) throw new Error(error.message);
      const first = (Array.isArray(data) ? data[0] : data) as { out_outcome?: unknown; out_run_id?: unknown; out_spent?: unknown } | undefined;
      const outcome = String(first?.out_outcome ?? '');
      if (outcome === 'cap') return { outcome: 'cap', spentUsd: numOrNull(first?.out_spent) ?? 0 };
      if (outcome !== 'reserved' && outcome !== 'existing') throw new Error('comic_model_lab_reserve answered nothing usable');
      const row = await byId(String(first?.out_run_id ?? ''));
      if (!row) throw new Error('reserved lab run not found');
      return { outcome, row };
    },
    async finish(id, patch) {
      const { data, error } = await db()
        .from(LAB_TABLES.runs)
        .update({ status: patch.status, cost_usd: patch.costUsd, provider_model: patch.providerModel, result: patch.result, finished_at: patch.finishedAt })
        .eq('id', id)
        .select(RUN_COLUMNS)
        .abortSignal(signal())
        .single();
      if (error) throw new Error(error.message);
      return one(data);
    },
    async updateResult(id, result) {
      const { data, error } = await db().from(LAB_TABLES.runs).update({ result }).eq('id', id).select(RUN_COLUMNS).abortSignal(signal()).single();
      if (error) throw new Error(error.message);
      return one(data);
    },
    async recent(limit) {
      const { data, error } = await db().from(LAB_TABLES.runs).select(RUN_COLUMNS).order('created_at', { ascending: false }).limit(limit).abortSignal(signal());
      if (error) throw new Error(error.message);
      return (data ?? []).map((r) => labRunFromDb(r as Record<string, unknown>)).filter((r): r is LabRunRow => !!r);
    },
    async spent(day) {
      const { data, error } = await db().from(LAB_TABLES.runs).select('status, quoted_usd, cost_usd').eq('day', day).abortSignal(signal());
      if (error) throw new Error(error.message);
      return round6(
        (data ?? []).reduce((s: number, r: Record<string, unknown>) => {
          const quoted = numOrNull(r.quoted_usd) ?? 0;
          return s + (r.status === 'running' ? quoted : numOrNull(r.cost_usd) ?? quoted);
        }, 0)
      );
    },
    async votes() {
      const { data, error } = await db().from(LAB_TABLES.votes).select('pair_id, admin_id, pick, a_run_id, b_run_id, created_at').abortSignal(signal());
      if (error) throw new Error(error.message);
      return (data ?? [])
        .map((r: Record<string, unknown>): LabVoteRow | null =>
          str(r.pair_id) && (r.pick === 'A' || r.pick === 'B' || r.pick === 'tie') && str(r.a_run_id) && str(r.b_run_id)
            ? { pairId: String(r.pair_id), adminId: str(r.admin_id) ?? null, pick: r.pick, aRunId: String(r.a_run_id), bRunId: String(r.b_run_id), createdAt: String(r.created_at ?? '') }
            : null
        )
        .filter((v): v is LabVoteRow => !!v);
    },
    async addVote(vote) {
      const { error } = await db()
        .from(LAB_TABLES.votes)
        .insert({ pair_id: vote.pairId, admin_id: vote.adminId, pick: vote.pick, a_run_id: vote.aRunId, b_run_id: vote.bRunId })
        .abortSignal(signal());
      if (!error) return 'recorded';
      if ((error as { code?: string }).code === '23505') return 'exists';
      throw new Error(error.message);
    },
    async recordImageCall(row) {
      const { error } = await db().from(LAB_TABLES.imageCalls).insert(row).abortSignal(signal());
      if (error) throw new Error(error.message);
    }
  };
}

// ── Views (what the admin UI gets) ───────────────────────────────────────────

export interface LabHealthView {
  state: HealthState;
  reason?: string;
  source: 'openrouter' | 'observed' | 'none';
  checkedAt: number;
}

export interface LabItemView {
  id: string;
  check: LabCheckId;
  title: string;
  modelId: string;
  nickname: string;
  kind: LabKind;
  res: Resolution;
  aspect: AspectRatio;
  /** References this click would send, and what they are. */
  refs: number;
  refsNote: string;
  quote: LabQuote | null;
  health: LabHealthView | null;
  canRun: boolean;
  /** Why it can't run right now (honest; nothing is charged). */
  reason?: string;
  note?: string;
  pair?: { id: string; label: string };
  runs: { ok: number; failed: number; running: number };
}

export interface LabCheckView {
  id: LabCheckId;
  title: string;
  decision: string;
  answers: string;
  note?: string;
  items: LabItemView[];
}

export type LabFactsView = Omit<LabResultFacts, 'imagePath' | 'quoteBasis' | 'quoteSource'>;

export interface LabRunView {
  id: string;
  checkId: LabCheckId;
  itemId: string;
  title: string;
  model: { id: string; nickname: string };
  status: 'running' | 'ok' | 'failed' | 'interrupted';
  kind: string;
  res: string | null;
  aspect: string | null;
  quotedUsd: number;
  costUsd: number | null;
  quoteBasis?: string;
  facts: LabFactsView;
  imageUrl?: string;
  createdAt: string;
  finishedAt: string | null;
}

/** One side of a blind pair. Before the vote it carries ONLY the slot and the image (no model, cost, size or id). */
export interface BlindSideView {
  slot: 'A' | 'B';
  imageUrl?: string;
  /** After the vote. */
  run?: LabRunView;
}

export interface BlindPairView {
  id: string;
  label: string;
  state: 'waiting' | 'ready' | 'voted';
  /** Models that still have to draw this one (naming them reveals nothing about A/B: no image is shown yet). */
  waitingFor?: string[];
  a?: BlindSideView;
  b?: BlindSideView;
  pick?: BlindPick;
  /** A ready pair: an opaque tag of the two drawings shown (no model, run id or cost in it). The vote sends it back,
   *  so a vote always records the pair the owner actually saw. */
  seen?: string;
}

export interface LabOverview {
  capUsd: number;
  day: string;
  spentUsd: number;
  remainingUsd: number;
  ready: { platformKey: boolean; storage: boolean };
  checks: LabCheckView[];
  /** D1–D3 runs, newest first. D4 runs appear only inside the blind pairs. */
  results: LabRunView[];
  blind: BlindPairView[];
  now: number;
}

/** A D4 run's click answer: no image (it is judged blind in the pair view), but the money facts stay visible. */
export interface LabBlindRunView {
  id: string;
  checkId: 'D4';
  itemId: string;
  status: 'ok' | 'failed' | 'running' | 'interrupted';
  pair: { id: string; label: string };
  quotedUsd: number;
  costUsd: number | null;
  /** A request reached the provider, and whether it reported usage.cost: so a $0 HTTP failure is never read as a
   *  provider-reported cost. Neither says which side or model this is. */
  callMade: boolean;
  costReported: boolean;
  message?: string | null;
}

export interface LabRunAnswer {
  replayed: boolean;
  run: LabRunView | LabBlindRunView;
  spentUsd: number;
  remainingUsd: number;
}

// ── Errors (honest copy; every refusal before a call says nothing was charged) ──

export type LabErrorCode =
  | 'ACK_REQUIRED'
  | 'BAD_KEY'
  | 'BAD_REQUEST'
  | 'UNKNOWN_CHECK'
  | 'NOT_RUNNABLE'
  | 'NO_PLATFORM_KEY'
  | 'NO_STORAGE'
  | 'PROVIDER_DOWN'
  | 'LAB_BUSY'
  | 'NO_QUOTE'
  | 'QUOTE_CHANGED'
  | 'LAB_CAP_REACHED'
  | 'NOT_FOUND'
  | 'PAIR_NOT_READY'
  | 'ALREADY_VOTED'
  | 'NOT_DRAWN'
  | 'PAIR_CHANGED';

export type LabError = StudioError & { labCode: LabErrorCode; details?: Record<string, unknown> };

const labError = (labCode: LabErrorCode, status: number, message: string, details?: Record<string, unknown>): LabError => {
  const code = status === 400 ? 'BAD_REQUEST' : status === 404 ? 'NOT_FOUND' : status === 503 ? 'NOT_AVAILABLE' : 'CONFLICT';
  return Object.assign(new StudioError(code, message, { status }), { labCode, ...(details ? { details } : {}) });
};
export const isLabError = (err: unknown): err is LabError => err instanceof StudioError && typeof (err as { labCode?: unknown }).labCode === 'string';

const NOTHING_CHARGED = 'Nothing was charged.';

// ── The service ──────────────────────────────────────────────────────────────

export interface ModelLabDeps {
  /** Null when this server cannot record results (the lab then refuses to spend). */
  store: LabStore | null;
  storage: LabStorage | null;
  /** The PLATFORM's keys (never a user's). */
  keys: () => StudioKeys | null;
  /** The live PriceBook (createPriceBook) for the admin. */
  prices: (userId: string) => Promise<ServerPriceBook | null>;
  health: Pick<ModelHealthPort, 'getModelHealth'>;
  /** The network the studio transport uses; wrapped so one provider call goes out per click. */
  network: typeof fetch;
  /**
   * The Images-API transport's endpoint list (price lines, resolutions, reference caps) for `provider.only`. Absent =
   * the transport's own cached, key-less read; a GET, never a provider call, so it is not the click's one call.
   */
  imageEndpoints?: ImageClientDeps['imageEndpoints'];
  now: () => number;
  newId?: () => string;
  audit?: (input: AuditInput) => unknown;
  capUsd?: number;
}

export interface ModelLab {
  overview(adminId: string): Promise<LabOverview>;
  run(adminId: string, body: unknown): Promise<LabRunAnswer>;
  setWatermark(adminId: string, runId: string, body: unknown): Promise<LabRunView>;
  vote(adminId: string, pairId: string, body: unknown): Promise<BlindPairView>;
}

interface RunInput {
  itemId: string;
  key: string;
  quotedUsd: number;
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Validate a run request. `ack: true` is checked FIRST: without it nothing else is read and nothing is called. */
export const parseRunBody = (body: unknown): RunInput => {
  const b = isObject(body) ? body : {};
  if (b.ack !== true) throw labError('ACK_REQUIRED', 400, `Confirm the quoted cost first — the lab never makes a paid call without it. ${NOTHING_CHARGED}`);
  if (typeof b.idempotencyKey !== 'string' || !LAB_KEY_RE.test(b.idempotencyKey)) {
    throw labError('BAD_KEY', 400, `This click has no valid id, so it can't be made safe to repeat. Reload the lab and try again. ${NOTHING_CHARGED}`);
  }
  if (typeof b.itemId !== 'string' || !b.itemId || b.itemId.length > 80) throw labError('BAD_REQUEST', 400, `Say which check to run. ${NOTHING_CHARGED}`);
  if (!isFiniteNumber(b.quotedUsd) || b.quotedUsd <= 0) throw labError('ACK_REQUIRED', 400, `Confirm the quoted cost first — the request carried no quote. ${NOTHING_CHARGED}`);
  return { itemId: b.itemId, key: b.idempotencyKey, quotedUsd: b.quotedUsd };
};

const sameQuote = (a: number, b: number) => Math.abs(a - b) <= QUOTE_EPSILON;

/** OpenRouter only: the lab never moves a check onto another route (D2/D3 are OpenRouter checks by definition). */
const platformOpenRouter = (keys: StudioKeys | null): StudioKeys | null => (keys?.openrouter?.key && !keys.openrouter.byok ? { openrouter: keys.openrouter } : null);

const routeHealth = (h: ModelHealth): LabHealthView => {
  const r = h.routes.find((x) => x.route === 'openrouter') ?? h.routes[0];
  return r ? { state: r.state, ...(r.reason ? { reason: r.reason } : {}), source: r.source, checkedAt: r.checkedAt } : { state: h.state, source: 'none', checkedAt: h.checkedAt };
};

const downCopy = (nickname: string, h: LabHealthView): string => {
  const reason = h.reason ? h.reason.replace(/\.$/, '') : '';
  const source = h.source === 'observed' ? 'our recent calls' : h.source === 'openrouter' ? 'OpenRouter status' : '';
  return `${nickname} is paused right now${reason ? ` — ${reason.charAt(0).toLowerCase()}${reason.slice(1)}` : ''}${source ? ` (${source})` : ''}. The lab didn't call it. ${NOTHING_CHARGED} Provider status shows when it's serving again.`;
};

/** How long imageClient.ts skips a model's Images API after a 404/405 (its IMAGES_API_RECHECK_MS, per process). */
const IMAGES_API_SKIP_MS = 15 * 60_000;
const hhmm = (ms: number) => new Date(ms).toISOString().slice(11, 16);

/**
 * A D2 item whose Images API answered 404/405 in the last 15 minutes: say so before the click. Not a refusal — the
 * transport's skip lives in this process only (a restart clears it), and inside it the transport itself refuses a
 * click unsent — but the owner should know a click now may come back "not sent".
 */
const imagesApiSkipNote = (item: LabItem, runs: LabRunRow[], now: number): string | undefined => {
  if (item.transport !== '/images') return undefined;
  const last = runs.find((r) => r.modelId === item.modelId && r.result.errorCode === 'IMAGES_API_UNAVAILABLE' && r.finishedAt); // newest first
  const at = last?.finishedAt ? Date.parse(last.finishedAt) : NaN;
  if (!Number.isFinite(at) || now - at >= IMAGES_API_SKIP_MS) return undefined;
  return `OpenRouter's Images API answered ${last!.result.httpStatus ?? 404} for this model at ${hhmm(at)} UTC. Until about ${hhmm(at + IMAGES_API_SKIP_MS)} UTC our transport may skip it; if it does, this call isn't sent and nothing is charged.`;
};

/** A D4 side whose pair is drawn and waiting for the vote: a redraw now would change one image and give A/B away. */
const pairReadyCopy = (label: string): string => `Vote on ${label} first — a new drawing now would show which side is which model.`;

/** The tag of a ready pair's two drawings, in A/B order (sha256 of their random preview paths). */
const seenTag = (a: LabRunRow, b: LabRunRow): string =>
  createHash('sha256').update(`${a.result.imagePath ?? a.id}|${b.result.imagePath ?? b.id}`).digest('hex').slice(0, 24);

const capCopy = (spent: number, cap: number, quote: number): string =>
  `Today's lab budget can't cover this: ${money(spent)} of ${money(cap)} used (UTC day), and this check is quoted at ${money(quote)}. It resets at 00:00 UTC. ${NOTHING_CHARGED}`;

const statusOf = (r: LabRunRow, now: number): LabRunView['status'] =>
  r.status === 'running' && now - Date.parse(r.createdAt) > LAB_STALE_RUN_MS ? 'interrupted' : r.status;

const factsView = (f: LabResultFacts): LabFactsView => {
  const { imagePath: _p, quoteBasis: _b, quoteSource: _s, ...rest } = f;
  return rest;
};

/** The provider's first answer, in words, when the lab stopped the transport's second attempt — or, for a check tied
 *  to one endpoint, why its only call was stopped before it was sent (nothing reached the provider). The studio
 *  never sends an Images-API model to chat (models.md §3.4 item 8): a 404/405 on /images ends the transport's attempt
 *  and its 15-minute skip refuses unsent, both answered in callOnce. The two Images-API branches here are guards for
 *  a transport that ever tried a second call or another endpoint, and they say only what the lab saw. */
export const firstAnswerCopy = (cap: ProviderCapture): { code: string; message: string } => {
  if (cap.skippedTransport !== undefined) {
    return {
      code: 'IMAGES_API_SKIPPED',
      message: `This check tests OpenRouter's Images API, but the transport tried ${cap.skippedTransport} instead, so the lab stopped the call before it was sent. ${NOTHING_CHARGED}`
    };
  }
  const stop = ' The studio would try once more; the lab stops after one call.';
  if (cap.networkError) return { code: 'PROVIDER_ERROR', message: `The request failed before any answer (${cap.networkError}).${stop}` };
  if (cap.downloadFailed) return { code: 'PROVIDER_ERROR', message: `The image was made${cap.costUsd !== undefined ? ' and billed' : ''}, but downloading it from the provider failed.${stop}` };
  const status = cap.status ?? 0;
  if (status >= 200 && status < 300) return { code: 'NO_IMAGE', message: `The model answered without a picture.${stop}` };
  if ((status === 404 || status === 405) && cap.endpoint === '/images') {
    return { code: 'IMAGES_API_UNAVAILABLE', message: `OpenRouter's Images API answered ${status} for this model. The transport tried a second call, and the lab stopped it before it was sent.` };
  }
  const classified = classifyImageError(Object.assign(new Error(cap.said || `HTTP ${status}`), { status }), { route: 'openrouter', byok: false });
  return { code: classified.code, message: `${classified.userMessage}${classified.retryable ? stop : ''}` };
};

export function createModelLab(deps: ModelLabDeps): ModelLab {
  const capUsd = Math.min(deps.capUsd ?? LAB_DAILY_CAP_USD, LAB_DAILY_CAP_USD);
  const newId = deps.newId ?? randomUUID;
  /** The click being run right now (one paid call at a time per server). */
  let inflightKey: string | null = null;

  const needStore = (): LabStore => {
    if (!deps.store) throw labError('NO_STORAGE', 503, `Results can't be saved on this server (storage isn't configured), so the lab won't spend on a result it can't keep. ${NOTHING_CHARGED}`);
    return deps.store;
  };

  const healthOf = async (spec: ImageModelSpec, keys: StudioKeys | null): Promise<LabHealthView | null> => {
    try {
      return routeHealth(await deps.health.getModelHealth(spec, keys ? { keys } : {}));
    } catch (err) {
      logger.warn('comic_model_lab_health_failed', { model: spec.id, message: String((err as Error)?.message || err).slice(0, 160) });
      return null; // unknown never blocks
    }
  };

  /** Latest ok run with a stored preview per item. */
  const latestOk = (runs: LabRunRow[]): Map<string, LabRunRow> => {
    const out = new Map<string, LabRunRow>();
    for (const r of runs) if (r.status === 'ok' && r.result.imagePath && !out.has(r.itemId)) out.set(r.itemId, r); // runs are newest first
    return out;
  };

  /** D4 pages: this model's own drawn sheets, in cast order. */
  const ownSheets = (item: LabItem, latest: Map<string, LabRunRow>): { label: string; path: string }[] =>
    LAB_CAST.flatMap((c) => {
      const sheet = labItems().find((i) => i.check === 'D4' && i.modelId === item.modelId && i.prompt === `sheet-${c.slot}`);
      const run = sheet ? latest.get(sheet.id) : undefined;
      return run?.result.imagePath ? [{ label: c.label, path: run.result.imagePath }] : [];
    });

  const refsPlan = (item: LabItem, latest: Map<string, LabRunRow>): { count: number; note: string } => {
    if (item.references === 'fixture') return { count: LAB_CAST.length, note: '4 synthetic reference cards (Maya, Tomas, Pip, the boathouse)' };
    if (item.references === 'none') return { count: 0, note: 'no references (drawn from the description)' };
    const n = ownSheets(item, latest).length;
    return { count: n, note: n ? `${n} of 4 sheets this model drew, as references` : 'no references yet — draw this model’s sheets first for a fair page' };
  };

  const loadReferences = async (item: LabItem, latest: Map<string, LabRunRow>): Promise<ImageReference[]> => {
    if (item.references === 'fixture') return labFixtureReferences();
    if (item.references === 'none' || !deps.storage) return [];
    const out: ImageReference[] = [];
    for (const s of ownSheets(item, latest)) {
      try {
        out.push({ label: s.label, dataUrl: await deps.storage.loadDataUrl(s.path) });
      } catch (err) {
        logger.warn('comic_model_lab_sheet_unreadable', { item: item.id, message: String((err as Error)?.message || err).slice(0, 160) });
      }
    }
    return out;
  };

  const runView = (r: LabRunRow, now: number, urls: Record<string, string>): LabRunView => {
    const item = labItem(r.itemId);
    const spec = labModel(r.modelId);
    const imageUrl = r.result.imagePath ? urls[r.result.imagePath] : undefined;
    return {
      id: r.id,
      checkId: r.checkId,
      itemId: r.itemId,
      title: item?.title ?? r.itemId,
      model: { id: r.modelId, nickname: spec?.nickname ?? r.modelId },
      status: statusOf(r, now),
      kind: r.kind,
      res: r.res,
      aspect: r.aspect,
      quotedUsd: r.quotedUsd,
      costUsd: r.costUsd,
      ...(r.result.quoteBasis ? { quoteBasis: r.result.quoteBasis } : {}),
      facts: factsView(r.result),
      ...(imageUrl ? { imageUrl } : {}),
      createdAt: r.createdAt,
      finishedAt: r.finishedAt
    };
  };

  const blindRunView = (r: LabRunRow, now: number): LabBlindRunView => {
    const item = labItem(r.itemId);
    return {
      id: r.id,
      checkId: 'D4',
      itemId: r.itemId,
      status: statusOf(r, now) as LabBlindRunView['status'],
      pair: item?.pair ?? { id: r.itemId, label: r.itemId },
      quotedUsd: r.quotedUsd,
      costUsd: r.costUsd,
      callMade: r.result.callMade === true,
      costReported: r.result.costReported === true,
      message: r.result.message ?? null
    };
  };

  const signAll = async (paths: string[]): Promise<Record<string, string>> => {
    if (!paths.length || !deps.storage) return {};
    try {
      return await deps.storage.signUrls([...new Set(paths)]);
    } catch (err) {
      logger.warn('comic_model_lab_sign_failed', { message: String((err as Error)?.message || err).slice(0, 160) });
      return {};
    }
  };

  /**
   * The blind pairs. A and B are ordered by each preview's random object id — stable, and unrelated to anything the
   * client saw when it clicked (the click answer carries no image and the run id is not in the image path).
   */
  const pairsOf = (runs: LabRunRow[], votes: LabVoteRow[]): { pair: { id: string; label: string }; state: BlindPairView['state']; a?: LabRunRow; b?: LabRunRow; waitingFor: string[]; vote?: LabVoteRow }[] => {
    const latest = latestOk(runs);
    const byId = new Map(runs.map((r) => [r.id, r] as const));
    const pairs = new Map<string, LabItem[]>();
    for (const i of labItems()) if (i.pair && !i.unavailable) pairs.set(i.pair.id, [...(pairs.get(i.pair.id) ?? []), i]);
    return [...pairs.values()].map((items) => {
      const pair = items[0].pair!;
      const vote = votes.find((v) => v.pairId === pair.id);
      if (vote) {
        const a = byId.get(vote.aRunId);
        const b = byId.get(vote.bRunId);
        if (a && b) return { pair, state: 'voted' as const, a, b, waitingFor: [], vote };
      }
      const done = items.map((i) => ({ i, run: latest.get(i.id) }));
      const waitingFor = done.filter((d) => !d.run).map((d) => labModel(d.i.modelId)?.nickname ?? d.i.modelId);
      if (waitingFor.length) return { pair, state: 'waiting' as const, waitingFor };
      const [a, b] = done.map((d) => d.run!).sort((x, y) => String(x.result.imagePath).localeCompare(String(y.result.imagePath)));
      return { pair, state: 'ready' as const, a, b, waitingFor: [] };
    });
  };

  const blindViews = async (runs: LabRunRow[], votes: LabVoteRow[], now: number): Promise<BlindPairView[]> => {
    const pairs = pairsOf(runs, votes);
    const urls = await signAll(pairs.flatMap((p) => [p.a?.result.imagePath, p.b?.result.imagePath]).filter((x): x is string => !!x));
    return pairs.map((p) => {
      const base: BlindPairView = { id: p.pair.id, label: p.pair.label, state: p.state };
      if (p.state === 'waiting') return { ...base, waitingFor: p.waitingFor };
      const side = (slot: 'A' | 'B', r: LabRunRow): BlindSideView => {
        const imageUrl = r.result.imagePath ? urls[r.result.imagePath] : undefined;
        return p.state === 'voted' ? { slot, ...(imageUrl ? { imageUrl } : {}), run: runView(r, now, urls) } : { slot, ...(imageUrl ? { imageUrl } : {}) };
      };
      return { ...base, a: side('A', p.a!), b: side('B', p.b!), ...(p.vote ? { pick: p.vote.pick } : {}), ...(p.state === 'ready' ? { seen: seenTag(p.a!, p.b!) } : {}) };
    });
  };

  const overview = async (adminId: string): Promise<LabOverview> => {
    const now = deps.now();
    const day = utcDay(now);
    const keys = platformOpenRouter(deps.keys());
    const store = deps.store;
    const [runs, votes, spentUsd, prices] = await Promise.all([
      store ? store.recent(LAB_RECENT_LIMIT) : Promise.resolve([] as LabRunRow[]),
      store ? store.votes() : Promise.resolve([] as LabVoteRow[]),
      store ? store.spent(day) : Promise.resolve(0),
      deps.prices(adminId).catch(() => null)
    ]);
    const remainingUsd = round6(Math.max(0, capUsd - spentUsd));
    const latest = latestOk(runs);
    const models = [...new Set(labItems().map((i) => i.modelId))];
    const healthByModel = new Map<string, LabHealthView | null>(
      await Promise.all(models.map(async (id) => [id, labModel(id) ? await healthOf(labModel(id)!, keys) : null] as const))
    );

    const pairState = new Map(pairsOf(runs, votes).map((p) => [p.pair.id, p.state] as const));

    const itemView = (item: LabItem): LabItemView => {
      const spec = labModel(item.modelId);
      const refs = refsPlan(item, latest);
      const quote = item.unavailable ? null : quoteLabItem(item, prices, refs.count);
      const health = healthByModel.get(item.modelId) ?? null;
      const mine = runs.filter((r) => r.itemId === item.id);
      let reason: string | undefined;
      if (item.unavailable) reason = item.unavailable;
      else if (!keys) reason = "The platform OpenRouter key isn't set on this server.";
      else if (!store || !deps.storage) reason = "Results can't be saved on this server (storage isn't configured), so the lab won't spend on a result it can't keep.";
      else if (item.pair && pairState.get(item.pair.id) === 'ready') reason = pairReadyCopy(item.pair.label);
      else if (!quote) reason = `There's no price to quote for ${spec?.nickname ?? item.modelId} at ${item.res}, so the lab won't run it.`;
      else if (health?.state === 'down') reason = downCopy(spec?.nickname ?? item.modelId, health);
      else if (spentUsd + quote.usd > capUsd + 1e-9) reason = capCopy(spentUsd, capUsd, quote.usd);
      const note = [item.note, item.unavailable ? undefined : imagesApiSkipNote(item, runs, now)].filter(Boolean).join(' ') || undefined;
      return {
        id: item.id,
        check: item.check,
        title: item.title,
        modelId: item.modelId,
        nickname: spec?.nickname ?? item.modelId,
        kind: item.kind,
        res: item.res,
        aspect: item.aspect,
        refs: refs.count,
        refsNote: refs.note,
        quote,
        health,
        canRun: !reason,
        ...(reason ? { reason } : {}),
        ...(note ? { note } : {}),
        ...(item.pair ? { pair: item.pair } : {}),
        runs: { ok: mine.filter((r) => r.status === 'ok').length, failed: mine.filter((r) => r.status === 'failed').length, running: mine.filter((r) => r.status === 'running').length }
      };
    };

    const shown = runs.filter((r) => r.checkId !== 'D4').slice(0, LAB_RESULTS_SHOWN);
    const urls = await signAll(shown.map((r) => r.result.imagePath).filter((p): p is string => !!p));
    return {
      capUsd,
      day,
      spentUsd: round6(spentUsd),
      remainingUsd,
      ready: { platformKey: !!keys, storage: !!store && !!deps.storage },
      checks: LAB_CHECKS.map((c) => ({ id: c.id, title: c.title, decision: c.decision, answers: c.answers, ...(c.note ? { note: c.note } : {}), items: c.items.map(itemView) })),
      results: shown.map((r) => runView(r, now, urls)),
      blind: await blindViews(runs, votes, now),
      now
    };
  };

  const answerFor = async (row: LabRunRow, replayed: boolean, store: LabStore): Promise<LabRunAnswer> => {
    const now = deps.now();
    const spentUsd = await store.spent(utcDay(now)).catch(() => NaN);
    const run =
      row.checkId === 'D4'
        ? blindRunView(row, now)
        : runView(row, now, row.result.imagePath ? await signAll([row.result.imagePath]) : {});
    return { replayed, run, spentUsd: isFiniteNumber(spentUsd) ? spentUsd : 0, remainingUsd: isFiniteNumber(spentUsd) ? round6(Math.max(0, capUsd - spentUsd)) : 0 };
  };

  /** Make the one call and turn its outcome into facts. Never throws for a provider failure. */
  const callOnce = async (
    item: LabItem,
    spec: ImageModelSpec,
    keys: StudioKeys,
    references: ImageReference[],
    adminId: string
  ): Promise<{ status: 'ok' | 'failed'; costUsd: number | null; providerModel: string | null; facts: LabResultFacts }> => {
    const transport = oneCallTransport(deps.network, deps.now, { requirePath: item.transport });
    const images = createImageGenerator(keys, {
      fetch: transport.fetch,
      // The lab never uses Gemini direct (its keys hold OpenRouter only); if anything tried, it would be a second call.
      createGemini: () => ({ generateContent: async () => Promise.reject(oneCallStop()) }),
      // No waiting on shared cooldowns or retry backoff: a second attempt is stopped anyway.
      sleep: async () => undefined,
      now: deps.now,
      ...(deps.imageEndpoints ? { imageEndpoints: deps.imageEndpoints } : {})
    });
    const cap = transport.capture;
    const base = (): LabResultFacts => ({
      callMade: cap.calls > 0,
      endpoint: cap.endpoint ?? null,
      httpStatus: cap.status ?? null,
      providerMs: cap.ms,
      providerModelVersion: cap.reportedModel ?? null,
      providerName: cap.providerName ?? null,
      generationId: cap.generationId ?? null,
      sent: cap.sent ?? null,
      refsSent: cap.sent?.references ?? 0,
      costReported: cap.costUsd !== undefined,
      // A SECOND call was stopped (one went out first). A first call stopped for its endpoint is not one.
      stoppedSecondCall: cap.calls > 0 && cap.stopped > 0
    });
    try {
      const result = await images({ spec, resolution: item.res, aspect: item.aspect, prompt: labPrompt(item, references.map((r) => r.label)), references });
      const facts: LabResultFacts = { ...base(), latencyMs: result.latencyMs };
      const cost = cap.costUsd ?? (isFiniteNumber(result.costUsd) ? result.costUsd : undefined);
      if (cost !== undefined) facts.costReported = true;
      // Measure the image the provider returned (pixel size, file size) before anything is downscaled.
      try {
        const { mimeType, buffer } = decodeImageDataUrl(result.dataUrl);
        facts.mediaType = mimeType;
        facts.bytes = buffer.byteLength;
        const m = await measureImage(buffer, item.aspect);
        Object.assign(facts, { width: m.w, height: m.h, aspectOk: m.aspectOk, blank: m.blank });
        if (deps.storage) {
          const preview = decodeImageDataUrl(await previewImage(buffer, LAB_PREVIEW_EDGE));
          const path = buildRefPath(adminId, LAB_STORAGE_PROJECT, newId());
          await deps.storage.put(path, preview.buffer, 'image/webp');
          facts.imagePath = path;
          facts.stored = true;
        }
      } catch (err) {
        facts.stored = false;
        facts.message = "The image came back and was paid for, but the lab couldn't read or store it.";
        logger.warn('comic_model_lab_store_failed', { item: item.id, message: String((err as Error)?.message || err).slice(0, 200) });
      }
      return { status: 'ok', costUsd: cost ?? null, providerModel: spec.routes.openrouter ?? null, facts };
    } catch (err) {
      const facts = base();
      if (isOneCallStop(err)) {
        const first = firstAnswerCopy(cap);
        facts.errorCode = first.code;
        facts.message = first.message;
      } else if (err instanceof StudioError) {
        facts.errorCode = err.code;
        facts.message = err.userMessage;
        const info = imageFailureInfo(err);
        if (info?.status && !facts.httpStatus) facts.httpStatus = info.status;
        if (info?.providerName && !facts.providerName) facts.providerName = info.providerName;
        // An Images-API model never goes to chat (models.md §3.4 item 8): after a 404/405 on /images the transport
        // itself stops, and inside its 15-minute skip it sends nothing at all. Name both, so the D2 answer is exact.
        if (item.transport === '/images' && modelUnavailableReason(err) === IMAGES_API_GONE_REASON) {
          const status = cap.status ?? 0;
          if (facts.callMade && cap.endpoint === '/images' && (status === 404 || status === 405)) {
            facts.errorCode = 'IMAGES_API_UNAVAILABLE';
            facts.message = `OpenRouter's Images API answered ${status} for this model. The studio never sends this model through chat instead, so nothing else was sent.`;
          } else if (!facts.callMade) {
            facts.errorCode = 'IMAGES_API_SKIPPED';
            facts.message = `Our transport is skipping OpenRouter's Images API for this model for up to 15 minutes after its last 404 or 405, and it never sends this model through chat, so this D2 call wasn't sent. ${NOTHING_CHARGED}`;
          }
        }
      } else {
        facts.errorCode = 'INTERNAL';
        facts.message = 'The lab could not finish this call.';
        logger.error('comic_model_lab_call_failed', { item: item.id, message: String((err as Error)?.message || err).slice(0, 200) });
      }
      if (cap.said) facts.providerSaid = cap.said;
      const spentOnFailure = (err as { spentUsd?: unknown })?.spentUsd;
      // imageClient tags a failure with the provider's cost only when money was spent (> 0); its `spentUsd: 0` on a
      // refusal that made no paid call means "nothing spent", not a cost the provider reported.
      const reported = cap.costUsd ?? (isFiniteNumber(spentOnFailure) && spentOnFailure > 0 ? spentOnFailure : undefined);
      facts.costReported = reported !== undefined;
      // Cost: what the provider reported; else $0 when no call left the server, or when the provider answered with an
      // HTTP error (OpenRouter bills no failed generation); otherwise unknown (null), so the cap keeps the quote.
      const cost = reported ?? (!facts.callMade ? 0 : (cap.status ?? 0) >= 400 ? 0 : null);
      return { status: 'failed', costUsd: cost, providerModel: spec.routes.openrouter ?? null, facts };
    }
  };

  const run = async (adminId: string, body: unknown): Promise<LabRunAnswer> => {
    const input = parseRunBody(body); // no ack → nothing else happens
    const store = needStore();
    const existing = await store.byKey(input.key);
    if (existing) return answerFor(existing, true, store);

    const item = labItem(input.itemId);
    if (!item) throw labError('UNKNOWN_CHECK', 404, `There's no lab check called “${input.itemId.slice(0, 80)}”. ${NOTHING_CHARGED}`);
    if (item.unavailable) throw labError('NOT_RUNNABLE', 409, `${item.unavailable} ${NOTHING_CHARGED}`);
    const spec = labModel(item.modelId);
    if (!spec?.routes.openrouter) throw labError('NOT_RUNNABLE', 409, `This check has no OpenRouter model to call. ${NOTHING_CHARGED}`);
    const keys = platformOpenRouter(deps.keys());
    if (!keys) throw labError('NO_PLATFORM_KEY', 503, `The platform OpenRouter key isn't set on this server, so this check can't run. ${NOTHING_CHARGED}`);
    if (!deps.storage) throw labError('NO_STORAGE', 503, `Results can't be saved on this server (storage isn't configured), so the lab won't spend on a result it can't keep. ${NOTHING_CHARGED}`);
    if (inflightKey === input.key) {
      throw labError('LAB_BUSY', 409, 'This click is still running. Its result shows here when the provider answers; it will not be sent twice.', { sameClick: true });
    }
    if (inflightKey) throw labError('LAB_BUSY', 409, `Another lab check is running. Wait for it to finish — one paid call at a time. ${NOTHING_CHARGED}`);
    inflightKey = input.key;
    try {
      const recentRuns = item.pair || item.references === 'own_sheets' ? await store.recent(LAB_RECENT_LIMIT) : [];
      // Blind test: while a pair waits for its vote, neither side may be redrawn (one image would change, and the
      // re-sorted A/B would tell which side is which model). Checked while this click holds the in-flight slot, so no
      // other run can complete the pair in between.
      if (item.pair) {
        const pair = pairsOf(recentRuns, await store.votes()).find((p) => p.pair.id === item.pair!.id);
        if (pair?.state === 'ready') throw labError('NOT_RUNNABLE', 409, `${pairReadyCopy(item.pair.label)} ${NOTHING_CHARGED}`);
      }

      const health = await healthOf(spec, keys);
      if (health?.state === 'down') throw labError('PROVIDER_DOWN', 503, downCopy(spec.nickname, health), { health });

      const latest = item.references === 'own_sheets' ? latestOk(recentRuns) : new Map<string, LabRunRow>();
      const references = await loadReferences(item, latest);
      const prices = await deps.prices(adminId).catch(() => null);
      const quote = quoteLabItem(item, prices, references.length);
      if (!quote) throw labError('NO_QUOTE', 409, `There's no price to quote for ${spec.nickname} at ${item.res}, so the lab won't run it (it never spends without showing the cost first). ${NOTHING_CHARGED}`);
      if (!sameQuote(quote.usd, input.quotedUsd)) {
        throw labError('QUOTE_CHANGED', 409, `The price changed since you opened this: it's now ${money(quote.usd)} (you confirmed ${money(input.quotedUsd)}). Check the new cost and confirm again. ${NOTHING_CHARGED}`, { quote });
      }
      const now = deps.now();
      const spent = await store.spent(utcDay(now));
      if (spent + quote.usd > capUsd + 1e-9) throw labError('LAB_CAP_REACHED', 409, capCopy(spent, capUsd, quote.usd), { spentUsd: spent, capUsd, quoteUsd: quote.usd });

      const reserved = await store.reserve({
        key: input.key,
        adminId,
        checkId: item.check,
        itemId: item.id,
        modelId: spec.id,
        providerModel: spec.routes.openrouter,
        kind: item.kind,
        res: item.res,
        aspect: item.aspect,
        refs: references.length,
        quotedUsd: quote.usd,
        capUsd
      });
      if (reserved.outcome === 'existing') return answerFor(reserved.row, true, store);
      if (reserved.outcome === 'cap') throw labError('LAB_CAP_REACHED', 409, capCopy(reserved.spentUsd, capUsd, quote.usd), { spentUsd: reserved.spentUsd, capUsd, quoteUsd: quote.usd });

      // ── The one paid call ──
      const outcome = await callOnce(item, spec, keys, references, adminId);
      const facts: LabResultFacts = { ...outcome.facts, quoteBasis: quote.basis, quoteSource: quote.source };

      if (facts.callMade) {
        try {
          await store.recordImageCall({
            user_id: adminId,
            project_id: null,
            model_id: spec.id,
            provider_model: spec.routes.openrouter,
            route: 'openrouter',
            provider_name: facts.providerName ?? null,
            kind: item.kind,
            res: item.res,
            aspect: item.aspect,
            refs: facts.refsSent,
            outcome: outcome.status,
            http_status: facts.httpStatus ?? null,
            error_code: outcome.status === 'ok' ? null : facts.httpStatus === 429 ? 'RATE_LIMIT' : facts.errorCode ?? null,
            provider_cost_usd: facts.costReported ? outcome.costUsd : null,
            billed_usd: 0, // nobody is billed: the platform pays for the owner's checks
            byok: false,
            latency_ms: facts.latencyMs ?? facts.providerMs ?? null
          });
          facts.recordedCall = true;
        } catch (err) {
          facts.recordedCall = false; // the lab row still holds every fact
          logger.warn('comic_model_lab_image_call_not_recorded', { item: item.id, message: String((err as Error)?.message || err).slice(0, 200) });
        }
      }

      const patch = { status: outcome.status, costUsd: outcome.costUsd, providerModel: outcome.providerModel, result: facts, finishedAt: new Date(deps.now()).toISOString() };
      // The call is made and paid for: try twice to record it (a row left 'running' keeps holding its quote). If both
      // writes fail, the facts would survive nowhere else (comic_image_calls has no version, pixels or preview path),
      // so they go to the error log before the failure is answered.
      const finished = await store.finish(reserved.row.id, patch).catch(async (err) => {
        logger.warn('comic_model_lab_finish_retry', { id: reserved.row.id, message: String((err as Error)?.message || err).slice(0, 200) });
        try {
          return await store.finish(reserved.row.id, patch);
        } catch (again) {
          logger.error('comic_model_lab_finish_failed', {
            id: reserved.row.id,
            check: item.check,
            item: item.id,
            status: patch.status,
            quotedUsd: quote.usd,
            costUsd: patch.costUsd,
            costReported: facts.costReported ?? false,
            providerModelVersion: facts.providerModelVersion ?? null,
            generationId: facts.generationId ?? null,
            imagePath: facts.imagePath ?? null,
            width: facts.width ?? null,
            height: facts.height ?? null,
            bytes: facts.bytes ?? null,
            latencyMs: facts.latencyMs ?? null,
            recordedCall: facts.recordedCall ?? false,
            message: String((again as Error)?.message || again).slice(0, 200)
          });
          throw again;
        }
      });
      try {
        await deps.audit?.({
          actorId: adminId,
          action: 'comic_model_lab_run',
          targetType: 'comic_model_lab_run',
          targetId: finished.id,
          detail: { check: item.check, item: item.id, model: spec.id, status: outcome.status, quotedUsd: quote.usd, costUsd: outcome.costUsd, providerModelVersion: facts.providerModelVersion ?? null }
        });
      } catch {
        /* best-effort */
      }
      logger.info('comic_model_lab_run', { check: item.check, item: item.id, status: outcome.status, quotedUsd: quote.usd, costUsd: outcome.costUsd, calls: facts.callMade ? 1 : 0, stoppedSecondCall: !!facts.stoppedSecondCall });
      return answerFor(finished, false, store);
    } finally {
      inflightKey = null;
    }
  };

  const setWatermark = async (adminId: string, runId: string, body: unknown): Promise<LabRunView> => {
    const store = needStore();
    const b = isObject(body) ? body : {};
    if (!(b.visible === true || b.visible === false || b.visible === null)) throw labError('BAD_REQUEST', 400, 'Say whether the watermark is visible (yes, no, or not checked).');
    const row = await store.byId(String(runId).slice(0, 64));
    if (!row) throw labError('NOT_FOUND', 404, 'That lab result is gone.');
    if (row.status !== 'ok') throw labError('NOT_DRAWN', 409, 'Only a drawn result can be checked for a watermark.');
    // A D4 result before its pair's vote stays blind: no per-run edits that would tie a run to a side.
    if (row.checkId === 'D4') {
      const pair = labItem(row.itemId)?.pair;
      const voted = pair ? (await store.votes()).some((v) => v.pairId === pair.id && (v.aRunId === row.id || v.bRunId === row.id)) : false;
      if (!voted) throw labError('PAIR_NOT_READY', 409, 'Vote on this pair first; the watermark box appears with the names.');
    }
    const now = deps.now();
    const updated = await store.updateResult(row.id, { ...row.result, watermark: { visible: b.visible as boolean | null, at: new Date(now).toISOString(), by: adminId } });
    return runView(updated, now, updated.result.imagePath ? await signAll([updated.result.imagePath]) : {});
  };

  const vote = async (adminId: string, pairId: string, body: unknown): Promise<BlindPairView> => {
    const store = needStore();
    const b = isObject(body) ? body : {};
    if (b.pick !== 'A' && b.pick !== 'B' && b.pick !== 'tie') throw labError('BAD_REQUEST', 400, 'Pick A, B or “about the same”.');
    const runs = await store.recent(LAB_RECENT_LIMIT);
    const votes = await store.votes();
    const pair = pairsOf(runs, votes).find((p) => p.pair.id === pairId);
    if (!pair) throw labError('NOT_FOUND', 404, 'There is no such blind pair.');
    if (pair.state === 'voted') throw labError('ALREADY_VOTED', 409, `You already voted on ${pair.pair.label}.`);
    if (pair.state !== 'ready' || !pair.a || !pair.b) throw labError('PAIR_NOT_READY', 409, `Both models need to draw ${pair.pair.label} before you can compare them.`);
    // The vote names the drawings it was cast on: if the pair is not the one the owner saw, nothing is recorded.
    if (typeof b.seen !== 'string' || b.seen !== seenTag(pair.a, pair.b)) {
      throw labError('PAIR_CHANGED', 409, `The drawings for ${pair.pair.label} changed since you opened them, so this vote wasn't saved. Refresh the lab and vote on what you see.`);
    }
    const recorded = await store.addVote({ pairId, adminId, pick: b.pick, aRunId: pair.a.id, bRunId: pair.b.id });
    if (recorded === 'exists') throw labError('ALREADY_VOTED', 409, `You already voted on ${pair.pair.label}.`);
    try {
      await deps.audit?.({ actorId: adminId, action: 'comic_model_lab_vote', targetType: 'comic_model_lab_pair', targetId: pairId, detail: { pick: b.pick, a: pair.a.modelId, b: pair.b.modelId } });
    } catch {
      /* best-effort */
    }
    const views = await blindViews(runs, await store.votes(), deps.now());
    return views.find((v) => v.id === pairId)!;
  };

  return { overview, run, setWatermark, vote };
}

// ── Production dependencies (built lazily by the route; nothing at import) ───

export function createDefaultLabDeps(): ModelLabDeps {
  const assets = getSupabaseCapabilityStatus().storagePersistenceEnabled ? createSupabaseAssetStore() : null;
  return {
    store: createSupabaseLabStore(),
    storage: assets
      ? {
          put: (path, buffer, contentType) => assets.putObject(path, buffer, contentType),
          loadDataUrl: (path) => assets.loadDataUrl(path),
          signUrls: (paths) => assets.signUrls(paths)
        }
      : null,
    keys: () => platformStudioKeys(),
    prices: (userId) => createPriceBook({ userId }),
    health: { getModelHealth: (spec, opts) => modelHealth().getModelHealth(spec, opts) },
    network: (input, init) => fetch(input, init),
    now: () => Date.now(),
    audit: (input) => recordAudit(input)
  };
}
