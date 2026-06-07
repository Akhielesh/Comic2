// Recipe schema — a native TypeScript port of goose's "recipe" concept
// (block/goose · Agentic AI Foundation), adapted to DreamStream's swarm + tool stack.
//
// A Recipe is a reusable, parameterized agent workflow: a saved bundle of
// instructions + an optional initial prompt + typed parameters + a tool/agent
// allowlist + optional structured-output contract. Where goose binds MCP
// "extensions", we bind this app's first-class primitives instead:
//   - goose `extensions`  →  `tools` (allowlisted KNOWN_TOOL_NAMES) + `agents`
//                            (built-in swarm specialists) / `swarm`
//   - goose `settings`    →  `settings` (model / temperature / preferFree)
//   - goose `response`    →  `response.json_schema` (final structured output)
// Everything else (version, title, description, instructions, prompt,
// parameters, activities, author) maps one-to-one so recipes authored for
// goose read naturally here.
//
// Recipes are what let the agents "improve themselves": a good run can be
// distilled into a Recipe (see learning.ts), saved, re-run, and refined — a
// durable, shareable skill instead of a one-off conversation.

/** Parameter value types a recipe can declare. Mirrors goose input_type. */
export type RecipeParameterType = 'string' | 'number' | 'boolean' | 'select';

/**
 * How a parameter is supplied:
 *  - required:    must be provided at run time (no default substitution).
 *  - optional:    may be omitted; `default` is used when absent.
 *  - user_prompt: the UI should ask the user for it interactively before running.
 */
export type RecipeRequirement = 'required' | 'optional' | 'user_prompt';

export interface RecipeParameter {
  key: string;
  input_type: RecipeParameterType;
  requirement: RecipeRequirement;
  description?: string;
  /** Used when an `optional` param is not supplied. */
  default?: string | number | boolean;
  /** Allowed values for `select` params. */
  options?: string[];
}

/** Optional structured-output contract enforced on the final answer. */
export interface RecipeResponse {
  /** JSON Schema the final output should match (best-effort coercion at run time). */
  json_schema?: Record<string, unknown>;
}

/** Execution settings (model + sampling). Omitted fields fall back to app defaults. */
export interface RecipeSettings {
  /** Preferred model for synthesis/answer. Falls back to the request's model. */
  model?: string;
  temperature?: number;
  /** Prefer a free/open model for the heavy lifting (default true for swarm recipes). */
  preferFree?: boolean;
}

export interface RecipeAuthor {
  contact?: string;
  metadata?: Record<string, unknown>;
}

export interface Recipe {
  /** Recipe schema version, e.g. "1.0.0". */
  version: string;
  /** Stable slug/id within a library (assigned on save; optional for inline recipes). */
  id?: string;
  title: string;
  description: string;
  /**
   * System-level instructions that steer the agent for the whole run. At least one
   * of `instructions` or `prompt` MUST be present (goose's core validation rule).
   */
  instructions?: string;
  /** Initial user prompt to kick the run off (templated like instructions). */
  prompt?: string;
  /** Typed, templated parameters substituted into instructions/prompt/activities. */
  parameters?: RecipeParameter[];
  /**
   * Allowlisted tool names (subset of KNOWN_TOOL_NAMES) the recipe's agent may call.
   * The runner re-filters these against the live allowlist — defense in depth.
   */
  tools?: string[];
  /**
   * Built-in swarm specialist ids to deploy (e.g. ['research','finance']). When set
   * (or `swarm` is true) the recipe runs through the swarm orchestrator instead of a
   * single chat turn.
   */
  agents?: string[];
  /** Force the swarm orchestrator (plan → dispatch → verify → synthesize). */
  swarm?: boolean;
  /** Suggested follow-up prompts surfaced in the UI after a run (templated). */
  activities?: string[];
  /** Final structured-output contract. */
  response?: RecipeResponse;
  settings?: RecipeSettings;
  author?: RecipeAuthor;
}

/** A validated recipe plus the (defaulted, coerced) values used for a specific run. */
export interface ResolvedRecipe {
  recipe: Recipe;
  /** Param key → resolved value after defaults + coercion. */
  values: Record<string, string | number | boolean>;
  /** Instructions with all parameters substituted. */
  instructions: string;
  /** Prompt with all parameters substituted (may be empty). */
  prompt: string;
  /** Activities with parameters substituted. */
  activities: string[];
}

export const RECIPE_SCHEMA_VERSION = '1.0.0';
