// Model Lab — the owner-approved paid checks D1–D4 (models.md §2.6; wm-plan M1-MODEL-LAB). Admin-only.
//
// The owner approved about $1 of real generations to settle four decisions. Builders never make a paid call; this
// module is how the OWNER makes them, one at a time, from Admin → Model Lab:
//   D1  Pro tier → Nano Banana 2.1 at 4K       one 4K 2:3 page with 4 references: cost, pixels, latency, file size
//   D2  GPT Image 2.5 Sunburst / Flare          one 2:3 page each through OpenRouter's Images API, 4 references
//   D3  Reveal Seedream 5.0 Pro                 one 2K page through OpenRouter: watermark visible? does 2K bill $0.09?
//   D4  Blind bake-off (optional)               Seedream 5.0 Flash vs Qwen Image 2.1 Turbo: 4 sheets + 2 pages each,
//                                               shown side by side as A / B with the names hidden until the owner votes
//   P1  Pro pages A/B, part 1 (plan §7, A6)     the owner's 3 golden pages drawn with the layout guide off and on, each
//                                               checked once, judged blind; OFF until COMIC_LAB_AB_BUDGET_USD is set
//                                               (PD-8: the test drawings are not approved yet). See "P1 · Pro pages A/B".
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
import { mapAssetRefs, normalizeDoc, type AspectRatio, type ComicDoc, type Page, type Resolution } from '../../../../shared/comic/doc.js';
import type { HealthState, ModelHealth } from '../../../../shared/comic/modelHealth.js';
import { lockOf, lockedSpecId } from '../../../../shared/comic/modelLock.js';
import { QC_USD_PER_PAGE, getImageModel, type ImageModelSpec } from '../../../../shared/comic/models.js';
import { REF_ALLOWANCE_USD } from '../../../../shared/comic/plan.js';
import { blockedPaths, nearestReadyBefore, withoutAssets } from '../../../../shared/comic/sendable.js';
import { reasoningBudget } from '../../ai/providers/openrouter.js';
import { OPENROUTER_APP_TITLE, OPENROUTER_APP_URL, OPENROUTER_BASE_URL } from '../../config.js';
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
import { tryRenderPageLayoutGuide, type LayoutGuideImage } from '../panelize/wireframe.js';
import { LAYOUT_REFERENCE_PATH, compilePage, type CompiledRenderJob } from '../prompts.js';
import { buildRefPath } from '../storagePaths.js';
import { TEXT_ROLE_DEFAULTS, resolveTextRoute } from '../textModels.js';
import { StudioError, type ImageReference, type LlmClient, type StudioKeys } from '../types.js';
import { analyzePageRender, type CheckedQcReport } from '../vision.js';
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

/**
 * Pro pages A/B (plan §7, §12 decision 1): about $0.90 of test drawings in two parts, with ONE hard cap of $1.20 over
 * every day, parts 1 (P1, this lab) and 2 (P2, B11) together. Enforced on the server before any call, atomically with
 * the daily cap (server/sql/comic_model_lab_pro_pages.sql); nothing can raise it.
 */
export const LAB_AB_HARD_CAP_USD = 1.2;
/**
 * Headroom held under the A/B limit for each image a drawing attaches (references and the layout guide), because the
 * quote can't price them: Nano Banana 2.1's reference input is unpublished (plan §7 names this per-reference provider
 * allowance, and real 2K pages bill about 27% over list). The quote shown stays the PriceBook's; only the limit a run
 * may reserve against shrinks, so a finished run's larger reported cost still lands under the hard cap. The number
 * lives in one place: shared/comic/plan.ts REF_ALLOWANCE_USD, the same allowance quoteRenderPages adds per extra
 * reference.
 */
export const LAB_AB_REF_ALLOWANCE_USD = REF_ALLOWANCE_USD;
/** The checks that share the A/B cap. */
export const LAB_AB_CHECKS: readonly LabCheckId[] = ['P1', 'P2'];
/**
 * The server-side budget switch for the A/B (container env, or a backend_env row, which reaches the container as env).
 * PROVISIONAL DEFAULT: unset = OFF. The owner has not approved the test drawings yet (PD-8): until this is set to a
 * dollar amount (at most LAB_AB_HARD_CAP_USD) nothing in the A/B can run or spend, even with an admin's confirm.
 */
export const LAB_AB_BUDGET_ENV = 'COMIC_LAB_AB_BUDGET_USD';

/** D1–D4: the owner-approved model checks (models.md §2.6). P1/P2: the Pro pages A/B, parts 1 and 2 (plan §7). */
export type LabCheckId = 'D1' | 'D2' | 'D3' | 'D4' | 'P1' | 'P2';
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
  /** Pro pages A/B runs (P1): which golden page and arm, what was attached, and its one page check. */
  proPages?: ProPagesRunFacts;
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
  /**
   * Pro pages A/B runs (P1, P2) only: the A/B's own limit across every day, checked in the same atomic step as the
   * daily cap. The store refuses an A/B run without it, and never lets it pass LAB_AB_HARD_CAP_USD.
   */
  ab?: { capUsd: number };
}

export type LabReserveOutcome =
  | { outcome: 'reserved' | 'existing'; row: LabRunRow }
  | { outcome: 'cap'; spentUsd: number }
  /** The Pro pages A/B limit (all days, parts 1 and 2 together) can't cover this quote. */
  | { outcome: 'ab_cap'; spentUsd: number };

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
  /**
   * models.md §2.5: the provider-reported model version (server/sql/comic_image_calls_model_version.sql). Sent only
   * when reported; the Supabase store retries once without it while that column does not exist yet.
   */
  model_version?: string;
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
  /** Spend on these checks over every day, counted the same way (the Pro pages A/B limit). Absent = unknown: the
   *  lab then refuses A/B runs rather than spend past a limit it can't count. */
  spentOn?(checkIds: readonly LabCheckId[]): Promise<number>;
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
      // An A/B run is reserved only against the A/B limit too (comic_model_lab_reserve_ab), never without it.
      const isAb = LAB_AB_CHECKS.includes(input.checkId);
      if (isAb !== !!input.ab) throw new Error('comic_model_lab_reserve: A/B runs, and only they, carry the A/B cap');
      const day = utcDay(now());
      const spent = runs.filter((r) => r.day === day).reduce((s, r) => s + spendOf(r), 0);
      if (spent + input.quotedUsd > Math.min(input.capUsd, LAB_DAILY_CAP_USD) + 1e-9) return { outcome: 'cap', spentUsd: round6(spent) };
      if (input.ab) {
        const abSpent = runs.filter((r) => LAB_AB_CHECKS.includes(r.checkId)).reduce((s, r) => s + spendOf(r), 0);
        if (abSpent + input.quotedUsd > Math.min(input.ab.capUsd, LAB_AB_HARD_CAP_USD) + 1e-9) return { outcome: 'ab_cap', spentUsd: round6(abSpent) };
      }
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
    async spentOn(checkIds) {
      return round6(runs.filter((r) => checkIds.includes(r.checkId)).reduce((s, r) => s + spendOf(r), 0));
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
const CHECK_IDS: ReadonlySet<string> = new Set(['D1', 'D2', 'D3', 'D4', 'P1', 'P2']);
/** The A/B reservation (server/sql/comic_model_lab_pro_pages.sql): the daily cap AND the A/B limit, atomically. */
export const LAB_AB_RESERVE_FN = 'comic_model_lab_reserve_ab';
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

/** Spend over rows of {status, quoted_usd, cost_usd}: a running row holds its quote; a finished one counts what the
 *  provider reported, else the quote (the SQL functions count the same way). */
const sumSpend = (rows: unknown): number =>
  round6(
    (Array.isArray(rows) ? (rows as Record<string, unknown>[]) : []).reduce((s: number, r) => {
      const quoted = numOrNull(r.quoted_usd) ?? 0;
      return s + (r.status === 'running' ? quoted : numOrNull(r.cost_usd) ?? quoted);
    }, 0)
  );

/** The lab's persistence on Supabase (service role). Null when storage is not configured on this server. */
export interface SupabaseLabStoreDeps {
  /** The service-role client (tests pass a fake; default getSupabaseAdmin). */
  db?: () => ReturnType<typeof getSupabaseAdmin>;
  /** Override the storage check (tests). */
  enabled?: boolean;
}

export function createSupabaseLabStore(deps: SupabaseLabStoreDeps = {}): LabStore | null {
  if (!(deps.enabled ?? getSupabaseCapabilityStatus().storagePersistenceEnabled)) return null;
  const db = deps.db ?? (() => getSupabaseAdmin());
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
      const args = {
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
      };
      // An A/B check never goes through the plain reserve (which knows no A/B limit); without a limit it asks for $0,
      // which the A/B function always refuses.
      const isAb = LAB_AB_CHECKS.includes(input.checkId);
      const { data, error } = await (isAb ? db().rpc(LAB_AB_RESERVE_FN, { ...args, p_ab_cap: input.ab?.capUsd ?? 0 }) : db().rpc('comic_model_lab_reserve', args)).abortSignal(signal());
      if (error) throw new Error(error.message);
      const first = (Array.isArray(data) ? data[0] : data) as { out_outcome?: unknown; out_run_id?: unknown; out_spent?: unknown } | undefined;
      const outcome = String(first?.out_outcome ?? '');
      if (outcome === 'cap') return { outcome: 'cap', spentUsd: numOrNull(first?.out_spent) ?? 0 };
      if (outcome === 'ab_cap') return { outcome: 'ab_cap', spentUsd: numOrNull(first?.out_spent) ?? 0 };
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
      return sumSpend(data);
    },
    async spentOn(checkIds) {
      const { data, error } = await db().from(LAB_TABLES.runs).select('status, quoted_usd, cost_usd').in('check_id', [...checkIds]).abortSignal(signal());
      if (error) throw new Error(error.message);
      return sumSpend(data);
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
      if (!error) return;
      // The model_version column is a separate PROD STEP (comic_image_calls_model_version.sql): until it is applied,
      // keep the row without it, exactly as billing.ts's recorder does. The lab run's own row keeps the version.
      if ('model_version' in row && /model_version/i.test(String(error.message || ''))) {
        const { model_version: _version, ...rest } = row;
        const retry = await db().from(LAB_TABLES.imageCalls).insert(rest).abortSignal(signal());
        if (!retry.error) return;
        throw new Error(retry.error.message);
      }
      throw new Error(error.message);
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
  /** Pro pages A/B pairs, after the vote only: which arm this side was, and its one page check. */
  arm?: { id: ProPagesArm; label: string };
  check?: LabPageCheckFacts;
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
  /** P1 · Pro pages A/B, part 1 (plan §7, §10 A6). Absent when this server has no A/B wiring. */
  proPages?: ProPagesView;
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
  run: LabRunView | LabBlindRunView | LabAbRunView;
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
  | 'PAIR_CHANGED'
  /** Pro pages A/B: the server-side budget switch (COMIC_LAB_AB_BUDGET_USD) is off. */
  | 'AB_NOT_ENABLED'
  /** Pro pages A/B: its own limit (all days, parts 1 and 2 together) can't cover this quote. */
  | 'AB_CAP_REACHED';

export type LabError = StudioError & { labCode: LabErrorCode; details?: Record<string, unknown> };

const labError = (labCode: LabErrorCode, status: number, message: string, details?: Record<string, unknown>): LabError => {
  const code = status === 400 ? 'BAD_REQUEST' : status === 404 ? 'NOT_FOUND' : status === 503 ? 'NOT_AVAILABLE' : 'CONFLICT';
  return Object.assign(new StudioError(code, message, { status }), { labCode, ...(details ? { details } : {}) });
};
export const isLabError = (err: unknown): err is LabError => err instanceof StudioError && typeof (err as { labCode?: unknown }).labCode === 'string';

const NOTHING_CHARGED = 'Nothing was charged.';

// ── P1 · Pro pages A/B, part 1: the layout guide (plan §7, §10 A6; decision PD-8) ──
//
// Three of the owner's golden pages, each drawn twice with everything else identical: as the studio draws it today
// (guide off) and with the PAGE LAYOUT GUIDE as Image 1 (guide on: exactly the prompt and references the studio sends
// with COMIC_LAYOUT_GUIDE=1 — compilePage + panelize/wireframe.ts). It settles whether that flag is turned on.
// Rules (each one is a test in lab.proPages.test.ts):
//   * OFF until the server-side budget switch is set (LAB_AB_BUDGET_ENV, PD-8). Until then the section shows a calm
//     "not enabled yet" next to the full quote, and a click is refused before anything is read, reserved or sent.
//   * Costs first: each arm is one page job from the PriceBook — the page at the comic's locked model and tier with its
//     references, plus one page check (QC) — at the provider price (the platform pays; no markup). The section
//     shows all six (6 page jobs + QC) before anything can run.
//   * One click = one arm: ONE image call (oneCallTransport: never retried) and its ONE page check (a single chat call
//     through the same kind of wrapper: no retry, no repair round), paid only for a drawing that was stored and can be
//     compared. One idempotency key per click; a repeat returns the stored result.
//   * The comic's model lock holds (the studio's assertLockedModel): a page whose lock this server can't draw is not
//     drawn on another model.
//   * The A/B's own hard cap (LAB_AB_HARD_CAP_USD, every day, parts 1 and 2 together) is reserved atomically with the
//     lab's daily cap, minus LAB_AB_REF_ALLOWANCE_USD per attached image (their price isn't in the quote), so a run's
//     reported cost lands under the limit.
//   * Blind: a page's two drawings are shown side by side as A and B, ordered by their random preview ids. Which arm
//     is which, every number and the page check appear only after the owner's vote. While a pair waits for its vote
//     neither arm can be redrawn; once voted its two drawings are final (a new one would be paid for and never shown).
//     After the vote the owner marks, per drawing, whether it copied the guide's lines (plan §4.8's second condition).
//   * The admin's OWN comics only (comic_docs rows of the admin who clicks, found by the plan's 8-character comic ids;
//     never another user's). Blocked or quarantined images and uploads with no safety verdict yet are never sent
//     (the studio's own reference gate); a reference that can't be loaded is left out. Both are counted in the result.

export type ProPagesArm = 'off' | 'on';
export const PRO_PAGES_ARMS: readonly ProPagesArm[] = ['off', 'on'];
export const PRO_PAGES_ARM_LABEL: Readonly<Record<ProPagesArm, string>> = { off: 'Guide off', on: 'Guide on' };

/** One golden page (plan §7: b4b5774f p2, b4b5774f p4, f8312c86 p1 — the owner's measured problem pages). */
export interface ProPagesGolden {
  /** "b4b5774f-p2": item ids, the pair id and the result row hang off it. */
  key: string;
  /** The first 8 characters of the owner's comic id (how the plan names comics). */
  comic: string;
  pageN: number;
  label: string;
  /** Why it is in the set (shown under the page). */
  why: string;
}

export const PRO_PAGES_GOLDEN: readonly ProPagesGolden[] = [
  { key: 'b4b5774f-p2', comic: 'b4b5774f', pageN: 2, label: 'b4b5774f · page 2', why: 'Six panels in 2-1-3 rows, the most words in the smallest panels, and a point-of-view panel.' },
  { key: 'b4b5774f-p4', comic: 'b4b5774f', pageN: 4, label: 'b4b5774f · page 4', why: 'A wide row over a tall panel beside a stack, a long caption and a silent insert.' },
  { key: 'f8312c86-p1', comic: 'f8312c86', pageN: 1, label: 'f8312c86 · page 1', why: 'A 4:5 storybook page whose protagonist is an extra with a ready sheet, in every panel; its beats drifted between panels.' }
];

/** One runnable arm of the A/B: a golden page with the guide off or on. */
export interface ProPagesItem {
  id: string;
  check: 'P1';
  golden: ProPagesGolden;
  arm: ProPagesArm;
  title: string;
  /** The blind pair this arm is one side of (one pair per golden page). */
  pair: { id: string; label: string };
}

export const proPagesItems = (): ProPagesItem[] =>
  PRO_PAGES_GOLDEN.flatMap((golden) =>
    PRO_PAGES_ARMS.map((arm) => ({
      id: `p1-${golden.key}-guide-${arm}`,
      check: 'P1' as const,
      golden,
      arm,
      title: `${golden.label} · ${PRO_PAGES_ARM_LABEL[arm].toLowerCase()}`,
      pair: { id: `p1-${golden.key}`, label: golden.label }
    }))
  );
export const proPagesItem = (id: string): ProPagesItem | undefined => proPagesItems().find((i) => i.id === id);
const proPagesPairIds = (): Set<string> => new Set(proPagesItems().map((i) => i.pair.id));

export const PRO_PAGES_CHECK = {
  id: 'P1' as const,
  title: 'Pro pages A/B, part 1 · the layout guide',
  decision: "Turn on COMIC_LAYOUT_GUIDE (the page layout guide as Image 1) only if the guide-on pages bind their beats better and never copy the guide's lines.",
  answers:
    'Three of your golden pages, each drawn twice with everything else the same — guide off and guide on — and each drawing checked once (beats matched, panels drawn, art crossing a border). Shown side by side as A and B; which is which appears after your vote.',
  note:
    `Each drawing is one image call that is never retried, plus its one page check. The A/B has its own hard cap of $${LAB_AB_HARD_CAP_USD.toFixed(2)} over every day, shared with part 2. ` +
    `Each drawing also keeps $${LAB_AB_REF_ALLOWANCE_USD} per attached image free under that cap, because reference input isn't priced yet. After your vote, mark whether each drawing copied the guide's lines.`
};

/** The A/B's budget switch as read from the server's environment. */
export interface LabAbBudget {
  enabled: boolean;
  /** The A/B limit in dollars: the switch's value, never above LAB_AB_HARD_CAP_USD. null when off. */
  limitUsd: number | null;
  /** Calm copy for why it is off. */
  reason?: string;
}

export const LAB_AB_NOT_ENABLED_COPY =
  `Not enabled yet. These test drawings wait for the owner's approval of the test budget, so nothing here can run or spend. ` +
  `To turn them on, set ${LAB_AB_BUDGET_ENV} on the server (at most $${LAB_AB_HARD_CAP_USD.toFixed(2)}, shared with part 2).`;

/** PD-8: unset, empty, zero or anything but a plain dollar amount = OFF. A larger amount is held to the hard cap. */
export const labAbBudget = (env: Record<string, string | undefined> = process.env): LabAbBudget => {
  const raw = String(env[LAB_AB_BUDGET_ENV] ?? '').trim();
  if (!raw) return { enabled: false, limitUsd: null, reason: LAB_AB_NOT_ENABLED_COPY };
  const n = /^\d+(?:\.\d+)?$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isFinite(n) || n <= 0) {
    return {
      enabled: false,
      limitUsd: null,
      reason: `Not enabled: ${LAB_AB_BUDGET_ENV} is set, but not to a dollar amount above zero (for example 1.20), so nothing here can run or spend.`
    };
  }
  return { enabled: true, limitUsd: round6(Math.min(n, LAB_AB_HARD_CAP_USD)) };
};

/** The one page check of a drawing, as recorded (admin view; shown after the vote). */
export interface LabPageCheckFacts {
  /** A usable reading came back. */
  ok: boolean;
  /** The check's single call reached the provider. */
  callMade: boolean;
  /** Provider-reported cost of the check, when reported. */
  costUsd?: number;
  costReported: boolean;
  model?: string;
  httpStatus?: number;
  score?: number;
  panelsPlanned: number;
  /** Panels the checker found drawn. */
  panelsDrawn?: number;
  /** For each drawn panel, the planned panel whose moment it shows (0 = none). */
  beats?: number[];
  /** Drawn panels showing their own planned moment (beat n in panel n). */
  beatsMatched?: number;
  /** Panels whose art breaks over their border. */
  crosses?: number[];
  boxesFrom?: 'vision' | 'estimate';
  issues?: string[];
  /** Why the check did not finish. */
  message?: string;
}

/** What a P1 run records next to the draw's own facts. */
export interface ProPagesRunFacts {
  golden: string;
  comic: string;
  pageN: number;
  arm: ProPagesArm;
  /** The PAGE LAYOUT GUIDE went as Image 1 (never on the off arm). */
  guide: boolean;
  /** Images the page would attach that were never sent: blocked, quarantined, or an upload not safety-checked yet. */
  withheld: number;
  /** References that couldn't be loaded and were left out. */
  dropped: number;
  check: LabPageCheckFacts;
  /**
   * The owner's mark, after the pair's vote: did this drawing copy the layout guide's borders or lines into the art?
   * (plan §4.8: COMIC_LAYOUT_GUIDE goes on only with "no copied guide lines".) null = not checked.
   */
  guideLinesCopied?: { value: boolean | null; at: string; by: string | null } | null;
}

/** A P1 click's answer: no image and no check numbers (judged blind in the pair view); the money facts stay visible. */
export interface LabAbRunView {
  id: string;
  checkId: 'P1' | 'P2';
  itemId: string;
  status: 'ok' | 'failed' | 'running' | 'interrupted';
  pair: { id: string; label: string };
  quotedUsd: number;
  costUsd: number | null;
  callMade: boolean;
  costReported: boolean;
  /** The drawing's page check ran (its findings stay hidden until the vote). */
  checked: boolean;
  message?: string | null;
}

/** One arm as the section lists it, with its quote and whether it can run now. */
export interface ProPagesArmView {
  id: string;
  check: 'P1';
  arm: ProPagesArm;
  label: string;
  title: string;
  pair: { id: string; label: string };
  modelId?: string;
  nickname?: string;
  res?: Resolution;
  aspect?: AspectRatio;
  refs?: number;
  refsNote?: string;
  quote: LabQuote | null;
  health: LabHealthView | null;
  canRun: boolean;
  reason?: string;
  runs: { ok: number; failed: number; running: number };
}

export interface ProPagesPageView {
  key: string;
  label: string;
  why: string;
  pairId: string;
  /** The page was found among this admin's comics. */
  available: boolean;
  reason?: string;
  arms: ProPagesArmView[];
}

/** Only from VOTED pairs (an unvoted pair contributes nothing, so the tally never gives a side away). */
export interface ProPagesTally {
  voted: number;
  pairs: number;
  picks: { on: number; off: number; tie: number };
  /** Beats matched over panels planned, per arm, from the voted pairs' page checks. */
  beats: Record<ProPagesArm, { matched: number; planned: number }>;
  /** Voted drawings the owner marked as copying the guide's lines, per arm. */
  guideLinesCopied: Record<ProPagesArm, number>;
  /** Voted drawings the owner marked either way (yes or no), per arm; the rest aren't checked yet. */
  guideLinesChecked: Record<ProPagesArm, number>;
}

export interface ProPagesView {
  id: 'P1';
  title: string;
  decision: string;
  answers: string;
  note: string;
  /** The server-side switch (named so the owner knows what turns it on). */
  switchName: string;
  enabled: boolean;
  /** Calm copy while it is off. */
  notice?: string;
  budget: { capUsd: number; limitUsd: number | null; spentUsd: number | null; remainingUsd: number | null };
  /** All six arms: 6 page jobs + 6 page checks from the PriceBook (provider price). usd null when any arm can't be quoted. */
  quote: { usd: number | null; arms: number; pages: number; checks: number; basis: string[]; refsUnpriced: boolean };
  pages: ProPagesPageView[];
  pairs: BlindPairView[];
  tally?: ProPagesTally;
}

/** Where the golden pages come from. Production: the admin's own comic_docs rows (createOwnerProPagesSource). */
export interface ProPagesSource {
  /** The admin's OWN comic whose id starts with `prefix` (8 hex), or why it can't be used. Never another user's. */
  comic(adminId: string, prefix: string): Promise<{ doc: ComicDoc } | { missing: string }>;
  /** A stored image the page attaches (sheet, photo, style board, previous page) as a data URL. */
  loadDataUrl(path: string): Promise<string>;
}

export interface ProPagesDeps {
  /** Null when this server can't read comics (the arms say so; nothing runs). */
  source: ProPagesSource | null;
  /** The budget switch (default: LAB_AB_BUDGET_ENV from the environment, read on every overview and click). */
  budget?: () => LabAbBudget;
}

const COMIC_PREFIX_RE = /^[0-9a-f]{8}$/;

/** The uuid range of every id starting with `prefix` (uuids order by their hex, so a prefix is a range). */
export const uuidPrefixRange = (prefix: string): [string, string] => [`${prefix}-0000-0000-0000-000000000000`, `${prefix}-ffff-ffff-ffff-ffffffffffff`];

/**
 * The golden pages from the admin's OWN comics (service role, but every read is scoped to `user_id = adminId`, the
 * same owner rule as the studio's doc store). Null when Supabase is not configured on this server.
 */
export function createOwnerProPagesSource(deps: {
  loadDataUrl: (path: string) => Promise<string>;
  db?: () => ReturnType<typeof getSupabaseAdmin>;
  enabled?: boolean;
}): ProPagesSource | null {
  if (!(deps.enabled ?? getSupabaseCapabilityStatus().storagePersistenceEnabled)) return null;
  const db = deps.db ?? (() => getSupabaseAdmin());
  return {
    async comic(adminId, prefix) {
      if (!COMIC_PREFIX_RE.test(prefix) || !adminId) return { missing: `“${prefix.slice(0, 12)}” isn't a comic id the lab can look up.` };
      const [lo, hi] = uuidPrefixRange(prefix);
      const { data, error } = await db()
        .from('comic_docs')
        .select('project_id, doc')
        .eq('user_id', adminId)
        .gte('project_id', lo)
        .lte('project_id', hi)
        .limit(2)
        .abortSignal(AbortSignal.timeout(LAB_DB_TIMEOUT_MS));
      if (error) throw new Error(error.message);
      const rows = (Array.isArray(data) ? data : []) as { project_id?: unknown; doc?: unknown }[];
      if (!rows.length) return { missing: `Comic ${prefix} isn't one of your comics on this server, so its page can't be drawn here.` };
      if (rows.length > 1) return { missing: `More than one of your comics starts with ${prefix}, so the lab won't guess which one to draw.` };
      const raw = rows[0].doc;
      if (!isObject(raw)) return { missing: `Comic ${prefix} couldn't be read.` };
      return { doc: normalizeDoc({ ...(raw as Partial<ComicDoc>), id: String(rows[0].project_id ?? prefix) }) };
    },
    loadDataUrl: deps.loadDataUrl
  };
}

/**
 * Images a page job must never send: blocked or quarantined by the content check (the runner's blockedPaths), and
 * uploads with no safety verdict yet (the studio checks those lazily before first use; the lab never sends one
 * unchecked, so its gate is stricter). Generated images carry their own check.
 */
export const labWithheldPaths = (doc: ComicDoc): Set<string> => {
  const out = blockedPaths(doc);
  mapAssetRefs(doc, (a) => {
    if (a?.path && a.source === 'upload' && !a.safety) out.add(a.path);
    return a;
  });
  return out;
};

/** One arm compiled for drawing. */
export interface ProPagesPlan {
  /** The doc the prompt was compiled from (withheld and missing images removed). */
  doc: ComicDoc;
  page: Page;
  compiled: CompiledRenderJob;
  /** The PAGE LAYOUT GUIDE is attached (Image 1). */
  guide: boolean;
  /** References the page would attach that are withheld (never sent). */
  withheld: number;
}

const guideNoSlotCopy = (nickname: string) =>
  `This comic's model (${nickname}) has no spare image slot for the layout guide, so a guide-on drawing would be the same page as guide off.`;

/**
 * Compile one arm exactly as the studio's page job would (the comic's locked model and tier, its references, the
 * previous drawn page), with the layout guide only on the "on" arm. Pure: nothing is loaded or sent.
 */
export const planProPagesArm = (
  loaded: ComicDoc,
  golden: Pick<ProPagesGolden, 'comic' | 'pageN'>,
  arm: ProPagesArm,
  missing: ReadonlySet<string> = new Set()
): { plan: ProPagesPlan } | { reason: string } => {
  const withheldPaths = labWithheldPaths(loaded);
  const doc = withoutAssets(loaded, new Set([...withheldPaths, ...missing]));
  const page = doc.pages.find((p) => p.n === golden.pageN);
  if (!page) return { reason: `Comic ${golden.comic} has no page ${golden.pageN} now, so this golden page can't be drawn.` };
  const compileFor = (d: ComicDoc, p: Page) => compilePage(d, p, { previousPage: nearestReadyBefore(d, p), layoutGuide: arm === 'on' });
  let compiled: CompiledRenderJob;
  try {
    compiled = compileFor(doc, page);
  } catch (err) {
    return { reason: err instanceof StudioError ? err.userMessage : `Page ${golden.pageN} couldn't be prepared for drawing.` };
  }
  // The comic's model lock, as the studio asserts it before any provider call (jobs.ts assertLockedModel): a lock the
  // registry doesn't know compiles for the tier's model instead, so refuse rather than draw on another model. The lab
  // never resolves a lock to a replacement and never changes the comic.
  const lock = lockOf(loaded);
  if (lock && lockedSpecId(lock.modelId) !== compiled.spec.id) {
    const known = getImageModel(lock.modelId);
    return {
      reason: known
        ? `Comic ${golden.comic} is locked to ${known.nickname}, but this page would be drawn on ${compiled.spec.nickname}, so the lab won't draw it on another model.`
        : `Comic ${golden.comic} is locked to ${lock.modelId.slice(0, 120)}, which this server can't draw, so the lab won't draw it on another model.`
    };
  }
  const guide = compiled.references.some((r) => r.path === LAYOUT_REFERENCE_PATH);
  if (arm === 'on' && !guide) return { reason: guideNoSlotCopy(compiled.spec.nickname) };
  // How many of the page's own references the gate held back (counted on the doc as stored; nothing is loaded).
  let withheld = 0;
  if (withheldPaths.size) {
    try {
      const rawPage = loaded.pages.find((p) => p.n === golden.pageN)!;
      withheld = compileFor(loaded, rawPage).references.filter((r) => withheldPaths.has(r.path)).length;
    } catch {
      withheld = 0;
    }
  }
  return { plan: { doc, page, compiled, guide, withheld } };
};

/**
 * One arm's quote: one page job from the PriceBook — the page at its model and resolution with `refs` references, plus
 * one page check (QC) — at the provider price. `byok: true` only drops the platform markup: the platform pays the
 * provider, exactly as the rest of the lab is reserved.
 */
export const quoteProPagesArm = (
  prices: Pick<ServerPriceBook, 'jobQuote'> | null,
  compiled: Pick<CompiledRenderJob, 'spec' | 'resolution'>,
  refs: number
): LabQuote | null => {
  if (!prices) return null;
  const q = prices.jobQuote(compiled.spec.id, compiled.resolution, 'page', { refs, byok: true });
  if (!isFiniteNumber(q.usd) || q.usd <= 0) return null;
  return { usd: round6(q.usd), source: 'pricebook', basis: q.basis, refsUnpriced: q.basisDetail.refsUnpriced === true };
};

const textOf = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((p) => (p && typeof (p as { text?: unknown }).text === 'string' ? (p as { text: string }).text : '')).join('').trim()
      : '';

/**
 * The page check's text client: exactly ONE OpenRouter chat call on the platform key, through the same one-call wrapper
 * as the image (so a provider retry, a fallback or the check's own repair round is stopped before it leaves the
 * server). Same model chain, schema, reasoning budget and timeout as the studio's own page check (textModels.ts).
 */
export const labVisionClient = (keys: StudioKeys, network: typeof fetch, now: () => number = Date.now): { llm: LlmClient; capture: ProviderCapture } => {
  const transport = oneCallTransport(network, now);
  const llm: LlmClient = {
    async complete(req) {
      const route = resolveTextRoute(req.role, keys);
      if (!route || route.route !== 'openrouter') throw new StudioError('NO_TEXT_KEY', "The platform OpenRouter key isn't set on this server, so the page can't be checked.", { status: 503 });
      const defaults = TEXT_ROLE_DEFAULTS[req.role];
      const effort = defaults.reasoningEffort;
      const body: Record<string, unknown> = {
        model: route.model,
        ...(route.models.length > 1 ? { models: [...new Set(route.models)].slice(0, 3) } : {}),
        messages: req.messages,
        temperature: req.temperature ?? defaults.temperature,
        max_tokens: (req.maxTokens ?? defaults.maxTokens) + (effort ? Math.ceil(reasoningBudget(effort) * 1.5) : 0),
        ...(effort ? { reasoning: { max_tokens: reasoningBudget(effort) } } : {}),
        ...(req.jsonSchema ? { response_format: { type: 'json_schema', json_schema: { name: req.jsonSchema.name, strict: req.jsonSchema.strict ?? true, schema: req.jsonSchema.schema } } } : {}),
        usage: { include: true }
      };
      const res = await transport.fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${route.key.key}`, 'HTTP-Referer': OPENROUTER_APP_URL, 'X-Title': OPENROUTER_APP_TITLE },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(defaults.timeoutMs)
      });
      if (!res.ok) {
        throw new StudioError('PROVIDER_ERROR', `The page check answered HTTP ${res.status}${transport.capture.said ? ` (${transport.capture.said})` : ''}.`, { status: 502 });
      }
      const data = (await res.json()) as { model?: unknown; choices?: { message?: { content?: unknown } }[]; usage?: { cost?: unknown; prompt_tokens?: unknown; completion_tokens?: unknown } };
      const text = textOf(data?.choices?.[0]?.message?.content);
      let json: unknown;
      try {
        json = text ? JSON.parse(text) : undefined;
      } catch {
        json = undefined;
      }
      const cost = data?.usage?.cost;
      return {
        text,
        ...(json !== undefined ? { json } : {}),
        model: str(data?.model, 120) ?? route.model,
        ...(isFiniteNumber(cost) && cost >= 0 ? { costUsd: cost } : {}),
        byok: false,
        provider: 'openrouter'
      };
    }
  };
  return { llm, capture: transport.capture };
};

/** The recorded summary of one page check (pure). */
export const summarizePageCheck = (qc: CheckedQcReport, page: Pick<Page, 'panels'>, call: { callMade: boolean; costUsd?: number; model?: string }): LabPageCheckFacts => {
  const drawn = qc.drawnBoxes?.length ?? (qc.boxesFrom === 'vision' ? qc.panelBoxes?.length : undefined);
  return {
    ok: true,
    callMade: call.callMade,
    costReported: call.costUsd !== undefined,
    ...(call.costUsd !== undefined ? { costUsd: call.costUsd } : {}),
    ...(call.model ? { model: call.model.slice(0, 120) } : {}),
    score: qc.score,
    panelsPlanned: page.panels.length,
    ...(drawn !== undefined ? { panelsDrawn: drawn } : {}),
    ...(qc.beats ? { beats: qc.beats.slice(0, 12), beatsMatched: qc.beats.filter((b, i) => b === i + 1).length } : {}),
    ...(qc.crosses ? { crosses: qc.crosses.slice(0, 12) } : {}),
    ...(qc.boxesFrom ? { boxesFrom: qc.boxesFrom } : {}),
    ...(qc.issues.length ? { issues: qc.issues.slice(0, 6).map((i) => i.slice(0, 200)) } : {})
  };
};

/** The drawing's one page check (the studio's own vision QC). Never throws: a failure is recorded with its reason. */
export const checkProPageOnce = async (args: { doc: ComicDoc; page: Page; dataUrl: string; keys: StudioKeys; network: typeof fetch; now: () => number }): Promise<LabPageCheckFacts> => {
  const { llm, capture } = labVisionClient(args.keys, args.network, args.now);
  try {
    const analysis = await analyzePageRender({ doc: args.doc, page: args.page, dataUrl: args.dataUrl, llm });
    return summarizePageCheck(analysis.qc, args.page, { callMade: capture.calls > 0, costUsd: capture.costUsd ?? analysis.costUsd, model: capture.reportedModel ?? analysis.model });
  } catch (err) {
    const message =
      capture.stopped > 0
        ? "The page check's answer couldn't be read, and the lab never sends a second check for the same drawing."
        : err instanceof StudioError
          ? err.userMessage
          : "The page check couldn't finish.";
    if (!(err instanceof StudioError) && !isOneCallStop(err)) logger.warn('comic_model_lab_page_check_failed', { message: String((err as Error)?.message || err).slice(0, 200) });
    return {
      ok: false,
      callMade: capture.calls > 0,
      costReported: capture.costUsd !== undefined,
      ...(capture.costUsd !== undefined ? { costUsd: capture.costUsd } : {}),
      ...(capture.status ? { httpStatus: capture.status } : {}),
      panelsPlanned: args.page.panels.length,
      message
    };
  }
};

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
  /** P1 · Pro pages A/B, part 1. Absent = this server has no A/B wiring (the overview leaves the section out and a
   *  click is refused unsent). Production: createDefaultLabDeps. */
  proPages?: ProPagesDeps;
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
      title: item?.title ?? proPagesItem(r.itemId)?.title ?? r.itemId,
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

  /** An A/B click's answer: like a D4 one, nothing that could tie the run to a side (no image, no check numbers). */
  const abRunView = (r: LabRunRow, now: number): LabAbRunView => {
    const item = proPagesItem(r.itemId);
    return {
      id: r.id,
      checkId: r.checkId === 'P2' ? 'P2' : 'P1',
      itemId: r.itemId,
      status: statusOf(r, now) as LabAbRunView['status'],
      pair: item?.pair ?? { id: r.itemId, label: r.itemId },
      quotedUsd: r.quotedUsd,
      costUsd: r.costUsd,
      callMade: r.result.callMade === true,
      costReported: r.result.costReported === true,
      checked: r.result.proPages?.check?.callMade === true,
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

    // D1–D3 only: D4 and the A/B are judged blind in their pair views.
    const shown = runs.filter((r) => r.checkId === 'D1' || r.checkId === 'D2' || r.checkId === 'D3').slice(0, LAB_RESULTS_SHOWN);
    const urls = await signAll(shown.map((r) => r.result.imagePath).filter((p): p is string => !!p));
    // The A/B section never takes the rest of the lab down: if it can't be prepared it says so, and nothing in it runs.
    const proPages = deps.proPages
      ? await proPagesView(adminId, { runs, votes, spentUsd, prices, keys, now, healthByModel }).catch((err) => {
          logger.warn('comic_model_lab_pro_pages_view_failed', { message: String((err as Error)?.message || err).slice(0, 200) });
          return proPagesUnavailable();
        })
      : undefined;
    return {
      capUsd,
      day,
      spentUsd: round6(spentUsd),
      remainingUsd,
      ready: { platformKey: !!keys, storage: !!store && !!deps.storage },
      checks: LAB_CHECKS.map((c) => ({ id: c.id, title: c.title, decision: c.decision, answers: c.answers, ...(c.note ? { note: c.note } : {}), items: c.items.map(itemView) })),
      results: shown.map((r) => runView(r, now, urls)),
      blind: await blindViews(runs, votes, now),
      now,
      ...(proPages ? { proPages } : {})
    };
  };

  const answerFor = async (row: LabRunRow, replayed: boolean, store: LabStore): Promise<LabRunAnswer> => {
    const now = deps.now();
    const spentUsd = await store.spent(utcDay(now)).catch(() => NaN);
    const run =
      row.checkId === 'D4'
        ? blindRunView(row, now)
        : LAB_AB_CHECKS.includes(row.checkId)
          ? abRunView(row, now)
          : runView(row, now, row.result.imagePath ? await signAll([row.result.imagePath]) : {});
    return { replayed, run, spentUsd: isFiniteNumber(spentUsd) ? spentUsd : 0, remainingUsd: isFiniteNumber(spentUsd) ? round6(Math.max(0, capUsd - spentUsd)) : 0 };
  };

  /** Make the one call for a D-check item and turn its outcome into facts. Never throws for a provider failure. */
  const callOnce = async (
    item: LabItem,
    spec: ImageModelSpec,
    keys: StudioKeys,
    references: ImageReference[],
    adminId: string
  ): Promise<{ status: 'ok' | 'failed'; costUsd: number | null; providerModel: string | null; facts: LabResultFacts }> => {
    const { dataUrl: _image, ...outcome } = await drawOnce({
      logId: item.id,
      spec,
      keys,
      adminId,
      res: item.res,
      aspect: item.aspect,
      prompt: labPrompt(item, references.map((r) => r.label)),
      references,
      transport: item.transport
    });
    return outcome;
  };

  /**
   * The one image call of a click, through the studio's own transport with its network wrapped (oneCallTransport), and
   * its outcome as facts. Never throws for a provider failure. A drawn image is measured, its preview stored, and the
   * full image handed back (`dataUrl`) for the page check of an A/B arm.
   */
  const drawOnce = async (d: {
    logId: string;
    spec: ImageModelSpec;
    keys: StudioKeys;
    adminId: string;
    res: Resolution;
    aspect: AspectRatio;
    prompt: string;
    references: ImageReference[];
    /** The one endpoint this check tests (D2: OpenRouter's Images API). */
    transport?: '/images';
  }): Promise<{ status: 'ok' | 'failed'; costUsd: number | null; providerModel: string | null; facts: LabResultFacts; dataUrl?: string }> => {
    const { spec, keys, references, adminId } = d;
    const item = { id: d.logId, res: d.res, aspect: d.aspect, transport: d.transport };
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
      const result = await images({ spec, resolution: item.res, aspect: item.aspect, prompt: d.prompt, references });
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
      return { status: 'ok', costUsd: cost ?? null, providerModel: spec.routes.openrouter ?? null, facts, dataUrl: result.dataUrl };
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

  /** The provider call as a comic_image_calls row (same column meanings as the studio's own). Sets facts.recordedCall. */
  const recordCall = async (
    store: LabStore,
    adminId: string,
    spec: ImageModelSpec,
    shape: { kind: string; res: Resolution; aspect: AspectRatio; logId: string },
    outcome: { status: 'ok' | 'failed'; costUsd: number | null },
    facts: LabResultFacts
  ): Promise<void> => {
    if (!facts.callMade) return;
    try {
      await store.recordImageCall({
        user_id: adminId,
        project_id: null,
        model_id: spec.id,
        provider_model: spec.routes.openrouter ?? null,
        route: 'openrouter',
        provider_name: facts.providerName ?? null,
        kind: shape.kind,
        res: shape.res,
        aspect: shape.aspect,
        refs: facts.refsSent,
        outcome: outcome.status,
        http_status: facts.httpStatus ?? null,
        error_code: outcome.status === 'ok' ? null : facts.httpStatus === 429 ? 'RATE_LIMIT' : facts.errorCode ?? null,
        provider_cost_usd: facts.costReported ? outcome.costUsd : null,
        billed_usd: 0, // nobody is billed: the platform pays for the owner's checks
        byok: false,
        latency_ms: facts.latencyMs ?? facts.providerMs ?? null,
        ...(facts.providerModelVersion ? { model_version: facts.providerModelVersion.slice(0, 160) } : {})
      });
      facts.recordedCall = true;
    } catch (err) {
      facts.recordedCall = false; // the lab row still holds every fact
      logger.warn('comic_model_lab_image_call_not_recorded', { item: shape.logId, message: String((err as Error)?.message || err).slice(0, 200) });
    }
  };

  /**
   * The call is made and paid for: try twice to record it (a row left 'running' keeps holding its quote). If both writes
   * fail, the facts would survive nowhere else (comic_image_calls has no version, pixels or preview path), so they go
   * to the error log before the failure is answered.
   */
  const finishRun = async (
    store: LabStore,
    rowId: string,
    patch: { status: 'ok' | 'failed'; costUsd: number | null; providerModel: string | null; result: LabResultFacts; finishedAt: string },
    log: { check: LabCheckId; item: string; quotedUsd: number }
  ): Promise<LabRunRow> =>
    store.finish(rowId, patch).catch(async (err) => {
      logger.warn('comic_model_lab_finish_retry', { id: rowId, message: String((err as Error)?.message || err).slice(0, 200) });
      try {
        return await store.finish(rowId, patch);
      } catch (again) {
        const facts = patch.result;
        logger.error('comic_model_lab_finish_failed', {
          id: rowId,
          check: log.check,
          item: log.item,
          status: patch.status,
          quotedUsd: log.quotedUsd,
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
          ...(facts.proPages ? { arm: facts.proPages.arm, golden: facts.proPages.golden, checkMade: facts.proPages.check.callMade, checkCostUsd: facts.proPages.check.costUsd ?? null } : {}),
          message: String((again as Error)?.message || again).slice(0, 200)
        });
        throw again;
      }
    });

  const auditRun = async (adminId: string, runId: string, detail: Record<string, unknown>): Promise<void> => {
    try {
      await deps.audit?.({ actorId: adminId, action: 'comic_model_lab_run', targetType: 'comic_model_lab_run', targetId: runId, detail });
    } catch {
      /* best-effort */
    }
  };

  /** One paid click at a time per server; the same click again while it runs is told so (never sent twice). */
  const claimInflight = (key: string): void => {
    if (inflightKey === key) {
      throw labError('LAB_BUSY', 409, 'This click is still running. Its result shows here when the provider answers; it will not be sent twice.', { sameClick: true });
    }
    if (inflightKey) throw labError('LAB_BUSY', 409, `Another lab check is running. Wait for it to finish — one paid call at a time. ${NOTHING_CHARGED}`);
    inflightKey = key;
  };

  const run = async (adminId: string, body: unknown): Promise<LabRunAnswer> => {
    const input = parseRunBody(body); // no ack → nothing else happens
    // The A/B's server-side switch is read before anything else: while it is off nothing is looked up, reserved or sent.
    const pro = proPagesItem(input.itemId);
    if (pro) {
      const budget = abBudget();
      if (!budget.enabled || budget.limitUsd === null) throw labError('AB_NOT_ENABLED', 503, `${budget.reason ?? LAB_AB_NOT_ENABLED_COPY} ${NOTHING_CHARGED}`);
    }
    const store = needStore();
    const existing = await store.byKey(input.key);
    if (existing) return answerFor(existing, true, store);
    if (pro) return runProPages(adminId, input, pro, store);

    const item = labItem(input.itemId);
    if (!item) throw labError('UNKNOWN_CHECK', 404, `There's no lab check called “${input.itemId.slice(0, 80)}”. ${NOTHING_CHARGED}`);
    if (item.unavailable) throw labError('NOT_RUNNABLE', 409, `${item.unavailable} ${NOTHING_CHARGED}`);
    const spec = labModel(item.modelId);
    if (!spec?.routes.openrouter) throw labError('NOT_RUNNABLE', 409, `This check has no OpenRouter model to call. ${NOTHING_CHARGED}`);
    const keys = platformOpenRouter(deps.keys());
    if (!keys) throw labError('NO_PLATFORM_KEY', 503, `The platform OpenRouter key isn't set on this server, so this check can't run. ${NOTHING_CHARGED}`);
    if (!deps.storage) throw labError('NO_STORAGE', 503, `Results can't be saved on this server (storage isn't configured), so the lab won't spend on a result it can't keep. ${NOTHING_CHARGED}`);
    claimInflight(input.key);
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
      if (reserved.outcome === 'cap' || reserved.outcome === 'ab_cap') throw labError('LAB_CAP_REACHED', 409, capCopy(reserved.spentUsd, capUsd, quote.usd), { spentUsd: reserved.spentUsd, capUsd, quoteUsd: quote.usd });

      // ── The one paid call ──
      const outcome = await callOnce(item, spec, keys, references, adminId);
      const facts: LabResultFacts = { ...outcome.facts, quoteBasis: quote.basis, quoteSource: quote.source };
      await recordCall(store, adminId, spec, { kind: item.kind, res: item.res, aspect: item.aspect, logId: item.id }, outcome, facts);

      const patch = { status: outcome.status, costUsd: outcome.costUsd, providerModel: outcome.providerModel, result: facts, finishedAt: new Date(deps.now()).toISOString() };
      const finished = await finishRun(store, reserved.row.id, patch, { check: item.check, item: item.id, quotedUsd: quote.usd });
      await auditRun(adminId, finished.id, { check: item.check, item: item.id, model: spec.id, status: outcome.status, quotedUsd: quote.usd, costUsd: outcome.costUsd, providerModelVersion: facts.providerModelVersion ?? null });
      logger.info('comic_model_lab_run', { check: item.check, item: item.id, status: outcome.status, quotedUsd: quote.usd, costUsd: outcome.costUsd, calls: facts.callMade ? 1 : 0, stoppedSecondCall: !!facts.stoppedSecondCall });
      return answerFor(finished, false, store);
    } finally {
      inflightKey = null;
    }
  };

  // ── P1 · Pro pages A/B ──

  const abBudget = (): LabAbBudget => (deps.proPages?.budget ?? (() => labAbBudget()))();

  type ProPair = { pair: { id: string; label: string }; state: BlindPairView['state']; a?: LabRunRow; b?: LabRunRow; waitingFor: string[]; vote?: LabVoteRow };

  /** One pair per golden page: its two arms, A and B ordered by each preview's random object id (as D4). */
  const proPairsOf = (runs: LabRunRow[], votes: LabVoteRow[]): ProPair[] => {
    const latest = latestOk(runs);
    const byId = new Map(runs.map((r) => [r.id, r] as const));
    const items = proPagesItems();
    return PRO_PAGES_GOLDEN.map((golden): ProPair => {
      const arms = items.filter((i) => i.golden.key === golden.key);
      const pair = arms[0].pair;
      const vote = votes.find((v) => v.pairId === pair.id);
      if (vote) {
        const a = byId.get(vote.aRunId);
        const b = byId.get(vote.bRunId);
        if (a && b) return { pair, state: 'voted', a, b, waitingFor: [], vote };
      }
      const done = arms.map((i) => ({ i, run: latest.get(i.id) }));
      // Naming the arm still to draw reveals nothing: no image of this pair is shown until both are drawn.
      const waitingFor = done.filter((x) => !x.run).map((x) => PRO_PAGES_ARM_LABEL[x.i.arm]);
      if (waitingFor.length) return { pair, state: 'waiting', waitingFor };
      const [a, b] = done.map((x) => x.run!).sort((x, y) => String(x.result.imagePath).localeCompare(String(y.result.imagePath)));
      return { pair, state: 'ready', a, b, waitingFor: [] };
    });
  };

  /** Before the vote a side carries ONLY its slot and image; after it, the arm, the run and its page check. */
  const proBlindViews = async (pairs: ProPair[], now: number): Promise<BlindPairView[]> => {
    const urls = await signAll(pairs.flatMap((p) => [p.a?.result.imagePath, p.b?.result.imagePath]).filter((x): x is string => !!x));
    return pairs.map((p) => {
      const base: BlindPairView = { id: p.pair.id, label: p.pair.label, state: p.state };
      if (p.state === 'waiting') return { ...base, waitingFor: p.waitingFor };
      const side = (slot: 'A' | 'B', r: LabRunRow): BlindSideView => {
        const imageUrl = r.result.imagePath ? urls[r.result.imagePath] : undefined;
        if (p.state !== 'voted') return { slot, ...(imageUrl ? { imageUrl } : {}) };
        const arm = proPagesItem(r.itemId)?.arm ?? r.result.proPages?.arm;
        return {
          slot,
          ...(imageUrl ? { imageUrl } : {}),
          run: runView(r, now, urls),
          ...(arm ? { arm: { id: arm, label: PRO_PAGES_ARM_LABEL[arm] } } : {}),
          ...(r.result.proPages?.check ? { check: r.result.proPages.check } : {})
        };
      };
      return { ...base, a: side('A', p.a!), b: side('B', p.b!), ...(p.vote ? { pick: p.vote.pick } : {}), ...(p.state === 'ready' ? { seen: seenTag(p.a!, p.b!) } : {}) };
    });
  };

  /** What the votes say so far (voted pairs only). */
  const proTally = (pairs: ProPair[]): ProPagesTally | undefined => {
    const voted = pairs.filter((p) => p.state === 'voted' && p.vote && p.a && p.b);
    if (!voted.length) return undefined;
    const tally: ProPagesTally = {
      voted: voted.length,
      pairs: pairs.length,
      picks: { on: 0, off: 0, tie: 0 },
      beats: { on: { matched: 0, planned: 0 }, off: { matched: 0, planned: 0 } },
      guideLinesCopied: { on: 0, off: 0 },
      guideLinesChecked: { on: 0, off: 0 }
    };
    const armOf = (r: LabRunRow): ProPagesArm | undefined => proPagesItem(r.itemId)?.arm ?? r.result.proPages?.arm;
    for (const p of voted) {
      const picked = p.vote!.pick === 'tie' ? undefined : armOf(p.vote!.pick === 'A' ? p.a! : p.b!);
      if (p.vote!.pick === 'tie') tally.picks.tie += 1;
      else if (picked) tally.picks[picked] += 1;
      for (const r of [p.a!, p.b!]) {
        const arm = armOf(r);
        if (!arm) continue;
        const copied = r.result.proPages?.guideLinesCopied?.value;
        if (copied === true || copied === false) {
          tally.guideLinesChecked[arm] += 1;
          if (copied) tally.guideLinesCopied[arm] += 1;
        }
        const check = r.result.proPages?.check;
        if (!check || check.beatsMatched === undefined) continue;
        tally.beats[arm].matched += check.beatsMatched;
        tally.beats[arm].planned += check.panelsPlanned;
      }
    }
    return tally;
  };

  const proPairReadyCopy = (label: string): string => `Vote on ${label} first — a new drawing now would show which side is which.`;
  /** A voted pair keeps the two drawings the owner judged (proPairsOf pins them): a new one would be paid for and never shown. */
  const proPairVotedCopy = (label: string): string => `You voted on ${label}; its two drawings are final, so a new drawing here would never be shown.`;
  const dollars = (n: number) => (n >= 1 ? `$${n.toFixed(2)}` : money(n));
  /** The headroom a drawing holds under the A/B limit for the images its quote can't price (LAB_AB_REF_ALLOWANCE_USD). */
  const refAllowance = (images: number): number => round6(Math.max(0, images) * LAB_AB_REF_ALLOWANCE_USD);
  const abCapCopy = (spent: number, limit: number, quote: number, allowance = 0): string =>
    `The A/B budget can't cover this: ${dollars(spent)} of ${dollars(limit)} used (every day, parts 1 and 2 together), and this drawing is quoted at ${money(quote)}` +
    `${allowance > 0 ? `, with ${money(allowance)} more held back for its attached images, whose price isn't published` : ''}. ${NOTHING_CHARGED}`;
  const AB_UNCOUNTED_COPY = `The A/B budget can't be counted on this server right now, so nothing here will run. ${NOTHING_CHARGED}`;
  const NO_SOURCE_COPY = "This server can't read comics (storage isn't configured), so the golden pages can't be drawn here.";

  /** The admin's own golden comics, one read per comic (b4b5774f holds two of the pages). */
  const loadGolden = async (adminId: string): Promise<Map<string, { doc: ComicDoc } | { missing: string }>> => {
    const source = deps.proPages?.source ?? null;
    const out = new Map<string, { doc: ComicDoc } | { missing: string }>();
    await Promise.all(
      [...new Set(PRO_PAGES_GOLDEN.map((g) => g.comic))].map(async (prefix) => {
        if (!source) return void out.set(prefix, { missing: NO_SOURCE_COPY });
        try {
          out.set(prefix, await source.comic(adminId, prefix));
        } catch (err) {
          logger.warn('comic_model_lab_golden_unreadable', { prefix, message: String((err as Error)?.message || err).slice(0, 160) });
          out.set(prefix, { missing: `Comic ${prefix} couldn't be read right now. Refresh to try again.` });
        }
      })
    );
    return out;
  };

  const proRefsNote = (plan: ProPagesPlan): string => {
    const others = plan.compiled.references.length - (plan.guide ? 1 : 0);
    return [
      plan.guide ? 'Image 1 is the page layout guide' : 'no layout guide',
      `${others} reference${others === 1 ? '' : 's'} as the studio attaches them`,
      ...(plan.withheld ? [`${plan.withheld} held back (blocked, or not safety-checked yet)`] : [])
    ].join(' · ');
  };

  /** The section when it couldn't be prepared: honest, quote-less, nothing runnable. */
  const proPagesUnavailable = (): ProPagesView => {
    const budget = abBudget();
    const reason = "The A/B section couldn't be prepared right now, so nothing here can run. Refresh to try again.";
    return {
      ...PRO_PAGES_CHECK,
      switchName: LAB_AB_BUDGET_ENV,
      enabled: budget.enabled,
      ...(budget.enabled ? {} : { notice: budget.reason ?? LAB_AB_NOT_ENABLED_COPY }),
      budget: { capUsd: LAB_AB_HARD_CAP_USD, limitUsd: budget.enabled ? budget.limitUsd : null, spentUsd: null, remainingUsd: null },
      quote: { usd: null, arms: 0, pages: 0, checks: 0, basis: [], refsUnpriced: false },
      pages: PRO_PAGES_GOLDEN.map((g) => ({ key: g.key, label: g.label, why: g.why, pairId: `p1-${g.key}`, available: false, reason, arms: [] })),
      pairs: []
    };
  };

  const proPagesView = async (
    adminId: string,
    ctx: { runs: LabRunRow[]; votes: LabVoteRow[]; spentUsd: number; prices: ServerPriceBook | null; keys: StudioKeys | null; now: number; healthByModel: Map<string, LabHealthView | null> }
  ): Promise<ProPagesView> => {
    const budget = abBudget();
    const store = deps.store;
    const abSpent = store?.spentOn ? await store.spentOn(LAB_AB_CHECKS).catch(() => null) : null;
    const limit = budget.enabled ? budget.limitUsd : null;
    const golden = await loadGolden(adminId);
    const pairs = proPairsOf(ctx.runs, ctx.votes);
    const pairState = new Map(pairs.map((p) => [p.pair.id, p.state] as const));
    // A vote is final even when its drawings have aged out of the recent runs this view reads.
    const votedPairs = new Set(ctx.votes.map((v) => v.pairId));
    const health = new Map(ctx.healthByModel);
    const healthFor = async (spec: ImageModelSpec): Promise<LabHealthView | null> => {
      if (!health.has(spec.id)) health.set(spec.id, await healthOf(spec, ctx.keys));
      return health.get(spec.id) ?? null;
    };

    const armView = async (item: ProPagesItem, doc: ComicDoc): Promise<ProPagesArmView> => {
      const mine = ctx.runs.filter((r) => r.itemId === item.id);
      const base = {
        id: item.id,
        check: 'P1' as const,
        arm: item.arm,
        label: PRO_PAGES_ARM_LABEL[item.arm],
        title: item.title,
        pair: item.pair,
        runs: { ok: mine.filter((r) => r.status === 'ok').length, failed: mine.filter((r) => r.status === 'failed').length, running: mine.filter((r) => r.status === 'running').length }
      };
      const planned = planProPagesArm(doc, item.golden, item.arm);
      if ('reason' in planned) return { ...base, quote: null, health: null, canRun: false, reason: planned.reason };
      const { plan } = planned;
      const spec = plan.compiled.spec;
      const refs = plan.compiled.references.length;
      const quote = quoteProPagesArm(ctx.prices, plan.compiled, refs);
      const h = await healthFor(spec);
      let reason: string | undefined;
      if (!budget.enabled) reason = budget.reason ?? LAB_AB_NOT_ENABLED_COPY;
      else if (!ctx.keys) reason = "The platform OpenRouter key isn't set on this server.";
      else if (!store || !deps.storage) reason = "Results can't be saved on this server (storage isn't configured), so the lab won't spend on a result it can't keep.";
      else if (pairState.get(item.pair.id) === 'voted' || votedPairs.has(item.pair.id)) reason = proPairVotedCopy(item.pair.label);
      else if (pairState.get(item.pair.id) === 'ready') reason = proPairReadyCopy(item.pair.label);
      else if (!quote) reason = `There's no price to quote for ${spec.nickname} at ${plan.compiled.resolution}, so the lab won't run it.`;
      else if (h?.state === 'down') reason = downCopy(spec.nickname, h);
      else if (ctx.spentUsd + quote.usd > capUsd + 1e-9) reason = capCopy(ctx.spentUsd, capUsd, quote.usd);
      else if (abSpent === null || limit === null) reason = AB_UNCOUNTED_COPY;
      else if (abSpent + quote.usd + refAllowance(refs) > limit + 1e-9) reason = abCapCopy(abSpent, limit, quote.usd, refAllowance(refs));
      return {
        ...base,
        modelId: spec.id,
        nickname: spec.nickname,
        res: plan.compiled.resolution,
        aspect: plan.compiled.aspect,
        refs,
        refsNote: proRefsNote(plan),
        quote,
        health: h,
        canRun: !reason,
        ...(reason ? { reason } : {})
      };
    };

    const pages: ProPagesPageView[] = [];
    for (const g of PRO_PAGES_GOLDEN) {
      const items = proPagesItems().filter((i) => i.golden.key === g.key);
      const head = { key: g.key, label: g.label, why: g.why, pairId: items[0].pair.id };
      const loaded = golden.get(g.comic) ?? { missing: NO_SOURCE_COPY };
      if ('missing' in loaded) {
        pages.push({ ...head, available: false, reason: loaded.missing, arms: [] });
        continue;
      }
      const arms: ProPagesArmView[] = [];
      for (const item of items) arms.push(await armView(item, loaded.doc));
      pages.push({ ...head, available: true, arms });
    }

    const quoted = pages.flatMap((p) => p.arms).filter((a): a is ProPagesArmView & { quote: LabQuote } => !!a.quote);
    const tally = proTally(pairs);
    return {
      ...PRO_PAGES_CHECK,
      switchName: LAB_AB_BUDGET_ENV,
      enabled: budget.enabled,
      ...(budget.enabled ? {} : { notice: budget.reason ?? LAB_AB_NOT_ENABLED_COPY }),
      budget: {
        capUsd: LAB_AB_HARD_CAP_USD,
        limitUsd: limit,
        spentUsd: abSpent,
        remainingUsd: limit !== null && abSpent !== null ? round6(Math.max(0, limit - abSpent)) : null
      },
      quote: {
        usd: quoted.length ? round6(quoted.reduce((s, a) => s + a.quote.usd, 0)) : null,
        arms: quoted.length,
        pages: quoted.length,
        checks: quoted.length,
        basis: [...new Set(quoted.map((a) => a.quote.basis))],
        refsUnpriced: quoted.some((a) => a.quote.refsUnpriced)
      },
      pages,
      pairs: await proBlindViews(pairs, ctx.now),
      ...(tally ? { tally } : {})
    };
  };

  /**
   * Compile the arm and load what it attaches: the layout guide (rendered, never stored) and every reference. A
   * reference that can't be loaded is left out and the page recompiled without it (its label goes, the images
   * renumber), as the studio's own runner does; a guide that can't be drawn refuses the arm (it would test nothing).
   */
  const prepareProPagesArm = async (
    source: ProPagesSource,
    loaded: ComicDoc,
    item: ProPagesItem
  ): Promise<{ plan: ProPagesPlan; references: ImageReference[]; dropped: number } | { reason: string }> => {
    const missing = new Set<string>();
    for (let pass = 0; pass < 3; pass += 1) {
      const planned = planProPagesArm(loaded, item.golden, item.arm, missing);
      if ('reason' in planned) return planned;
      const { plan } = planned;
      let guide: LayoutGuideImage | null = null;
      if (plan.guide) {
        guide = await tryRenderPageLayoutGuide(plan.doc, plan.page, plan.compiled.aspect, plan.compiled.resolution, undefined, { lab: item.id });
        if (!guide) return { reason: "The layout guide couldn't be drawn for this page, so a guide-on drawing wouldn't test anything." };
      }
      const references: ImageReference[] = [];
      let dropped = false;
      for (const ref of plan.compiled.references) {
        if (ref.path === LAYOUT_REFERENCE_PATH) {
          references.push({ label: ref.label, dataUrl: guide!.dataUrl });
          continue;
        }
        try {
          references.push({ label: ref.label, dataUrl: await source.loadDataUrl(ref.path) });
        } catch (err) {
          logger.warn('comic_model_lab_reference_missing', { item: item.id, path: ref.path, label: ref.label, message: String((err as Error)?.message || err).slice(0, 160) });
          missing.add(ref.path);
          dropped = true;
        }
      }
      if (!dropped) return { plan, references, dropped: missing.size };
    }
    return { reason: "Several of this page's reference images couldn't be loaded, so the lab won't draw a page that isn't the real one." };
  };

  /** One A/B arm: one image call and its one page check, reserved against the daily cap and the A/B limit together. */
  const runProPages = async (adminId: string, input: RunInput, item: ProPagesItem, store: LabStore): Promise<LabRunAnswer> => {
    const budget = abBudget();
    if (!budget.enabled || budget.limitUsd === null) throw labError('AB_NOT_ENABLED', 503, `${budget.reason ?? LAB_AB_NOT_ENABLED_COPY} ${NOTHING_CHARGED}`);
    const limit = budget.limitUsd;
    const source = deps.proPages?.source ?? null;
    const keys = platformOpenRouter(deps.keys());
    if (!keys) throw labError('NO_PLATFORM_KEY', 503, `The platform OpenRouter key isn't set on this server, so this check can't run. ${NOTHING_CHARGED}`);
    if (!deps.storage) throw labError('NO_STORAGE', 503, `Results can't be saved on this server (storage isn't configured), so the lab won't spend on a result it can't keep. ${NOTHING_CHARGED}`);
    if (!source) throw labError('NO_STORAGE', 503, `${NO_SOURCE_COPY} ${NOTHING_CHARGED}`);
    if (!store.spentOn) throw labError('NOT_RUNNABLE', 409, AB_UNCOUNTED_COPY);
    claimInflight(input.key);
    try {
      // Blind: while this page's pair waits for its vote, neither arm may be redrawn; once it is voted its two drawings
      // are final, and a new one would be paid for and shown nowhere (both checked inside the in-flight slot).
      const votes = await store.votes();
      const pair = proPairsOf(await store.recent(LAB_RECENT_LIMIT), votes).find((p) => p.pair.id === item.pair.id);
      if (pair?.state === 'voted' || votes.some((v) => v.pairId === item.pair.id)) throw labError('NOT_RUNNABLE', 409, `${proPairVotedCopy(item.pair.label)} ${NOTHING_CHARGED}`);
      if (pair?.state === 'ready') throw labError('NOT_RUNNABLE', 409, `${proPairReadyCopy(item.pair.label)} ${NOTHING_CHARGED}`);

      const loaded = await source.comic(adminId, item.golden.comic);
      if ('missing' in loaded) throw labError('NOT_RUNNABLE', 409, `${loaded.missing} ${NOTHING_CHARGED}`);
      const prepared = await prepareProPagesArm(source, loaded.doc, item);
      if ('reason' in prepared) throw labError('NOT_RUNNABLE', 409, `${prepared.reason} ${NOTHING_CHARGED}`);
      const { plan, references } = prepared;
      const { spec, resolution: res, aspect } = plan.compiled;
      if (!spec.routes.openrouter) throw labError('NOT_RUNNABLE', 409, `${spec.nickname} has no OpenRouter route, and the lab only calls the platform's OpenRouter key. ${NOTHING_CHARGED}`);

      const health = await healthOf(spec, keys);
      if (health?.state === 'down') throw labError('PROVIDER_DOWN', 503, downCopy(spec.nickname, health), { health });

      const prices = await deps.prices(adminId).catch(() => null);
      const quote = quoteProPagesArm(prices, plan.compiled, references.length);
      if (!quote) throw labError('NO_QUOTE', 409, `There's no price to quote for ${spec.nickname} at ${res}, so the lab won't run it (it never spends without showing the cost first). ${NOTHING_CHARGED}`);
      if (!sameQuote(quote.usd, input.quotedUsd)) {
        throw labError('QUOTE_CHANGED', 409, `The price changed since you opened this: it's now ${money(quote.usd)} (you confirmed ${money(input.quotedUsd)}). Check the new cost and confirm again. ${NOTHING_CHARGED}`, { quote });
      }
      const spent = await store.spent(utcDay(deps.now()));
      if (spent + quote.usd > capUsd + 1e-9) throw labError('LAB_CAP_REACHED', 409, capCopy(spent, capUsd, quote.usd), { spentUsd: spent, capUsd, quoteUsd: quote.usd });
      // The quote can't price the attached images, so the run reserves against the limit minus their allowance: a reported
      // cost above the quote then still fits under the limit (and the $1.20 hard cap).
      const allowance = refAllowance(references.length);
      const abSpent = await store.spentOn(LAB_AB_CHECKS);
      if (abSpent + quote.usd + allowance > limit + 1e-9) {
        throw labError('AB_CAP_REACHED', 409, abCapCopy(abSpent, limit, quote.usd, allowance), { spentUsd: abSpent, limitUsd: limit, capUsd: LAB_AB_HARD_CAP_USD, quoteUsd: quote.usd, allowanceUsd: allowance });
      }

      const reserved = await store.reserve({
        key: input.key,
        adminId,
        checkId: item.check,
        itemId: item.id,
        modelId: spec.id,
        providerModel: spec.routes.openrouter,
        kind: 'page',
        res,
        aspect,
        refs: references.length,
        quotedUsd: quote.usd,
        capUsd,
        ab: { capUsd: round6(Math.max(0, limit - allowance)) }
      });
      if (reserved.outcome === 'existing') return answerFor(reserved.row, true, store);
      if (reserved.outcome === 'cap') throw labError('LAB_CAP_REACHED', 409, capCopy(reserved.spentUsd, capUsd, quote.usd), { spentUsd: reserved.spentUsd, capUsd, quoteUsd: quote.usd });
      if (reserved.outcome === 'ab_cap') {
        throw labError('AB_CAP_REACHED', 409, abCapCopy(reserved.spentUsd, limit, quote.usd, allowance), {
          spentUsd: reserved.spentUsd,
          limitUsd: limit,
          capUsd: LAB_AB_HARD_CAP_USD,
          quoteUsd: quote.usd,
          allowanceUsd: allowance
        });
      }

      // ── The one image call, then its one page check ──
      const drawn = await drawOnce({ logId: item.id, spec, keys, adminId, res, aspect, prompt: plan.compiled.prompt, references });
      // The check is paid only for a drawing that can be judged: one whose preview was stored (latestOk skips any other,
      // so it would never reach a pair or the tally).
      const drewImage = drawn.status === 'ok' && !!drawn.dataUrl;
      const check: LabPageCheckFacts =
        drewImage && drawn.facts.imagePath
          ? await checkProPageOnce({ doc: plan.doc, page: plan.page, dataUrl: drawn.dataUrl!, keys, network: deps.network, now: deps.now })
          : {
              ok: false,
              callMade: false,
              costReported: false,
              panelsPlanned: plan.page.panels.length,
              message: drewImage ? "Not checked: the drawing couldn't be stored, so it can't be compared." : 'Not checked: the page was not drawn.'
            };
      // The check's own cost when reported; a check that reached the provider without reporting counts its quote (never
      // under-count); no check, nothing.
      const checkUsd = !check.callMade ? 0 : check.costUsd ?? prices?.qcUsd ?? QC_USD_PER_PAGE;
      const costUsd = drawn.costUsd === null ? null : round6(drawn.costUsd + checkUsd);
      const facts: LabResultFacts = {
        ...drawn.facts,
        quoteBasis: quote.basis,
        quoteSource: quote.source,
        proPages: { golden: item.golden.key, comic: item.golden.comic, pageN: item.golden.pageN, arm: item.arm, guide: plan.guide, withheld: plan.withheld, dropped: prepared.dropped, check }
      };
      // comic_image_calls records the image call with the image's own reported cost; the page check lives in the lab row.
      await recordCall(store, adminId, spec, { kind: 'page', res, aspect, logId: item.id }, { status: drawn.status, costUsd: drawn.costUsd }, facts);
      // The run's cost is reported only when both of its calls reported theirs (the cap otherwise keeps the quote's part).
      facts.costReported = drawn.facts.costReported === true && (!check.callMade || check.costReported);

      const patch = { status: drawn.status, costUsd, providerModel: drawn.providerModel, result: facts, finishedAt: new Date(deps.now()).toISOString() };
      const finished = await finishRun(store, reserved.row.id, patch, { check: item.check, item: item.id, quotedUsd: quote.usd });
      await auditRun(adminId, finished.id, {
        check: item.check,
        item: item.id,
        golden: item.golden.key,
        arm: item.arm,
        model: spec.id,
        status: drawn.status,
        quotedUsd: quote.usd,
        costUsd,
        checked: check.callMade,
        providerModelVersion: facts.providerModelVersion ?? null
      });
      logger.info('comic_model_lab_run', {
        check: item.check,
        item: item.id,
        status: drawn.status,
        quotedUsd: quote.usd,
        costUsd,
        calls: (facts.callMade ? 1 : 0) + (check.callMade ? 1 : 0),
        stoppedSecondCall: !!facts.stoppedSecondCall
      });
      return answerFor(finished, false, store);
    } finally {
      inflightKey = null;
    }
  };

  /**
   * P1 only, after its pair's vote: the owner's mark of whether this drawing copied the layout guide's borders or
   * lines (plan §4.8 turns COMIC_LAYOUT_GUIDE on only with "no copied guide lines"). Same rules as the D4 watermark box:
   * never before the vote (it would tie a run to a side), and only on a run the vote was cast on.
   */
  const setGuideLines = async (adminId: string, store: LabStore, row: LabRunRow, value: boolean | null): Promise<LabRunView> => {
    if (row.checkId !== 'P1') throw labError('BAD_REQUEST', 400, 'Only the Pro pages A/B part 1 drawings are checked for copied guide lines.');
    const facts = row.result.proPages;
    if (row.status !== 'ok' || !facts) throw labError('NOT_DRAWN', 409, 'Only a drawn A/B result can be checked for copied guide lines.');
    const pair = proPagesItem(row.itemId)?.pair;
    const voted = pair ? (await store.votes()).some((v) => v.pairId === pair.id && (v.aRunId === row.id || v.bRunId === row.id)) : false;
    if (!voted) throw labError('PAIR_NOT_READY', 409, 'Vote on this page first; the guide-lines box appears with the arms.');
    const now = deps.now();
    const updated = await store.updateResult(row.id, { ...row.result, proPages: { ...facts, guideLinesCopied: { value, at: new Date(now).toISOString(), by: adminId } } });
    return runView(updated, now, updated.result.imagePath ? await signAll([updated.result.imagePath]) : {});
  };

  const setWatermark = async (adminId: string, runId: string, body: unknown): Promise<LabRunView> => {
    const store = needStore();
    const b = isObject(body) ? body : {};
    const triState = (v: unknown): v is boolean | null => v === true || v === false || v === null;
    // The same route carries the A/B's guide-lines mark: { guideLines: true | false | null }.
    const guideAsked = Object.prototype.hasOwnProperty.call(b, 'guideLines');
    if (guideAsked ? !triState(b.guideLines) : !triState(b.visible)) {
      throw labError('BAD_REQUEST', 400, guideAsked ? "Say whether the drawing copied the guide's lines (yes, no, or not checked)." : 'Say whether the watermark is visible (yes, no, or not checked).');
    }
    const row = await store.byId(String(runId).slice(0, 64));
    if (!row) throw labError('NOT_FOUND', 404, 'That lab result is gone.');
    if (guideAsked) return setGuideLines(adminId, store, row, b.guideLines as boolean | null);
    // The A/B draws on the comic's own model and stays blind until its vote: no watermark box there.
    if (LAB_AB_CHECKS.includes(row.checkId)) throw labError('BAD_REQUEST', 400, 'The Pro pages A/B drawings have no watermark check.');
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
    const isAb = proPagesPairIds().has(pairId);
    const pair = (isAb ? proPairsOf(runs, votes) : pairsOf(runs, votes)).find((p) => p.pair.id === pairId);
    if (!pair) throw labError('NOT_FOUND', 404, 'There is no such blind pair.');
    if (pair.state === 'voted') throw labError('ALREADY_VOTED', 409, `You already voted on ${pair.pair.label}.`);
    if (pair.state !== 'ready' || !pair.a || !pair.b) {
      throw labError('PAIR_NOT_READY', 409, isAb ? `Both drawings of ${pair.pair.label} (guide off and guide on) are needed before you can compare them.` : `Both models need to draw ${pair.pair.label} before you can compare them.`);
    }
    // The vote names the drawings it was cast on: if the pair is not the one the owner saw, nothing is recorded.
    if (typeof b.seen !== 'string' || b.seen !== seenTag(pair.a, pair.b)) {
      throw labError('PAIR_CHANGED', 409, `The drawings for ${pair.pair.label} changed since you opened them, so this vote wasn't saved. Refresh the lab and vote on what you see.`);
    }
    const recorded = await store.addVote({ pairId, adminId, pick: b.pick, aRunId: pair.a.id, bRunId: pair.b.id });
    if (recorded === 'exists') throw labError('ALREADY_VOTED', 409, `You already voted on ${pair.pair.label}.`);
    try {
      await deps.audit?.({
        actorId: adminId,
        action: 'comic_model_lab_vote',
        targetType: 'comic_model_lab_pair',
        targetId: pairId,
        detail: isAb ? { pick: b.pick, a: proPagesItem(pair.a.itemId)?.arm ?? null, b: proPagesItem(pair.b.itemId)?.arm ?? null } : { pick: b.pick, a: pair.a.modelId, b: pair.b.modelId }
      });
    } catch {
      /* best-effort */
    }
    const after = await store.votes();
    const views = isAb ? await proBlindViews(proPairsOf(runs, after), deps.now()) : await blindViews(runs, after, deps.now());
    return views.find((v) => v.id === pairId)!;
  };

  return { overview, run, setWatermark, vote };
}

// ── Production dependencies (built lazily by the route; nothing at import) ───

export function createDefaultLabDeps(): ModelLabDeps {
  const assets = getSupabaseCapabilityStatus().storagePersistenceEnabled ? createSupabaseAssetStore() : null;
  return {
    // P1: the admin's own golden pages; the switch is read from the env on every overview and click (PD-8: unset = off).
    proPages: {
      source: assets ? createOwnerProPagesSource({ loadDataUrl: (path) => assets.loadDataUrl(path), enabled: true }) : null,
      budget: () => labAbBudget(process.env)
    },
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
