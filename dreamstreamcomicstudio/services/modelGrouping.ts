// Cross-source model grouping.
//
// The same underlying model is often offered by more than one source (e.g. Llama 3.3 70B
// from both OpenRouter and NVIDIA Build), and a single source can list a model twice — a
// ':free' variant and a paid one. A flat list hides that. This groups variants by a canonical
// model key so the picker can:
//   - dedupe when the variants are technically identical (just let the user choose a source), and
//   - split + surface the REAL difference (cost, context, price, modality, hosting) when they're not.
//
// Differences are computed from catalog data only — we never invent latency numbers we don't have.

import type { CatalogModel, ModelSource } from './modelCatalog';

/**
 * A stable key shared by the same model across sources. Publisher prefixes vary by source
 * ("meta-llama/…" vs "meta/…", "deepseek/…" vs "deepseek-ai/…") and a ':free' suffix is just a
 * billing variant, so we key on the normalized model-name tail plus the output slot (image vs
 * text) — never merging an image model with a text model that happens to share a name.
 */
export const canonicalModelKey = (model: CatalogModel): string => {
  const slot = model.supportsImageOutput ? 'img' : 'txt';
  let id = model.id.toLowerCase().trim();
  if (id.endsWith(':free')) id = id.slice(0, -':free'.length);
  const tail = id.includes('/') ? id.slice(id.lastIndexOf('/') + 1) : id;
  const norm = tail.replace(/[._]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return `${slot}:${norm}`;
};

/** Technical axes we compare across a group's variants. Order is the display order. */
export type DiffAxis =
  | 'cost'
  | 'tokenPrice'
  | 'imagePrice'
  | 'context'
  | 'imageInput'
  | 'inputModalities'
  | 'jsonOutput'
  | 'parameters';

export const DIFF_AXIS_LABEL: Record<DiffAxis, string> = {
  cost: 'Cost',
  tokenPrice: 'Token price',
  imagePrice: 'Image price',
  context: 'Context',
  imageInput: 'Image input',
  inputModalities: 'Input modalities',
  jsonOutput: 'JSON output',
  parameters: 'Parameters'
};

const AXIS_VALUE: Record<DiffAxis, (m: CatalogModel) => string> = {
  cost: (m) => (m.isFree ? 'free' : m.costClass),
  tokenPrice: (m) => String(m.pricing.completionPerToken),
  imagePrice: (m) => String(m.pricing.imagePerImage),
  context: (m) => String(m.contextLength || 0),
  imageInput: (m) => String(m.supportsImageInput),
  inputModalities: (m) => [...m.inputModalities].sort().join(','),
  jsonOutput: (m) => String(m.supportsJsonOutput),
  parameters: (m) => [...m.supportedParameters].sort().join(',')
};

const ALL_AXES: DiffAxis[] = ['cost', 'tokenPrice', 'imagePrice', 'context', 'imageInput', 'inputModalities', 'jsonOutput', 'parameters'];

/** Which axes actually differ across the given variants (empty ⇒ technically identical). */
export const computeGroupDifferences = (variants: CatalogModel[]): DiffAxis[] => {
  if (variants.length < 2) return [];
  return ALL_AXES.filter((axis) => new Set(variants.map(AXIS_VALUE[axis])).size > 1);
};

/** Human-readable value of one axis for a single variant (for the per-source diff chips). */
export const axisDisplay = (model: CatalogModel, axis: DiffAxis): string => {
  switch (axis) {
    case 'cost':
      return model.isFree ? 'Free' : model.costClass === 'free_verified' ? 'Free' : 'Paid';
    case 'tokenPrice':
      return `$${(model.pricing.completionPerToken * 1_000_000).toFixed(2)}/M out`;
    case 'imagePrice':
      return `$${model.pricing.imagePerImage.toFixed(3)}/img`;
    case 'context':
      return model.contextLength ? `${Math.round(model.contextLength / 1000)}K ctx` : 'ctx n/a';
    case 'imageInput':
      return model.supportsImageInput ? 'Image input' : 'Text-only input';
    case 'inputModalities':
      return model.inputModalities.join('+');
    case 'jsonOutput':
      return model.supportsJsonOutput ? 'JSON output' : 'No JSON';
    case 'parameters':
      return `${model.supportedParameters.length} params`;
    default:
      return '';
  }
};

/**
 * Short, honest hosting descriptor per source — the "hosting tier" the user asked to see.
 * Qualitative (we have no measured latency), so it states what the source actually is.
 */
export const SOURCE_HOSTING: Record<ModelSource, string> = {
  openrouter: 'Unified gateway — routes to an upstream host; pay-per-token, some :free variants.',
  nvidia: 'NVIDIA DGX Cloud (NIM) — credit-based free tier, then billed to your nvapi- key.'
};

export interface ModelGroup {
  key: string;
  /** Display name (taken from the preferred/first variant). */
  name: string;
  /** Variants sorted free-first, then by source, then id — so the cheapest option leads. */
  variants: CatalogModel[];
  /** True when more than one distinct source offers this model. */
  multiSource: boolean;
  /** True when there are 2+ variants and they are technically identical (dedupe + pick source). */
  identical: boolean;
  /** Axes that differ across variants (drives the "show the difference" UI). */
  differences: DiffAxis[];
}

const variantSort = (a: CatalogModel, b: CatalogModel): number => {
  if (a.isFree !== b.isFree) return a.isFree ? -1 : 1; // free first
  if (a.source !== b.source) return a.source.localeCompare(b.source);
  return a.id.localeCompare(b.id);
};

/** Group a flat model list by canonical key, annotated with cross-source differences. */
export const groupModelsBySource = (models: CatalogModel[]): ModelGroup[] => {
  const map = new Map<string, CatalogModel[]>();
  for (const m of models) {
    const k = canonicalModelKey(m);
    const bucket = map.get(k);
    if (bucket) bucket.push(m);
    else map.set(k, [m]);
  }

  const groups: ModelGroup[] = [];
  for (const [key, variants] of map) {
    const sorted = [...variants].sort(variantSort);
    const sources = new Set(variants.map((v) => v.source));
    const differences = computeGroupDifferences(sorted);
    groups.push({
      key,
      name: sorted[0].name,
      variants: sorted,
      multiSource: sources.size > 1,
      identical: sorted.length > 1 && differences.length === 0,
      differences
    });
  }
  // Keep the catalog's incoming order roughly, by first-variant appearance.
  return groups;
};
