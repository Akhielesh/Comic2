// Recipe validation + parameter resolution.
//
// Two jobs:
//  1) sanitizeRecipe(raw) — turn untrusted JSON (from a request, a saved row, or a
//     model that "distilled" a recipe) into a safe Recipe: length-capped strings,
//     tool names re-filtered to the live allowlist (minus the swarm tool, so a recipe
//     can't recursively spawn swarms), agent ids checked against the registry, and the
//     core goose rule enforced — at least one of `instructions` / `prompt` must exist.
//  2) resolveRecipe(recipe, values) — apply defaults, coerce values to their declared
//     types, fail on missing `required` params, and render instructions/prompt/
//     activities with the templating engine.
//
// Mirrors the defense-in-depth philosophy of sanitizeCustomAgents in agents/registry.ts.

import { KNOWN_TOOL_NAMES } from '../tools/registry.js';
import { AGENTS } from '../agents/registry.js';
import { renderTemplate, type TemplateVars } from './template.js';
import {
  RECIPE_SCHEMA_VERSION,
  type Recipe,
  type RecipeParameter,
  type RecipeParameterType,
  type RecipeRequirement,
  type ResolvedRecipe
} from './schema.js';

const MAX_TITLE = 120;
const MAX_DESC = 400;
const MAX_TEXT = 8000; // instructions / prompt
const MAX_PARAMS = 24;
const MAX_ACTIVITIES = 8;
const MAX_TOOLS = 32;
const MAX_AGENTS = 6;

const str = (v: unknown, max: number): string =>
  typeof v === 'string' ? v.trim().slice(0, max) : '';

const PARAM_TYPES: RecipeParameterType[] = ['string', 'number', 'boolean', 'select'];
const REQUIREMENTS: RecipeRequirement[] = ['required', 'optional', 'user_prompt'];

// Parameter keys must be underscore-only — they become {{template_vars}}, and the
// template engine only matches [a-zA-Z0-9_].
const slugifyKey = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);

// Recipe ids are hyphenated, URL-friendly slugs (goose convention, e.g.
// "deep-research-brief"). Kept distinct from param keys above.
const slugifyId = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);

const sanitizeParameter = (raw: unknown): RecipeParameter | null => {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const key = slugifyKey(str(r.key, 40));
  if (!key) return null;
  const input_type: RecipeParameterType = PARAM_TYPES.includes(r.input_type as RecipeParameterType)
    ? (r.input_type as RecipeParameterType)
    : 'string';
  const requirement: RecipeRequirement = REQUIREMENTS.includes(r.requirement as RecipeRequirement)
    ? (r.requirement as RecipeRequirement)
    : 'optional';
  const param: RecipeParameter = { key, input_type, requirement };
  const description = str(r.description, 200);
  if (description) param.description = description;
  if (input_type === 'select' && Array.isArray(r.options)) {
    const options = r.options.filter((o): o is string => typeof o === 'string').map((o) => o.slice(0, 80)).slice(0, 24);
    if (options.length) param.options = options;
  }
  if (r.default !== undefined && r.default !== null) {
    if (typeof r.default === 'string') param.default = r.default.slice(0, 400);
    else if (typeof r.default === 'number' || typeof r.default === 'boolean') param.default = r.default;
  }
  return param;
};

/**
 * Sanitize untrusted recipe JSON into a safe Recipe, or null if it can't be made valid.
 * `idHint` seeds the slug when the recipe carries no id (e.g. a freshly distilled one).
 */
export const sanitizeRecipe = (raw: unknown, idHint?: string): Recipe | null => {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;

  const title = str(r.title, MAX_TITLE);
  const description = str(r.description, MAX_DESC);
  const instructions = str(r.instructions, MAX_TEXT);
  const prompt = str(r.prompt, MAX_TEXT);
  if (!title) return null;
  // Core goose rule: a recipe must carry at least instructions or a prompt.
  if (!instructions && !prompt) return null;

  const parameters: RecipeParameter[] = [];
  if (Array.isArray(r.parameters)) {
    const seen = new Set<string>();
    for (const p of r.parameters.slice(0, MAX_PARAMS)) {
      const param = sanitizeParameter(p);
      if (param && !seen.has(param.key)) {
        seen.add(param.key);
        parameters.push(param);
      }
    }
  }

  const tools = Array.isArray(r.tools)
    ? [...new Set(r.tools.filter((t): t is string => typeof t === 'string' && KNOWN_TOOL_NAMES.includes(t) && t !== 'run_agent_swarm'))].slice(0, MAX_TOOLS)
    : [];

  const agents = Array.isArray(r.agents)
    ? [...new Set(r.agents.filter((a): a is string => typeof a === 'string' && Boolean(AGENTS[a])))].slice(0, MAX_AGENTS)
    : [];

  const activities = Array.isArray(r.activities)
    ? r.activities.filter((a): a is string => typeof a === 'string').map((a) => a.trim().slice(0, 200)).filter(Boolean).slice(0, MAX_ACTIVITIES)
    : [];

  const recipe: Recipe = {
    version: str(r.version, 16) || RECIPE_SCHEMA_VERSION,
    title,
    description,
    swarm: r.swarm === true || agents.length > 0
  };
  const id = slugifyId(str(r.id, 48)) || (idHint ? slugifyId(idHint) : '') || slugifyId(title);
  if (id) recipe.id = id;
  if (instructions) recipe.instructions = instructions;
  if (prompt) recipe.prompt = prompt;
  if (parameters.length) recipe.parameters = parameters;
  if (tools.length) recipe.tools = tools;
  if (agents.length) recipe.agents = agents;
  if (activities.length) recipe.activities = activities;

  // settings
  if (r.settings && typeof r.settings === 'object') {
    const s = r.settings as Record<string, unknown>;
    const settings: NonNullable<Recipe['settings']> = {};
    if (typeof s.model === 'string') settings.model = s.model.slice(0, 120);
    if (typeof s.temperature === 'number' && s.temperature >= 0 && s.temperature <= 2) settings.temperature = s.temperature;
    if (typeof s.preferFree === 'boolean') settings.preferFree = s.preferFree;
    if (Object.keys(settings).length) recipe.settings = settings;
  }

  // response.json_schema (kept opaque; only shallow-validated as an object)
  if (r.response && typeof r.response === 'object') {
    const resp = r.response as Record<string, unknown>;
    if (resp.json_schema && typeof resp.json_schema === 'object') {
      recipe.response = { json_schema: resp.json_schema as Record<string, unknown> };
    }
  }

  // author
  if (r.author && typeof r.author === 'object') {
    const a = r.author as Record<string, unknown>;
    const author: NonNullable<Recipe['author']> = {};
    if (typeof a.contact === 'string') author.contact = a.contact.slice(0, 200);
    if (a.metadata && typeof a.metadata === 'object') author.metadata = a.metadata as Record<string, unknown>;
    if (Object.keys(author).length) recipe.author = author;
  }

  return recipe;
};

const coerceValue = (param: RecipeParameter, raw: unknown): string | number | boolean | undefined => {
  if (raw === undefined || raw === null || raw === '') return undefined;
  switch (param.input_type) {
    case 'number': {
      const n = typeof raw === 'number' ? raw : Number(String(raw));
      return Number.isFinite(n) ? n : undefined;
    }
    case 'boolean':
      if (typeof raw === 'boolean') return raw;
      return ['true', '1', 'yes', 'on'].includes(String(raw).toLowerCase());
    case 'select': {
      const v = String(raw);
      if (param.options && param.options.length && !param.options.includes(v)) return undefined;
      return v;
    }
    default:
      return String(raw).slice(0, 4000);
  }
};

export interface ResolveResult {
  resolved?: ResolvedRecipe;
  /** Keys of `required` params the caller did not supply. */
  missing: string[];
  errors: string[];
}

/**
 * Apply defaults + coercion to caller-supplied values, enforce required params, and
 * render the recipe's instructions/prompt/activities. Returns the missing required
 * keys (so a UI can prompt) rather than throwing.
 */
export const resolveRecipe = (
  recipe: Recipe,
  rawValues: Record<string, unknown> = {}
): ResolveResult => {
  const values: Record<string, string | number | boolean> = {};
  const missing: string[] = [];
  const errors: string[] = [];

  for (const param of recipe.parameters || []) {
    let v = coerceValue(param, rawValues[param.key]);
    if (v === undefined && param.default !== undefined) v = coerceValue(param, param.default);
    if (v === undefined) {
      if (param.requirement === 'required') missing.push(param.key);
      continue;
    }
    values[param.key] = v;
  }

  if (missing.length) return { missing, errors };

  const vars: TemplateVars = values;
  const resolved: ResolvedRecipe = {
    recipe,
    values,
    instructions: renderTemplate(recipe.instructions, vars),
    prompt: renderTemplate(recipe.prompt, vars),
    activities: (recipe.activities || []).map((a) => renderTemplate(a, vars)).filter(Boolean)
  };
  return { resolved, missing: [], errors };
};
