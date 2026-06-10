// Ranked, typo-tolerant model search.
//
// The old search was a raw substring test over a space-joined haystack — "claud",
// "gpt4o" or "antropic" found nothing, and every hit weighed the same. This engine
// scores each model against the query so results RANK by relevance instead of
// filtering blind:
//   · exact / prefix / substring token matches on the id, name and vendor
//   · family aliases ("claude" → Anthropic, "kimi" → Moonshot, "flux" → Black Forest)
//   · semantic facets ("free", "image", "reasoning", "nvidia" …) via QUERY_FACETS
//   · benchmark-backed domains ("coding", "math" …) require real strength ≥ 55
//   · bounded edit-distance fuzzy match so one-letter typos still land
// Every query token must match somewhere (AND), mirroring how people narrow a list.

import type { CatalogModel } from './modelCatalog';
import { getCapabilities, QUERY_FACETS } from './modelCapabilities';
import { getModelVendor } from './modelVendors';
import { domainStrength, DOMAIN_META, type DomainId } from './modelDomains';

// Family/product names users type that rarely appear verbatim in the model id.
// Keyed by canonical vendor id (modelVendors), values are extra searchable tokens.
const FAMILY_ALIASES: Record<string, string[]> = {
  anthropic: ['claude', 'sonnet', 'opus', 'haiku'],
  openai: ['gpt', 'chatgpt', 'dalle', 'sora', 'codex'],
  google: ['gemini', 'gemma', 'imagen', 'deepmind'],
  meta: ['llama'],
  xai: ['grok'],
  zai: ['glm', 'zhipu'],
  moonshot: ['kimi'],
  mistral: ['mixtral', 'codestral', 'magistral', 'pixtral', 'devstral'],
  qwen: ['qwq', 'qvq', 'alibaba'],
  deepseek: ['r1'],
  'black-forest-labs': ['flux'],
  stability: ['sdxl', 'stable', 'diffusion'],
  nvidia: ['nemotron', 'nim'],
  amazon: ['nova', 'aws', 'bedrock'],
  microsoft: ['phi', 'azure'],
  cohere: ['command'],
  perplexity: ['sonar'],
  nous: ['hermes']
};

const tokenize = (text: string): string[] =>
  text
    .toLowerCase()
    .split(/[^a-z0-9.]+/)
    .map((t) => t.replace(/^\.+|\.+$/g, ''))
    .filter((t) => t.length > 0);

interface ModelIndex {
  /** Discrete searchable tokens (id parts, name parts, vendor, aliases). */
  tokens: string[];
  /** Adjacent-token joins ("gpt"+"4o" → "gpt4o") so collapsed queries still hit. */
  joined: string[];
  /** Lower-priority full-text haystack (description, notes, roles). */
  haystack: string;
}

const INDEX_CACHE = new WeakMap<CatalogModel, ModelIndex>();

const buildIndex = (model: CatalogModel): ModelIndex => {
  const vendor = getModelVendor(model);
  const tokens = new Set<string>([
    ...tokenize(model.id),
    ...tokenize(model.name),
    ...tokenize(vendor.label),
    vendor.id,
    ...vendor.aliases,
    ...(FAMILY_ALIASES[vendor.id] ?? []),
    model.source
  ]);
  const idTokens = tokenize(model.id);
  const nameTokens = tokenize(model.name);
  const joined: string[] = [];
  for (const list of [idTokens, nameTokens]) {
    for (let i = 0; i < list.length - 1; i++) joined.push(list[i] + list[i + 1]);
    if (list.length > 1) joined.push(list.join(''));
  }
  const haystack = [
    model.description,
    model.editorialNote,
    model.roles?.join(' '),
    model.possibilities?.join(' '),
    model.drawbacks?.join(' ')
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return { tokens: [...tokens], joined, haystack };
};

const indexOfModel = (model: CatalogModel): ModelIndex => {
  let idx = INDEX_CACHE.get(model);
  if (!idx) {
    idx = buildIndex(model);
    INDEX_CACHE.set(model, idx);
  }
  return idx;
};

/**
 * Bounded edit distance (optimal string alignment: insert/delete/substitute +
 * adjacent transposition, so "cluade"→"claude" counts as 1). Bails out early
 * once `max` is exceeded.
 */
export const boundedEditDistance = (a: string, b: string, max: number): number => {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev2: number[] | null = null;
  let prev = new Array<number>(b.length + 1);
  let curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      if (prev2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, prev2[j - 2] + 1);
      }
      curr[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev2 = prev;
    prev = curr;
    curr = new Array<number>(b.length + 1);
  }
  return prev[b.length];
};

const fuzzyBudget = (len: number): number => (len >= 7 ? 2 : len >= 4 ? 1 : 0);

// Domain lookup: token → DomainId ("coding" / "math" / "science" …, plus label words).
const DOMAIN_TOKEN_MAP: Map<string, DomainId> = (() => {
  const map = new Map<string, DomainId>();
  for (const meta of Object.values(DOMAIN_META)) {
    map.set(meta.id, meta.id);
    for (const word of tokenize(meta.label)) {
      if (word.length >= 4 && !map.has(word)) map.set(word, meta.id);
    }
  }
  return map;
})();

/**
 * How well one query token matches a model. 0 = no match (model is excluded when
 * any token scores 0). Higher = stronger, used for relevance ranking.
 */
const scoreToken = (token: string, model: CatalogModel, idx: ModelIndex): number => {
  const caps = getCapabilities(model);

  // Semantic facets keep their hard-filter behavior ("free" means free, not substring).
  const facet = QUERY_FACETS.find((f) => f.keys.includes(token));
  if (facet) return facet.test(caps, model) ? 60 : 0;

  // Benchmark-backed domains: "coding" only matches models that can actually code.
  const domain = DOMAIN_TOKEN_MAP.get(token);
  if (domain) {
    const strength = domainStrength(model, domain);
    if (strength >= 55) return 30 + Math.round(strength / 2);
    return 0;
  }

  let best = 0;
  const idLower = model.id.toLowerCase();
  const nameLower = model.name.toLowerCase();
  if (token === idLower || token === nameLower) return 200;

  for (const t of idx.tokens) {
    if (t === token) { best = Math.max(best, 100); break; }
    if (token.length >= 2 && t.startsWith(token)) best = Math.max(best, 70 + Math.min(20, token.length * 2));
    else if (token.length >= 3 && t.includes(token)) best = Math.max(best, 55);
  }
  if (best >= 100) return best;

  if (token.length >= 3) {
    for (const j of idx.joined) {
      if (j === token) return 95;
      if (j.startsWith(token)) best = Math.max(best, 65);
    }
    if (idLower.includes(token) || nameLower.includes(token)) best = Math.max(best, 50);
    if (best === 0 && idx.haystack.includes(token)) best = 35;
  }

  // Typo tolerance — only when nothing else matched and the token is long enough
  // that a 1–2 letter slip is plausibly the same word.
  if (best === 0) {
    const budget = fuzzyBudget(token.length);
    if (budget > 0) {
      for (const t of idx.tokens) {
        if (Math.abs(t.length - token.length) > budget) continue;
        if (boundedEditDistance(token, t, budget) <= budget) { best = 30; break; }
      }
    }
  }
  return best;
};

/** Relevance score for a whole query. 0 = the model doesn't match. */
export const scoreModelForQuery = (model: CatalogModel, query: string): number => {
  const tokens = tokenize(query);
  if (!tokens.length) return 1; // empty query matches everything, neutrally
  const idx = indexOfModel(model);
  let total = 0;
  for (const token of tokens) {
    const s = scoreToken(token, model, idx);
    if (s === 0) return 0; // AND semantics — every token must land somewhere
    total += s;
  }
  return total;
};

export const modelMatchesQuery = (model: CatalogModel, query: string): boolean =>
  scoreModelForQuery(model, query) > 0;

/**
 * Filter + rank models for a query. With an empty query the input order is kept;
 * otherwise results sort by relevance (stable — catalog order breaks ties).
 */
export const searchModels = <T extends CatalogModel>(models: T[], query: string): T[] => {
  const trimmed = query.trim();
  if (!trimmed) return models;
  const scored: { model: T; score: number; i: number }[] = [];
  for (let i = 0; i < models.length; i++) {
    const score = scoreModelForQuery(models[i], trimmed);
    if (score > 0) scored.push({ model: models[i], score, i });
  }
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  return scored.map((s) => s.model);
};
